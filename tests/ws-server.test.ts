import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { ActorStore } from "../src/actor-store.js";
import { Logger } from "../src/logger.js";
import { createWsServer } from "../src/ws-server.js";

const TEST_PORT = 17357;

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("WebSocket Server", () => {
  const logger = new Logger("error");
  let store: ActorStore;
  let wss: ReturnType<typeof createWsServer>;

  afterEach(async () => {
    if (wss) {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });

  it("accepts connections and processes @xstate.actor events", async () => {
    store = new ActorStore(100, logger);
    wss = createWsServer({ port: TEST_PORT, store, logger });
    await wait(100);

    const client = new WebSocket(`ws://localhost:${TEST_PORT}`);
    await waitForOpen(client);

    client.send(
      JSON.stringify({
        type: "@xstate.actor",
        sessionId: "x:0:agents",
        rootId: "x:0",
        parentId: "x:0",
        name: "agentsMachine",
        definition: { id: "agents", initial: "idle", states: { idle: {} } },
        snapshot: { status: "active", value: "idle", context: {} },
        createdAt: "2026-02-28T12:00:00.000Z",
        id: "evt-1",
        _version: 1,
      }),
    );

    await wait(50);

    const actor = store.getActor("x:0:agents");
    expect(actor).toBeDefined();
    expect(actor!.name).toBe("agentsMachine");
    expect(actor!.currentSnapshot!.value).toBe("idle");

    client.close();
  });

  it("processes @xstate.snapshot events", async () => {
    store = new ActorStore(100, logger);
    wss = createWsServer({ port: TEST_PORT + 1, store, logger });
    await wait(100);

    const client = new WebSocket(`ws://localhost:${TEST_PORT + 1}`);
    await waitForOpen(client);

    // Register actor first
    client.send(
      JSON.stringify({
        type: "@xstate.actor",
        sessionId: "x:0:test",
        rootId: "x:0",
        name: "test",
        snapshot: { status: "active", value: "idle", context: {} },
        createdAt: "2026-02-28T12:00:00.000Z",
        id: "evt-1",
        _version: 1,
      }),
    );

    await wait(50);

    // Send snapshot update
    client.send(
      JSON.stringify({
        type: "@xstate.snapshot",
        sessionId: "x:0:test",
        rootId: "x:0",
        snapshot: {
          status: "active",
          value: "loading",
          context: { items: [1, 2, 3] },
        },
        event: { type: "LOAD" },
        createdAt: "2026-02-28T12:00:01.000Z",
        id: "evt-2",
        _version: 1,
      }),
    );

    await wait(50);

    const actor = store.getActor("x:0:test");
    expect(actor!.currentSnapshot!.value).toBe("loading");
    expect(actor!.currentSnapshot!.context).toEqual({ items: [1, 2, 3] });

    client.close();
  });

  it("processes @xstate.event events into history", async () => {
    store = new ActorStore(100, logger);
    wss = createWsServer({ port: TEST_PORT + 2, store, logger });
    await wait(100);

    const client = new WebSocket(`ws://localhost:${TEST_PORT + 2}`);
    await waitForOpen(client);

    // Register actor
    client.send(
      JSON.stringify({
        type: "@xstate.actor",
        sessionId: "x:0:test",
        rootId: "x:0",
        name: "test",
        snapshot: { status: "active", value: "idle", context: {} },
        createdAt: "2026-02-28T12:00:00.000Z",
        id: "evt-1",
        _version: 1,
      }),
    );

    await wait(50);

    // Send events
    client.send(
      JSON.stringify({
        type: "@xstate.event",
        sessionId: "x:0:test",
        rootId: "x:0",
        sourceId: "x:0",
        event: { type: "sys.refresh" },
        createdAt: "2026-02-28T12:00:01.000Z",
        id: "evt-2",
        _version: 1,
      }),
    );

    await wait(50);

    const actor = store.getActor("x:0:test");
    const events = actor!.eventHistory.toArray();
    expect(events).toHaveLength(1);
    expect(events[0].event).toEqual({ type: "sys.refresh" });

    client.close();
  });

  it("handles malformed JSON without crashing", async () => {
    store = new ActorStore(100, logger);
    wss = createWsServer({ port: TEST_PORT + 3, store, logger });
    await wait(100);

    const client = new WebSocket(`ws://localhost:${TEST_PORT + 3}`);
    await waitForOpen(client);

    client.send("not json at all");
    await wait(50);

    // Server should still be running
    expect(store.size).toBe(0);

    // Should still accept valid events after bad ones
    client.send(
      JSON.stringify({
        type: "@xstate.actor",
        sessionId: "x:0:test",
        rootId: "x:0",
        name: "test",
        snapshot: { status: "active", value: "idle", context: {} },
        createdAt: "2026-02-28T12:00:00.000Z",
        id: "evt-1",
        _version: 1,
      }),
    );

    await wait(50);
    expect(store.size).toBe(1);

    client.close();
  });

  // --- Native XState 5 format tests (actorRef/sourceRef objects) ---

  it("processes native @xstate.actor events with actorRef", async () => {
    store = new ActorStore(100, logger);
    wss = createWsServer({ port: TEST_PORT + 5, store, logger });
    await wait(100);

    const client = new WebSocket(`ws://localhost:${TEST_PORT + 5}`);
    await waitForOpen(client);

    // Native XState 5 format — actorRef object, no sessionId/createdAt/id/_version
    client.send(
      JSON.stringify({
        type: "@xstate.actor",
        actorRef: { sessionId: "x:0:agents", id: "agentsMachine" },
        rootId: "x:0",
      }),
    );

    await wait(50);

    const actor = store.getActor("x:0:agents");
    expect(actor).toBeDefined();
    expect(actor!.sessionId).toBe("x:0:agents");
    expect(actor!.name).toBe("agentsMachine");
    expect(actor!.createdAt).toBeDefined();

    client.close();
  });

  it("processes native @xstate.snapshot events with actorRef", async () => {
    store = new ActorStore(100, logger);
    wss = createWsServer({ port: TEST_PORT + 6, store, logger });
    await wait(100);

    const client = new WebSocket(`ws://localhost:${TEST_PORT + 6}`);
    await waitForOpen(client);

    // Register actor first (native format)
    client.send(
      JSON.stringify({
        type: "@xstate.actor",
        actorRef: { sessionId: "x:0:test" },
        rootId: "x:0",
        snapshot: { status: "active", value: "idle", context: {} },
      }),
    );

    await wait(50);

    // Snapshot update (native format)
    client.send(
      JSON.stringify({
        type: "@xstate.snapshot",
        actorRef: { sessionId: "x:0:test" },
        rootId: "x:0",
        snapshot: {
          status: "active",
          value: "loading",
          context: { items: [1, 2] },
        },
        event: { type: "LOAD" },
      }),
    );

    await wait(50);

    const actor = store.getActor("x:0:test");
    expect(actor!.currentSnapshot!.value).toBe("loading");
    expect(actor!.currentSnapshot!.context).toEqual({ items: [1, 2] });

    client.close();
  });

  it("processes native @xstate.event events with actorRef/sourceRef", async () => {
    store = new ActorStore(100, logger);
    wss = createWsServer({ port: TEST_PORT + 7, store, logger });
    await wait(100);

    const client = new WebSocket(`ws://localhost:${TEST_PORT + 7}`);
    await waitForOpen(client);

    // Register actor (native format)
    client.send(
      JSON.stringify({
        type: "@xstate.actor",
        actorRef: { sessionId: "x:0:test" },
        rootId: "x:0",
        snapshot: { status: "active", value: "idle", context: {} },
      }),
    );

    await wait(50);

    // Event (native format with sourceRef)
    client.send(
      JSON.stringify({
        type: "@xstate.event",
        actorRef: { sessionId: "x:0:test" },
        sourceRef: { sessionId: "x:0" },
        rootId: "x:0",
        event: { type: "sys.refresh" },
      }),
    );

    await wait(50);

    const actor = store.getActor("x:0:test");
    const events = actor!.eventHistory.toArray();
    expect(events).toHaveLength(1);
    expect(events[0].event).toEqual({ type: "sys.refresh" });
    expect(events[0].sourceId).toBe("x:0");

    client.close();
  });

  it("processes real XState 5 native format with actorRef.id (no sessionId)", async () => {
    store = new ActorStore(100, logger);
    wss = createWsServer({ port: TEST_PORT + 8, store, logger });
    await wait(100);

    const client = new WebSocket(`ws://localhost:${TEST_PORT + 8}`);
    await waitForOpen(client);

    // Real XState 5 serialization: { xstate$$type: 1, id: "x:5" }
    client.send(
      JSON.stringify({
        type: "@xstate.actor",
        actorRef: { xstate$$type: 1, id: "x:5" },
        rootId: "x:0",
        snapshot: { status: "active", value: "idle", context: {} },
      }),
    );

    await wait(50);

    const actor = store.getActor("x:5");
    expect(actor).toBeDefined();
    expect(actor!.sessionId).toBe("x:5");

    // Send event with sourceRef using id
    client.send(
      JSON.stringify({
        type: "@xstate.event",
        actorRef: { xstate$$type: 1, id: "x:5" },
        sourceRef: { xstate$$type: 1, id: "x:0" },
        event: { type: "NAVIGATE" },
      }),
    );

    await wait(50);

    const events = actor!.eventHistory.toArray();
    expect(events).toHaveLength(1);
    expect(events[0].event).toEqual({ type: "NAVIGATE" });
    expect(events[0].sourceId).toBe("x:0");

    client.close();
  });

  it("skips @xstate.microstep events", async () => {
    store = new ActorStore(100, logger);
    wss = createWsServer({ port: TEST_PORT + 4, store, logger });
    await wait(100);

    const client = new WebSocket(`ws://localhost:${TEST_PORT + 4}`);
    await waitForOpen(client);

    client.send(
      JSON.stringify({
        type: "@xstate.microstep",
        sessionId: "x:0:test",
        createdAt: "2026-02-28T12:00:00.000Z",
        id: "evt-1",
        _version: 1,
      }),
    );

    await wait(50);
    expect(store.size).toBe(0);

    client.close();
  });
});
