import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { packExtension } from "@anthropic-ai/mcpb";
import { unzipSync, zipSync } from "fflate";
import {
  cliEntry,
  hashFile,
  here,
  json,
  manifestFor,
  run,
  sha,
  validateManifest,
  writeJson,
} from "./common.mjs";

function inventory(directory, prefix = "") {
  for (const name of readdirSync(join(directory, prefix)).sort()) {
    const relative = prefix ? `${prefix}/${name}` : name;
    const file = join(directory, relative);
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) {
      // Executable shims are excluded by the MCPB packer; all runtime modules must be real files.
      assert(
        relative.startsWith("server/node_modules/.bin/"),
        `Unexpected symlink: ${relative}`,
      );
    } else if (stat.isDirectory()) inventory(directory, relative);
    else assert(stat.isFile(), `Unsupported bundle file: ${relative}`);
  }
}
export async function canonicalPack(stage, output) {
  assert(
    await packExtension({
      extensionPath: stage,
      outputPath: output,
      silent: true,
    }),
    "Official MCPB packing failed",
  );
  const data = unzipSync(readFileSync(output));
  const sorted = {};
  for (const name of Object.keys(data).sort()) {
    assert(
      !name.startsWith("/") &&
        !name.split("/").includes("..") &&
        !name.includes("\\"),
      `Invalid archive path: ${name}`,
    );
    assert(
      !/(^|\/)(\.git|\.env[^/]*|\.npmrc|\.backbone)(\/|$)/.test(name),
      `Private file in archive: ${name}`,
    );
    sorted[name] = [
      data[name],
      {
        os: 3,
        attrs:
          (name.endsWith("/launch.mjs") ||
          lstatSync(join(stage, name)).mode & 0o111
            ? 0o755
            : 0o644) << 16,
      },
    ];
  }
  // The upstream packer uses wall-clock ZIP times. Canonicalize its actual payload.
  writeFileSync(
    output,
    zipSync(sorted, { level: 9, mtime: new Date(2000, 0, 1) }),
  );
  return Object.fromEntries(
    Object.entries(data)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, bytes]) => [name, sha(bytes)]),
  );
}
export async function buildBundle({
  source = resolve(here, "../.."),
  output = resolve(source, "artifacts/mcpb"),
} = {}) {
  source = resolve(source);
  output = resolve(output);
  const pkg = json(join(source, "package.json"));
  assert.equal(pkg.name, "xstate-mcp");
  const entry = cliEntry(pkg);
  const manifest = manifestFor(pkg);
  validateManifest(manifest);
  assert.equal(run("bun", ["--version"]), "1.4.2", "Use pinned Bun 1.4.2");
  const sourceCommit = run("git", ["rev-parse", "HEAD"], { cwd: source });
  const sourceDirty = Boolean(
    run("git", ["status", "--porcelain"], { cwd: source }),
  );
  const scratch = mkdtempSync(join(tmpdir(), "xstate-mcp-mcpb-build-"));
  mkdirSync(output, { recursive: true });
  try {
    const archives = join(scratch, "archives");
    mkdirSync(archives);
    let tarball, npmHash;
    for (let iteration = 0; iteration < 2; iteration++) {
      run("bun", ["run", "build"], { cwd: source });
      const packed = JSON.parse(
        run(
          "npm",
          [
            "pack",
            "--ignore-scripts",
            "--json",
            "--pack-destination",
            archives,
            "--cache",
            join(scratch, "npm-cache"),
          ],
          { cwd: source },
        ),
      )[0];
      tarball = join(archives, packed.filename);
      assert(
        packed.files.every(
          ({ path }) =>
            !path.startsWith("/") && !path.split("/").includes(".."),
        ),
        "Unsafe npm package path",
      );
      const current = hashFile(tarball);
      if (iteration)
        assert.equal(
          current,
          npmHash,
          "Two clean builds produced different npm artifacts",
        );
      npmHash = current;
    }
    const install = join(scratch, "production");
    mkdirSync(install);
    cpSync(join(source, "package.json"), join(install, "package.json"));
    cpSync(join(source, "bun.lock"), join(install, "bun.lock"));
    run(
      "bun",
      [
        "install",
        "--production",
        "--frozen-lockfile",
        "--ignore-scripts",
        "--omit",
        "optional",
        "--linker=hoisted",
      ],
      { cwd: install },
    );
    const stage = join(scratch, "bundle");
    mkdirSync(stage);
    run("tar", ["-xzf", tarball, "-C", stage]);
    cpSync(join(stage, "package"), join(stage, "server"), { recursive: true });
    rmSync(join(stage, "package"), { recursive: true });
    cpSync(join(install, "node_modules"), join(stage, "server/node_modules"), {
      recursive: true,
      dereference: false,
    });
    for (const dependency of [
      "typescript",
      "vitest",
      "tsup",
      "tsx",
      "eslint",
      "@anthropic-ai/mcpb",
    ])
      assert(
        !existsSync(join(stage, "server/node_modules", dependency)),
        `Build dependency retained: ${dependency}`,
      );
    assert(
      existsSync(join(stage, "server", entry)),
      "CLI missing from npm artifact",
    );
    cpSync(join(here, "launch.mjs"), join(stage, "server/launch.mjs"));
    writeJson(join(stage, "manifest.json"), manifest);
    const provenance = {
      sourceCommit,
      sourceDirty,
      version: pkg.version,
      cli: entry,
      separateLibraryEntry: entry !== pkg.main,
      npmSha256: npmHash,
      sourceLockSha256: hashFile(join(source, "bun.lock")),
      toolLockSha256: hashFile(join(here, "bun.lock")),
      schema: json(join(here, "schema/provenance.json")),
      node: process.versions.node,
      bun: "1.4.2",
      launcherSha256: hashFile(join(here, "launch.mjs")),
      optionalDependencies: "omitted; pure-JavaScript WebSocket runtime",
    };
    writeJson(join(stage, "provenance.json"), provenance);
    inventory(stage);
    const bundle = join(output, `xstate-mcp-${pkg.version}.mcpb`);
    const files = await canonicalPack(stage, bundle);
    const repeated = join(scratch, "repeat.mcpb");
    await canonicalPack(stage, repeated);
    assert.equal(
      hashFile(bundle),
      hashFile(repeated),
      "MCPB output is not reproducible",
    );
    cpSync(tarball, join(output, basename(tarball)));
    const evidence = {
      ...provenance,
      bundle: basename(bundle),
      bundleSha256: hashFile(bundle),
      npmArtifact: basename(tarball),
      reproducibleNpm: true,
      reproducibleBundle: true,
      files,
      publication:
        "Not published. Verify the integrated release, matching MCP version, lifecycle and client gates before uploading.",
    };
    writeJson(join(output, "build-evidence.json"), evidence);
    return {
      bundle,
      evidence: join(output, "build-evidence.json"),
      fileCount: Object.keys(files).length,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { values } = parseArgs({
    options: { source: { type: "string" }, output: { type: "string" } },
  });
  console.log(JSON.stringify(await buildBundle(values), null, 2));
}
