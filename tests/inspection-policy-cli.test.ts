import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const nodeEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  ),
);
beforeAll(async () => {
  await run(process.execPath, ["node_modules/tsup/dist/cli-default.js"], {
    cwd: root,
    timeout: 30_000,
  });
}, 35_000);

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing address");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

describe("built CLI and development policy example", () => {
  it("imports the policy subpath without starting a server and bundles for a browser", async () => {
    const imported = await run(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import {createInspectionGuard} from "xstate-mcp/inspection-policy"; if (createInspectionGuard().enabled) process.exit(1);',
      ],
      { cwd: root, timeout: 3000 },
    );
    expect(imported.stdout).toBe("");
    expect(imported.stderr).toBe("");
    await run(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import {build} from "esbuild"; await build({entryPoints:["dist/inspection-policy.js"], bundle:true, platform:"browser", write:false});',
      ],
      { cwd: root, timeout: 3000 },
    );
  });

  it.each([undefined, "production"])(
    "does not instrument the example for NODE_ENV=%s",
    async (mode) => {
      const env = { ...nodeEnv };
      if (mode === undefined) delete env.NODE_ENV;
      else env.NODE_ENV = mode;
      const result = await run(process.execPath, ["examples/policy-app.mjs"], {
        cwd: root,
        env,
        timeout: 3000,
      });
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe("");
    },
  );

  it.each([true, false])(
    "runs the real example through MCP stdio with readOnly=%s",
    async (readOnly) => {
      const port = await freePort();
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ["dist/index.js"],
        cwd: root,
        stderr: "pipe",
        env: {
          ...nodeEnv,
          XSTATE_MCP_WS_PORT: String(port),
          XSTATE_MCP_READ_ONLY: String(readOnly),
          XSTATE_MCP_WRITE_ALLOW: '[{"actor":"*","events":["NEXT","RESET"]}]',
          XSTATE_MCP_REDACTION: '{"paths":[["context","count"]]}',
        },
      });
      const client = new Client({ name: "policy-cli-test", version: "1" });
      let app: ChildProcess | undefined;
      let stderr = "";
      transport.stderr?.on("data", (data) => {
        stderr += data.toString();
      });
      try {
        await client.connect(transport);
        app = spawn(process.execPath, ["examples/policy-app.mjs"], {
          cwd: root,
          env: {
            ...nodeEnv,
            NODE_ENV: "development",
            XSTATE_MCP_WS_PORT: String(port),
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let ready = "";
        app.stderr!.on("data", (data) => {
          ready += data.toString();
        });
        await expect
          .poll(() => ready, { timeout: 5000 })
          .toContain("Policy demo ready");
        const result = await client.callTool({
          name: "send_event",
          arguments: { target: "policy-demo", event: { type: "NEXT" } },
        });
        expect(result.structuredContent).toMatchObject({
          success: !readOnly,
          ...(readOnly ? { code: "read_only" } : {}),
        });
        const actors = await client.callTool({
          name: "list_actors",
          arguments: {},
        });
        expect(actors.isError, JSON.stringify(actors)).not.toBe(true);
        const sessionId = (
          actors.structuredContent as { actors: { sessionId: string }[] }
        ).actors[0].sessionId;
        const snapshot = await client.callTool({
          name: "get_actor_state",
          arguments: { sessionId },
        });
        expect(snapshot.structuredContent).toMatchObject({
          value: readOnly ? "idle" : "ready",
          context: {
            password: "[REDACTED]",
            email: "[REDACTED]",
            count: "[REDACTED]",
          },
        });
        if (!readOnly) {
          const denied = await client.callTool({
            name: "send_event",
            arguments: { target: sessionId, event: { type: "RESET" } },
          });
          expect(denied.isError).toBe(true);
          expect(denied.structuredContent).toMatchObject({
            success: false,
            code: "write_not_allowed",
          });
        }
        expect(stderr).not.toContain("demo-secret");
        expect(stderr).not.toContain("demo@example.test");
      } finally {
        if (app) await stop(app);
        await client.close();
        await transport.close();
      }
    },
  );
});
