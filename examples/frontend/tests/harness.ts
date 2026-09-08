import { test as base, expect, type Page } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer as createViteServer } from "vite";
import { createServer } from "node:net";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, join, basename } from "node:path";
import { createHash } from "node:crypto";
import { finishDemoRun } from "./teardown.js";
const frontend = resolve(import.meta.dirname, "..");
const repository = resolve(frontend, "../..");
export interface Actor {
  sessionId: string;
  localSessionId: string;
  connectionId: string | null;
  name: string;
  currentState: unknown;
}
interface Row {
  step: number;
  elapsedMs: number;
  kind: string;
  [key: string]: unknown;
}
async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No port assigned");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
export class Harness {
  readonly rows: Row[] = [];
  readonly aliases = new Map<string, string>();
  readonly available = new Set<string>();
  private started = performance.now();
  constructor(
    readonly client: Client,
    readonly url: string,
  ) {}
  record(kind: string, value: Record<string, unknown>) {
    this.rows.push({
      step: this.rows.length + 1,
      elapsedMs: Math.round(performance.now() - this.started),
      kind,
      ...value,
    });
  }
  async call(
    name: string,
    args: Record<string, unknown> = {},
    allowError = false,
  ): Promise<Record<string, unknown>> {
    const result = await this.client.callTool(
      { name, arguments: args },
      undefined,
      { timeout: 5000 },
    );
    this.record("mcp", { tool: name, arguments: args, result });
    if (!allowError)
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const content = result.structuredContent;
    if (content && typeof content === "object")
      return content as Record<string, unknown>;
    if (allowError) return { isError: result.isError, content: result.content };
    throw new Error(`Tool ${name} returned no structured content`);
  }
  async actors(): Promise<Actor[]> {
    return (await this.call("list_actors")).actors as Actor[];
  }
  async discover(
    label: string,
    exclude: string[] = [],
  ): Promise<{ root: Actor; document: Actor }> {
    let found: Actor[] = [];
    await expect
      .poll(async () => {
        found = (await this.actors()).filter(
          (a) => !exclude.includes(a.sessionId),
        );
        return found.filter((a) => a.name === "document").length;
      })
      .toBe(1);
    const root = found.find((a) => a.name === "workspace")!;
    const document = found.find((a) => a.name === "document")!;
    expect(root).toBeDefined();
    expect(root.connectionId).toEqual(expect.any(String));
    expect(document.connectionId).toBe(root.connectionId);
    for (const actor of [root, document]) {
      expect(actor.localSessionId).toEqual(expect.any(String));
      expect(actor.sessionId).not.toBe(actor.localSessionId);
    }
    this.aliases.set(root.sessionId, `${label}/workspace`);
    this.aliases.set(document.sessionId, `${label}/document`);
    this.aliases.set(root.localSessionId, `${label}/local/workspace`);
    this.aliases.set(document.localSessionId, `${label}/local/document`);
    this.aliases.set(root.connectionId!, `${label}/connection`);
    expect(
      await this.call("get_connection_health", {
        connectionId: root.connectionId,
      }),
    ).toMatchObject({
      listener: { state: "listening" },
      connections: [
        {
          connectionId: root.connectionId,
          negotiation: "negotiated",
          protocolVersion: 1,
          commands: ["send_event"],
          actorCount: 2,
        },
      ],
    });
    return { root, document };
  }
  async waitState(
    sessionId: string,
    value: string,
    after?: unknown,
  ): Promise<Record<string, unknown>> {
    const result = await this.call("wait_for_state", {
      sessionId,
      state: value,
      ...(after ? { after } : {}),
      timeoutMs: 4000,
    });
    expect(result.outcome).toBe("matched");
    expect(result.snapshot).toMatchObject({ value });
    return {
      ...(result.snapshot as Record<string, unknown>),
      cursor: result.cursor,
    };
  }
  async waitEvent(sessionId: string, eventType: string, after: unknown) {
    const result = await this.call("wait_for_event", {
      sessionId,
      eventType,
      after,
      timeoutMs: 4000,
    });
    expect(result.outcome).toBe("matched");
    expect(result.event).toMatchObject({ event: { type: eventType } });
    return result;
  }
  async screenshot(page: Page, file: string, label: string) {
    await page.screenshot({
      path: file,
      fullPage: true,
      animations: "disabled",
    });
    this.record("browser", {
      label,
      screenshot: basename(file),
      state: await page.locator("#actor-state").textContent(),
      title: await page.getByLabel("TITLE", { exact: true }).inputValue(),
    });
  }
  sanitized(value: unknown): unknown {
    if (typeof value === "string") {
      let result = value.replaceAll(
        "fixture-only-never-transfer-17",
        "[REDACTED]",
      );
      // Replace full public IDs before their embedded local/connection IDs.
      for (const [id, alias] of [...this.aliases].sort(
        ([left], [right]) => right.length - left.length,
      ))
        result = result.replaceAll(id, alias);
      return result;
    }
    if (Array.isArray(value))
      return value.map((entry) => this.sanitized(entry));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          key,
          /password|token|secret|authorization/i.test(key)
            ? "[REDACTED]"
            : this.sanitized(entry),
        ]),
      );
    return value;
  }
}
export const test = base.extend<{ demo: Harness }>({
  demo: async ({ browser }, use, info) => {
    const port = await freePort();
    const pkg = JSON.parse(
      await readFile(join(repository, "package.json"), "utf8"),
    );
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve(repository, pkg.bin["xstate-mcp"])],
      cwd: repository,
      stderr: "pipe",
      env: {
        ...env,
        XSTATE_MCP_WS_PORT: String(port),
        XSTATE_MCP_READ_ONLY: "false",
        XSTATE_MCP_REDACTION: '{"keys":["draftAccessToken"]}',
        XSTATE_MCP_LOG_LEVEL: "info",
        XSTATE_MCP_WRITE_ALLOW:
          '[{"actor":"*","events":["CHANGE_TITLE","CHANGE_BODY","SAVE","RETRY"]}]',
      },
    });
    let logs = "";
    transport.stderr?.on("data", (data) => {
      logs = (logs + data.toString()).slice(-20_000);
    });
    const client = new Client({
      name: "deterministic-frontend-verifier",
      version: "1",
    });
    const vite = await createViteServer({
      root: frontend,
      configFile: false,
      server: { host: "127.0.0.1", port: 0 },
      define: {
        "import.meta.env.VITE_XSTATE_MCP_URL": JSON.stringify(
          `ws://127.0.0.1:${port}`,
        ),
      },
      logLevel: "error",
    });
    let harness: Harness | undefined;
    try {
      await client.connect(transport);
      await expect.poll(() => logs).toContain("WebSocket server listening");
      await vite.listen();
      const address = vite.httpServer!.address();
      if (!address || typeof address === "string")
        throw new Error("Missing frontend address");
      harness = new Harness(client, `http://127.0.0.1:${address.port}`);
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(12);
      expect(client.getServerVersion()?.version).toBe(pkg.version);
      for (const tool of tools.tools) harness.available.add(tool.name);
      harness.record("initialize", {
        server: client.getServerVersion(),
        tools: tools.tools.map((tool) => tool.name),
        verification:
          "Real MCP stdio client with bounded state/event waits and browser assertions; no model calls",
      });
      await use(harness);
    } finally {
      const evidence = harness ?? new Harness(client, "");
      const teardown = await finishDemoRun({
        closeClient: () => client.close(),
        closeTransport: () => transport.close(),
        closeVite: () => vite.close(),
        probePort: async () => {
          const probe = createServer();
          await new Promise<void>((resolve, reject) => {
            probe.once("error", reject);
            probe.listen(port, "127.0.0.1", () =>
              probe.close((error) => (error ? reject(error) : resolve())),
            );
          });
        },
        sourceCommit: () =>
          execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: repository,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 5000,
          }).trim(),
        writeTranscript: async (observations) => {
          const sourceFiles = [
            "src/model.ts",
            "src/demo-inspector.ts",
            "src/main.ts",
            "src/style.css",
            "index.html",
            "tests/harness.ts",
            "tests/demo.spec.ts",
            "tests/teardown.ts",
            "tests/teardown.spec.ts",
          ];
          const sources = Object.fromEntries(
            await Promise.all(
              sourceFiles.map(async (file) => [
                file,
                createHash("sha256")
                  .update(await readFile(join(frontend, file)))
                  .digest("hex"),
              ]),
            ),
          );
          const packageJson = JSON.parse(
            await readFile(join(frontend, "package.json"), "utf8"),
          );
          const hashFiles = async (directory: string, files: string[]) =>
            Object.fromEntries(
              await Promise.all(
                files.sort().map(async (file) => [
                  file,
                  createHash("sha256")
                    .update(await readFile(join(directory, file)))
                    .digest("hex"),
                ]),
              ),
            );
          const serverSources = (
            await readdir(join(repository, "src"), { recursive: true })
          )
            .filter((file) => file.endsWith(".ts"))
            .map((file) => `src/${file}`);
          const artifacts = (await readdir(join(repository, "dist")))
            .filter((file) => file.endsWith(".js"))
            .map((file) => `dist/${file}`);
          const serverDependencies = Object.fromEntries(
            await Promise.all(
              Object.keys(pkg.dependencies).map(async (name) => {
                const installed = JSON.parse(
                  await readFile(
                    join(repository, "node_modules", name, "package.json"),
                    "utf8",
                  ),
                );
                return [name, installed.version];
              }),
            ),
          );
          const transcript = {
            schemaVersion: 3,
            scenario: info.title,
            generator:
              "Deterministic test client; not a live model/agent session",
            sourceCommit:
              observations.sourceCommit.status === "fulfilled"
                ? observations.sourceCommit.value
                : null,
            sourceHashes: sources,
            serverSourceHashes: await hashFiles(repository, [
              ...serverSources,
              "package.json",
              "bun.lock",
              "tsup.config.ts",
            ]),
            serverArtifactHashes: await hashFiles(repository, artifacts),
            serverDependencies,
            runtime: {
              node: process.version,
              browser: browser.version(),
              ...packageJson.dependencies,
              ...packageJson.devDependencies,
            },
            teardown: observations,
            steps: evidence.rows,
          };
          const file = info.outputPath("sanitized-transcript.json");
          await writeFile(
            file,
            JSON.stringify(evidence.sanitized(transcript), null, 2) + "\n",
          );
          await info.attach("sanitized MCP transcript", {
            path: file,
            contentType: "application/json",
          });
        },
      });
      expect(logs).not.toContain("fixture-only-never-transfer-17");
      for (const result of Object.values(teardown.cleanup))
        expect(result).toMatchObject({ status: "fulfilled" });
      expect(teardown.portReleased, JSON.stringify(teardown.portProbe)).toBe(
        true,
      );
    }
  },
});
export { expect };
