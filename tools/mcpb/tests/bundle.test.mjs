import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getMcpConfigForManifest } from "@anthropic-ai/mcpb";
import {
  hashFile,
  here,
  manifestFor,
  run,
  validateManifest,
  writeJson,
} from "../common.mjs";
import { canonicalPack } from "../build.mjs";
import { assertReady } from "../release-check.mjs";
import { verifyArchive } from "../verify.mjs";

const pkg = {
  name: "xstate-mcp",
  version: "1.2.3",
  main: "dist/index.js",
  bin: { "xstate-mcp": "dist/cli.js" },
};
const env = {
  XSTATE_MCP_WS_PORT: "7357",
  XSTATE_MCP_WS_HOST: "127.0.0.1",
  XSTATE_MCP_BUFFER_SIZE: "100",
  XSTATE_MCP_LOG_LEVEL: "error",
  XSTATE_MCP_ALLOWED_ORIGINS: "http://localhost:*",
  XSTATE_MCP_REQUIRE_ORIGIN: "true",
};
test("official loader substitutes numeric, boolean and absolute path configuration", async () => {
  const manifest = manifestFor(pkg);
  validateManifest(manifest);
  const config = await getMcpConfigForManifest({
    manifest,
    extensionPath: "/clean install",
    systemDirs: {},
    userConfig: { wsPort: 9999, requireOrigin: false },
    pathSeparator: "/",
  });
  assert.deepEqual(config.args, ["/clean install/server/launch.mjs"]);
  assert.equal(config.env.XSTATE_MCP_WS_PORT, "9999");
  assert.equal(config.env.XSTATE_MCP_REQUIRE_ORIGIN, "false");
  assert.equal(config.env.XSTATE_MCP_BUFFER_SIZE, "100");
  assert.throws(() =>
    validateManifest({ ...manifest, manifest_version: "9.0" }),
  );
});
test("bundle launcher chooses the actual CLI and rejects bad configuration before import", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcpb-launch-test-"));
  try {
    cpSync(join(here, "launch.mjs"), join(dir, "launch.mjs"));
    mkdirSync(join(dir, "dist"));
    writeJson(join(dir, "package.json"), { ...pkg, type: "module" });
    writeFileSync(
      join(dir, "dist/cli.js"),
      'process.stdout.write("CLI started");',
    );
    writeFileSync(
      join(dir, "dist/index.js"),
      'throw Error("Library must not launch");',
    );
    assert.equal(
      run(process.execPath, ["launch.mjs"], { cwd: dir, env }),
      "CLI started",
    );
    for (const override of [
      { XSTATE_MCP_WS_PORT: "7357junk" },
      { XSTATE_MCP_WS_PORT: "7357.5" },
      { XSTATE_MCP_WS_PORT: "65536" },
      { XSTATE_MCP_WS_PORT: "0" },
      { XSTATE_MCP_BUFFER_SIZE: "-1" },
      { XSTATE_MCP_BUFFER_SIZE: "10001" },
      { XSTATE_MCP_WS_HOST: "0.0.0.0" },
      { XSTATE_MCP_LOG_LEVEL: "verbose" },
      { XSTATE_MCP_REQUIRE_ORIGIN: "yes" },
      {
        XSTATE_MCP_ALLOWED_ORIGINS:
          "https://example.com/private?token=synthetic",
      },
    ]) {
      assert.throws(
        () =>
          run(process.execPath, ["launch.mjs"], {
            cwd: dir,
            env: { ...env, ...override },
          }),
        (error) =>
          error.status === 1 && !String(error.stdout).includes("CLI started"),
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("canonical bundle preserves payload across packs and excludes private files and rejects tampering", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcpb-pack-test-"));
  try {
    const stage = join(dir, "stage");
    mkdirSync(stage);
    writeJson(join(stage, "manifest.json"), manifestFor(pkg));
    writeJson(join(stage, "provenance.json"), { sourceCommit: "fixture" });
    const output = join(dir, "one.mcpb");
    const repeated = join(dir, "two.mcpb");
    const files = await canonicalPack(stage, output);
    await canonicalPack(stage, repeated);
    assert.equal(hashFile(output), hashFile(repeated));
    const evidence = {
      bundleSha256: hashFile(output),
      files,
      sourceCommit: "fixture",
    };
    verifyArchive(output, evidence);
    writeFileSync(output, "tampered");
    assert.throws(() => verifyArchive(output, evidence), /checksum/);
    writeFileSync(join(stage, ".env"), "FAKE_SECRET=do-not-bundle");
    const filtered = await canonicalPack(stage, repeated);
    assert(!Object.keys(filtered).includes(".env"));
    assert.equal(hashFile(repeated), evidence.bundleSha256);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("release gate rejects unintegrated runtime, different artifacts, dirty and prerelease sources", () => {
  const build = {
    sourceCommit: "reviewed",
    sourceDirty: false,
    version: "1.2.3",
    bundleSha256: "same",
  };
  const reports = [22, 24].map((major) => ({
    node: `${major}.0.0`,
    status: "passed",
    sourceCommit: "reviewed",
    bundleSha256: "same",
    versionMatches: true,
    separateLibraryEntry: true,
    libraryImportSafe: true,
    exitsOnEof: true,
    portReleased: true,
    remainingReleaseGates: [],
  }));
  assertReady(build, reports, "reviewed");
  assert.throws(
    () => assertReady({ ...build, sourceDirty: true }, reports, "reviewed"),
    /clean/,
  );
  assert.throws(
    () =>
      assertReady({ ...build, version: "1.2.3-dev.0" }, reports, "reviewed"),
    /stable/,
  );
  assert.throws(() => assertReady(build, reports, "different"), /checkout/);
  for (const field of [
    "versionMatches",
    "separateLibraryEntry",
    "libraryImportSafe",
    "exitsOnEof",
    "portReleased",
  ])
    assert.throws(() =>
      assertReady(
        build,
        [{ ...reports[0], [field]: false }, reports[1]],
        "reviewed",
      ),
    );
  assert.throws(
    () =>
      assertReady(
        build,
        [{ ...reports[0], bundleSha256: "different" }, reports[1]],
        "reviewed",
      ),
    /different bundle/,
  );
  assert.throws(() => assertReady(build, [reports[0]], "reviewed"), /Node 24/);
});
