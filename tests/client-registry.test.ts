import { describe, it, expect, beforeEach, vi } from "vitest";
import { ClientRegistry } from "../src/client-registry.js";
import { ActorStore } from "../src/actor-store.js";
import { Logger } from "../src/logger.js";

const logger = new Logger("error");

/** Minimal mock WebSocket with the properties ClientRegistry uses */
function makeMockWs(readyState = 1 /* OPEN */): {
  readyState: number;
  OPEN: number;
  send: ReturnType<typeof vi.fn>;
} {
  return {
    readyState,
    OPEN: 1,
    send: vi.fn((_msg: string, cb?: (err?: Error) => void) => {
      if (cb) cb();
    }),
  };
}

describe("ClientRegistry", () => {
  let registry: ClientRegistry;

  beforeEach(() => {
    registry = new ClientRegistry(1000, logger);
  });

  describe("session tracking", () => {
    it("registers and tracks sessions per client", () => {
      const ws = makeMockWs();
      registry.registerSession(ws as never, "x:0");
      registry.registerSession(ws as never, "x:1");

      expect(registry.getConnectedSessionCount()).toBe(2);
      expect(registry.getConnectedClientCount()).toBe(1);
    });

    it("removes all sessions when client disconnects", () => {
      const ws = makeMockWs();
      registry.registerSession(ws as never, "x:0");
      registry.registerSession(ws as never, "x:1");

      registry.removeClient(ws as never);
      expect(registry.getConnectedSessionCount()).toBe(0);
      expect(registry.getConnectedClientCount()).toBe(0);
    });
  });

  describe("sendEvent", () => {
    it("returns error when no client owns the session", async () => {
      const result = await registry.sendEvent("unknown", { type: "TEST" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("No connected client");
    });

    it("returns error when client connection is not open", async () => {
      const ws = makeMockWs(3 /* CLOSED */);
      registry.registerSession(ws as never, "x:0");

      const result = await registry.sendEvent("x:0", { type: "TEST" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("not open");
    });

    it("sends message and resolves on response", async () => {
      const ws = makeMockWs();
      registry.registerSession(ws as never, "x:0");

      const promise = registry.sendEvent("x:0", { type: "TEST" });

      // Extract the requestId from the sent message
      expect(ws.send).toHaveBeenCalledOnce();
      const sentMsg = JSON.parse(ws.send.mock.calls[0][0] as string);
      expect(sentMsg.type).toBe("xstate-mcp.send");
      expect(sentMsg.sessionId).toBe("x:0");
      expect(sentMsg.event).toEqual({ type: "TEST" });

      // Simulate response from browser
      registry.handleResponse(sentMsg.requestId, true);

      const result = await promise;
      expect(result.success).toBe(true);
    });

    it("returns error on send failure", async () => {
      const ws = makeMockWs();
      ws.send = vi.fn((_msg: string, cb?: (err?: Error) => void) => {
        if (cb) cb(new Error("Connection reset"));
      });
      registry.registerSession(ws as never, "x:0");

      const result = await registry.sendEvent("x:0", { type: "TEST" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("Connection reset");
    });

    it("times out when no response arrives", async () => {
      vi.useFakeTimers();
      const shortRegistry = new ClientRegistry(100, logger);
      const ws = makeMockWs();
      shortRegistry.registerSession(ws as never, "x:0");

      const promise = shortRegistry.sendEvent("x:0", { type: "TEST" });

      vi.advanceTimersByTime(150);

      const result = await promise;
      expect(result.success).toBe(false);
      expect(result.error).toContain("Timeout");

      vi.useRealTimers();
    });
  });

  describe("disconnect behavior", () => {
    it("rejects pending promises when client disconnects", async () => {
      const ws = makeMockWs();
      registry.registerSession(ws as never, "x:0");

      const promise = registry.sendEvent("x:0", { type: "TEST" });

      // Disconnect before response arrives
      registry.removeClient(ws as never);

      const result = await promise;
      expect(result.success).toBe(false);
      expect(result.error).toBe("Client disconnected");
    });

    it("removes actors from store when store is provided", () => {
      const store = new ActorStore(100, logger);
      store.registerActor({
        type: "@xstate.actor",
        sessionId: "x:0",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      store.registerActor({
        type: "@xstate.actor",
        sessionId: "x:1",
        createdAt: "2026-01-01T00:00:00.000Z",
      });

      const ws = makeMockWs();
      registry.registerSession(ws as never, "x:0");
      registry.registerSession(ws as never, "x:1");

      registry.removeClient(ws as never, store);

      expect(store.size).toBe(0);
    });

    it("does not affect actors from other clients", () => {
      const store = new ActorStore(100, logger);
      store.registerActor({
        type: "@xstate.actor",
        sessionId: "x:0",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      store.registerActor({
        type: "@xstate.actor",
        sessionId: "x:1",
        createdAt: "2026-01-01T00:00:00.000Z",
      });

      const ws1 = makeMockWs();
      const ws2 = makeMockWs();
      registry.registerSession(ws1 as never, "x:0");
      registry.registerSession(ws2 as never, "x:1");

      registry.removeClient(ws1 as never, store);

      expect(store.size).toBe(1);
      expect(store.getActor("x:1")).toBeDefined();
    });
  });

  describe("handleResponse", () => {
    it("ignores responses for unknown request IDs", () => {
      // Should not throw
      registry.handleResponse("nonexistent", true);
    });

    it("forwards error from browser response", async () => {
      const ws = makeMockWs();
      registry.registerSession(ws as never, "x:0");

      const promise = registry.sendEvent("x:0", { type: "TEST" });

      const sentMsg = JSON.parse(ws.send.mock.calls[0][0] as string);
      registry.handleResponse(
        sentMsg.requestId,
        false,
        "Actor not found in browser",
      );

      const result = await promise;
      expect(result.success).toBe(false);
      expect(result.error).toBe("Actor not found in browser");
    });
  });
});
