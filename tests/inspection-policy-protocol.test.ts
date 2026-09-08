import { applicationHello } from "./fixtures/application-hello.js";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createActor, createMachine, assign, sendTo } from "xstate";
import WebSocket from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ActorStore } from "../src/actor-store.js";
import { ClientRegistry } from "../src/client-registry.js";
import { createMcpServer } from "../src/mcp-server.js";
import { createWsServer } from "../src/ws-server.js";
import { Logger } from "../src/logger.js";
import {
  createInspectionGuard,
  serializeRedacted,
  type WritePolicyOptions,
} from "../src/inspection-policy.js";

const PASSWORD = "fixture-password-private";
const APP_ONLY = "fixture-app-private";
const SERVER_ONLY = "fixture-server-private";
const EMAIL = "fixture-email-private";
const ALLOWED: WritePolicyOptions = {
  readOnly: false,
  allow: [{ actor: "*", events: ["NEXT", "RESET", "IGNORED"] }],
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function fixture(
  writePolicy?: WritePolicyOptions,
  advertisedCommands: string[] | null = ["send_event"],
) {
  const logger = new Logger("error");
  const store = new ActorStore(20, logger, {
    keys: ["serverOnly", "received", "sourceId"],
    paths: [["customer", "email"]],
  });
  const registry = new ClientRegistry(1000, logger, { writePolicy });
  const mcp = createMcpServer(store, registry, logger);
  const client = new Client({ name: "policy-test", version: "1" });
  const [serverTransport, clientTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    mcp.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  const wss = createWsServer({
    port: 0,
    store,
    clientRegistry: registry,
    logger,
  });
  await once(wss, "listening");
  const address = wss.address();
  if (typeof address === "string" || !address)
    throw new Error("Missing listener address");
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}`);
  await once(ws, "open");
  if (advertisedCommands !== null) {
    const hello = once(ws, "message", { signal: AbortSignal.timeout(2000) });
    ws.send(JSON.stringify(applicationHello(advertisedCommands)));
    expect(JSON.parse((await hello)[0].toString()).success).toBe(true);
  }
  const wire: string[] = [];
  const commands: unknown[] = [];
  const guard = createInspectionGuard({
    enabled: true,
    writePolicy: {
      readOnly: false,
      allow: [{ actor: "*", events: ["NEXT", "IGNORED"] }],
    },
    redaction: { keys: ["appOnly", "received"] },
  });
  const machine = createMachine({
    id: "policy-fixture",
    initial: "idle",
    context: {
      count: 0,
      received: "",
      password: PASSWORD,
      appOnly: APP_ONLY,
      serverOnly: SERVER_ONLY,
      customer: { email: EMAIL },
    },
    meta: {
      password: PASSWORD,
      appOnly: APP_ONLY,
      serverOnly: SERVER_ONLY,
      customer: { email: EMAIL },
    },
    states: {
      idle: {
        entry: sendTo(({ self }) => self, { type: "SOURCE_PROBE" }),
        on: {
          NEXT: {
            target: "ready",
            actions: assign({
              count: ({ context }) => context.count + 1,
              received: ({ event }) => event.password,
            }),
          },
        },
      },
      ready: { on: { RESET: "idle" } },
    },
  });
  const actor = createActor(machine, {
    inspect(event) {
      // Deliberate projection of native inspection objects: never stringify actorRef.
      if (
        event.type !== "@xstate.actor" &&
        event.type !== "@xstate.snapshot" &&
        event.type !== "@xstate.event"
      )
        return;
      const snapshot =
        event.type === "@xstate.snapshot"
          ? (event.snapshot as unknown as Record<string, unknown>)
          : undefined;
      const text = guard.serializeInspection({
        type: event.type,
        sessionId: event.actorRef.sessionId,
        ...(event.type === "@xstate.actor"
          ? {
              name: "policy-fixture",
              definition: JSON.stringify(machine.toJSON()),
            }
          : {}),
        ...(snapshot
          ? {
              snapshot: {
                status: snapshot.status,
                value: snapshot.value,
                context: snapshot.context,
                output: snapshot.output,
              },
            }
          : {}),
        ...(event.type === "@xstate.event" || event.type === "@xstate.snapshot"
          ? { event: event.event }
          : {}),
        ...(event.type === "@xstate.event"
          ? { sourceId: event.sourceRef?.sessionId }
          : {}),
        createdAt: new Date().toISOString(),
      });
      if (text !== null) {
        wire.push(text);
        ws.send(text);
      }
    },
  });
  ws.on("message", (raw) => {
    const command = JSON.parse(raw.toString());
    commands.push(command);
    const result = guard.dispatch(actor, command);
    ws.send(
      JSON.stringify({
        type: "xstate-mcp.send.response",
        requestId: command.requestId,
        ...result,
      }),
    );
  });
  cleanups.push(async () => {
    actor.stop();
    registry.clear();
    ws.terminate();
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await client.close();
    await mcp.close();
  });
  actor.start();
  await expect
    .poll(
      () =>
        store
          .listActors()
          .find((record) => record.localSessionId === actor.sessionId)
          ?.currentSnapshot?.value,
      {
        timeout: 5000,
      },
    )
    .toBe("idle");
  const sessionId = store
    .listActors()
    .find((record) => record.localSessionId === actor.sessionId)!.sessionId;
  expect(sessionId).not.toBe(actor.sessionId);
  return { actor, sessionId, store, registry, client, wire, commands };
}

describe("write controls and redaction across actual XState, WebSocket and MCP", () => {
  it.each([null, []] as const)(
    "requires independent command negotiation with advertised commands %j",
    async (commands) => {
      const {
        client,
        sessionId,
        actor,
        commands: sent,
        registry,
      } = await fixture(ALLOWED, commands === null ? null : [...commands]);
      const result = await client.callTool({
        name: "send_event",
        arguments: { target: sessionId, event: { type: "NEXT" } },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        success: false,
        code:
          commands === null
            ? "capability_negotiation_required"
            : "unsupported_command",
      });
      expect(sent).toHaveLength(0);
      expect(actor.getSnapshot().value).toBe("idle");
      expect(registry.getHealth().counters.unsupportedCommands).toBe(1);
    },
  );

  it("rejects default writes by session and name without sending a command; clearing affects only debugger data", async () => {
    const { actor, sessionId, store, client, commands } = await fixture();
    for (const target of [sessionId, "policy-fixture"]) {
      const result = await client.callTool({
        name: "send_event",
        arguments: { target, event: { type: "NEXT", password: PASSWORD } },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        success: false,
        code: "read_only",
        event: { password: "[REDACTED]" },
      });
      expect(JSON.stringify(result)).not.toContain(PASSWORD);
    }
    expect(commands).toHaveLength(0);
    expect(actor.getSnapshot().value).toBe("idle");
    const tools = await client.listTools();
    expect(
      tools.tools.find((t) => t.name === "send_event")!.annotations,
    ).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(
      tools.tools.find((t) => t.name === "clear_actors")!.annotations,
    ).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
    await client.callTool({ name: "clear_actors" });
    expect(store.size).toBe(0);
    expect(actor.getSnapshot().status).toBe("active");
  });

  it("checks resolved session IDs rather than accepting an allow rule for a target name", async () => {
    const { client, commands, actor, sessionId } = await fixture({
      readOnly: false,
      allow: [{ actor: "policy-fixture", events: ["NEXT"] }],
    });
    const result = await client.callTool({
      name: "send_event",
      arguments: { target: "policy-fixture", event: { type: "NEXT" } },
    });
    expect(result.structuredContent).toMatchObject({
      sessionId: sessionId,
      code: "write_not_allowed",
    });
    expect(commands).toHaveLength(0);
    expect(actor.getSnapshot().value).toBe("idle");
  });

  it("enforces server and adapter policies independently and verifies actual transitions", async () => {
    const { actor, sessionId, client, commands } = await fixture(ALLOWED);
    const denied = await client.callTool({
      name: "send_event",
      arguments: { target: "policy-fixture", event: { type: "DELETE" } },
    });
    expect(denied.structuredContent).toMatchObject({
      code: "write_not_allowed",
    });
    expect(commands).toHaveLength(0);
    const allowed = await client.callTool({
      name: "send_event",
      arguments: {
        target: "policy-fixture",
        event: { type: "NEXT", password: PASSWORD },
      },
    });
    expect(allowed.structuredContent).toMatchObject({ success: true });
    expect(actor.getSnapshot().value).toBe("ready");
    expect(actor.getSnapshot().context.received).toBe(PASSWORD); // Redaction must not rewrite application commands.
    const adapterDenied = await client.callTool({
      name: "send_event",
      arguments: { target: sessionId, event: { type: "RESET" } },
    });
    expect(adapterDenied.isError).toBe(true);
    expect(adapterDenied.structuredContent).toMatchObject({
      success: false,
      code: "write_not_allowed",
      error: "Application rejected event (details withheld)",
    });
    expect(commands).toHaveLength(2);
    expect(actor.getSnapshot().value).toBe("ready");
    const ignored = await client.callTool({
      name: "send_event",
      arguments: { target: sessionId, event: { type: "IGNORED" } },
    });
    expect(ignored.structuredContent).toMatchObject({ success: true });
    expect(actor.getSnapshot().value).toBe("ready"); // ACK is not proof of a transition.
  });

  it("redacts before transfer and consistently exposes sanitized data in every read surface and a diagnostic export", async () => {
    const { actor, sessionId, store, client, wire } = await fixture(ALLOWED);
    // An application event, not an MCP command, contains the same sensitive fields.
    actor.send({
      type: "NEXT",
      password: PASSWORD,
      appOnly: APP_ONLY,
      serverOnly: SERVER_ONLY,
      customer: { email: EMAIL },
    });
    await expect
      .poll(() => store.getActor(sessionId)?.currentSnapshot?.value, {
        timeout: 5000,
      })
      .toBe("ready");
    const transferred = wire.join("\n");
    expect(transferred).not.toContain(APP_ONLY);
    expect(transferred).not.toContain(PASSWORD);
    expect(transferred).toContain(SERVER_ONLY); // Independent server policy removes this.
    expect(
      wire
        .map((text) => JSON.parse(text))
        .find((event) => event.event?.type === "SOURCE_PROBE"),
    ).toMatchObject({ sourceId: actor.sessionId });
    const record = store.getActor(sessionId)!;
    expect(record.eventHistory.toArray()).toContainEqual(
      expect.objectContaining({
        event: { type: "SOURCE_PROBE" },
        sourceId: "[REDACTED]",
      }),
    );
    expect(record.currentSnapshot!.context).toMatchObject({
      password: "[REDACTED]",
      appOnly: "[REDACTED]",
      serverOnly: "[REDACTED]",
      customer: { email: "[REDACTED]" },
    });
    const results: unknown[] = [];
    for (const name of [
      "list_actors",
      "get_actor_tree",
      "get_actor_state",
      "get_event_history",
      "get_state_timeline",
      "get_machine_definition",
      "can_handle_event",
    ]) {
      const result = await client.callTool({
        name,
        arguments: { sessionId: sessionId, eventType: "RESET" },
      });
      expect(result.isError, `${name}: ${JSON.stringify(result)}`).not.toBe(
        true,
      );
      if (name === "get_event_history") {
        expect(JSON.stringify(result)).toContain('"sourceId":"[REDACTED]"');
        expect(JSON.stringify(result)).not.toContain(
          `"sourceId":"${sessionId}"`,
        );
      }
      results.push(result);
    }
    for (const uri of [
      "xstate://actors",
      `xstate://actor/${sessionId}/snapshot`,
      `xstate://actor/${sessionId}/definition`,
    ])
      results.push(await client.readResource({ uri }));
    results.push(await client.listResources());
    for (const name of ["debug_actor", "explain_machine", "trace_event_flow"])
      results.push(
        await client.getPrompt({
          name,
          arguments: { sessionId: sessionId },
        }),
      );
    const diagnostic = {
      schemaVersion: 1,
      actors: [
        {
          snapshot: record.currentSnapshot,
          definition: record.definition,
          events: record.eventHistory.toArray(),
          transitions: record.transitionHistory.toArray(),
        },
      ],
      extra: { password: PASSWORD },
    };
    const directory = await mkdtemp(join(tmpdir(), "xstate-policy-export-"));
    try {
      await writeFile(
        join(directory, "trace.json"),
        serializeRedacted(diagnostic, { keys: ["received"] }),
      );
      results.push(
        JSON.parse(await readFile(join(directory, "trace.json"), "utf8")),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    for (const result of results) {
      const text = JSON.stringify(result);
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain(APP_ONLY);
      expect(text).not.toContain(SERVER_ONLY);
      expect(text).not.toContain(EMAIL);
    }
    expect(JSON.stringify(results)).toContain("[REDACTED]");
    expect(JSON.stringify(results)).toContain('"ready"');
  });
});
