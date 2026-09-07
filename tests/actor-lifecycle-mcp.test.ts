import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { WebSocket } from "ws";
import {
  createActor,
  createMachine,
  fromCallback,
  fromPromise,
  fromTransition,
} from "xstate";
import { ActorStore } from "../src/actor-store.js";
import { ClientRegistry } from "../src/client-registry.js";
import { Logger } from "../src/logger.js";
import { createMcpServer } from "../src/mcp-server.js";
import { createWsServer } from "../src/ws-server.js";
import { nativeInspectionForwarder } from "./fixtures/native-inspection.js";

async function setup() {
  const logger = new Logger("error");
  const store = new ActorStore(10, logger);
  const registry = new ClientRegistry(5000, logger);
  const server = createMcpServer(store, registry, logger);
  const client = new Client({ name: "lifecycle-test", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  onTestFinished(async () => {
    await client.close();
    await server.close();
  });
  const wss = createWsServer({
    port: 0,
    store,
    logger,
    clientRegistry: registry,
  });
  await once(wss, "listening");
  onTestFinished(async () => {
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });
  const address = wss.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}`);
  await once(ws, "open");
  onTestFinished(async () => {
    const closed = once(ws, "close");
    ws.close();
    await closed;
  });
  const forwarder = nativeInspectionForwarder(ws);
  // Fetch discovery so the SDK validates structured tool results against schemas.
  await client.listTools();
  async function discover(localSessionId: string) {
    const result = await client.callTool({
      name: "list_actors",
      arguments: {},
    });
    expect(result.isError).not.toBe(true);
    const { actors } = result.structuredContent as {
      actors: { sessionId: string; localSessionId: string }[];
    };
    const actor = actors.find(
      (candidate) => candidate.localSessionId === localSessionId,
    );
    if (!actor) throw new Error(`Actor ${localSessionId} was not discovered`);
    expect(actor.sessionId).not.toBe(localSessionId);
    return actor.sessionId;
  }
  function status(localSessionId: string) {
    return store
      .listActors()
      .find((actor) => actor.localSessionId === localSessionId)?.currentSnapshot
      ?.status;
  }
  return { client, discover, status, ...forwarder };
}

async function readState(client: Client, sessionId: string) {
  const tool = await client.callTool({
    name: "get_actor_state",
    arguments: { sessionId },
  });
  expect(tool.isError).not.toBe(true);
  const resource = await client.readResource({
    uri: `xstate://actor/${sessionId}/snapshot`,
  });
  const content = resource.contents[0];
  if (!("text" in content)) throw new Error("Expected JSON resource");
  const state = JSON.parse(content.text);
  expect(tool.structuredContent).toEqual(state);
  const text = tool.content as { type: string; text: string }[];
  expect(JSON.parse(text[0].text)).toEqual(state);
  return state;
}

async function readTimeline(client: Client, sessionId: string) {
  const result = await client.callTool({
    name: "get_state_timeline",
    arguments: { sessionId },
  });
  expect(result.isError).not.toBe(true);
  return result.structuredContent as { transitions: Record<string, unknown>[] };
}

async function expectPrompts(client: Client, sessionId: string, text: string) {
  for (const name of ["debug_actor", "explain_machine", "trace_event_flow"]) {
    const prompt = await client.getPrompt({ name, arguments: { sessionId } });
    const content = prompt.messages[0].content;
    if (content.type !== "text") throw new Error("Expected text prompt");
    expect(content.text).toContain(text);
    expect(content.text).toContain("Output:");
    expect(content.text).toContain("Error:");
  }
}

