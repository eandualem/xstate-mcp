import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { getMcpConfigForManifest, unpackExtension } from "@anthropic-ai/mcpb";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocket } from "ws";
import { createActor, createMachine } from "xstate";
import { unzipSync } from "fflate";
import {
  defaultArtifacts,
  hashFile,
  json,
  run,
  sha,
  validateManifest,
  writeJson,
} from "./common.mjs";

async function poll(fn, label, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await delay(25);
  }
  throw new Error(`Timed out: ${label}`);
}
async function reserve() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((done) => server.close(done));
  return port;
}
export function verifyArchive(bundle, evidence) {
  assert.equal(
    hashFile(bundle),
    evidence.bundleSha256,
    "Bundle checksum mismatch",
  );
  const files = unzipSync(readFileSync(bundle));
  assert.deepEqual(
    Object.keys(files).sort(),
    Object.keys(evidence.files).sort(),
    "Bundle inventory changed",
  );
  for (const [name, bytes] of Object.entries(files))
    assert.equal(
      sha(bytes),
      evidence.files[name],
      `Changed bundle file: ${name}`,
    );
  const provenance = JSON.parse(
    Buffer.from(files["provenance.json"]).toString(),
  );
  for (const key of [
    "sourceCommit",
    "sourceDirty",
    "npmSha256",
    "sourceLockSha256",
    "toolLockSha256",
  ])
    assert.deepEqual(
      provenance[key],
      evidence[key],
      `Provenance mismatch: ${key}`,
    );
}
export async function verifyBundle(
  bundle,
  evidencePath = join(dirname(bundle), "build-evidence.json"),
) {
  bundle = resolve(bundle);
  const build = json(evidencePath);
  verifyArchive(bundle, build);
  const installed = mkdtempSync(join(tmpdir(), "xstate-mcp-mcpb-client-"));
  const report = {
    sourceCommit: build.sourceCommit,
    bundleSha256: build.bundleSha256,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    client:
      "@modelcontextprotocol/sdk@1.30.0 with @anthropic-ai/mcpb@2.1.2 loader",
    packageVersion: build.version,
    calls: [],
    status: "running",
  };
  let child, client, socket, actor, closed;
  let stdout = "",
    stderr = "",
    forwarding = true,
    exitResult;
  const timer = setTimeout(() => child?.kill("SIGKILL"), 25_000);
  const transcriptFile = join(
    dirname(bundle),
    `verification-${process.platform}-node${process.versions.node}.json`,
  );
  try {
    assert(
      await unpackExtension({
        mcpbPath: bundle,
        outputDir: installed,
        silent: true,
      }),
    );
    const manifest = json(join(installed, "manifest.json"));
    validateManifest(manifest);
    const port = await reserve();
    report.port = port;
    const config = await getMcpConfigForManifest({
      manifest,
      extensionPath: installed,
      systemDirs: { HOME: installed },
      userConfig: {
        wsPort: port,
        bufferSize: 3,
        logLevel: "debug",
        allowedOrigins: "http://127.0.0.1:45678",
        requireOrigin: true,
      },
      pathSeparator: sep,
    });
    assert(config);
    assert.equal(config.command, "node");
    assert.equal(config.env.XSTATE_MCP_WS_PORT, String(port));
    assert.equal(config.env.XSTATE_MCP_REQUIRE_ORIGIN, "true");
    assert.equal(config.args[0], join(installed, "server/launch.mjs"));
    const env = {
      PATH: dirname(process.execPath),
      HOME: installed,
      NODE_PATH: "",
      ...config.env,
      // Harmless on old sources; required once #31/#32 are integrated.
      XSTATE_MCP_READ_ONLY: "false",
      XSTATE_MCP_WRITE_ALLOW: '[{"actor":"*","events":["RUN"]}]',
    };
    report.configuration = {
      ...config,
      args: ["${install}/server/launch.mjs"],
    };
    // Invalid numeric text must fail before importing the real server, on every source version.
    try {
      run(process.execPath, config.args, {
        cwd: installed,
        env: { ...env, XSTATE_MCP_WS_PORT: `${port}junk` },
        timeout: 2000,
      });
      assert.fail("Invalid port unexpectedly started");
    } catch (error) {
      assert.equal(error.status, 1);
      assert.match(String(error.stderr), /must be a whole number/);
    }
    report.invalidConfigRejected = true;
    const pkg = json(join(installed, "server/package.json"));
    const entry = typeof pkg.bin === "string" ? pkg.bin : pkg.bin["xstate-mcp"];
    report.separateLibraryEntry = entry !== pkg.main;
    if (report.separateLibraryEntry) {
      const library = pathToFileURL(join(installed, "server", pkg.main)).href;
      const code = `const m = await import(${JSON.stringify(library)}); if (typeof m.createInspectionServer !== 'function') throw Error('Missing factory'); await m.createSandboxServer().close();`;
      run(process.execPath, ["--input-type=module", "-e", code], {
        cwd: installed,
        env,
        timeout: 3000,
      });
      report.libraryImportSafe = true;
    }
    child = spawn(process.execPath, config.args, {
      cwd: installed,
      env,
      stdio: "pipe",
    });
    closed = new Promise((done) => {
      child.once("close", (code, signal) => {
        exitResult = { code, signal };
        done(exitResult);
      });
    });
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    client = new Client({ name: "clean-mcpb-consumer", version: "1.0.0" });
    client.onerror = () => {}; // Failure assertions below own the evidence and teardown.
    await client.connect(new StdioServerTransport(child.stdout, child.stdin));
    report.initialize = client.getServerVersion();
    report.versionMatches = report.initialize.version === build.version;
    const tools = await client.listTools();
    report.tools = tools.tools.map((t) => t.name);
    const call = async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args });
      report.calls.push({ name, arguments: args, result });
      assert(!result.isError, JSON.stringify(result));
      return JSON.parse(result.content[0].text);
    };
    await poll(
      () => stderr.includes("WebSocket server listening"),
      "bundle listener",
    );
    // The installed manifest's exact-origin/required-origin settings must reach the real server.
    const denied = new WebSocket(`ws://127.0.0.1:${port}`);
    const rejected = await new Promise((done, reject) => {
      denied.once("open", () => {
        denied.terminate();
        reject(new Error("Missing Origin accepted"));
      });
      denied.once("unexpected-response", (_request, response) => {
        response.resume();
        denied.terminate();
        done(response.statusCode);
      });
      denied.on("error", reject);
    });
    assert.equal(rejected, 403);
    report.missingOriginRejected = true;
    socket = new WebSocket(`ws://127.0.0.1:${port}`, {
      origin: "http://127.0.0.1:45678",
    });
    await once(socket, "open", { signal: AbortSignal.timeout(5000) });
    if (report.tools.includes("get_connection_health")) {
      const response = once(socket, "message", {
        signal: AbortSignal.timeout(5000),
      });
      socket.send(
        JSON.stringify({
          type: "xstate-mcp.hello",
          protocolVersion: 1,
          application: { name: "bundle-fixture" },
          adapter: { name: "bundle-fixture", version: "1.0.0" },
          capabilities: { commands: ["send_event"] },
        }),
      );
      assert.equal(JSON.parse((await response)[0].toString()).success, true);
    }
    const machine = createMachine({
      id: "bundle-fixture",
      initial: "idle",
      states: { idle: { on: { RUN: "running" } }, running: {} },
    });
    actor = createActor(machine, {
      inspect(event) {
        if (
          !forwarding ||
          !["@xstate.actor", "@xstate.event", "@xstate.snapshot"].includes(
            event.type,
          )
        )
          return;
        socket.send(
          JSON.stringify({
            ...event,
            sessionId: event.actorRef.sessionId,
            timestamp: Date.now(),
            ...(event.type === "@xstate.actor"
              ? { definition: machine.toJSON() }
              : {}),
          }),
        );
      },
    });
    socket.on("message", (data) => {
      const command = JSON.parse(data.toString());
      if (command.type !== "xstate-mcp.send") return;
      const success =
        command.sessionId === actor.sessionId && command.event?.type === "RUN";
      if (success) actor.send(command.event);
      socket.send(
        JSON.stringify({
          type: "xstate-mcp.send.response",
          requestId: command.requestId,
          sessionId: command.sessionId,
          success,
        }),
      );
    });
    actor.start();
    const actors = await poll(async () => {
      const value = await call("list_actors");
      return value.actors.length === 1 && value.actors;
    }, "actor discovery");
    const sessionId = actors[0].sessionId;
    assert.equal((await call("get_actor_state", { sessionId })).value, "idle");
    assert.equal(
      (await call("send_event", { target: sessionId, event: { type: "RUN" } }))
        .success,
      true,
    );
    assert.equal(actor.getSnapshot().value, "running");
    await poll(
      async () =>
        (await call("get_actor_state", { sessionId })).value === "running",
      "state after send",
    );
    const resource = await client.readResource({
      uri: `xstate://actor/${sessionId}/snapshot`,
    });
    assert.equal(JSON.parse(resource.contents[0].text).value, "running");
    report.resourceVerified = true;
    forwarding = false;
    actor.stop();
    socket.terminate();
    child.stdin.end();
    report.exitsOnEof = Boolean(
      await Promise.race([
        closed.then(() => true),
        delay(750).then(() => false),
      ]),
    );
    if (!exitResult) child.kill("SIGTERM");
    await Promise.race([
      closed,
      delay(2000).then(() => {
        throw new Error("Bundle did not stop on SIGTERM");
      }),
    ]);
    assert.equal(exitResult.code, 0);
    report.shutdown = exitResult;
    const rebind = createServer();
    rebind.listen(port, "127.0.0.1");
    await once(rebind, "listening");
    await new Promise((done) => rebind.close(done));
    report.portReleased = true;
    for (const line of stdout.trim().split("\n"))
      assert.equal(JSON.parse(line).jsonrpc, "2.0", "Non-MCP stdout");
    report.status = "passed";
    report.remainingReleaseGates = [
      !report.versionMatches && "MCP/package version mismatch (#8)",
      !report.separateLibraryEntry && "CLI/library split (#5)",
      !report.exitsOnEof && "stdin EOF shutdown (#5)",
      build.sourceDirty && "Source checkout is dirty",
    ].filter(Boolean);
    return report;
  } catch (error) {
    report.status = "failed";
    report.error = String(error);
    throw error;
  } finally {
    clearTimeout(timer);
    forwarding = false;
    actor?.stop();
    socket?.terminate();
    if (child && !exitResult) {
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 1000);
      await closed;
      clearTimeout(force);
    }
    try {
      await client?.close();
    } finally {
      report.stderr = stderr;
      writeJson(transcriptFile, report);
      rmSync(installed, { recursive: true, force: true });
    }
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const bundle =
    process.argv[2] ??
    resolve(
      defaultArtifacts,
      json(join(defaultArtifacts, "build-evidence.json")).bundle,
    );
  const report = await verifyBundle(bundle, process.argv[3]);
  console.log(
    JSON.stringify(
      {
        status: report.status,
        runtime: report.node,
        remainingReleaseGates: report.remainingReleaseGates,
      },
      null,
      2,
    ),
  );
}
