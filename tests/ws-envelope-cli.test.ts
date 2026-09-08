import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it, onTestFinished } from "vitest";
import { WebSocket } from "ws";
import { createActor, createMachine } from "xstate";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const cliEntry: string = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).bin["xstate-mcp"];
const privateMarker = "APPLICATION_PAYLOAD_MUST_NOT_BE_LOGGED";
const malformedFrames = [
  "null",
  "[]",
  "[null]",
  "true",
  "false",
  "42",
  '"text"',
  "{",
  "",
  "{}",
  JSON.stringify({ type: null }),
  JSON.stringify({ type: [] }),
  JSON.stringify({ type: 1 }),
  JSON.stringify({ type: privateMarker.repeat(1000) }),
  JSON.stringify({ type: "@xstate.actor" }),
  JSON.stringify({
    type: "@xstate.actor",
    sessionId: 42,
    snapshot: { secret: privateMarker },
  }),
  JSON.stringify({
    type: "@xstate.snapshot",
    sessionId: "missing",
    snapshot: [],
  }),
  JSON.stringify({ type: "@xstate.event", sessionId: "missing", event: null }),
  JSON.stringify({ type: "xstate-mcp.send.response" }),
];

async function availablePort() {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test port");
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function startCli() {
  const port = await availablePort();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliEntry],
    cwd: repoRoot,
    stderr: "pipe",
    env: {
      XSTATE_MCP_WS_PORT: String(port),
      XSTATE_MCP_WS_HOST: "127.0.0.1",
      XSTATE_MCP_LOG_LEVEL: "info",
    },
  });
  let stderr = "";
  transport.stderr!.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const client = new Client({ name: "envelope-regression", version: "1.0.0" });
  let exited = false;
  client.onclose = () => {
    exited = true;
  };
  onTestFinished(async () => {
    // Stop our subprocess through the CLI's graceful signal shutdown path.
    if (transport.pid !== null) process.kill(transport.pid, "SIGTERM");
    await client.close();
  });
  await client.connect(transport);
  await expect
    .poll(() => stderr.includes("WebSocket server listening"), {
      timeout: 3000,
    })
    .toBe(true);
  await client.listTools();
  return {
    client,
    get stderr() {
      return stderr;
    },
    get exited() {
      return exited;
    },
    async connectSocket() {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      await once(ws, "open");
      onTestFinished(async () => {
        if (ws.readyState === WebSocket.CLOSED) return;
        const closed = once(ws, "close");
        ws.terminate();
        await closed;
      });
      return ws;
    },
  };
}

function flush(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("pong", onPong);
      ws.off("close", onClose);
      ws.off("error", onError);
    };
    const onPong = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () =>
      onError(
        new Error("CLI closed its WebSocket before processing the frames"),
      );
    const timer = setTimeout(
      () => onError(new Error("Timed out waiting for WebSocket pong")),
      2000,
    );
    ws.once("pong", onPong);
    ws.once("close", onClose);
    ws.once("error", onError);
    ws.ping();
  });
}

function startActor(ws: WebSocket) {
  // Real XState root actor; its default id equals its sessionId.
  // Forward native inspection events without rewriting metadata or snapshots.
  const actor = createActor(
    createMachine({
      initial: "idle",
      states: { idle: { on: { NEXT: "ready" } }, ready: {} },
    }),
    { inspect: (event) => ws.send(JSON.stringify(event)) },
  );
  onTestFinished(() => {
    if (ws.readyState === WebSocket.OPEN) actor.stop();
  });
  actor.start();
  return actor;
}

async function discoverSessionId(client: Client, localSessionId: string) {
  const list = await client.callTool({ name: "list_actors", arguments: {} });
  expect(list.structuredContent).toMatchObject({
    totalActors: 1,
    actors: [{ localSessionId }],
  });
  const { actors } = list.structuredContent as {
    actors: { sessionId: string }[];
  };
  expect(actors[0].sessionId).not.toBe(localSessionId);
  return actors[0].sessionId;
}

