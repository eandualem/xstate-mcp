// Copied into a clean npm consumer by package-smoke.mjs; run there, never in the source tree.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { accessSync, constants, readFileSync, realpathSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocket } from "ws";
import { createActor, createMachine } from "xstate";
import { createInspectionGuard } from "xstate-mcp/inspection-policy";

const allow = [{ actor: "*", events: ["RUN"] }];
const secret = "release-fixture-secret";
const guard = createInspectionGuard({
  enabled: true,
  writePolicy: { readOnly: false, allow },
});

const packageRoot = resolve("node_modules/xstate-mcp");
const pkg = JSON.parse(
  readFileSync(resolve(packageRoot, "package.json"), "utf8"),
);
assert.equal(
  fileURLToPath(import.meta.resolve("xstate-mcp")),
  resolve(packageRoot, pkg.main),
);
assert.equal(pkg.exports["."].types, `./${pkg.types}`);
accessSync(resolve(packageRoot, pkg.types));
const bin = resolve("node_modules/.bin/xstate-mcp");
accessSync(bin, constants.X_OK);
assert.equal(
  realpathSync(bin),
  realpathSync(resolve(packageRoot, pkg.bin[pkg.name])),
);
assert(readFileSync(bin, "utf8").startsWith("#!/usr/bin/env node\n"));

