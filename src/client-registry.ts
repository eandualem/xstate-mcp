import { createWritePolicy, type WritePolicyOptions } from "./inspection-policy.js";
import { ConnectionHealth } from "./connection-health.js";
import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type { ActorStore } from "./actor-store.js";
import type { Logger } from "./logger.js";

export interface SessionIdentity {
  sessionId: string;
  localSessionId: string;
  connectionId: string;
  applicationName: string | null;
}

interface Connection {
  connectionId: string;
  applicationName: string | null;
}
interface Session extends SessionIdentity {
  client: WebSocket;
}
interface PendingRequest {
  session: Session;
  resolve: (result: SendEventResult) => void;
  timer: ReturnType<typeof setTimeout>;
}
export interface SendEventResult {
  success: boolean;
  error?: string;
  code?: string;
}

export class ClientRegistry {
  private connections = new WeakMap<WebSocket, Connection>();
  private sessions = new Map<string, Session>();
  private clientToSessions = new Map<WebSocket, Set<string>>();
  private pending = new Map<string, PendingRequest>();
  private closed = false;

  private checkWrite: ReturnType<typeof createWritePolicy>;

  readonly health: ConnectionHealth;

  constructor(
    private timeoutMs: number,
    private logger: Logger,
    options: { health?: ConnectionHealth; writePolicy?: WritePolicyOptions } = {},
  ) {
    this.health = options.health ?? new ConnectionHealth();
    this.checkWrite = createWritePolicy(options.writePolicy);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** A connection's namespace is server-assigned; labels never confer ownership. */
  registerClient(ws: WebSocket, applicationName?: string): void {
    if (this.closed) throw new Error("Client registry is closed");
    if (this.connections.has(ws)) return;
    this.connections.set(ws, {
      connectionId: this.health.connect(ws),
      applicationName: applicationName?.trim().slice(0, 128) || null,
    });
  }

  /** Scope even unregistered references so they cannot link into another app. */
  getSessionId(ws: WebSocket, localSessionId: string): string {
    this.registerClient(ws);
    const { connectionId } = this.connections.get(ws)!;
    // UTF-16 preserves every JS string, including otherwise-colliding lone surrogates.
    const encoded = Buffer.from(localSessionId, "utf16le").toString(
      "base64url",
    );
    return `${connectionId}.${encoded}`;
  }

  /** Repeated registration on one socket is idempotent; ownership never migrates. */
  registerSession(ws: WebSocket, localSessionId: string): SessionIdentity {
    const sessionId = this.getSessionId(ws, localSessionId);
    const existing = this.sessions.get(sessionId);
    if (existing) return this.identity(existing);
    const session: Session = {
      ...this.connections.get(ws)!,
      sessionId,
      localSessionId,
      client: ws,
    };
    this.sessions.set(sessionId, session);
    if (!this.clientToSessions.has(ws))
      this.clientToSessions.set(ws, new Set());
    this.clientToSessions.get(ws)!.add(sessionId);
    return this.identity(session);
  }

  getSession(
    ws: WebSocket,
    localSessionId: string,
  ): SessionIdentity | undefined {
    if (this.closed) return undefined;
    const session = this.sessions.get(this.getSessionId(ws, localSessionId));
    return session?.client === ws ? this.identity(session) : undefined;
  }

  private identity({
    sessionId,
    localSessionId,
    connectionId,
    applicationName,
  }: Session): SessionIdentity {
    return { sessionId, localSessionId, connectionId, applicationName };
  }

  removeClient(ws: WebSocket, store?: ActorStore): void {
    this.health.disconnect(ws);
    // Match the original socket, independently of current actor mappings.
    for (const [requestId, pending] of this.pending) {
      if (pending.session.client === ws) {
        this.settle(requestId, {
          success: false,
          error: "Client disconnected",
        });
      }
    }
    for (const sessionId of this.clientToSessions.get(ws) ?? []) {
      const session = this.sessions.get(sessionId);
      if (session?.client !== ws) continue;
      this.sessions.delete(sessionId);
      if (store?.getActor(sessionId)?.connectionId === session.connectionId) {
        store.removeActor(sessionId, "disconnected");
      }
    }
    this.clientToSessions.delete(ws);
    this.connections.delete(ws);
  }

  sendEvent(
    sessionId: string,
    event: Record<string, unknown>,
  ): Promise<SendEventResult> {
    if (this.closed)
      return Promise.resolve({ success: false, error: "Server shutting down" });
    const policy = this.checkWrite(sessionId, event.type);
    if (!policy.success) return Promise.resolve(policy);
    const session = this.sessions.get(sessionId);
    if (!session)
      return Promise.resolve({
        success: false,
        error: `No connected client owns actor ${sessionId}`,
      });
    const ws = session.client;
    if (ws.readyState !== ws.OPEN)
      return Promise.resolve({
        success: false,
        error: `Client connection is not open (state: ${ws.readyState})`,
      });
    const blocked = this.health.writeBlock(ws);
    if (blocked) {
      this.health.count(ws, "unsupportedCommands");
      return Promise.resolve({ success: false, ...blocked });
    }
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.health.count(ws, "commandTimeouts");
        this.settle(requestId, {
          success: false,
          error: `Timeout waiting for response (${this.timeoutMs}ms)`,
        });
      }, this.timeoutMs);
      this.pending.set(requestId, { session, resolve, timer });
      // Applications continue to receive their original, local XState session ID.
      const message = JSON.stringify({
        type: "xstate-mcp.send",
        requestId,
        sessionId: session.localSessionId,
        event,
      });
      ws.send(message, (err) => {
        if (err)
          this.settle(requestId, {
            success: false,
            error: "Failed to send event",
          });
      });
      this.logger.debug(
        `Sent event to actor ${sessionId} (request: ${requestId})`,
      );
    });
  }

  handleResponse(
    ws: WebSocket,
    requestId: string,
    success: boolean,
    error?: string,
  ): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) {
      this.logger.warn("Received response for unknown request, skipping");
      return false;
    }
    if (
      pending.session.client !== ws ||
      this.sessions.get(pending.session.sessionId) !== pending.session
    ) {
      this.logger.warn("Rejected response from non-owning connection");
      return false;
    }
    this.settle(requestId, { success, error: success ? undefined : error === undefined ? "Application rejected event" : "Application rejected event (details withheld)" });
    return true;
  }

  private settle(requestId: string, result: SendEventResult): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(result);
  }

  /** Permanently reject new registrations/commands and settle pending requests. */
  close(): void {
    this.closed = true;
    this.clear("Server shutting down");
  }

  /** Clear routes and requests without reopening a closed registry. */
  clear(error = "Registry cleared"): void {
    for (const requestId of this.pending.keys()) {
      this.settle(requestId, { success: false, error });
    }
    this.sessions.clear();
    this.clientToSessions.clear();
    // Live sockets keep their connection identity, but must register actors again.
  }

  getHealth(limit?: number, connectionId?: string, offset?: number) {
    return this.health.snapshot(
      (ws) => this.clientToSessions.get(ws)?.size ?? 0,
      limit,
      connectionId,
      offset,
    );
  }

  getConnectedSessionCount(): number {
    return this.sessions.size;
  }
  getConnectedClientCount(): number {
    return this.health.size;
  }
}