describe("CLI WebSocket envelope validation", () => {
  it("survives malformed frames and lets a second real actor client use MCP", async () => {
    const cli = await startCli();
    const badClient = await cli.connectSocket();
    for (const frame of malformedFrames) badClient.send(frame);
    await flush(badClient).catch((error: Error) => {
      throw new Error(`${error.message}\n${cli.stderr.slice(-2000)}`);
    });
    expect(cli.exited, cli.stderr).toBe(false);
    const empty = await cli.client.callTool({
      name: "list_actors",
      arguments: {},
    });
    expect(empty.structuredContent).toMatchObject({ totalActors: 0 });

    const goodClient = await cli.connectSocket();
    const actor = startActor(goodClient);
    await flush(goodClient);
    const sessionId = await discoverSessionId(cli.client, actor.sessionId);
    actor.send({ type: "NEXT" });
    await flush(goodClient);
    const state = await cli.client.callTool({
      name: "get_actor_state",
      arguments: { sessionId },
    });
    expect(state.structuredContent).toMatchObject({
      status: "active",
      value: "ready",
    });
    expect(cli.stderr.includes(privateMarker)).toBe(false);
    expect(cli.stderr).toContain("Invalid WebSocket message envelope");
    expect(cli.stderr).toContain("Invalid send response");
    expect(cli.stderr).toContain("non-JSON");
    expect(cli.stderr.split("\n").every((line) => line.length < 512)).toBe(
      true,
    );
  });

  it.each([true, false])(
    "keeps requests pending until a valid success=%s acknowledgement",
    async (success) => {
      const cli = await startCli();
      const ws = await cli.connectSocket();
      const actor = startActor(ws);
      await flush(ws);
      const sessionId = await discoverSessionId(cli.client, actor.sessionId);
      const commandReceived = once(ws, "message");
      const response = cli.client.callTool({
        name: "send_event",
        arguments: { target: sessionId, event: { type: "NEXT" } },
      });
      let settled = false;
      void response.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      const [raw] = await commandReceived;
      const command = JSON.parse(raw.toString());
      expect(command.sessionId).toBe(actor.sessionId);
      const base = {
        type: "xstate-mcp.send.response",
        requestId: command.requestId,
        success: true,
      };
      const malformedResponses = [
        { type: base.type, requestId: base.requestId },
        { type: base.type, success: true },
        ...[null, "true", 1, {}, []].map((value) => ({
          ...base,
          success: value,
        })),
        ...[null, 42, {}, [], ""].map((value) => ({
          ...base,
          requestId: value,
        })),
        ...[null, 42, {}, []].map((value) => ({ ...base, error: value })),
      ];
      for (const frame of malformedResponses) ws.send(JSON.stringify(frame));
      await flush(ws);
      // MCP ping provides a stdio ordering barrier after WS processing.
      await cli.client.ping();
      expect(settled).toBe(false);
      for (const frame of malformedFrames) ws.send(frame);
      await flush(ws);
      await cli.client.ping();
      expect(settled).toBe(false);
      if (success) actor.send(command.event);
      ws.send(
        JSON.stringify({
          ...base,
          success,
          ...(success ? {} : { error: "Action rejected" }),
        }),
      );
      const result = await response;
      expect(result.structuredContent).toMatchObject({
        success,
        ...(success ? {} : { error: "Action rejected" }),
      });
      expect(result.isError).toBe(!success);
      await flush(ws);
      const state = await cli.client.callTool({
        name: "get_actor_state",
        arguments: { sessionId },
      });
      expect(state.structuredContent).toMatchObject({
        value: success ? "ready" : "idle",
      });
      expect(cli.exited).toBe(false);
    },
  );

  it("keeps unknown acknowledgement diagnostics bounded without echoing payloads", async () => {
    const cli = await startCli();
    const ws = await cli.connectSocket();
    ws.send(
      JSON.stringify({
        type: "xstate-mcp.send.response",
        requestId: privateMarker.repeat(10000),
        success: true,
        error: privateMarker,
      }),
    );
    await flush(ws);
    await cli.client.ping();
    expect(cli.stderr).toContain("Received response for unknown request");
    expect(cli.stderr.includes(privateMarker)).toBe(false);
    expect(cli.stderr.split("\n").every((line) => line.length < 512)).toBe(
      true,
    );
  });
});
