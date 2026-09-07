import type { Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import { HEARTBEAT_INTERVAL_MS } from "./connection-health.js";
import {
  inspectionEventSchema,
  messageEnvelopeSchema,
  sendResponseSchema,
  type IncomingEvent,
  type ActorEvent,
  type SnapshotEvent,
  type XStateEvent,
  type InspectionEvent,
} from "./types.js";
import type { ActorStore } from "./actor-store.js";
import { ClientRegistry } from "./client-registry.js";
import type { Logger } from "./logger.js";

export interface WsServerOptions {
  port: number;
  server?: HttpServer;
  signal?: AbortSignal;
  host?: string;
  store: ActorStore;
  clientRegistry?: ClientRegistry;
  logger: Logger;
  allowedOrigins?: string[];
  requireOrigin?: boolean;
  maxPayload?: number;
}

/**
 * Check if an origin matches any of the allowed origin patterns.
 * Patterns support `*` as a port wildcard (e.g. `http://localhost:*`).
 */
export function matchesAllowedOrigin(
  origin: string,
  patterns: string[],
): boolean {
  for (const pattern of patterns) {
    // Escape regex special chars except *, then replace :* with port wildcard
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Replace :\* (escaped colon-star) with optional port: (:\d+)?
    const regexStr = `^${escaped.replace(":\\*", "(:\\d+)?")}$`;
    if (new RegExp(regexStr).test(origin)) {
      return true;
    }
  }
  return false;
}

const DEFAULT_MAX_PAYLOAD = 10 * 1024 * 1024; // 10 MB

export function createWsServer(options: WsServerOptions): WebSocketServer {
  const {
    port,
    host,
    store,
    clientRegistry: providedRegistry,
    logger,
    allowedOrigins,
    requireOrigin,
  } = options;

  const clientRegistry = providedRegistry ?? new ClientRegistry(5000, logger);
  const unsubscribeClear = store.onCleared(() => clientRegistry.clear());
  const health = clientRegistry.health;
  health.setListener("starting");
  let wss: WebSocketServer;
  const listenerError = (err: unknown) => {
    const code =
      err && typeof err === "object" && "code" in err
        ? String(err.code)
        : "UNKNOWN";
    health.setListener(
      "error",
      null,
      code === "EADDRINUSE" ||
        code === "EACCES" ||
        code === "EADDRNOTAVAIL" ||
        code === "ENOTFOUND"
        ? code
        : "UNKNOWN",
    );
  };
  try {
    wss = new WebSocketServer({
      ...(options.server
        ? { server: options.server }
        : { port, host: host ?? "127.0.0.1" }),
      maxPayload: options.maxPayload ?? DEFAULT_MAX_PAYLOAD,
      verifyClient: allowedOrigins
        ? (info, callback) => {
            const origin = info.origin;
            if (!origin) {
              if (requireOrigin) {
                health.rejectConnection();
                logger.warn(
                  "Rejected WebSocket connection: missing Origin header",
                );
                callback(false, 403, "Origin header required");
              } else {
                callback(true);
              }
              return;
            }
            if (matchesAllowedOrigin(origin, allowedOrigins)) {
              callback(true);
            } else {
              health.rejectConnection();
              logger.warn("Rejected WebSocket connection: origin not allowed");
              callback(false, 403, "Origin not allowed");
            }
          }
        : undefined,
    });
  } catch (err) {
    unsubscribeClear();
    listenerError(err);
    throw err;
  }

  wss.once("close", unsubscribeClear);

  wss.on("listening", () => {
    const address = wss.address();
    if (address && typeof address !== "string") {
      const endpointHost =
        address.family === "IPv6" ? `[${address.address}]` : address.address;
      health.setListener("listening", {
        host: address.address,
        port: address.port,
        url: `ws://${endpointHost}:${address.port}`,
      });
      logger.info(
        `WebSocket server listening on ${endpointHost}:${address.port}`,
      );
    }
  });

  wss.on("connection", (ws: WebSocket, request) => {
    if (options.signal?.aborted || clientRegistry.isClosed) {
      ws.terminate();
      return;
    }
    const query = (request.url ?? "").split("?").slice(1).join("?");
    const params = new URLSearchParams(query);
    clientRegistry.registerClient(ws, params.get("applicationName") ?? undefined);
    logger.info("Client connected");
    ws.on("pong", () => health.activity(ws));
    ws.on("ping", () => health.activity(ws));

    ws.on("message", (data: Buffer | string) => {
      if (options.signal?.aborted || clientRegistry.isClosed) return;
      health.activity(ws);
      health.count(ws, "receivedFrames");
      handleMessage(data.toString(), ws, store, clientRegistry, logger);
    });

    ws.on("close", () => {
      if (clientRegistry) {
        clientRegistry.removeClient(ws, store);
      }
      logger.info("Client disconnected");
    });

    ws.on("error", (err: Error) => {
      health.reject(ws, "transport_error");
      logger.error(`WebSocket error: ${err.message}`);
    });
  });

  wss.on("error", (err: Error) => {
    listenerError(err);
    logger.error(`WebSocket server error: ${err.message}`);
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients)
      if (ws.readyState === ws.OPEN) {
        ws.ping(undefined, undefined, (err) => {
          if (err) health.reject(ws, "transport_error");
        });
      }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();
  wss.on("close", () => {
    clearInterval(heartbeat);
    if (clientRegistry.getHealth(1).listener.state !== "error")
      health.setListener("closed");
  });

  return wss;
}

function handleMessage(
  raw: string,
  ws: WebSocket,
  store: ActorStore,
  clientRegistry: ClientRegistry,
  logger: Logger,
): void {
  const health = clientRegistry.health;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    health.reject(ws, "invalid_json");
    logger.warn("Received non-JSON message, skipping");
    return;
  }

  const envelope = messageEnvelopeSchema.safeParse(parsed);
  if (!envelope.success) {
    health.reject(ws, "invalid_envelope");
    logger.warn("Invalid WebSocket message envelope, skipping");
    return;
  }
  const obj = envelope.data;

  if (obj.type === "xstate-mcp.hello") {
    const response = health.negotiate(ws, parsed);
    ws.send(JSON.stringify(response), (err) => {
      if (err) health.reject(ws, "transport_error");
    });
    return;
  }
  if (obj.type === "xstate-mcp.send.response") {
    const ack = sendResponseSchema.safeParse(parsed);
    if (!ack.success) {
      health.reject(ws, "invalid_ack");
      logger.warn("Invalid send response, skipping");
      return;
    }
    if (
      !clientRegistry.handleResponse(
        ws,
        ack.data.requestId,
        ack.data.success,
        ack.data.error,
      )
    )
      health.reject(ws, "unexpected_ack");
    return;
  }
  if (!health.canInspect(ws)) {
    health.reject(ws, "incompatible_protocol");
    return;
  }

  // Skip microstep events
  if (obj.type === "@xstate.microstep") {
    health.count(ws, "ignoredFrames");
    logger.debug("Skipping @xstate.microstep event");
    return;
  }

  const result = inspectionEventSchema.safeParse(parsed);
  if (!result.success) {
    health.reject(ws, "invalid_inspection");
    logger.warn("Invalid inspection event, skipping");
    return;
  }

  const event = normalizeEvent(result.data, logger);
  if (!event) {
    health.reject(ws, "missing_session_id");
    return;
  }
  const localSessionId = event.sessionId;
  const scope = (id: string | undefined) =>
    id === undefined ? undefined : clientRegistry.getSessionId(ws, id);
  if (event.type === "@xstate.actor") {
    const identity = clientRegistry.registerSession(ws, localSessionId);
    if (store.getActor(identity.sessionId)) {
      logger.debug(
        "Ignoring duplicate actor registration on the same connection",
      );
      return;
    }
    health.acceptedInspection(ws);
    store.registerActor({
      ...event,
      ...identity,
      name: event.name ?? localSessionId,
      rootId: scope(event.rootId),
      parentId: scope(event.parentId),
    });
    return;
  }

  const identity = clientRegistry.getSession(ws, localSessionId);
  if (
    !identity ||
    store.getActor(identity.sessionId)?.connectionId !== identity.connectionId
  ) {
    health.reject(ws, "actor_not_registered");
    logger.warn(
      "Rejected inspection update for an actor not registered on this connection",
    );
    return;
  }
  health.acceptedInspection(ws);
  if (event.type === "@xstate.snapshot") {
    store.updateSnapshot({
      ...event,
      sessionId: identity.sessionId,
      rootId: scope(event.rootId),
    });
  } else {
    store.addEvent({
      ...event,
      sessionId: identity.sessionId,
      rootId: scope(event.rootId),
      sourceId: scope(event.sourceId),
    });
  }
}

const isoTimestampSchema = z.string().datetime({ offset: true });

function normalizeTimestamp(createdAt: string | undefined): string | null {
  if (createdAt === undefined) return new Date().toISOString();

  const time = /^-?\d+$/.test(createdAt)
    ? Number(createdAt)
    : isoTimestampSchema.safeParse(createdAt).success
      ? Date.parse(createdAt)
      : NaN;
  const date = new Date(time);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/**
 * Normalize incoming events from either native XState 5 format (actorRef/sourceRef)
 * or @statelyai/inspect serialized format (sessionId/sourceId) into our internal types.
 */
export function normalizeEvent(
  incoming: IncomingEvent,
  logger: Logger,
): InspectionEvent | null {
  // Extract sessionId: prefer top-level sessionId, fall back to actorRef.sessionId or actorRef.id
  // Native XState 5 serializes actorRef as { xstate$$type: 1, id: "x:5" } — no sessionId field
  const actorRef = (incoming as Record<string, unknown>).actorRef as
    { sessionId?: string; id?: string } | undefined;
  const resolvedSessionId =
    incoming.sessionId ?? actorRef?.sessionId ?? actorRef?.id;

  if (!resolvedSessionId) {
    logger.warn(
      "Event missing sessionId, actorRef.sessionId, and actorRef.id, skipping",
    );
    return null;
  }

  const createdAt = normalizeTimestamp(incoming.createdAt);
  if (createdAt === null) {
    logger.warn("Event has invalid createdAt, skipping");
    return null;
  }

  switch (incoming.type) {
    case "@xstate.actor": {
      // In native format, actorRef may contain id/name info
      const name =
        incoming.name ??
        ((actorRef as Record<string, unknown> | undefined)?.id as
          string | undefined);

      const event: ActorEvent = {
        type: "@xstate.actor",
        sessionId: resolvedSessionId,
        rootId: incoming.rootId,
        name,
        parentId: incoming.parentId,
        definition: incoming.definition,
        snapshot: incoming.snapshot,
        createdAt,
      };
      return event;
    }

    case "@xstate.snapshot": {
      const event: SnapshotEvent = {
        type: "@xstate.snapshot",
        sessionId: resolvedSessionId,
        rootId: incoming.rootId,
        snapshot: incoming.snapshot,
        event: incoming.event,
        createdAt,
      };
      return event;
    }

    case "@xstate.event": {
      // sourceId: prefer top-level sourceId, fall back to sourceRef.sessionId or sourceRef.id
      const sourceRef = (incoming as Record<string, unknown>).sourceRef as
        { sessionId?: string; id?: string } | undefined;
      const sourceId =
        incoming.sourceId ?? sourceRef?.sessionId ?? sourceRef?.id;

      const event: XStateEvent = {
        type: "@xstate.event",
        sessionId: resolvedSessionId,
        rootId: incoming.rootId,
        sourceId,
        event: incoming.event,
        createdAt,
      };
      return event;
    }
  }
}
