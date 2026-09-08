import { applicationHello } from "./fixtures/application-hello.js";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { WebSocket } from "ws";
import { ClientRegistry } from "../src/client-registry.js";
import { ActorStore } from "../src/actor-store.js";
import { Logger } from "../src/logger.js";

function makeMockWs(readyState = 1) {
  const send = vi.fn((_msg: string, cb?: (err?: Error) => void) => cb?.());
  return { readyState, OPEN: 1, send } as unknown as WebSocket & {
    send: typeof send;
  };
}
const logger = new Logger("error");
describe("ClientRegistry", () => {
  let registry: ClientRegistry;
  let store: ActorStore;
  beforeEach(() => {
    vi.useFakeTimers();
    registry = new ClientRegistry(1000, logger, {
      writePolicy: {
        readOnly: false,
        allow: [{ actor: "*", events: ["TEST", "OTHER", "RUN"] }],
      },
    });
    store = new ActorStore(20, logger);
  });
  afterEach(() => {
    registry.clear();
    vi.useRealTimers();
  });
  function register(ws: WebSocket, localSessionId = "x:0") {
    registry.health.negotiate(ws, applicationHello());
    const identity = registry.registerSession(ws, localSessionId);
    store.registerActor({
      type: "@xstate.actor",
      ...identity,
      createdAt: new Date().toISOString(),
    });
    return identity;
  }
  function command(ws: ReturnType<typeof makeMockWs>, index = 0) {
    return JSON.parse(ws.send.mock.calls[index][0]) as {
      requestId: string;
      sessionId: string;
      type: string;
      event: unknown;
    };
  }

  it("isolates equal local IDs and removes only the disconnected client's actors", () => {
    const a = makeMockWs(),
      b = makeMockWs();
    const a0 = register(a),
      a1 = register(a, "x:1"),
      b0 = register(b);
    expect(a0.sessionId).not.toBe(b0.sessionId);
    expect(a0.connectionId).toBe(a1.connectionId);
    expect(a0.connectionId).not.toBe(b0.connectionId);
    expect(registry.getConnectedSessionCount()).toBe(3);
    expect(registry.getConnectedClientCount()).toBe(2);
    registry.removeClient(a, store);
    expect(store.listActors().map((a) => a.sessionId)).toEqual([b0.sessionId]);
    expect(registry.getConnectedSessionCount()).toBe(1);
    expect(registry.getConnectedClientCount()).toBe(1);
    registry.removeClient(a, store);
    expect(store.size).toBe(1);
  });

  it("keeps repeated registration idempotent and bounds descriptive labels", () => {
    const ws = makeMockWs();
    registry.registerClient(ws, ` ${"A".repeat(200)} `);
    const identity = register(ws);
    registry.registerClient(ws, "changed");
    expect(registry.registerSession(ws, "x:0")).toEqual(identity);
    expect(identity.applicationName).toBe("A".repeat(128));
    expect(registry.getConnectedSessionCount()).toBe(1);
    expect(registry.getConnectedClientCount()).toBe(1);
  });

  it("keeps all JavaScript local IDs distinct and safe inside a resource URI", () => {
    const ws = makeMockWs();
    const ids = ["x:0", "x/0?#%", "", "😀", "\ud800", "\ud801", "�"];
    const scoped = ids.map((id) => registry.registerSession(ws, id).sessionId);
    expect(new Set(scoped).size).toBe(ids.length);
    for (const id of scoped) expect(id).toMatch(/^[a-zA-Z0-9_.-]+$/);
    expect(registry.getSession(ws, "missing")).toBeUndefined();
    expect(registry.getSession(makeMockWs(), "x:0")).toBeUndefined();
  });

  it("never deletes a store record belonging to a different connection", () => {
    const ws = makeMockWs();
    const identity = register(ws);
    store.registerActor({
      type: "@xstate.actor",
      ...identity,
      connectionId: "different",
      createdAt: new Date().toISOString(),
    });
    registry.removeClient(ws, store);
    expect(store.getActor(identity.sessionId)?.connectionId).toBe("different");
  });

  it("rejects unknown or raw local targets", async () => {
    register(makeMockWs());
    for (const id of ["unknown", "x:0"]) {
      expect(await registry.sendEvent(id, { type: "TEST" })).toMatchObject({
        success: false,
        error: expect.stringContaining("No connected client"),
      });
    }
  });

  it("pairs public actor IDs and events while retaining local wire targets and socket ownership", async () => {
    const a = makeMockWs(),
      b = makeMockWs();
    const first = registry.getSessionId(a, "x:0");
    const second = registry.getSessionId(b, "x:0");
    registry = new ClientRegistry(1000, logger, {
      health: registry.health,
      writePolicy: {
        readOnly: false,
        allow: [
          { actor: first, events: ["RUN"] },
          { actor: second, events: ["RESET"] },
        ],
      },
    });
    expect(register(a).sessionId).toBe(first);
    expect(register(b).sessionId).toBe(second);
    expect(first).not.toBe(second);
    for (const [actor, type] of [
      [first, "RESET"],
      [second, "RUN"],
      ["x:0", "RUN"],
    ]) {
      expect(await registry.sendEvent(actor, { type })).toMatchObject({
        success: false,
        code: "write_not_allowed",
      });
    }
    expect(a.send).not.toHaveBeenCalled();
    expect(b.send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    const pending = registry.sendEvent(first, { type: "RUN" });
    const sent = command(a);
    expect(sent.sessionId).toBe("x:0");
    expect(
      registry.handleResponse(
        b,
        sent.requestId,
        false,
        "private foreign detail",
        "read_only",
      ),
    ).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    expect(registry.handleResponse(a, sent.requestId, true)).toBe(true);
    expect(await pending).toMatchObject({ success: true });
    const other = registry.sendEvent(second, { type: "RESET" });
    expect(command(b).sessionId).toBe("x:0");
    registry.handleResponse(b, command(b).requestId, true);
    expect(await other).toMatchObject({ success: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects sends on a closed connection", async () => {
    const { sessionId } = register(makeMockWs(3));
    expect(await registry.sendEvent(sessionId, { type: "TEST" })).toMatchObject(
      { success: false, error: expect.stringContaining("not open") },
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("routes local IDs to the owner and ignores wrong-socket responses without consuming requests", async () => {
    const a = makeMockWs(),
      b = makeMockWs();
    const { sessionId } = register(a);
    register(b);
    let settled = false;
    const result = registry.sendEvent(sessionId, { type: "TEST" }).then((r) => {
      settled = true;
      return r;
    });
    const sent = command(a);
    expect(sent).toMatchObject({
      type: "xstate-mcp.send",
      sessionId: "x:0",
      event: { type: "TEST" },
    });
    expect(b.send).not.toHaveBeenCalled();
    registry.handleResponse(b, sent.requestId, true);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    registry.handleResponse(
      a,
      sent.requestId,
      false,
      "Application rejected event",
    );
    expect(await result).toEqual({
      success: false,
      error: "Application rejected event (details withheld)",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resolves success once and ignores duplicate or unknown responses", async () => {
    const ws = makeMockWs();
    const { sessionId } = register(ws);
    const promise = registry.sendEvent(sessionId, { type: "TEST" });
    registry.handleResponse(ws, "unknown", false);
    registry.handleResponse(ws, command(ws).requestId, true);
    registry.handleResponse(ws, command(ws).requestId, false);
    expect(await promise).toEqual({ success: true, error: undefined });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up send failures", async () => {
    const ws = makeMockWs();
    ws.send.mockImplementation((_msg, cb) =>
      cb?.(new Error("Connection reset")),
    );
    const { sessionId } = register(ws);
    expect(await registry.sendEvent(sessionId, { type: "TEST" })).toEqual({
      success: false,
      error: "Failed to send event",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out requests and ignores late responses", async () => {
    const ws = makeMockWs();
    const { sessionId } = register(ws);
    const promise = registry.sendEvent(sessionId, { type: "TEST" });
    await vi.advanceTimersByTimeAsync(1000);
    registry.handleResponse(ws, command(ws).requestId, true);
    expect(await promise).toMatchObject({
      success: false,
      error: expect.stringContaining("Timeout"),
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("binds pending requests to original sockets across overlapping reconnects", async () => {
    const old = makeMockWs(),
      next = makeMockWs();
    const oldId = register(old).sessionId;
    const oldResult = registry.sendEvent(oldId, { type: "TEST" });
    const newId = register(next).sessionId;
    const newResult = registry.sendEvent(newId, { type: "TEST" });
    registry.removeClient(old, store);
    expect(await oldResult).toMatchObject({
      success: false,
      error: "Client disconnected",
    });
    expect(store.getActor(newId)).toBeDefined();
    expect(vi.getTimerCount()).toBe(1);
    registry.handleResponse(old, command(next).requestId, true);
    registry.handleResponse(next, command(old).requestId, true);
    expect(vi.getTimerCount()).toBe(1);
    registry.handleResponse(next, command(next).requestId, true);
    expect(await newResult).toMatchObject({ success: true });
  });

  it("clears pending requests and prevents stale ACKs settling re-registered actors", async () => {
    const ws = makeMockWs();
    const identity = register(ws);
    const first = registry.sendEvent(identity.sessionId, { type: "TEST" });
    registry.clear();
    expect(await first).toEqual({ success: false, error: "Registry cleared" });
    expect(registry.getConnectedClientCount()).toBe(1);
    expect(registry.getConnectedSessionCount()).toBe(0);
    expect(registry.getSession(ws, "x:0")).toBeUndefined();
    expect(register(ws)).toEqual(identity);
    const second = registry.sendEvent(identity.sessionId, { type: "TEST" });
    registry.handleResponse(ws, command(ws).requestId, true);
    expect(vi.getTimerCount()).toBe(1);
    registry.handleResponse(ws, command(ws, 1).requestId, true);
    expect(await second).toMatchObject({ success: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps scoped registration and commands terminal after close and clear", async () => {
    const ws = makeMockWs();
    const { sessionId } = register(ws);
    const pending = registry.sendEvent(sessionId, { type: "TEST" });
    registry.close();
    registry.close();
    registry.clear();
    expect(await pending).toEqual({
      success: false,
      error: "Server shutting down",
    });
    expect(() => registry.registerClient(ws)).toThrow(
      "Client registry is closed",
    );
    expect(() => registry.registerSession(ws, "x:0")).toThrow(
      "Client registry is closed",
    );
    expect(registry.getSession(ws, "x:0")).toBeUndefined();
    expect(await registry.sendEvent(sessionId, { type: "LATE" })).toEqual({
      success: false,
      error: "Server shutting down",
    });
    expect(ws.send).toHaveBeenCalledOnce();
    expect(registry.getConnectedClientCount()).toBe(1);
    expect(registry.getConnectedSessionCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([
    "read_only",
    "invalid_event",
    "write_not_allowed",
    "instrumentation_disabled",
    "invalid_command",
    "actor_not_found",
    "dispatch_failed",
  ])("preserves the adapter rejection code %s", async (code) => {
    const ws = makeMockWs();
    const { sessionId } = register(ws);
    const promise = registry.sendEvent(sessionId, { type: "TEST" });
    const message = JSON.parse(ws.send.mock.calls[0][0]);
    registry.handleResponse(
      ws,
      message.requestId,
      false,
      "private detail",
      code,
    );
    expect(await promise).toEqual({
      success: false,
      code,
      error: "Application rejected event (details withheld)",
    });
  });

  it.each(["private-code", { token: "private-code" }, 42, null])(
    "withholds unrecognized or malformed adapter codes: %j",
    async (code) => {
      const ws = makeMockWs();
      const { sessionId } = register(ws);
      const promise = registry.sendEvent(sessionId, { type: "TEST" });
      const message = JSON.parse(ws.send.mock.calls[0][0]);
      registry.handleResponse(ws, message.requestId, false, undefined, code);
      const result = await promise;
      expect(result.code).toBeUndefined();
      expect(result.error).toBe("Application rejected event");
      expect(JSON.stringify(result)).not.toContain("private-code");
    },
  );

  it("does not attach a rejection code to a successful acknowledgement", async () => {
    const ws = makeMockWs();
    const { sessionId } = register(ws);
    const promise = registry.sendEvent(sessionId, { type: "TEST" });
    const message = JSON.parse(ws.send.mock.calls[0][0]);
    registry.handleResponse(
      ws,
      message.requestId,
      true,
      "private detail",
      "read_only",
    );
    expect(await promise).toEqual({ success: true });
  });
});
