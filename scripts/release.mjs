import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const run = (command, args) =>
  execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const hash = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const pkg = json(resolve(root, "package.json"));
const output = resolve(root, "artifacts");
const mode = process.argv[2];

function verify() {
  const manifest = json(resolve(output, "release.json"));
  assert.equal(manifest.version, pkg.version);
  if (process.env.GITHUB_ACTIONS === "true")
    assert.equal(
      manifest.dirty,
      false,
      "CI artifacts must come from a clean checkout",
    );
  assert.equal(manifest.commit, run("git", ["rev-parse", "HEAD"]));
  assert.equal(manifest.lockSha256, hash(resolve(root, "bun.lock")));
  assert.equal(manifest.tag, `v${pkg.version}`);
  assert.equal(manifest.tarball, `${pkg.name}-${pkg.version}.tgz`);
  for (const [file, digest] of Object.entries(manifest.files)) {
    assert(!file.includes("/") && file !== "..", "Invalid artifact filename");
    assert.equal(
      hash(resolve(output, file)),
      digest,
      `Artifact changed: ${file}`,
    );
  }
  for (const required of [
    manifest.tarball,
    "server.json",
    "glama.json",
    "release-notes.md",
    "consumer-package-lock.json",
  ]) {
    assert(manifest.files[required], `Missing artifact digest: ${required}`);
  }
  // Tie publication metadata to the checked-out source as well as the uploaded manifest.
  for (const file of ["server.json", "glama.json"])
    assert.equal(hash(resolve(output, file)), hash(resolve(root, file)));
  const notes = resolve(root, "docs/releases", `${pkg.version}.md`);
  assert.equal(hash(resolve(output, "release-notes.md")), hash(notes));
  const packed = JSON.parse(
    run("tar", [
      "-xOf",
      resolve(output, manifest.tarball),
      "package/package.json",
    ]),
  );
  assert.deepEqual(packed, pkg);
  console.log(`Verified ${manifest.tarball} from ${manifest.commit}`);
  return manifest;
}

async function guard() {
  assert.equal(
    run("git", ["status", "--porcelain", "--untracked-files=normal"]),
    "",
    "Release requires a clean checkout",
  );
  assert(
    /^\d+\.\d+\.\d+$/.test(pkg.version),
    "Development/prerelease versions cannot be published by this workflow",
  );
  assert.equal(process.env.GITHUB_REPOSITORY, "eandualem/xstate-mcp");
  assert.equal(
    process.env.GITHUB_REF,
    `refs/tags/v${pkg.version}`,
    "Dispatch from the matching maintainer-created tag",
  );
  assert.equal(process.env.GITHUB_SHA, run("git", ["rev-parse", "HEAD"]));
  run("git", ["merge-base", "--is-ancestor", "HEAD", "origin/main"]);
  assert.notEqual(
    pkg.bin[pkg.name],
    pkg.main,
    "Integrate the import-safe factory/CLI boundary (#5) before publishing",
  );
  assert(
    pkg.scripts["audit:check"],
    "Integrate the audited runtime/CI baseline (#6/#7) before publishing",
  );
  assert(
    existsSync(resolve(root, "docs/releases", `${pkg.version}.md`)),
    "Commit release notes first",
  );
  const response = await fetch(`https://registry.npmjs.org/${pkg.name}`, {
    signal: AbortSignal.timeout(15000),
  });
  assert(
    response.ok,
    `Cannot verify npm version availability: HTTP ${response.status}`,
  );
  const registry = await response.json();
  assert.equal(registry.name, pkg.name, "Unexpected npm registry record");
  assert(
    registry.versions && typeof registry.versions === "object",
    "Missing npm version history",
  );
  assert(
    !registry.versions[pkg.version],
    `${pkg.version} is already published; never overwrite or republish it`,
  );
  console.log(`Release preflight passed for v${pkg.version}`);
}

if (mode === "guard") {
  await guard();
} else if (mode === "verify") {
  verify();
} else if (mode === "prepare") {
  run(process.execPath, [resolve(root, "scripts/metadata.mjs")]);
  const scratch = mkdtempSync(resolve(tmpdir(), "xstate-mcp-pack-"));
  try {
    const packs = [];
    for (let pass = 0; pass < 2; pass++) {
      const destination = resolve(scratch, String(pass));
      mkdirSync(destination);
      // tsup cleans dist, so the second archive comes from a fresh build.
      run(process.execPath, [
        resolve(root, "node_modules/tsup/dist/cli-default.js"),
      ]);
      const [pack] = JSON.parse(
        run("npm", [
          "pack",
          "--ignore-scripts",
          "--json",
          "--pack-destination",
          destination,
        ]),
      );
      assert.equal(pack.version, pkg.version);
      const paths = new Set(pack.files.map((file) => file.path));
      for (const entry of [
        "README.md",
        "LICENSE",
        "package.json",
        pkg.main,
        pkg.types,
        ...Object.values(pkg.bin),
      ])
        assert(paths.has(entry), `Missing package entry: ${entry}`);
      for (const file of pack.files) {
        assert(
          file.path.startsWith("dist/") ||
            ["README.md", "LICENSE", "package.json"].includes(file.path),
          `Unexpected package file: ${file.path}`,
        );
        if (Object.values(pkg.bin).includes(file.path))
          assert(file.mode & 0o111, "Packed CLI must be executable");
      }
      packs.push(resolve(destination, pack.filename));
    }
    assert.equal(
      hash(packs[0]),
      hash(packs[1]),
      "Fresh builds produced different package bytes",
    );
    mkdirSync(output, { recursive: true });
    const tarball = `${pkg.name}-${pkg.version}.tgz`;
    cpSync(packs[0], resolve(output, tarball));
    for (const file of ["server.json", "glama.json"])
      cpSync(resolve(root, file), resolve(output, file));
    cpSync(
      resolve(root, "docs/releases", `${pkg.version}.md`),
      resolve(output, "release-notes.md"),
    );
    console.log(
      run(process.execPath, [
        resolve(root, "scripts/package-smoke.mjs"),
        resolve(output, tarball),
        output,
      ]),
    );
    const files = Object.fromEntries(
      [
        tarball,
        "server.json",
        "glama.json",
        "release-notes.md",
        "consumer-package-lock.json",
      ].map((file) => [file, hash(resolve(output, file))]),
    );
    writeFileSync(
      resolve(output, "release.json"),
      JSON.stringify(
        {
          version: pkg.version,
          tag: `v${pkg.version}`,
          commit: run("git", ["rev-parse", "HEAD"]),
          dirty:
            run("git", [
              "status",
              "--porcelain",
              "--untracked-files=normal",
            ]) !== "",
          lockSha256: hash(resolve(root, "bun.lock")),
          node: process.version,
          npm: run("npm", ["--version"]),
          bun: run("bun", ["--version"]),
          tarball,
          files,
        },
        null,
        2,
      ) + "\n",
    );
    verify();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
} else {
  throw new Error("Usage: node scripts/release.mjs prepare|verify|guard");
}
