import { once } from "node:events";
import { createServer, connect } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { WebSocket } from "ws";
import { createActor, createMachine } from "xstate";
import {
  createInspectionServer,
  createSandboxServer,
  createMcpServer,
  ActorStore,
  ClientRegistry,
  Logger,
} from "../src/index.js";

function fakeTransport(): Transport {
  const transport: Transport = {
    start: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
    close: vi.fn(async () => {
      transport.onclose?.();
    }),
  };
  return transport;
}
async function assertReusable(port: number) {
  const listener = createServer();
  listener.listen(port, "127.0.0.1");
  await once(listener, "listening");
  await new Promise<void>((resolve) => listener.close(() => resolve()));
}
async function setup() {
  const bridge = createInspectionServer({ wsPort: 0, logLevel: "error" });
  const client = new Client({ name: "embedded-lifecycle-test", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  onTestFinished(async () => {
    await bridge.close();
    await client.close();
  });
  await Promise.all([bridge.start(st), client.connect(ct)]);
  const address = bridge.address;
  if (!address || typeof address === "string")
    throw new Error("Missing address");
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}`);
  await once(ws, "open");
  onTestFinished(() => ws.terminate());
  return {
    bridge,
    client,
    ws,
    port: address.port,
    transport: st,
    async flush() {
      const pong = once(ws, "pong");
      ws.ping();
      await pong;
    },
  };
}

describe("importable inspection server lifecycle", () => {
  it("scans capabilities with no inspection listener and disposes a terminal instance", async () => {
    const server = createSandboxServer();
    const client = new Client({ name: "scanner", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    expect((await client.listTools()).tools).toHaveLength(9);
    expect((await client.listPrompts()).prompts).toHaveLength(3);
    expect((await client.listResources()).resources).toHaveLength(1);
    await client.close();
    await server.close();
    await expect(server.connect(fakeTransport())).rejects.toThrow("closed");
  });

  it("closes an idle factory idempotently without opening the transport", async () => {
    const bridge = createInspectionServer({ wsPort: 0, logLevel: "error" });
    expect(bridge.address).toBeNull();
    const first = bridge.close();
    expect(bridge.close()).toBe(first);
    expect(bridge.closed).toBe(first);
    await first;
    const transport = fakeTransport();
    await expect(bridge.start(transport)).rejects.toThrow("closed");
    expect(transport.start).not.toHaveBeenCalled();
    expect(
      await bridge.clientRegistry.sendEvent("unknown", { type: "RUN" }),
    ).toMatchObject({ success: false, error: "Server shutting down" });
  });

  it.each(["explicit", "transport", "mcp"] as const)(
    "releases real actors, callbacks, pending sends, and the port on %s close",
    async (trigger) => {
      const { bridge, client, ws, port, flush, transport } = await setup();
      let actions = 0;
      const actor = createActor(
        createMachine({
          initial: "idle",
          states: {
            idle: {
              on: { RUN: { target: "running", actions: () => actions++ } },
            },
            running: {},
          },
        }),
        {
          inspect: (event) =>
            ws.send(
              JSON.stringify({ ...event, sessionId: event.actorRef.sessionId }),
            ),
        },
      );
      actor.start();
      await flush();
      const discovery = await client.callTool({
        name: "list_actors",
        arguments: {},
      });
      const [{ sessionId }] = (
        discovery.structuredContent as { actors: { sessionId: string }[] }
      ).actors;
      ws.once("message", (raw) => {
        const command = JSON.parse(raw.toString());
        expect(command.sessionId).toBe(actor.sessionId);
        actor.send(command.event);
        ws.send(
          JSON.stringify({
            type: "xstate-mcp.send.response",
            requestId: command.requestId,
            success: true,
          }),
        );
      });
      await client.callTool({
        name: "send_event",
        arguments: { target: sessionId, event: { type: "RUN" } },
      });
      const state = await client.callTool({
        name: "get_actor_state",
        arguments: { sessionId },
      });
      expect((state.structuredContent as { value: unknown }).value).toBe(
        "running",
      );
      expect(actions).toBe(1);
      const received = once(ws, "message");
      const pending = bridge.clientRegistry.sendEvent(sessionId, {
        type: "HELD",
      });
      await received;
      const wsClosed = once(ws, "close");
      if (trigger === "explicit") {
        const first = bridge.close();
        expect(bridge.close()).toBe(first);
        await first;
      } else if (trigger === "transport") await client.close();
      else await bridge.mcpServer.close();
      await bridge.closed;
      expect(await pending).toMatchObject({
        success: false,
        error: "Server shutting down",
      });
      expect((await wsClosed)[0]).toBe(1001);
      expect(bridge.store.size).toBe(0);
      expect(bridge.clientRegistry.getConnectedSessionCount()).toBe(0);
      expect(bridge.clientRegistry.getConnectedClientCount()).toBe(0);
      expect(transport.onmessage).toBeUndefined();
      expect(transport.onclose).toBeUndefined();
      await assertReusable(port);
    },
  );

  it("rejects duplicate starts without taking ownership of the extra transport", async () => {
    const bridge = createInspectionServer({ wsPort: 0, logLevel: "error" });
    onTestFinished(() => bridge.close());
    const first = bridge.start(fakeTransport());
    const extra = fakeTransport();
    await expect(bridge.start(extra)).rejects.toThrow("already started");
    await first;
    expect(extra.start).not.toHaveBeenCalled();
    expect(extra.close).not.toHaveBeenCalled();
  });

  it("rolls back a failed transport start and releases its listening port", async () => {
    const bridge = createInspectionServer({ wsPort: 0, logLevel: "error" });
    const transport = fakeTransport();
    let port = 0;
    transport.start = vi.fn(async () => {
      const address = bridge.address;
      if (!address || typeof address === "string")
        throw new Error("Not listening");
      port = address.port;
      throw new Error("Transport start failed");
    });
    await expect(bridge.start(transport)).rejects.toThrow(
      "Transport start failed",
    );
    expect(transport.close).toHaveBeenCalledOnce();
    await bridge.closed;
    await assertReusable(port);
  });

  it("cancels startup while a transport start is pending and stays closed after late completion", async () => {
    const bridge = createInspectionServer({ wsPort: 0, logLevel: "error" });
    const transport = fakeTransport();
    let finishStart!: () => void, entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    transport.start = vi.fn(() => {
      entered();
      return new Promise<void>((resolve) => {
        finishStart = resolve;
      });
    });
    const starting = bridge.start(transport);
    const failed = expect(starting).rejects.toThrow("closed during startup");
    await started;
    const address = bridge.address;
    if (!address || typeof address === "string")
      throw new Error("Missing address");
    await bridge.close();
    await failed;
    finishStart();
    await Promise.resolve();
    expect(bridge.mcpServer.isConnected()).toBe(false);
    await assertReusable(address.port);
  });

  it("cancels a pending listen before connecting MCP", async () => {
    const bridge = createInspectionServer({
      wsPort: 0,
      wsHost: "localhost",
      logLevel: "error",
    });
    const transport = fakeTransport();
    const starting = bridge.start(transport);
    const failed = expect(starting).rejects.toThrow("closed during startup");
    await bridge.close();
    await failed;
    expect(transport.start).not.toHaveBeenCalled();
    expect(bridge.address).toBeNull();
  });

  it("bounds a transport that never finishes closing and releases SDK callbacks", async () => {
    const bridge = createInspectionServer({
      wsPort: 0,
      logLevel: "error",
      shutdownTimeoutMs: 60,
    });
    const transport = fakeTransport();
    transport.close = vi.fn(() => new Promise<void>(() => {}));
    await bridge.start(transport);
    const address = bridge.address;
    if (!address || typeof address === "string")
      throw new Error("Missing address");
    const began = performance.now();
    await expect(bridge.close()).rejects.toThrow("Shutdown exceeded 60ms");
    expect(performance.now() - began).toBeLessThan(500);
    expect(bridge.mcpServer.isConnected()).toBe(false);
    expect(transport.onclose).toBeUndefined();
    expect(transport.onmessage).toBeUndefined();
    await assertReusable(address.port);
  });

  it("force-closes idle HTTP connections as well as WebSockets", async () => {
    const { bridge, port } = await setup();
    const socket = connect(port, "127.0.0.1");
    await once(socket, "connect");
    onTestFinished(() => {
      socket.destroy();
    });
    socket.write("GET / HTTP/1.1\r\nHost: localhost\r\n"); // incomplete HTTP request
    socket.on("error", (error: NodeJS.ErrnoException) =>
      expect(error.code).toBe("ECONNRESET"),
    );
    const socketClosed = new Promise<void>((resolve) =>
      socket.once("close", () => resolve()),
    );
    await bridge.close();
    await socketClosed;
    await assertReusable(port);
  });

  it.each([NaN, Infinity, -1, 0, 0.5, 30001])(
    "rejects invalid shutdown budgets: %s",
    (shutdownTimeoutMs) => {
      expect(() => createInspectionServer({ shutdownTimeoutMs })).toThrow(
        "shutdownTimeoutMs",
      );
    },
  );

  it("detaches MCP-owned store callbacks on explicit close and transport closure", async () => {
    const logger = new Logger("error");
    const store = new ActorStore(10, logger);
    const observers = new Set<unknown>();
    for (const name of [
      "onActorRegistered",
      "onActorRemoved",
      "onSnapshotUpdated",
    ] as const) {
      const original = store[name].bind(store);
      vi.spyOn(store, name).mockImplementation((callback) => {
        const registration = { callback };
        observers.add(registration);
        const remove = original(callback);
        return () => {
          remove();
          observers.delete(registration);
        };
      });
    }
    const onCleared = store.onCleared.bind(store);
    vi.spyOn(store, "onCleared").mockImplementation((callback) => {
      const registration = { callback };
      observers.add(registration);
      const remove = onCleared(callback);
      return () => {
        remove();
        observers.delete(registration);
      };
    });
    for (const trigger of [
      "explicit",
      "transport",
      "before-connect",
    ] as const) {
      const server = createMcpServer(
        store,
        new ClientRegistry(5000, logger),
        logger,
      );
      expect(observers.size).toBe(4);
      if (trigger === "before-connect") await server.close();
      else {
        const [ct, st] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: "cleanup-test", version: "1" });
        await Promise.all([server.connect(st), client.connect(ct)]);
        if (trigger === "transport") await client.close();
        else await server.close();
        await client.close();
      }
      expect(observers.size).toBe(0);
      store.registerActor({
        type: "@xstate.actor",
        sessionId: "after-close",
        createdAt: new Date().toISOString(),
      });
      store.updateSnapshot({
        type: "@xstate.snapshot",
        sessionId: "after-close",
        snapshot: { value: "idle" },
        createdAt: new Date().toISOString(),
      });
      store.clear();
    }
  });
});

it("disposes owned callbacks and routes even when transport.close rejects", async () => {
  const bridge = createInspectionServer({ wsPort: 0, logLevel: "error" });
  const transport = fakeTransport();
  transport.close = vi.fn(async () => {
    throw new Error("Close failed");
  });
  await bridge.start(transport);
  const address = bridge.address;
  if (!address || typeof address === "string")
    throw new Error("Missing address");
  await expect(bridge.close()).rejects.toThrow("Close failed");
  expect(bridge.mcpServer.isConnected()).toBe(false);
  expect(transport.onmessage).toBeUndefined();
  expect(bridge.store.size).toBe(0);
  expect(bridge.clientRegistry.getConnectedSessionCount()).toBe(0);
  await assertReusable(address.port);
});

it("lets separate registrations of the same callback be disposed independently", () => {
  const store = new ActorStore(10, new Logger("error"));
  const callback = vi.fn();
  const removeFirst = store.onCleared(callback);
  const removeSecond = store.onCleared(callback);
  removeFirst();
  removeFirst();
  store.clear();
  expect(callback).toHaveBeenCalledOnce();
  removeSecond();
  store.clear();
  expect(callback).toHaveBeenCalledOnce();
});
