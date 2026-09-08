import { negotiateApplication } from "./fixtures/application-hello.js";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { WebSocket } from "ws";
import { createActor, createMachine, type MachineConfig } from "xstate-compat";
import { describe, expect, it, onTestFinished } from "vitest";
import { ActorStore } from "../src/actor-store.js";
import { ClientRegistry } from "../src/client-registry.js";
import { createMcpServer } from "../src/mcp-server.js";
import { createWsServer } from "../src/ws-server.js";
import { Logger } from "../src/logger.js";

type Config = MachineConfig<Record<string, unknown>, { type: string }>;
async function connectActor(
  config: Config,
  definition: (value: unknown) => unknown = (value) => value,
) {
  const logger = new Logger("error");
  const store = new ActorStore(100, logger);
  const registry = new ClientRegistry(500, logger);
  const server = createMcpServer(store, registry, logger);
  const client = new Client({ name: "eligibility-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const wss = createWsServer({
    port: 0,
    store,
    clientRegistry: registry,
    logger,
  });
  const actors: { stop(): unknown }[] = [];
  onTestFinished(async () => {
    actors.forEach((actor) => actor.stop());
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  if (!wss.address()) await once(wss, "listening");
  const address = wss.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}`);
  onTestFinished(() => ws.terminate());
  await once(ws, "open");
  await negotiateApplication(ws);
  const machine = createMachine(config, { guards: { reject: () => false } });
  const actor = createActor(machine, {
    inspect: (event) =>
      ws.send(
        JSON.stringify({
          ...event,
          sessionId: event.actorRef.sessionId,
          ...(event.type === "@xstate.actor"
            ? { definition: definition(machine.toJSON()) }
            : {}),
        }),
      ),
  });
  actors.push(actor);
  ws.on("message", (raw) => {
    const request = JSON.parse(raw.toString());
    if (request.type !== "xstate-mcp.send") return;
    actor.send(request.event);
    ws.send(
      JSON.stringify({
        type: "xstate-mcp.send.response",
        requestId: request.requestId,
        success: true,
      }),
    );
  });
  actor.start();
  const pong = once(ws, "pong");
  ws.ping();
  await pong;
  const listed = await client.callTool({ name: "list_actors", arguments: {} });
  const [{ sessionId }] = (
    listed.structuredContent as { actors: { sessionId: string }[] }
  ).actors;
  async function eligibility(
    eventType: string,
  ): Promise<Record<string, unknown>> {
    const result = await client.callTool({
      name: "can_handle_event",
      arguments: { sessionId, eventType },
    });
    expect(result.isError).not.toBe(true);
    const content = result.content as { type: string; text: string }[];
    expect(JSON.parse(content[0].text)).toEqual(result.structuredContent);
    return result.structuredContent as Record<string, unknown>;
  }
  return { client, actor, sessionId, eligibility };
}

describe("registered can_handle_event protocol", () => {
  it("rejects ancestor masking, finds partial wildcards and verifies actual delivery", async () => {
    const { client, actor, sessionId, eligibility } = await connectActor({
      initial: "idle",
      on: { GO: ".done" },
      states: {
        idle: {
          on: {
            GO: {},
            GUARDED: { guard: "reject", target: "done" },
            "user.*": "done",
          },
        },
        done: { type: "final" },
      },
    });
    const { tools } = await client.listTools();
    const tool = tools.find((tool) => tool.name === "can_handle_event")!;
    expect(tool.annotations?.readOnlyHint).toBe(true);
    expect(tool.description).toContain("null");
    expect(tool.outputSchema?.properties).toHaveProperty("blockedTransitions");
    expect(await eligibility("GO")).toMatchObject({
      canHandle: false,
      analysis: "static",
      reason: "forbidden_transition",
      matchedTransitions: [],
      blockedTransitions: ["idle.on.GO"],
    });
    expect(await eligibility("GUARDED")).toMatchObject({
      canHandle: null,
      reason: "guard_not_evaluated",
    });
    for (const type of ["GO", "GUARDED"]) {
      const sent = await client.callTool({
        name: "send_event",
        arguments: { target: sessionId, event: { type } },
      });
      expect(sent.structuredContent).toMatchObject({ success: true });
      expect(actor.getSnapshot().value).toBe("idle");
    }
    expect(await eligibility("user.save")).toMatchObject({
      canHandle: true,
      matchedTransitions: ["idle.on.user.*"],
    });
    await client.callTool({
      name: "send_event",
      arguments: { target: sessionId, event: { type: "user.save" } },
    });
    const state = await client.callTool({
      name: "get_actor_state",
      arguments: { sessionId },
    });
    expect(state.structuredContent).toMatchObject({
      value: "done",
      status: "done",
    });
    expect(await eligibility("GO")).toMatchObject({
      canHandle: false,
      reason: "actor_inactive",
    });
    const invalid = await client.callTool({
      name: "can_handle_event",
      arguments: { sessionId, eventType: 42 },
    });
    expect(invalid.isError).toBe(true);
  });

  it.each([
    ["missing", (): undefined => undefined, "definition_unavailable"],
    ["truncated", () => ({ id: "incomplete" }), "definition_incomplete"],
  ] as const)(
    "returns a schema-valid null for a %s definition",
    async (_name, definition, reason) => {
      const { eligibility } = await connectActor(
        { initial: "idle", states: { idle: {} } },
        definition,
      );
      expect(await eligibility("GO")).toMatchObject({
        canHandle: null,
        analysis: "static",
        reason,
        matchedTransitions: [],
        blockedTransitions: [],
      });
    },
  );

  it("keeps lossy serialization explicitly static instead of promising a runtime transition", async () => {
    let guardCalls = 0;
    const { client, actor, sessionId, eligibility } = await connectActor({
      initial: "idle",
      states: {
        idle: {
          on: {
            GO: {
              guard: () => {
                guardCalls++;
                return false;
              },
              target: "done",
            },
          },
        },
        done: {},
      },
    });
    // Plain JSON drops the inline guard. The server cannot recover that code.
    expect(await eligibility("GO")).toMatchObject({
      canHandle: true,
      analysis: "static",
      note: expect.stringContaining("serialization may omit"),
    });
    expect(guardCalls).toBe(0);
    await client.callTool({
      name: "send_event",
      arguments: { target: sessionId, event: { type: "GO" } },
    });
    expect(guardCalls).toBe(1);
    expect(actor.getSnapshot().value).toBe("idle");
  });
});
