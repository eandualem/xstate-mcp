import { WebSocketServer, type WebSocket } from "ws";
import {
  inspectionEventSchema,
  type IncomingEvent,
  type ActorEvent,
  type SnapshotEvent,
  type XStateEvent,
  type InspectionEvent,
} from "./types.js";
import type { ActorStore } from "./actor-store.js";
import type { Logger } from "./logger.js";

export interface WsServerOptions {
  port: number;
  store: ActorStore;
  logger: Logger;
}

export function createWsServer(options: WsServerOptions): WebSocketServer {
  const { port, store, logger } = options;

  const wss = new WebSocketServer({ port });

  wss.on("listening", () => {
    logger.info(`WebSocket server listening on port ${port}`);
  });

  wss.on("connection", (ws: WebSocket) => {
    logger.info("Client connected");

    ws.on("message", (data: Buffer | string) => {
      handleMessage(data.toString(), store, logger);
    });

    ws.on("close", () => {
      logger.info("Client disconnected");
    });

    ws.on("error", (err: Error) => {
      logger.error(`WebSocket error: ${err.message}`);
    });
  });

  wss.on("error", (err: Error) => {
    logger.error(`WebSocket server error: ${err.message}`);
  });

  return wss;
}

function handleMessage(raw: string, store: ActorStore, logger: Logger): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.warn("Received non-JSON message, skipping");
    return;
  }

  // Skip microstep events
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "type" in parsed &&
    (parsed as Record<string, unknown>).type === "@xstate.microstep"
  ) {
    logger.debug("Skipping @xstate.microstep event");
    return;
  }

  const result = inspectionEventSchema.safeParse(parsed);
  if (!result.success) {
    logger.warn("Invalid inspection event", {
      errors: result.error.issues.map((i) => i.message),
    });
    return;
  }

  const event = normalizeEvent(result.data, logger);
  if (!event) return;

  switch (event.type) {
    case "@xstate.actor":
      store.registerActor(event);
      break;
    case "@xstate.snapshot":
      store.updateSnapshot(event);
      break;
    case "@xstate.event":
      store.addEvent(event);
      break;
  }
}

/**
 * Normalize incoming events from either native XState 5 format (actorRef/sourceRef)
 * or @statelyai/inspect serialized format (sessionId/sourceId) into our internal types.
 */
export function normalizeEvent(
  incoming: IncomingEvent,
  logger: Logger,
): InspectionEvent | null {
  const now = new Date().toISOString();

  // Extract sessionId: prefer top-level sessionId, fall back to actorRef.sessionId or actorRef.id
  // Native XState 5 serializes actorRef as { xstate$$type: 1, id: "x:5" } — no sessionId field
  const actorRef = (incoming as Record<string, unknown>).actorRef as
    | { sessionId?: string; id?: string }
    | undefined;
  const resolvedSessionId =
    incoming.sessionId ?? actorRef?.sessionId ?? actorRef?.id;

  if (!resolvedSessionId) {
    logger.warn(
      "Event missing sessionId, actorRef.sessionId, and actorRef.id, skipping",
    );
    return null;
  }

  const createdAt = incoming.createdAt ?? now;

  switch (incoming.type) {
    case "@xstate.actor": {
      // In native format, actorRef may contain id/name info
      const name =
        incoming.name ??
        ((actorRef as Record<string, unknown> | undefined)?.id as
          | string
          | undefined);

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
        | { sessionId?: string; id?: string }
        | undefined;
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
