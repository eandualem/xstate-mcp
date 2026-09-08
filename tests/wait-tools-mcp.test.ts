import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { WebSocket } from "ws";
import { assign, createActor, createMachine, fromPromise } from "xstate-compat";
import { ActorStore } from "../src/actor-store.js";
import { ActorWaits } from "../src/actor-waits.js";
import { ClientRegistry } from "../src/client-registry.js";
import { Logger } from "../src/logger.js";
import { createMcpServer } from "../src/mcp-server.js";
import { createWsServer } from "../src/ws-server.js";
import { nativeInspectionForwarder } from "./fixtures/native-inspection.js";

async function setup() {
  const logger = new Logger("error");
  const store = new ActorStore(10, logger);
  const observers = new Set<unknown>();
  const subscribe = store.subscribe.bind(store);
  vi.spyOn(store, "subscribe").mockImplementation((cb) => {
    observers.add(cb);
    const unsubscribe = subscribe(cb);
    return () => {
      observers.delete(cb);
      unsubscribe();
    };
  });
  const registry = new ClientRegistry(1000, logger);
  const server = createMcpServer(store, registry, logger);
  const client = new Client({ name: "wait-test", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  onTestFinished(async () => {
    await client.close();
    await server.close();
  });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  const tools = await client.listTools();
  const wss = createWsServer({
    port: 0,
    store,
    clientRegistry: registry,
    logger,
  });
  await once(wss, "listening");
  onTestFinished(async () => {
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });
  const address = wss.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}`);
  await once(ws, "open");
  onTestFinished(async () => {
    if (ws.readyState === WebSocket.CLOSED) return;
    const closed = once(ws, "close");
    ws.terminate();
    await closed;
  });
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as { type: string; text: string }[];
    expect(result.structuredContent).toEqual(JSON.parse(content[0].text));
    return result.structuredContent as Record<string, unknown>;
  };
  async function discover(localSessionId: string) {
    const result = await call("list_actors", {});
    const actors = result.actors as {
      sessionId: string;
      localSessionId: string;
    }[];
    const actor = actors.find(
      (candidate) => candidate.localSessionId === localSessionId,
    );
    if (!actor) throw new Error(`Actor ${localSessionId} was not discovered`);
    expect(actor.sessionId).not.toBe(localSessionId);
    return actor.sessionId;
  }
  return {
    discover,
    client,
    server,
    serverTransport,
    logger,
    store,
    ws,
    tools,
    observers,
    call,
    async flush() {
      const pong = once(ws, "pong");
      ws.ping();
      await pong;
    },
  };
}

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("MCP verification waits with real XState actors", () => {
  it("contains failed resource-list notifications and keeps MCP requests usable", async () => {
    const { call, ws, flush, serverTransport, logger, discover } =
      await setup();
    const debug = vi.spyOn(logger, "debug");
    const send = serverTransport.send.bind(serverTransport);
    const delivery = vi
      .spyOn(serverTransport, "send")
      .mockImplementation(async (message, options) => {
        if (
          "method" in message &&
          message.method === "notifications/resources/list_changed"
        ) {
          throw new Error("Transport closed during notification delivery");
        }
        await send(message, options);
      });
    onTestFinished(() => {
      debug.mockRestore();
      delivery.mockRestore();
    });
    const actor = createActor(
      createMachine({ initial: "idle", states: { idle: {} } }),
      {
        inspect: (event) =>
          ws.send(
            JSON.stringify({ ...event, sessionId: event.actorRef.sessionId }),
          ),
      },
    );
    onTestFinished(() => {
      if (ws.readyState === WebSocket.OPEN) actor.stop();
    });
    actor.start();
    await flush();

    const sessionId = await discover(actor.sessionId);
    expect(debug).toHaveBeenCalledWith(
      "Resource-list notification could not be delivered",
    );
    expect(
      await call("wait_for_state", {
        sessionId,
        state: "idle",
        timeoutMs: 0,
      }),
    ).toMatchObject({ outcome: "matched", snapshot: { value: "idle" } });
  });

  it("releases observers when closed before connecting a transport", async () => {
    const logger = new Logger("error");
    const store = new ActorStore(10, logger);
    const subscribe = store.subscribe.bind(store);
    const disposers: ReturnType<typeof vi.fn>[] = [];
    vi.spyOn(store, "subscribe").mockImplementation((cb) => {
      const dispose = vi.fn(subscribe(cb));
      disposers.push(dispose);
      return dispose;
    });
    const server = createMcpServer(
      store,
      new ClientRegistry(1000, logger),
      logger,
    );
    await server.close();
    expect(disposers).toHaveLength(1);
    for (const dispose of disposers) expect(dispose).toHaveBeenCalledOnce();
  });

  it.each(["success", "failure"] as const)(
    "verifies asynchronous load → %s without replaying actions",
    async (outcome) => {
      const { call, client, ws, tools, flush, discover } = await setup();
      const work = deferred();
      const guard = vi.fn(() => true);
      const completed = vi.fn();
      const commands: unknown[] = [];
      const machine = createMachine({
        context: { result: null as unknown },
        initial: "idle",
        output: ({ context }) => context.result,
        states: {
          idle: { on: { LOAD: { target: "loading", guard } } },
          loading: {
            invoke: {
              id: "loader",
              src: fromPromise(() => work.promise),
              onDone: {
                target: "success",
                actions: assign({ result: ({ event }) => event.output }),
              },
              onError: { target: "failure" },
            },
          },
          success: { type: "final", entry: completed },
          failure: { type: "final", entry: completed },
        },
      });
      const actor = createActor(machine, {
        // Preserve native session IDs and Error properties for lifecycle diagnostics.
        inspect: nativeInspectionForwarder(ws).inspect,
      });
      onTestFinished(() => {
        if (ws.readyState === WebSocket.OPEN) actor.stop();
      });
      ws.on("message", (raw) => {
        const command = JSON.parse(raw.toString());
        commands.push(command);
        actor.send(command.event);
        ws.send(
          JSON.stringify({
            type: "xstate-mcp.send.response",
            requestId: command.requestId,
            success: true,
          }),
        );
      });
      actor.start();
      await flush();
      const sessionId = await discover(actor.sessionId);
      const baseline = await call("get_actor_state", {
        sessionId,
      });
      const resource = await client.readResource({
        uri: `xstate://actor/${sessionId}/snapshot`,
      });
      const resourceContent = resource.contents[0];
      if (!("text" in resourceContent))
        throw new Error("Expected text resource");
      expect(JSON.parse(resourceContent.text)).toEqual(baseline);
      expect(baseline).toMatchObject({
        sessionId,
        localSessionId: actor.sessionId,
        connectionId: expect.any(String),
        output: null,
        error: null,
      });
      const history = await call("get_event_history", {
        sessionId,
      });
      expect(history.cursor).toEqual(baseline.cursor);
      for (const name of ["wait_for_state", "wait_for_event"]) {
        expect(
          tools.tools.find((tool) => tool.name === name)?.annotations
            ?.readOnlyHint,
        ).toBe(true);
      }

      await call("send_event", {
        target: sessionId,
        event: { type: "LOAD" },
      });
      const loadEvent = await call("wait_for_event", {
        sessionId,
        eventType: "LOAD",
        after: baseline.cursor,
      });
      expect(loadEvent).toMatchObject({
        outcome: "matched",
        event: { event: { type: "LOAD" } },
      });
      const loading = await call("wait_for_state", {
        sessionId,
        state: "loading",
        after: baseline.cursor,
      });
      expect(loading.outcome).toBe("matched");
      const child = actor.getSnapshot().children.loader!;
      const childSessionId = await discover(child.sessionId);
      const childBaseline = await call("get_actor_state", {
        sessionId: childSessionId,
      });
      const childStatus = outcome === "success" ? "done" : "error";
      const childWait = call("wait_for_state", {
        sessionId: childSessionId,
        status: childStatus,
        after: childBaseline.cursor,
      });
      const stateWait = call("wait_for_state", {
        sessionId,
        state: outcome,
        status: "done",
        after: loading.cursor,
      });
      const eventWait = call("wait_for_event", {
        sessionId,
        eventType:
          outcome === "success"
            ? "xstate.done.actor.loader"
            : "xstate.error.actor.loader",
        after: loading.cursor,
      });
      if (outcome === "success") work.resolve({ answer: 42 });
      else work.reject(new Error("load failed"));
      const [stateResult, eventResult, childResult] = await Promise.all([
        stateWait,
        eventWait,
        childWait,
      ]);
      expect(childResult).toMatchObject({
        outcome: "matched",
        snapshot: { status: childStatus, value: null },
      });
      if (outcome === "failure") {
        expect(childResult.snapshot).toMatchObject({
          error: { name: "Error", message: "load failed" },
        });
        expect(
          tools.tools.find((tool) => tool.name === "wait_for_state")
            ?.outputSchema,
        ).toMatchObject({
          properties: {
            snapshot: {
              properties: {
                error: { properties: { message: { type: "string" } } },
              },
            },
          },
        });
      }
      expect(stateResult).toMatchObject({
        outcome: "matched",
        snapshot: { status: "done", value: outcome },
      });
      if (outcome === "success")
        expect(stateResult.snapshot).toMatchObject({ output: { answer: 42 } });
      expect(eventResult.outcome).toBe("matched");
      expect(stateResult.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(
        Date.parse(String(stateResult.completedAt)),
      ).toBeGreaterThanOrEqual(Date.parse(String(stateResult.startedAt)));
      expect(commands).toHaveLength(1);
      expect(guard).toHaveBeenCalledOnce();
      expect(completed).toHaveBeenCalledOnce();
    },
  );

  it("returns a structured disconnect result when the actor's socket closes", async () => {
    const { client, call, ws, flush, discover } = await setup();
    ws.send(
      JSON.stringify({
        type: "@xstate.actor",
        sessionId: "actor",
        snapshot: { status: "active", value: "idle" },
      }),
    );
    await flush();
    const spy = vi.spyOn(ActorWaits.prototype, "waitForState");
    onTestFinished(() => {
      spy.mockRestore();
    });
    const sessionId = await discover("actor");
    const pending = call("wait_for_state", {
      sessionId,
      state: "ready",
    });
    await expect.poll(() => spy.mock.calls.length).toBe(1);
    const closed = once(ws, "close");
    ws.close();
    await closed;
    expect(await pending).toMatchObject({ outcome: "disconnected" });
    expect((await client.listTools()).tools).toHaveLength(11);
  });

  it("cleans up an MCP cancellation and keeps subsequent requests usable", async () => {
    const { client, store, call } = await setup();
    store.registerActor({
      type: "@xstate.actor",
      sessionId: "actor",
      createdAt: new Date().toISOString(),
    });
    const spy = vi.spyOn(ActorWaits.prototype, "waitForEvent");
    onTestFinished(() => {
      spy.mockRestore();
    });
    const controller = new AbortController();
    const pending = client.callTool(
      {
        name: "wait_for_event",
        arguments: { sessionId: "actor", eventType: "READY" },
      },
      undefined,
      { signal: controller.signal },
    );
    const cancelled = expect(pending).rejects.toThrow("cancel test");
    await expect.poll(() => spy.mock.calls.length).toBe(1);
    const waits = spy.mock.contexts[0] as ActorWaits;
    expect(waits.pendingCount).toBe(1);
    controller.abort(new Error("cancel test"));
    await cancelled;
    const internal = await spy.mock.results[0].value;
    expect(internal.structuredContent).toMatchObject({ outcome: "cancelled" });
    expect(waits.pendingCount).toBe(0);
    expect(
      await call("wait_for_event", {
        sessionId: "actor",
        eventType: "READY",
        timeoutMs: 0,
      }),
    ).toMatchObject({ outcome: "timeout" });
  });

  it("settles clear and releases all store observers on explicit server shutdown", async () => {
    const { store, call, server, observers } = await setup();
    store.registerActor({
      type: "@xstate.actor",
      sessionId: "actor",
      createdAt: new Date().toISOString(),
    });
    const spy = vi.spyOn(ActorWaits.prototype, "waitForEvent");
    onTestFinished(() => {
      spy.mockRestore();
    });
    const pending = call("wait_for_event", {
      sessionId: "actor",
      eventType: "READY",
    });
    await expect.poll(() => spy.mock.calls.length).toBe(1);
    await call("clear_actors", {});
    expect(await pending).toMatchObject({ outcome: "cleared" });
    expect(observers.size).toBe(1);
    await server.close();
    expect(observers.size).toBe(0);
    // Changes after MCP shutdown must not leave rejected notification promises.
    store.registerActor({
      type: "@xstate.actor",
      sessionId: "after-close",
      createdAt: new Date().toISOString(),
    });
  });

  it.each(["client", "server"] as const)(
    "cleans up pending waits when the %s closes the transport",
    async (side) => {
      const { store, client, server, observers } = await setup();
      store.registerActor({
        type: "@xstate.actor",
        sessionId: "actor",
        createdAt: new Date().toISOString(),
      });
      const spy = vi.spyOn(ActorWaits.prototype, "waitForEvent");
      onTestFinished(() => {
        spy.mockRestore();
      });
      const pending = client.callTool({
        name: "wait_for_event",
        arguments: { sessionId: "actor", eventType: "READY" },
      });
      const closed = expect(pending).rejects.toThrow();
      await expect.poll(() => spy.mock.calls.length).toBe(1);
      const waits = spy.mock.contexts[0] as ActorWaits;
      if (side === "client") await client.close();
      else await server.close();
      await closed;
      expect((await spy.mock.results[0].value).structuredContent.outcome).toBe(
        side === "client" ? "cancelled" : "shutdown",
      );
      expect(waits.pendingCount).toBe(0);
      expect(observers.size).toBe(0);
    },
  );

  it("rejects out-of-range timeouts through MCP input validation", async () => {
    const { client } = await setup();
    const result = await client.callTool({
      name: "wait_for_state",
      arguments: { sessionId: "actor", status: "done", timeoutMs: 30001 },
    });
    expect(result.isError).toBe(true);
  });
});
