import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import {
  readFileSync,
  mkdtempSync,
  mkdirSync,
  symlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocket } from "ws";
import { createActor, createMachine } from "xstate";
import { resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { describe, expect, inject, it, onTestFinished } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const cli = resolve(root, pkg.bin["xstate-mcp"]);

function launch(args: string[], env: Record<string, string> = {}, cwd = root) {
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: "pipe",
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise<{
    code: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) =>
      resolve({ code, signal, stdout, stderr }),
    );
  });
  onTestFinished(async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await exited;
  });
  return { child, exited };
}
async function within<T>(promise: Promise<T>, timeoutMs = 2000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error(`Process did not finish within ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}
async function occupiedPort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  onTestFinished(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  return address.port;
}

describe("built library and CLI lifecycle", () => {
  it("imports the library and capability factory without reading process configuration or touching stdio", async () => {
    const moduleUrl = pathToFileURL(resolve(root, "dist/index.js")).href;
    const { exited } = launch([
      "--input-type=module",
      "-e",
      `
      import assert from 'node:assert/strict';
      const before = [process.stdin.listenerCount('data'), process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
      process.env = new Proxy(process.env, { get(target, key) {
        if (String(key).startsWith('XSTATE_MCP_')) throw new Error('Factory read process configuration');
        return Reflect.get(target, key);
      }});
      const { default: factory, createSandboxServer, createInspectionServer } = await import(${JSON.stringify(moduleUrl)});
      assert.equal(factory, createSandboxServer);
      const bridge = createInspectionServer({ wsPort: 0, logLevel: 'error' });
      assert.equal(bridge.address, null);
      await bridge.close();
      const server = factory();
      await server.close();
      assert.deepEqual([process.stdin.listenerCount('data'), process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')], before);
      process.stdout.write('IMPORT_OK');
    `,
    ]);
    expect(await within(exited)).toMatchObject({
      code: 0,
      stdout: "IMPORT_OK",
      stderr: "",
    });
  });

  it("fails an occupied inspection port before answering MCP initialize", async () => {
    const port = await occupiedPort();
    const { child, exited } = launch([cli], {
      XSTATE_MCP_WS_PORT: String(port),
      XSTATE_MCP_WS_HOST: "127.0.0.1",
    });
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "startup-test", version: "1" },
        },
      }) + "\n",
    );
    const result = await within(exited);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("EADDRINUSE");
    expect(result.stderr).toContain(String(port));
  });
});

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
async function runningCli(executable = cli, env: Record<string, string> = {}) {
  const port = await freePort();
  const launched = launch([executable], {
    XSTATE_MCP_WS_PORT: String(port),
    XSTATE_MCP_WS_HOST: "127.0.0.1",
    XSTATE_MCP_LOG_LEVEL: "debug",
    ...env,
  });
  // SDK framing is symmetric: read child stdout and write child stdin, without
  // StdioClientTransport's automatic process kill masking a leaked CLI process.
  const transport = new StdioServerTransport(
    launched.child.stdout,
    launched.child.stdin,
  );
  const client = new Client({ name: "cli-lifecycle-test", version: "1" });
  void launched.exited.then(() => transport.close());
  onTestFinished(() => client.close());
  await client.connect(transport);
  return { ...launched, client, port };
}
async function assertReusable(port: number) {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("CLI shutdown with live applications", () => {
  it.each(["SIGINT", "SIGTERM", "EOF"] as const)(
    "closes open clients and pending sends on %s",
    async (trigger) => {
      const { child, exited, client, port } = await runningCli();
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      await once(ws, "open");
      onTestFinished(() => ws.terminate());
      const actor = createActor(
        createMachine({
          initial: "idle",
          states: { idle: { on: { RUN: "running" } }, running: {} },
        }),
        {
          inspect: (event) =>
            ws.send(
              JSON.stringify({ ...event, sessionId: event.actorRef.sessionId }),
            ),
        },
      );
      actor.start();
      const pong = once(ws, "pong");
      ws.ping();
      await pong;
      const actors = await client.callTool({
        name: "list_actors",
        arguments: {},
      });
      const [{ sessionId }] = (
        actors.structuredContent as { actors: { sessionId: string }[] }
      ).actors;
      const command = once(ws, "message");
      const pending = client
        .callTool({
          name: "send_event",
          arguments: { target: sessionId, event: { type: "RUN" } },
        })
        .catch((error: Error) => error);
      expect(JSON.parse((await command)[0].toString()).sessionId).toBe(
        actor.sessionId,
      );
      const wsClosed = once(ws, "close");
      if (trigger === "EOF") child.stdin.end();
      else child.kill(trigger);
      const result = await within(exited);
      expect(result).toMatchObject({ code: 0, signal: null });
      expect(result.stderr).not.toContain("Shutdown exceeded");
      for (const line of result.stdout.trim().split("\n"))
        expect(JSON.parse(line).jsonrpc).toBe("2.0");
      expect((await within(wsClosed))[0]).toBe(1001);
      await within(pending);
      await assertReusable(port);
    },
  );

  it("forces a client that ignores the close handshake and tolerates repeated shutdown triggers", async () => {
    const { child, exited, port } = await runningCli();
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await once(ws, "open");
    onTestFinished(() => ws.terminate());
    ws.pause(); // Do not process or acknowledge the server's close frame.
    const start = performance.now();
    child.kill("SIGTERM");
    child.kill("SIGINT");
    child.stdin.end();
    expect(await within(exited)).toMatchObject({ code: 0, signal: null });
    expect(performance.now() - start).toBeLessThan(1500);
    ws.terminate();
    await assertReusable(port);
  });

  it("exits cleanly when stdin is already at EOF during startup", async () => {
    const port = await freePort();
    const { child, exited } = launch([cli], {
      XSTATE_MCP_WS_PORT: String(port),
    });
    child.stdin.end();
    expect(await within(exited)).toMatchObject({ code: 0, signal: null });
    await assertReusable(port);
  });
});

it("uses the packed library exports, type declarations, and executable", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "xstate-mcp-packed-"));
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  const packageRoot = resolve(directory, "node_modules/xstate-mcp");
  mkdirSync(packageRoot, { recursive: true });
  execFileSync("tar", [
    "-xzf",
    inject("packedCliArchive"),
    "-C",
    packageRoot,
    "--strip-components=1",
  ]);
  // Exercise only the packed xstate-mcp files; reuse exact installed dependencies.
  for (const dependency of ["@modelcontextprotocol", "ws", "zod", "@types"]) {
    symlinkSync(
      resolve(root, "node_modules", dependency),
      resolve(directory, "node_modules", dependency),
      "dir",
    );
  }
  const pkg = JSON.parse(
    readFileSync(resolve(packageRoot, "package.json"), "utf8"),
  );
  expect(pkg.exports["."].import).toBe("./dist/index.js");
  expect(pkg.exports["."].types).toBe("./dist/index.d.ts");
  expect(pkg.bin["xstate-mcp"]).toBe("dist/cli.js");
  const executable = resolve(packageRoot, pkg.bin["xstate-mcp"]);
  expect(statSync(executable).mode & 0o111).not.toBe(0);
  expect(
    readFileSync(executable, "utf8").startsWith("#!/usr/bin/env node\n"),
  ).toBe(true);
  expect(
    readFileSync(resolve(packageRoot, pkg.main), "utf8").startsWith("#!"),
  ).toBe(false);
  const { exited } = launch(
    [
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    import createSandboxServer, { createInspectionServer } from 'xstate-mcp';
    import { Client } from '@modelcontextprotocol/sdk/client/index.js';
    import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
    const server = createSandboxServer();
    const client = new Client({ name: 'packed-scanner', version: '1' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    assert.equal((await client.listTools()).tools.length, 9);
    assert.equal((await client.listPrompts()).prompts.length, 3);
    await client.close(); await server.close();
    const bridge = createInspectionServer({ wsPort: 0, logLevel: 'error' });
    assert.equal(bridge.address, null);
    assert.equal(bridge.close(), bridge.close());
    await bridge.closed;
    process.stdout.write('PACK_OK');
  `,
    ],
    { XSTATE_MCP_WS_PORT: "invalid", XSTATE_MCP_BUFFER_SIZE: "invalid" },
    directory,
  );
  expect(await within(exited)).toMatchObject({
    code: 0,
    stdout: "PACK_OK",
    stderr: "",
  });
  const consumer = resolve(directory, "consumer.mts");
  writeFileSync(
    consumer,
    `
    import createSandboxServer, { createInspectionServer, type InspectionServer } from 'xstate-mcp';
    const bridge: InspectionServer = createInspectionServer({ wsPort: 0 });
    await bridge.close();
    await createSandboxServer().close();
  `,
  );
  execFileSync(
    process.execPath,
    [
      resolve(root, "node_modules/typescript/bin/tsc"),
      "--noEmit",
      "--strict",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--target",
      "ES2022",
      "--skipLibCheck",
      consumer,
    ],
    { cwd: directory, stdio: "pipe" },
  );
  const {
    child,
    exited: cliExited,
    port,
    client,
  } = await runningCli(executable);
  expect((await client.listTools()).tools).toHaveLength(9);
  child.stdin.end();
  expect(await within(cliExited)).toMatchObject({ code: 0, signal: null });
  await assertReusable(port);
});

it("bounds EOF shutdown even when the MCP client stops reading a large response", async () => {
  const { child, exited, port } = await runningCli();
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await once(ws, "open");
  onTestFinished(() => ws.terminate());
  ws.send(
    JSON.stringify({
      type: "@xstate.actor",
      sessionId: "large",
      snapshot: {
        value: "idle",
        context: { text: "x".repeat(2 * 1024 * 1024) },
      },
    }),
  );
  const pong = once(ws, "pong");
  ws.ping();
  await pong;
  child.stdout.pause();
  child.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: "large-response",
      method: "tools/call",
      params: { name: "get_actor_state", arguments: { sessionId: "large" } },
    }) + "\n",
  );
  child.stdin.end();
  const result = await within(exited, 2500);
  expect(result).toMatchObject({ code: 1, signal: null });
  expect(result.stderr).toContain("forcing exit (stdio may be blocked)");
  await assertReusable(port);
});
