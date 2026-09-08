import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocket } from "ws";
import * as current from "xstate";
import * as compatible from "xstate-compat";
import { describe, expect, it, onTestFinished } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const cli = resolve(root, pkg.bin["xstate-mcp"]);

async function startCli() {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const child = spawn(process.execPath, [cli], {
    cwd: root,
    env: {
      ...process.env,
      XSTATE_MCP_WS_PORT: String(address.port),
      XSTATE_MCP_WS_HOST: "127.0.0.1",
      XSTATE_MCP_LOG_LEVEL: "debug",
      XSTATE_MCP_REQUIRE_ORIGIN: "false",
    },
    stdio: "pipe",
  });
  let stderr = "";
  let stdout = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  const exited = once(child, "close");
  const client = new Client({ name: "runtime-compatibility", version: "1" });
  onTestFinished(async () => {
    // Shutdown behavior has separate regression coverage; never leave a failed
    // compatibility test's subprocess listening on a port.
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await exited;
    await client.close();
  });
  await client.connect(new StdioServerTransport(child.stdout, child.stdin));
  await expect.poll(() => stderr).toContain("WebSocket server listening");
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}`);
  onTestFinished(() => ws.terminate());
  await once(ws, "open");
  return { client, ws, stdout: () => stdout };
}

async function flushed(ws: WebSocket) {
  const pong = once(ws, "pong");
  ws.ping();
  await pong;
}

async function tool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
) {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError).not.toBe(true);
  const content = result.content as { type: string; text: string }[];
  expect(content[0].type).toBe("text");
  expect(JSON.parse(content[0].text)).toEqual(result.structuredContent);
  expect(result.structuredContent).toBeDefined();
  return result.structuredContent as Record<string, unknown>;
}

const machineConfig = {
  id: "compatibility",
  initial: "idle",
  context: { message: "ready" },
  states: { idle: { on: { RUN: "running" } }, running: {} },
};

// Both producers emit real inspection events. The adapter preserves the runtime
// session ID before ActorRef.toJSON drops it and attaches the actual definition.
// Stately's different serialization format is covered by issue #1.
function forward(ws: WebSocket, definition: unknown) {
  return (event: { type: string; actorRef: { sessionId: string } }) => {
    ws.send(
      JSON.stringify({
        ...event,
        sessionId: event.actorRef.sessionId,
        ...(event.type === "@xstate.actor" ? { definition } : {}),
      }),
    );
  };
}

describe.each([
  [
    "5.32.6",
    (ws: WebSocket) => {
      const machine = current.createMachine(machineConfig);
      return current.createActor(machine, {
        inspect: forward(ws, machine.toJSON()),
      });
    },
  ],
  [
    "5.28.0",
    (ws: WebSocket) => {
      const machine = compatible.createMachine(machineConfig);
      return compatible.createActor(machine, {
        inspect: forward(ws, machine.toJSON()),
      });
    },
  ],
] as const)(
  "Node stdio/WebSocket compatibility with XState %s",
  (_version, makeActor) => {
    it("discovers, queries, commands and verifies a real actor through the built CLI", async () => {
      const { client, ws, stdout } = await startCli();
      const actor = makeActor(ws);
      onTestFinished(() => {
        actor.stop();
      });
      ws.on("message", (raw) => {
        const command = JSON.parse(raw.toString());
        if (command.type !== "xstate-mcp.send") return;
        const success =
          command.sessionId === actor.sessionId &&
          command.event.type !== "REJECT";
        if (success) actor.send(command.event);
        ws.send(
          JSON.stringify({
            type: "xstate-mcp.send.response",
            requestId: command.requestId,
            success,
            ...(success ? {} : { error: "Adapter rejected the command" }),
          }),
        );
      });
      actor.start();
      await flushed(ws);

      const { tools } = await client.listTools();
      expect(tools.map(({ name }) => name)).toEqual(
        expect.arrayContaining([
          "list_actors",
          "get_actor_state",
          "send_event",
          "clear_actors",
        ]),
      );
      expect(
        tools.find(({ name }) => name === "get_actor_state"),
      ).toMatchObject({
        inputSchema: { required: ["sessionId"] },
        outputSchema: { type: "object" },
        annotations: { readOnlyHint: true },
      });
      const listed = await tool(client, "list_actors");
      const actors = listed.actors as { sessionId: string }[];
      expect(actors).toHaveLength(1);
      const sessionId = actors[0].sessionId;
      expect(
        await tool(client, "get_actor_state", { sessionId }),
      ).toMatchObject({
        value: "idle",
        status: "active",
        context: { message: "ready" },
      });
      expect(await tool(client, "get_actor_tree")).toMatchObject({
        totalActors: 1,
      });
      expect(
        await tool(client, "get_machine_definition", { sessionId }),
      ).toMatchObject({
        definition: { id: "compatibility" },
      });
      expect(
        await tool(client, "can_handle_event", { sessionId, eventType: "RUN" }),
      ).toMatchObject({ canHandle: true });
      expect(
        await tool(client, "send_event", {
          target: sessionId,
          event: { type: "RUN", request: 42 },
        }),
      ).toMatchObject({ success: true });
      expect(actor.getSnapshot().value).toBe("running");
      expect(
        await tool(client, "get_actor_state", { sessionId }),
      ).toMatchObject({ value: "running" });
      expect(
        await tool(client, "get_event_history", { sessionId }),
      ).toMatchObject({
        events: expect.arrayContaining([
          expect.objectContaining({ event: { type: "RUN", request: 42 } }),
        ]),
      });
      expect(
        await tool(client, "get_state_timeline", { sessionId }),
      ).toMatchObject({
        transitions: expect.arrayContaining([
          expect.objectContaining({
            fromValue: "idle",
            toValue: "running",
            event: "RUN",
          }),
        ]),
      });
      const snapshot = await client.readResource({
        uri: `xstate://actor/${sessionId}/snapshot`,
      });
      expect(
        JSON.parse(
          "text" in snapshot.contents[0] ? snapshot.contents[0].text : "null",
        ),
      ).toMatchObject({
        value: "running",
      });
      const prompt = await client.getPrompt({
        name: "debug_actor",
        arguments: { sessionId },
      });
      expect(JSON.stringify(prompt.messages)).toContain("running");

      const rejected = await client.callTool({
        name: "send_event",
        arguments: { target: sessionId, event: { type: "REJECT" } },
      });
      expect(rejected).toMatchObject({
        isError: true,
        structuredContent: {
          success: false,
          error: "Adapter rejected the command",
        },
      });
      expect(
        await tool(client, "get_actor_state", { sessionId }),
      ).toMatchObject({ value: "running" });
      const invalid = await client.callTool({
        name: "get_actor_state",
        arguments: { sessionId: 42 },
      });
      expect(invalid.isError).toBe(true);
      expect(await tool(client, "clear_actors")).toMatchObject({ cleared: 1 });
      expect(await tool(client, "list_actors")).toMatchObject({
        totalActors: 0,
      });
      // Every stdout line must remain a protocol envelope after dependency updates.
      for (const line of stdout().trim().split("\n")) {
        expect(JSON.parse(line)).toHaveProperty("jsonrpc", "2.0");
      }
    });
  },
);

it("bounds fragmented input and keeps MCP available after closing the offending socket", async () => {
  const { client, ws } = await startCli();
  const closed = once(ws, "close");
  // ws 8.21+ defaults to at most 16,384 fragments. This fixed-size probe sends
  // less than 120 KiB on the wire; it never attempts unbounded memory exhaustion.
  for (let i = 0; i < 16_385; i++) ws.send(" ", { fin: false });
  ws.send(" ", { fin: true });
  expect((await closed)[0]).toBe(1008);
  expect(await tool(client, "list_actors")).toMatchObject({ totalActors: 0 });
});
