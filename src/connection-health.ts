import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { WebSocket } from "ws";
import { z } from "zod";

export const APPLICATION_PROTOCOL_VERSION = 1;
export const HEARTBEAT_INTERVAL_MS = 15_000;
export const STALE_AFTER_MS = 45_000;
export const MAX_HEALTH_CONNECTIONS = 50;
export const COUNTER_MAX = 2_147_483_647;

const label = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[\w .@/-]+$/);
export const applicationHelloSchema = z.object({
  type: z.literal("xstate-mcp.hello"),
  protocolVersion: z.number().int().min(1).max(65535),
  application: z.object({ name: label }),
  adapter: z.object({
    name: label,
    version: z
      .string()
      .min(1)
      .max(32)
      .regex(/^[\w.+-]+$/),
  }),
  capabilities: z.object({
    commands: z
      .array(
        z
          .string()
          .min(1)
          .max(32)
          .regex(/^[\w.-]+$/),
      )
      .max(8),
  }),
});
export type ApplicationHello = z.infer<typeof applicationHelloSchema>;

const rejectionSchema = z.enum([
  "invalid_json",
  "invalid_envelope",
  "invalid_inspection",
  "missing_session_id",
  "actor_not_registered",
  "invalid_ack",
  "unexpected_ack",
  "invalid_hello",
  "incompatible_protocol",
  "capabilities_locked",
  "transport_error",
]);
type Rejection = z.infer<typeof rejectionSchema>;
const counterSchema = z.number().int().min(0).max(COUNTER_MAX);
const countersSchema = z.object({
  receivedFrames: counterSchema,
  acceptedInspectionFrames: counterSchema,
  rejectedFrames: counterSchema,
  ignoredFrames: counterSchema,
  transportErrors: counterSchema,
  unsupportedCommands: counterSchema,
  commandTimeouts: counterSchema,
});
type Counters = z.infer<typeof countersSchema>;
const counters = (): Counters => ({
  receivedFrames: 0,
  acceptedInspectionFrames: 0,
  rejectedFrames: 0,
  ignoredFrames: 0,
  transportErrors: 0,
  unsupportedCommands: 0,
  commandTimeouts: 0,
});
const increment = (value: number) => Math.min(COUNTER_MAX, value + 1);
const timestamp = z.string().nullable();
const age = z.number().nonnegative().nullable();
const connectionSchema = z.object({
  connectionId: z.string(),
  application: applicationHelloSchema.shape.application.nullable(),
  adapter: applicationHelloSchema.shape.adapter.nullable(),
  negotiation: z.enum([
    "awaiting_hello",
    "negotiated",
    "invalid",
    "incompatible",
  ]),
  offeredProtocolVersion: z.number().nullable(),
  protocolVersion: z.number().nullable(),
  commands: z.array(z.literal("send_event")).max(1),
  actorCount: z.number().int().nonnegative(),
  connectedAt: z.string(),
  lastActivityAt: z.string(),
  lastInspectionAt: timestamp,
  activityAgeMs: z.number().nonnegative(),
  inspectionAgeMs: age,
  freshness: z.enum(["fresh", "stale"]),
  counters: countersSchema,
  lastRejection: rejectionSchema.nullable(),
  lastRejectedAt: timestamp,
});
export const connectionHealthOutputSchema = {
  sampledAt: z.string(),
  supportedProtocolVersions: z.array(z.literal(1)).length(1),
  heartbeatIntervalMs: z.literal(HEARTBEAT_INTERVAL_MS),
  staleAfterMs: z.literal(STALE_AFTER_MS),
  listener: z.object({
    state: z.enum(["not_started", "starting", "listening", "error", "closed"]),
    endpoint: z
      .object({ host: z.string(), port: z.number().int(), url: z.string() })
      .nullable(),
    errorCode: z
      .enum(["EADDRINUSE", "EACCES", "EADDRNOTAVAIL", "ENOTFOUND", "UNKNOWN"])
      .nullable(),
  }),
  totals: z.object({
    connectedClients: z.number().int().nonnegative(),
    clientsWithActors: z.number().int().nonnegative(),
    staleClients: z.number().int().nonnegative(),
    registeredSessions: z.number().int().nonnegative(),
    acceptedConnections: counterSchema,
    closedConnections: counterSchema,
    rejectedConnections: counterSchema,
    lastDisconnectedAt: timestamp,
  }),
  counters: countersSchema,
  connections: z.array(connectionSchema).max(MAX_HEALTH_CONNECTIONS),
  omittedConnections: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative().nullable(),
};
export const connectionHealthSchema = z.object(connectionHealthOutputSchema);
type Health = z.infer<typeof connectionHealthSchema>;

