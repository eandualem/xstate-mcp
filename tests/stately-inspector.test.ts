import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { expect, it, onTestFinished } from "vitest";
import { createActor } from "xstate";
import { createWebSocketInspector } from "@statelyai/inspect";
import WebSocket from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ActorStore } from "../src/actor-store.js";
import { ClientRegistry } from "../src/client-registry.js";
import { Logger } from "../src/logger.js";
import { createMcpServer } from "../src/mcp-server.js";
import { createWsServer } from "../src/ws-server.js";
import { statelyMachine } from "./fixtures/stately-machine.js";

const isoTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

it("exposes real Stately actors, hierarchy, definitions and events through MCP", async () => {
  const logger = new Logger("error");
  const store = new ActorStore(100, logger);
  const registry = new ClientRegistry(100, logger);
  const server = createMcpServer(store, registry, logger);
  const client = new Client({ name: "stately-contract-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  onTestFinished(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const wss = createWsServer({
    port: 0,
    store,
    clientRegistry: registry,
    logger,
  });
  const messages: Record<string, unknown>[] = [];
  wss.on("connection", (ws) => {
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
  });
  await once(wss, "listening");
  const port = (wss.address() as AddressInfo).port;
  const inspector = createWebSocketInspector({
    url: `ws://127.0.0.1:${port}`,
  });
  const actor = createActor(statelyMachine, {
    id: "app",
    inspect: inspector.inspect,
  });
  onTestFinished(async () => {
    actor.stop();
    inspector.stop();
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });
  actor.start();
  const worker = actor.getSnapshot().children.worker!;
  await expect
    .poll(() => store.getActor(worker.sessionId)?.currentSnapshot?.value, {
      timeout: 2000,
    })
    .toBe("idle");

  async function callTool(name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).not.toBe(true);
    return result.structuredContent;
  }

  expect(await callTool("list_actors")).toMatchObject({
    totalActors: 2,
    actors: expect.arrayContaining([
      {
        sessionId: actor.sessionId,
        name: "app",
        currentState: "running",
        status: "active",
        childCount: 1,
      },
      {
        sessionId: worker.sessionId,
        name: "worker",
        currentState: "idle",
        status: "active",
        childCount: 0,
      },
    ]),
  });
  expect(await callTool("get_actor_tree")).toMatchObject({
    totalActors: 2,
    tree: [
      {
        sessionId: actor.sessionId,
        children: [{ sessionId: worker.sessionId, children: [] }],
      },
    ],
  });
  expect(
    await callTool("get_machine_definition", {
      sessionId: actor.sessionId,
    }),
  ).toMatchObject({
    definition: {
      id: "inspectionFixture",
      states: { running: { invoke: { id: "worker", src: "worker" } } },
    },
  });
  expect(
    await callTool("get_machine_definition", {
      sessionId: worker.sessionId,
    }),
  ).toMatchObject({
    definition: {
      id: "workerMachine",
      states: { idle: { on: { PING: { target: "working" } } } },
    },
  });

  actor.send({ type: "PING" });
  await expect
    .poll(() => store.getActor(worker.sessionId)?.currentSnapshot?.value)
    .toBe("working");
  expect(
    await callTool("get_actor_state", {
      sessionId: worker.sessionId,
    }),
  ).toMatchObject({
    value: "working",
    context: { count: 1 },
    parentId: actor.sessionId,
    updatedAt: expect.stringMatching(isoTimestamp),
  });
  expect(
    await callTool("get_event_history", {
      sessionId: worker.sessionId,
    }),
  ).toMatchObject({
    events: expect.arrayContaining([
      {
        event: { type: "PING", message: "from parent" },
        sourceId: actor.sessionId,
        createdAt: expect.stringMatching(isoTimestamp),
      },
    ]),
  });
  expect(
    await callTool("get_state_timeline", {
      sessionId: worker.sessionId,
    }),
  ).toMatchObject({
    transitions: expect.arrayContaining([
      {
        fromValue: "idle",
        toValue: "working",
        event: "PING",
        timestamp: expect.stringMatching(isoTimestamp),
      },
    ]),
  });

  // Observe the wire without rewriting the producer's messages.
  for (const type of ["@xstate.actor", "@xstate.event", "@xstate.snapshot"]) {
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type,
          id: null,
          _version: "0.7.2",
          createdAt: expect.stringMatching(/^\d+$/),
        }),
      ]),
    );
  }
  for (const record of store.listActors()) {
    expect(record.createdAt).toMatch(isoTimestamp);
    expect(record.updatedAt).toMatch(isoTimestamp);
  }
});

it("rejects invalid wire timestamps before mutating an existing actor", async () => {
  const logger = new Logger("error");
  const store = new ActorStore(100, logger);
  const wss = createWsServer({ port: 0, store, logger });
  onTestFinished(async () => {
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });
  await once(wss, "listening");
  const ws = new WebSocket(
    `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`,
  );
  await once(ws, "open");
  onTestFinished(() => ws.terminate());

  // A pong acknowledges that all preceding frames on this socket were handled.
  async function flushMessages() {
    const pong = once(ws, "pong");
    ws.ping();
    await pong;
  }

  ws.send(
    JSON.stringify({
      type: "@xstate.actor",
      id: null,
      sessionId: "x:0",
      createdAt: "1788768000000",
      snapshot: { value: "idle", context: { count: 0 }, status: "active" },
    }),
  );
  await flushMessages();
  const registered = store.getActor("x:0");
  expect(registered?.createdAt).toBe("2026-09-07T08:00:00.000Z");

  for (const type of ["@xstate.actor", "@xstate.snapshot", "@xstate.event"]) {
    ws.send(
      JSON.stringify({
        type,
        id: null,
        sessionId: "x:0",
        createdAt: "invalid",
        snapshot: { value: "incorrect", context: { count: 99 } },
        event: { type: "INVALID" },
      }),
    );
  }
  await flushMessages();
  expect(store.getActor("x:0")).toBe(registered);
  expect(registered?.currentSnapshot).toMatchObject({
    value: "idle",
    context: { count: 0 },
  });
  expect(registered?.updatedAt).toBe("2026-09-07T08:00:00.000Z");
  expect(registered?.eventHistory.size).toBe(0);
  expect(registered?.transitionHistory.size).toBe(0);

  ws.send(
    JSON.stringify({
      type: "@xstate.snapshot",
      id: null,
      sessionId: "x:0",
      createdAt: "2026-09-07T11:00:01+03:00",
      snapshot: { value: "working", context: { count: 1 } },
      event: { type: "PING" },
    }),
  );
  await flushMessages();
  expect(registered?.currentSnapshot?.value).toBe("working");
  expect(registered?.updatedAt).toBe("2026-09-07T08:00:01.000Z");
});
