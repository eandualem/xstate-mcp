import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const tarball = resolve(
  process.argv[2] ?? `artifacts/${pkg.name}-${pkg.version}.tgz`,
);
const consumer = mkdtempSync(resolve(tmpdir(), "xstate-mcp-consumer-"));
try {
  // No workspace symlinks or development dependencies. XState is the consuming app.
  cpSync(tarball, resolve(consumer, "candidate.tgz"));
  writeFileSync(
    resolve(consumer, "package.json"),
    JSON.stringify(
      {
        name: "xstate-mcp-clean-consumer",
        private: true,
        type: "module",
        dependencies: {
          "xstate-mcp": "file:candidate.tgz",
          xstate: pkg.devDependencies.xstate,
        },
      },
      null,
      2,
    ),
  );
  execFileSync(
    "npm",
    ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: consumer, stdio: "inherit", timeout: 120000 },
  );
  const installed = JSON.parse(
    readFileSync(
      resolve(consumer, "node_modules/xstate-mcp/package.json"),
      "utf8",
    ),
  );
  assert.equal(installed.version, pkg.version);
  cpSync(
    resolve(root, "scripts/consumer-fixture.mjs"),
    resolve(consumer, "smoke.mjs"),
  );
  execFileSync(process.execPath, ["smoke.mjs"], {
    cwd: consumer,
    stdio: "inherit",
    timeout: 20000,
  });
  if (process.argv[3])
    cpSync(
      resolve(consumer, "package-lock.json"),
      resolve(process.argv[3], "consumer-package-lock.json"),
    );
  console.log(`Clean consumer passed: ${pkg.name}@${pkg.version}`);
} finally {
  rmSync(consumer, { recursive: true, force: true });
}