type Connection = {
  id: string;
  connectedAt: string;
  lastActivityAt: string;
  activityTime: number;
  lastInspectionAt: string | null;
  inspectionTime: number | null;
  hello: ApplicationHello | null;
  negotiation: "awaiting_hello" | "negotiated" | "invalid" | "incompatible";
  offeredProtocolVersion: number | null;
  counters: Counters;
  lastRejection: Rejection | null;
  lastRejectedAt: string | null;
};

/** Fixed-size facts per live socket; no payloads, URLs, headers or disconnected records. */
export class ConnectionHealth {
  private connections = new Map<WebSocket, Connection>();
  private totals = {
    acceptedConnections: 0,
    closedConnections: 0,
    rejectedConnections: 0,
    lastDisconnectedAt: null as string | null,
  };
  private counts = counters();
  private listener: Health["listener"] = {
    state: "not_started",
    endpoint: null,
    errorCode: null,
  };

  constructor(
    private clock: () => number = () => performance.now(),
    private wallClock: () => number = Date.now,
  ) {}
  private stamp(): string {
    return new Date(this.wallClock()).toISOString();
  }
  connect(ws: WebSocket, connectionId?: string): string {
    const existing = this.connections.get(ws);
    if (existing) return existing.id;
    const now = this.stamp();
    const connection: Connection = {
      id: connectionId ?? randomUUID(),
      connectedAt: now,
      lastActivityAt: now,
      activityTime: this.clock(),
      lastInspectionAt: null,
      inspectionTime: null,
      hello: null,
      negotiation: "awaiting_hello",
      offeredProtocolVersion: null,
      counters: counters(),
      lastRejection: null,
      lastRejectedAt: null,
    };
    this.connections.set(ws, connection);
    this.totals.acceptedConnections = increment(
      this.totals.acceptedConnections,
    );
    return connection.id;
  }
  disconnect(ws: WebSocket): void {
    if (!this.connections.delete(ws)) return;
    this.totals.closedConnections = increment(this.totals.closedConnections);
    this.totals.lastDisconnectedAt = this.stamp();
  }
  get size(): number {
    return this.connections.size;
  }
  setListener(
    state: Health["listener"]["state"],
    endpoint: Health["listener"]["endpoint"] = null,
    errorCode: Health["listener"]["errorCode"] = null,
  ): void {
    this.listener = { state, endpoint, errorCode };
  }
  rejectConnection(): void {
    this.totals.rejectedConnections = increment(
      this.totals.rejectedConnections,
    );
  }
  activity(ws: WebSocket): void {
    const c = this.connections.get(ws);
    if (c) {
      c.lastActivityAt = this.stamp();
      c.activityTime = this.clock();
    }
  }
  count(ws: WebSocket, key: keyof Counters): void {
    this.counts[key] = increment(this.counts[key]);
    const c = this.connections.get(ws);
    if (c) c.counters[key] = increment(c.counters[key]);
  }
  acceptedInspection(ws: WebSocket): void {
    this.count(ws, "acceptedInspectionFrames");
    const c = this.connections.get(ws);
    if (c) {
      c.lastInspectionAt = this.stamp();
      c.inspectionTime = this.clock();
    }
  }
  reject(ws: WebSocket, reason: Rejection): void {
    this.count(
      ws,
      reason === "transport_error" ? "transportErrors" : "rejectedFrames",
    );
    const c = this.connections.get(ws);
    if (c) {
      c.lastRejection = reason;
      c.lastRejectedAt = this.stamp();
    }
  }
  negotiate(ws: WebSocket, input: unknown) {
    this.connect(ws);
    const c = this.connections.get(ws)!;
    const parsed = applicationHelloSchema.safeParse(input);
    let code:
      "invalid_hello" | "incompatible_protocol" | "capabilities_locked" | null =
      null;
    if (!parsed.success) {
      code = "invalid_hello";
      if (!c.hello) c.negotiation = "invalid";
    } else if (
      c.hello &&
      JSON.stringify(parsed.data) !== JSON.stringify(c.hello)
    ) {
      code = "capabilities_locked";
    } else if (parsed.data.protocolVersion !== APPLICATION_PROTOCOL_VERSION) {
      code = "incompatible_protocol";
      c.negotiation = "incompatible";
      c.offeredProtocolVersion = parsed.data.protocolVersion;
    } else {
      c.hello = parsed.data;
      c.negotiation = "negotiated";
      c.offeredProtocolVersion = parsed.data.protocolVersion;
    }
    if (code) this.reject(ws, code);
    return {
      type: "xstate-mcp.hello.response",
      success: code === null,
      connectionId: c.id,
      supportedProtocolVersions: [APPLICATION_PROTOCOL_VERSION],
      protocolVersion: c.hello ? APPLICATION_PROTOCOL_VERSION : null,
      commands: this.commands(c),
      ...(code
        ? {
            code,
            error:
              code === "capabilities_locked"
                ? "Capabilities are fixed for this connection. Reconnect to change them."
                : "Send a valid xstate-mcp.hello with protocolVersion 1; see docs/connection-health.md.",
          }
        : {}),
    };
  }
  private commands(c: Connection): "send_event"[] {
    return c.hello?.capabilities.commands.includes("send_event")
      ? ["send_event"]
      : [];
  }
  canInspect(ws: WebSocket): boolean {
    const c = this.connections.get(ws);
    return (
      !!c && c.negotiation !== "incompatible" && c.negotiation !== "invalid"
    );
  }
  writeBlock(ws: WebSocket): {
    code: "capability_negotiation_required" | "unsupported_command";
    error: string;
  } | null {
    const c = this.connections.get(ws);
    if (!c?.hello)
      return {
        code: "capability_negotiation_required",
        error:
          "This connection has not negotiated send_event. Use an application adapter that sends xstate-mcp.hello with protocolVersion 1 and advertises send_event; see docs/connection-health.md.",
      };
    if (!this.commands(c).includes("send_event"))
      return {
        code: "unsupported_command",
        error:
          "This adapter is read-only: send_event is not supported. Enable command handling in the application adapter and reconnect advertising send_event; see docs/connection-health.md.",
      };
    return null;
  }
  snapshot(
    actorCount: (ws: WebSocket) => number,
    limit = MAX_HEALTH_CONNECTIONS,
    connectionId?: string,
    offset = 0,
  ): Health {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HEALTH_CONNECTIONS)
      throw new RangeError("limit must be an integer from 1 to 50");
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new RangeError("offset must be a nonnegative safe integer");
    const now = this.clock();
    const connections: Health["connections"] = [];
    let clientsWithActors = 0,
      staleClients = 0,
      registeredSessions = 0,
      matching = 0;
    for (const [ws, c] of this.connections) {
      const actors = actorCount(ws);
      const activityAgeMs = Math.max(0, now - c.activityTime);
      const stale = activityAgeMs >= STALE_AFTER_MS;
      if (actors) clientsWithActors++;
      if (stale) staleClients++;
      registeredSessions += actors;
      if (connectionId && c.id !== connectionId) continue;
      matching++;
      if (matching <= offset || connections.length >= limit) continue;
      connections.push({
        connectionId: c.id,
        application: c.hello ? { ...c.hello.application } : null,
        adapter: c.hello ? { ...c.hello.adapter } : null,
        negotiation: c.negotiation,
        offeredProtocolVersion: c.offeredProtocolVersion,
        protocolVersion: c.hello ? APPLICATION_PROTOCOL_VERSION : null,
        commands: this.commands(c),
        actorCount: actors,
        connectedAt: c.connectedAt,
        lastActivityAt: c.lastActivityAt,
        lastInspectionAt: c.lastInspectionAt,
        activityAgeMs,
        inspectionAgeMs:
          c.inspectionTime === null
            ? null
            : Math.max(0, now - c.inspectionTime),
        freshness: stale ? "stale" : "fresh",
        counters: { ...c.counters },
        lastRejection: c.lastRejection,
        lastRejectedAt: c.lastRejectedAt,
      });
    }
    return {
      sampledAt: this.stamp(),
      supportedProtocolVersions: [1],
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      staleAfterMs: STALE_AFTER_MS,
      listener: {
        ...this.listener,
        endpoint: this.listener.endpoint ? { ...this.listener.endpoint } : null,
      },
      totals: {
        connectedClients: this.size,
        clientsWithActors,
        staleClients,
        registeredSessions,
        ...this.totals,
      },
      counters: { ...this.counts },
      connections,
      omittedConnections: matching - connections.length,
      nextOffset:
        offset + connections.length < matching
          ? offset + connections.length
          : null,
    };
  }
}
