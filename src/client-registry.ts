import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type { ActorStore } from "./actor-store.js";
import type { Logger } from "./logger.js";

interface PendingRequest {
  resolve: (result: SendEventResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface SendEventResult {
  success: boolean;
  error?: string;
}

export class ClientRegistry {
  /** sessionId → WebSocket that owns this actor */
  private sessionToClient = new Map<string, WebSocket>();
  /** WebSocket → set of sessionIds it owns */
  private clientToSessions = new Map<WebSocket, Set<string>>();
  /** requestId → pending resolve + timeout */
  private pending = new Map<string, PendingRequest>();
  /** requestId → sessionId for matching pending requests to sessions on disconnect */
  private requestToSession = new Map<string, string>();

  constructor(
    private timeoutMs: number,
    private logger: Logger,
  ) {}

  /**
   * Register that a WebSocket client owns a given actor sessionId.
   * Called when we receive an @xstate.actor event from a client.
   */
  registerSession(ws: WebSocket, sessionId: string): void {
    this.sessionToClient.set(sessionId, ws);
    if (!this.clientToSessions.has(ws)) {
      this.clientToSessions.set(ws, new Set());
    }
    this.clientToSessions.get(ws)!.add(sessionId);
  }

  /**
   * Remove all sessions associated with a disconnected client.
   * Rejects pending sendEvent promises and optionally removes actors from the store.
   */
  removeClient(ws: WebSocket, store?: ActorStore): void {
    const sessions = this.clientToSessions.get(ws);
    if (sessions) {
      // Reject pending requests for sessions owned by this client
      for (const [requestId, sessionId] of this.requestToSession) {
        if (sessions.has(sessionId)) {
          const pending = this.pending.get(requestId);
          if (pending) {
            clearTimeout(pending.timer);
            this.pending.delete(requestId);
            this.requestToSession.delete(requestId);
            pending.resolve({
              success: false,
              error: "Client disconnected",
            });
          }
        }
      }

      for (const sessionId of sessions) {
        this.sessionToClient.delete(sessionId);
        if (store) {
          store.removeActor(sessionId);
        }
      }
      this.clientToSessions.delete(ws);
    }
  }

  /**
   * Send an event to an actor via its owning WebSocket client.
   * Returns a promise that resolves when the client responds or times out.
   */
  sendEvent(
    sessionId: string,
    event: Record<string, unknown>,
  ): Promise<SendEventResult> {
    const ws = this.sessionToClient.get(sessionId);
    if (!ws) {
      return Promise.resolve({
        success: false,
        error: `No connected client owns actor ${sessionId}`,
      });
    }

    if (ws.readyState !== ws.OPEN) {
      return Promise.resolve({
        success: false,
        error: `Client connection is not open (state: ${ws.readyState})`,
      });
    }

    const requestId = randomUUID();

    return new Promise<SendEventResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        this.requestToSession.delete(requestId);
        resolve({
          success: false,
          error: `Timeout waiting for response (${this.timeoutMs}ms)`,
        });
      }, this.timeoutMs);

      this.pending.set(requestId, { resolve, timer });
      this.requestToSession.set(requestId, sessionId);

      const message = JSON.stringify({
        type: "xstate-mcp.send",
        requestId,
        sessionId,
        event,
      });

      ws.send(message, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(requestId);
          this.requestToSession.delete(requestId);
          resolve({ success: false, error: `Failed to send: ${err.message}` });
        }
      });

      this.logger.debug(
        `Sent event to actor ${sessionId} (request: ${requestId})`,
      );
    });
  }

  /**
   * Handle a response from a client for a pending send_event request.
   */
  handleResponse(requestId: string, success: boolean, error?: string): void {
    const pending = this.pending.get(requestId);
    if (!pending) {
      this.logger.warn(`Received response for unknown request: ${requestId}`);
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    this.requestToSession.delete(requestId);
    pending.resolve({ success, error });
  }

  /**
   * Find the sessionId of an actor by its name.
   * Returns the first match, or undefined if not found.
   */
  getConnectedSessionCount(): number {
    return this.sessionToClient.size;
  }

  getConnectedClientCount(): number {
    return this.clientToSessions.size;
  }
}
