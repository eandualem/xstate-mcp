import { describe, it, expect, beforeEach, vi } from "vitest";
import { ActorStore } from "../../src/actor-store.js";
import { ClientRegistry } from "../../src/client-registry.js";
import { Logger } from "../../src/logger.js";
import { sendEvent } from "../../src/tools/send-event.js";
import type { ActorEvent } from "../../src/types.js";

const logger = new Logger("error");

function makeActorEvent(overrides: Partial<ActorEvent> = {}): ActorEvent {
  return {
    type: "@xstate.actor",
    sessionId: "x:0",
    rootId: "x:0",
    name: "app",
    snapshot: { status: "active", value: "idle", context: {} },
    createdAt: "2026-02-28T12:00:00.000Z",
    ...overrides,
  };
}

function makeMockWs() {
  return {
    readyState: 1,
    OPEN: 1,
    send: vi.fn((_msg: string, cb?: (err?: Error) => void) => {
      if (cb) cb();
    }),
  };
}

describe("send_event tool", () => {
  let store: ActorStore;
  let registry: ClientRegistry;

  beforeEach(() => {
    store = new ActorStore(100, logger);
    registry = new ClientRegistry(1000, logger);
  });

  it("returns error when actor not found by sessionId or name", async () => {
    const result = await sendEvent(store, registry, "nonexistent", {
      type: "TEST",
    });
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toContain("nonexistent");
  });

  it("resolves target by sessionId", async () => {
    const ws = makeMockWs();
    const identity = registry.registerSession(ws as never, "x:0");
    store.registerActor(makeActorEvent(identity));

    const promise = sendEvent(store, registry, identity.sessionId, {
      type: "SUBMIT",
    });

    // Resolve the pending request
    const sentMsg = JSON.parse(ws.send.mock.calls[0][0] as string);
    registry.handleResponse(ws as never, sentMsg.requestId, true);

    const result = await promise;
    const data = JSON.parse(result.content[0].text);
    expect(data.success).toBe(true);
    expect(data.sessionId).toBe(identity.sessionId);
    expect(data.event).toEqual({ type: "SUBMIT" });
  });

  it("resolves target by actor name when sessionId not found", async () => {
    const ws = makeMockWs();
    const identity = registry.registerSession(ws as never, "x:99");
    store.registerActor(makeActorEvent({ ...identity, name: "appMachine" }));

    const promise = sendEvent(store, registry, "appMachine", { type: "LOAD" });

    const sentMsg = JSON.parse(ws.send.mock.calls[0][0] as string);
    expect(sentMsg.sessionId).toBe("x:99");
    registry.handleResponse(ws as never, sentMsg.requestId, true);

    const result = await promise;
    const data = JSON.parse(result.content[0].text);
    expect(data.success).toBe(true);
    expect(data.sessionId).toBe(identity.sessionId);
  });

  it("returns error when multiple actors match by name", async () => {
    store.registerActor(
      makeActorEvent({ sessionId: "x:1", name: "agentsMachine" }),
    );
    store.registerActor(
      makeActorEvent({ sessionId: "x:2", name: "agentsMachine" }),
    );

    const result = await sendEvent(store, registry, "agentsMachine", {
      type: "TEST",
    });
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toContain("Ambiguous");
    expect(data.matches).toHaveLength(2);
    expect(data.suggestion).toContain("sessionId");
  });

  it("returns error when client is disconnected", async () => {
    store.registerActor(makeActorEvent());
    // No ws registered — no client owns this actor

    const result = await sendEvent(store, registry, "x:0", { type: "TEST" });
    const data = JSON.parse(result.content[0].text);
    expect(data.success).toBe(false);
    expect(data.error).toContain("No connected client");
  });
});
