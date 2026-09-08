import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    packedCliArchive: string;
  }
}

/** Build and pack before parallel suites inspect or launch the shared dist files. */
export default function buildCli(project: TestProject): () => void {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const directory = mkdtempSync(resolve(tmpdir(), "xstate-mcp-build-"));
  const cleanup = () => rmSync(directory, { recursive: true, force: true });
  try {
    execFileSync(
      process.execPath,
      [resolve(root, "node_modules/tsup/dist/cli-default.js")],
      { cwd: root, stdio: "pipe", timeout: 30000 },
    );
    // npm 10 can still run prepare despite --ignore-scripts. Pack before workers
    // start, and keep lifecycle output off stdout so --json stays machine-readable.
    const pack = JSON.parse(
      execFileSync(
        "npm",
        [
          "--cache",
          resolve(directory, "npm-cache"),
          "pack",
          "--ignore-scripts",
          "--foreground-scripts=false",
          "--json",
          "--pack-destination",
          directory,
        ],
        { cwd: root, encoding: "utf8", timeout: 30000 },
      ),
    );
    project.provide("packedCliArchive", resolve(directory, pack[0].filename));
    return cleanup;
  } catch (error) {
    cleanup();
    throw error;
  }
}
