import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, onTestFinished } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
function fixture(version?: string) {
  const dir = mkdtempSync(resolve(tmpdir(), "xstate-release-validation-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  for (const file of [
    "scripts",
    "schemas",
    "package.json",
    "server.json",
    "glama.json",
    ".bun-version",
    "bun.lock",
    "docs/releases",
  ])
    cpSync(resolve(root, file), resolve(dir, file), { recursive: true });
  if (version !== undefined) {
    const path = resolve(dir, "package.json");
    const pkg = JSON.parse(readFileSync(path, "utf8"));
    pkg.version = version;
    writeFileSync(path, JSON.stringify(pkg));
  }
  symlinkSync(
    resolve(root, "node_modules"),
    resolve(dir, "node_modules"),
    "dir",
  );
  writeFileSync(resolve(dir, ".gitignore"), "node_modules/\nartifacts/\n");
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
  git("init", "-q");
  git("add", ".");
  git(
    "-c",
    "user.name=Release Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "fixture",
  );
  return {
    dir,
    git,
    run: (script: string, ...args: string[]) =>
      spawnSync(process.execPath, [resolve(dir, "scripts", script), ...args], {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, GITHUB_ACTIONS: "false" },
      }),
  };
}

it("rejects registry version drift and regenerates it from the package version", () => {
  const { dir, run } = fixture();
  const path = resolve(dir, "package.json");
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  pkg.version = "2.0.0-dev.1";
  writeFileSync(path, JSON.stringify(pkg));
  expect(run("metadata.mjs").status).not.toBe(0);
  expect(run("metadata.mjs", "--write").status).toBe(0);
  const server = JSON.parse(readFileSync(resolve(dir, "server.json"), "utf8"));
  expect(server.version).toBe(pkg.version);
  expect(server.packages[0].version).toBe(pkg.version);
});

it("rejects registry metadata outside the pinned current schema", () => {
  const { dir, run } = fixture();
  const path = resolve(dir, "server.json");
  const server = JSON.parse(readFileSync(path, "utf8"));
  server.repository = "https://github.com/eandualem/xstate-mcp";
  writeFileSync(path, JSON.stringify(server));
  expect(run("metadata.mjs").status).not.toBe(0);
});

it("refuses publication from a dirty checkout or a development version", () => {
  const { dir, run } = fixture("9.9.9-dev.0");
  expect(run("release.mjs", "guard").stderr).toContain(
    "Development/prerelease versions",
  );
  writeFileSync(resolve(dir, "unreviewed.txt"), "uncommitted change");
  expect(run("release.mjs", "guard").stderr).toContain(
    "Release requires a clean checkout",
  );
});

it("binds release evidence to source and rejects a replaced archive", () => {
  const { dir, git, run } = fixture();
  const pkg = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8"));
  const output = resolve(dir, "artifacts");
  mkdirSync(output);
  const archive = `${pkg.name}-${pkg.version}.tgz`;
  // A minimal archive is enough to test the independent verification boundary;
  // release:prepare separately checks contents and executes the actual package.
  const staging = resolve(output, "package");
  mkdirSync(staging);
  cpSync(resolve(dir, "package.json"), resolve(staging, "package.json"));
  execFileSync("tar", ["-czf", resolve(output, archive), "package"], {
    cwd: output,
  });
  for (const file of ["server.json", "glama.json"])
    cpSync(resolve(dir, file), resolve(output, file));
  cpSync(
    resolve(dir, "docs/releases", `${pkg.version}.md`),
    resolve(output, "release-notes.md"),
  );
  writeFileSync(resolve(output, "consumer-package-lock.json"), "{}");
  const hash = (file: string) =>
    createHash("sha256").update(readFileSync(file)).digest("hex");
  const manifest = {
    version: pkg.version,
    tag: `v${pkg.version}`,
    commit: git("rev-parse", "HEAD"),
    lockSha256: hash(resolve(dir, "bun.lock")),
    dirty: false,
    tarball: archive,
    files: Object.fromEntries(
      [
        archive,
        "server.json",
        "glama.json",
        "release-notes.md",
        "consumer-package-lock.json",
      ].map((file) => [file, hash(resolve(output, file))]),
    ),
  };
  const save = () =>
    writeFileSync(resolve(output, "release.json"), JSON.stringify(manifest));
  save();
  expect(run("release.mjs", "verify").status).toBe(0);
  manifest.commit = "0".repeat(40);
  save();
  expect(run("release.mjs", "verify").status).not.toBe(0);
  manifest.commit = git("rev-parse", "HEAD");
  save();
  writeFileSync(resolve(output, archive), "replaced artifact");
  expect(run("release.mjs", "verify").stderr).toContain(
    `Artifact changed: ${archive}`,
  );
});
