import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { hashFile, json, run } from "./common.mjs";
import { verifyArchive } from "./verify.mjs";

export function assertReady(build, reports, currentCommit) {
  assert.equal(
    build.sourceCommit,
    currentCommit,
    "Candidate source does not match the reviewed checkout",
  );
  assert.equal(build.sourceDirty, false, "Rebuild from a clean commit");
  assert.match(
    build.version,
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/,
    "A reviewed stable version is required",
  );
  for (const major of [22, 24]) {
    const report = reports.find((r) => Number(r.node.split(".")[0]) === major);
    assert(report, `Missing Node ${major} clean-client verification`);
    assert.equal(report.status, "passed");
    assert.equal(
      report.bundleSha256,
      build.bundleSha256,
      "Verification used a different bundle",
    );
    assert.equal(
      report.sourceCommit,
      build.sourceCommit,
      "Verification used a different source",
    );
    assert.equal(
      report.versionMatches,
      true,
      "MCP and package versions differ (#8)",
    );
    assert.equal(
      report.separateLibraryEntry,
      true,
      "CLI/library split must be integrated (#5)",
    );
    assert.equal(
      report.libraryImportSafe,
      true,
      "Installed library import was not verified",
    );
    assert.equal(
      report.exitsOnEof,
      true,
      "Graceful EOF shutdown must be integrated (#5)",
    );
    assert.equal(report.portReleased, true);
    assert.deepEqual(report.remainingReleaseGates, []);
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const dir = resolve(process.argv[2] ?? "artifacts/mcpb");
  const { readdirSync } = await import("node:fs");
  const build = json(join(dir, "build-evidence.json"));
  verifyArchive(join(dir, build.bundle), build);
  assert.equal(
    hashFile(join(dir, build.npmArtifact)),
    build.npmSha256,
    "npm artifact changed",
  );
  const reports = readdirSync(dir)
    .filter((name) => /^verification-.*\.json$/.test(name))
    .map((name) => json(join(dir, name)));
  assertReady(build, reports, run("git", ["rev-parse", "HEAD"]));
  assert.equal(
    run("git", ["status", "--porcelain"]),
    "",
    "Checkout changed since verification",
  );
  console.log(
    "MCPB local release gates pass. Complete the integrated release and supported-client review before a separate maintainer upload.",
  );
}