assert.notEqual(
  pkg.bin[pkg.name],
  pkg.main,
  "Library and CLI entries are separate",
);
const library = await import("xstate-mcp");
assert.equal(typeof library.createSandboxServer, "function");
assert.equal(typeof library.createInspectionServer, "function");
assert.equal(library.default, library.createSandboxServer);
await library.createSandboxServer().close();
const reservation = createServer();
reservation.listen(0, "127.0.0.1");
await once(reservation, "listening");
const { port } = reservation.address();
await new Promise((done) => reservation.close(done));
const child = spawn(bin, [], {
  stdio: "pipe",
  env: {
    ...process.env,
    NODE_PATH: "",
    PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
    XSTATE_MCP_WS_PORT: String(port),
    XSTATE_MCP_WS_HOST: "127.0.0.1",
    XSTATE_MCP_LOG_LEVEL: "debug",
    XSTATE_MCP_REQUIRE_ORIGIN: "false",
    XSTATE_MCP_READ_ONLY: "false",
    XSTATE_MCP_WRITE_ALLOW: JSON.stringify(allow),
    XSTATE_MCP_REDACTION: "{}",
  },
});
const deadline = setTimeout(() => {
  child.kill("SIGKILL");
  console.error("Clean consumer exceeded its 15 second protocol deadline");
  process.exit(1);
}, 15000);
let stderr = "";
let stdout = "";
child.stderr.on("data", (data) => {
  stderr += data;
});
child.stdout.on("data", (data) => {
  stdout += data;
});
const closed = once(child, "close");
const client = new Client({ name: "clean-consumer", version: "1.0.0" });
let ws;
let actor;
let forwarding = true;
let commandCount = 0;
let receivedTarget;
let exitResult;
const tool = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  assert(!result.isError, JSON.stringify(result));
  const data = JSON.parse(result.content[0].text);
  assert.deepEqual(data, result.structuredContent);
  return data;
};
try {
  await client.connect(new StdioServerTransport(child.stdout, child.stdin));
  assert.equal(client.getServerVersion().version, pkg.version);
  for (
    let retry = 0;
    !stderr.includes("WebSocket server listening") && retry < 100;
    retry++
  )
    await delay(20);
  assert(stderr.includes("WebSocket server listening"), stderr);
  ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await once(ws, "open");
  const helloResponse = once(ws, "message", {
    signal: AbortSignal.timeout(2000),
  });
  ws.send(
    JSON.stringify({
      type: "xstate-mcp.hello",
      protocolVersion: 1,
      application: { name: "release-consumer" },
      adapter: { name: "release-fixture", version: "1.0.0" },
      capabilities: { commands: ["send_event"] },
    }),
  );
  const hello = JSON.parse((await helloResponse)[0].toString());
  assert.equal(hello.type, "xstate-mcp.hello.response");
  assert.equal(hello.success, true);
  assert.deepEqual(hello.commands, ["send_event"]);
  const machine = createMachine({
    id: "release-demo",
    context: { password: secret },
    initial: "idle",
    states: { idle: { on: { RUN: "running" } }, running: {} },
  });
  actor = createActor(machine, {
    inspect(event) {
      if (!forwarding) return;
      // Project this trusted producer's toJSON values before the inert guard.
      const envelope = JSON.parse(
        JSON.stringify({
          ...event,
          sessionId: event.actorRef.sessionId,
          ...(event.type === "@xstate.actor"
            ? { definition: machine.toJSON() }
            : {}),
        }),
      );
      const serialized = guard.serializeInspection(envelope);
      if (serialized !== null) {
        assert(!serialized.includes(secret));
        ws.send(serialized);
      }
    },
  });
  ws.on("message", (raw) => {
    const command = JSON.parse(raw.toString());
    if (command.type !== "xstate-mcp.send") return;
    commandCount++;
    receivedTarget = command.sessionId;
    const result = guard.dispatch(actor, command);
    ws.send(
      JSON.stringify({
        type: "xstate-mcp.send.response",
        requestId: command.requestId,
        sessionId: command.sessionId,
        ...result,
      }),
    );
  });
  actor.start();
  const pong = once(ws, "pong");
  ws.ping();
  await pong;
  const { actors } = await tool("list_actors");
  assert.equal(actors.length, 1);
  const sessionId = actors[0].sessionId;
  assert.notEqual(sessionId, actor.sessionId);
  assert.equal(actors[0].localSessionId, actor.sessionId);
  assert.equal(actors[0].connectionId, hello.connectionId);
  const health = await tool("get_connection_health");
  assert.equal(health.connections[0].connectionId, hello.connectionId);
  assert.equal(health.connections[0].negotiation, "negotiated");
  assert.equal(health.connections[0].actorCount, 1);
  const before = await tool("get_actor_state", { sessionId });
  assert.equal(before.value, "idle");
  assert.equal(before.context.password, "[REDACTED]");
  assert.equal(before.output, null);
  assert.equal(before.error, null);
  const rejected = await client.callTool({
    name: "send_event",
    arguments: { target: sessionId, event: { type: "FORBIDDEN" } },
  });
  assert.equal(rejected.isError, true);
  assert.equal(rejected.structuredContent.code, "write_not_allowed");
  assert.equal(commandCount, 0);
  assert.equal(
    (
      await tool("send_event", {
        target: sessionId,
        event: { type: "RUN", token: secret },
      })
    ).success,
    true,
  );
  const state = await tool("wait_for_state", {
    sessionId,
    state: "running",
    after: before.cursor,
    timeoutMs: 2000,
  });
  assert.equal(state.outcome, "matched");
  assert.equal(state.snapshot.value, "running");
  assert.equal(state.snapshot.context.password, "[REDACTED]");
  const event = await tool("wait_for_event", {
    sessionId,
    eventType: "RUN",
    after: before.cursor,
    timeoutMs: 2000,
  });
  assert.equal(event.outcome, "matched");
  assert.equal(event.event.event.token, "[REDACTED]");
  assert.equal(commandCount, 1);
  assert.equal(receivedTarget, actor.sessionId);
  assert.equal(actor.getSnapshot().value, "running");
  assert.equal((await tool("get_actor_state", { sessionId })).value, "running");
  const resource = await client.readResource({
    uri: `xstate://actor/${sessionId}/snapshot`,
  });
  assert.equal(JSON.parse(resource.contents[0].text).value, "running");
  assert.equal(
    JSON.parse(resource.contents[0].text).context.password,
    "[REDACTED]",
  );
  console.log(
    `Installed CLI initialize ${pkg.version}; negotiated real XState idle → RUN → running verified with MCP waits`,
  );
} finally {
  forwarding = false;
  actor?.stop();
  ws?.terminate();
  child.stdin.end();
  const force = setTimeout(() => child.kill("SIGKILL"), 1000);
  exitResult = await closed;
  clearTimeout(force);
  clearTimeout(deadline);
  await client.close();
}
assert.deepEqual(
  exitResult,
  [0, null],
  "Installed CLI exits cleanly on stdin EOF",
);
assert(
  !stdout.includes(secret),
  "Inspection responses must redact fixture secrets",
);
const released = createServer();
await new Promise((done, reject) => {
  released.once("error", reject);
  released.listen(port, "127.0.0.1", done);
});
await new Promise((done) => released.close(done));
for (const line of stdout.trim().split("\n"))
  assert.equal(
    JSON.parse(line).jsonrpc,
    "2.0",
    "stdout must contain only MCP messages",
  );
