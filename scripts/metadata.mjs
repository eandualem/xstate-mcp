import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import addFormats from "ajv-formats";

const root = new URL("../", import.meta.url);
const read = (name) => JSON.parse(readFileSync(new URL(name, root), "utf8"));
const pkg = read("package.json");
const server = read("server.json");
if (process.argv.includes("--write")) {
  server.version = pkg.version;
  server.packages[0].version = pkg.version;
  writeFileSync(
    new URL("server.json", root),
    JSON.stringify(server, null, 2) + "\n",
  );
}
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
for (const source of read("schemas/sources.json")) {
  const bytes = readFileSync(new URL(`schemas/${source.file}`, root));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), source.sha256);
  const data = source.file.startsWith("mcp-") ? server : read("glama.json");
  assert.equal(data.$schema, source.url);
  const validate = ajv.compile(JSON.parse(bytes));
  assert(validate(data), JSON.stringify(validate.errors, null, 2));
}
assert.equal(
  server.version,
  pkg.version,
  "Run bun run metadata:sync after changing version",
);
assert.equal(server.name, pkg.mcpName);
assert.equal(server.packages.length, 1);
assert.equal(server.packages[0].version, pkg.version);
assert.equal(server.packages[0].identifier, pkg.name);
assert.equal(server.packages[0].registryType, "npm");
assert.deepEqual(server.packages[0].transport, { type: "stdio" });
assert.equal(
  server.repository.url,
  pkg.repository.url.replace(/^git\+/, "").replace(/\.git$/, ""),
);
assert.equal(
  readFileSync(new URL(".bun-version", root), "utf8").trim(),
  pkg.packageManager.split("@")[1],
);
assert.equal(pkg.exports["."].import, `./${pkg.main}`);
assert.equal(pkg.exports["."].types, `./${pkg.types}`);
for (const path of [pkg.main, pkg.types, ...Object.values(pkg.bin)]) {
  assert(
    /^dist\/[\w./-]+$/.test(path) && !path.includes(".."),
    `Invalid entry point: ${path}`,
  );
}
console.log(
  `Validated ${pkg.name}@${pkg.version} metadata in ${fileURLToPath(root)}`,
);