describe("real XState lifecycle over WebSocket and MCP", () => {
  it("exposes promise and machine completion outputs", async () => {
    const { client, inspect, flush, discover, status } = await setup();
    const promise = createActor(
      fromPromise(async () => ({ answer: 42 })),
      { inspect },
    );
    onTestFinished(() => {
      promise.stop();
    });
    promise.start();
    await expect.poll(() => status(promise.sessionId)).toBe("done");
    const promiseSessionId = await discover(promise.sessionId);
    const state = await readState(client, promiseSessionId);
    expect(state).toMatchObject({
      status: "done",
      value: null,
      output: { answer: 42 },
      error: null,
    });
    const timeline = await readTimeline(client, promiseSessionId);
    expect(timeline.transitions.at(-1)).toMatchObject({
      type: "lifecycle",
      changes: ["status", "output"],
      fromStatus: "active",
      toStatus: "done",
      fromValue: null,
      toValue: null,
      output: { answer: 42 },
    });
    await expectPrompts(client, promiseSessionId, '"answer":42');

    const machine = createActor(
      createMachine({
        initial: "working",
        states: {
          working: { on: { FINISH: "complete" } },
          complete: { type: "final" },
        },
        output: () => ({ result: "finished" }),
      }),
      { inspect },
    );
    onTestFinished(() => {
      machine.stop();
    });
    machine.start();
    machine.send({ type: "FINISH" });
    await flush();
    const machineSessionId = await discover(machine.sessionId);
    expect(await readState(client, machineSessionId)).toMatchObject({
      status: "done",
      value: "complete",
      output: { result: "finished" },
      error: null,
    });
    expect(
      (await readTimeline(client, machineSessionId)).transitions.at(-1),
    ).toMatchObject({
      type: "state",
      changes: ["value", "status", "output"],
      fromStatus: "active",
      toStatus: "done",
    });
  });

  it("retains a rejected invocation on both promise and parent machine", async () => {
    const { client, inspect, discover, status, sent } = await setup();
    const error = Object.assign(new TypeError("service failed"), {
      code: "SERVICE_FAILED",
    });
    const machine = createActor(
      createMachine({
        initial: "loading",
        states: {
          loading: {
            invoke: {
              id: "fetcher",
              src: fromPromise(async () => {
                throw error;
              }),
            },
          },
        },
      }),
      { inspect },
    );
    const onError = vi.fn();
    machine.subscribe({ error: onError });
    onTestFinished(() => {
      machine.stop();
    });
    machine.start();
    const child = machine.getSnapshot().children.fetcher!;
    await expect.poll(() => status(machine.sessionId)).toBe("error");
    expect(onError).toHaveBeenCalledWith(error);
    for (const localSessionId of [machine.sessionId, child.sessionId]) {
      const sessionId = await discover(localSessionId);
      expect(await readState(client, sessionId)).toMatchObject({
        status: "error",
        output: null,
        error: {
          name: "TypeError",
          message: "service failed",
          code: "SERVICE_FAILED",
        },
      });
      expect(
        (await readTimeline(client, sessionId)).transitions.at(-1),
      ).toMatchObject({
        type: "lifecycle",
        changes: ["status", "error"],
        fromStatus: "active",
        toStatus: "error",
        error: {
          name: "TypeError",
          message: "service failed",
          code: "SERVICE_FAILED",
        },
      });
      await expectPrompts(client, sessionId, '"message":"service failed"');
    }
    expect(
      sent.some(
        (event) =>
          event.type === "@xstate.snapshot" &&
          (event.snapshot as Record<string, unknown>).status === "error",
      ),
    ).toBe(true);
  });

  it("records callback and machine explicit stops without inventing output", async () => {
    const { client, inspect, flush, discover } = await setup();
    const cleanup = vi.fn();
    const callback = createActor(
      fromCallback(() => cleanup),
      { inspect },
    );
    const machine = createActor(
      createMachine({ initial: "idle", states: { idle: {} } }),
      { inspect },
    );
    onTestFinished(() => {
      callback.stop();
      machine.stop();
    });
    callback.start();
    machine.start();
    callback.stop();
    machine.stop();
    await flush();
    expect(cleanup).toHaveBeenCalledOnce();
    for (const actor of [callback, machine]) {
      const sessionId = await discover(actor.sessionId);
      expect(await readState(client, sessionId)).toMatchObject({
        status: "stopped",
        output: null,
        error: null,
      });
      expect(
        (await readTimeline(client, sessionId)).transitions.at(-1),
      ).toMatchObject({
        type: "lifecycle",
        changes: ["status"],
        fromStatus: "active",
        toStatus: "stopped",
        event: "xstate.stop",
      });
    }
  });

  it("preserves real callback failure snapshots supplied by an error observer", async () => {
    const { client, inspect, flush, captureSnapshot, discover } = await setup();
    const actor = createActor(
      fromCallback(({ receive }) => {
        receive(() => {
          throw new Error("callback failed");
        });
      }),
      { inspect },
    );
    actor.subscribe({
      error() {
        captureSnapshot(actor);
      },
    });
    onTestFinished(() => {
      actor.stop();
    });
    actor.start();
    actor.send({ type: "FAIL" });
    await flush();
    const sessionId = await discover(actor.sessionId);
    expect(await readState(client, sessionId)).toMatchObject({
      status: "error",
      value: null,
      output: null,
      error: { name: "Error", message: "callback failed" },
    });
    await expectPrompts(client, sessionId, '"message":"callback failed"');
  });

  it("records a real context reset on an actor without a state value", async () => {
    const { client, inspect, flush, discover } = await setup();
    const actor = createActor(
      fromTransition(
        (_context: { count: number } | null, _event: { type: "RESET" }) => null,
        { count: 1 },
      ),
      { inspect },
    );
    onTestFinished(() => {
      actor.stop();
    });
    actor.start();
    actor.send({ type: "RESET" });
    await flush();
    const sessionId = await discover(actor.sessionId);
    expect(await readState(client, sessionId)).toMatchObject({
      status: "active",
      context: null,
      value: null,
    });
    expect(
      (await readTimeline(client, sessionId)).transitions.at(-1),
    ).toMatchObject({
      type: "context",
      changes: ["context"],
      fromValue: null,
      toValue: null,
      event: "RESET",
    });
  });
});
