import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { MANIFEST_SCHEMAS } from "@anthropic-ai/mcpb";

export const here = dirname(fileURLToPath(import.meta.url));
export const defaultArtifacts = resolve(here, "../../artifacts/mcpb");
export const json = (file) => JSON.parse(readFileSync(file, "utf8"));
export const sha = (data) => createHash("sha256").update(data).digest("hex");
export const hashFile = (file) => sha(readFileSync(file));
export const writeJson = (file, value) =>
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
export function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}
export function validateManifest(manifest) {
  const provenance = json(resolve(here, "schema/provenance.json"));
  const file = resolve(here, "schema/manifest-v0.4.json");
  assert.equal(
    hashFile(file),
    provenance.sha256,
    "Vendored schema checksum changed",
  );
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(json(file));
  assert(validate(manifest), JSON.stringify(validate.errors));
  MANIFEST_SCHEMAS["0.4"].parse(manifest);
}
export function cliEntry(pkg) {
  const entry = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.["xstate-mcp"];
  assert(
    typeof entry === "string" &&
      /^dist\/[a-zA-Z0-9_./-]+\.js$/.test(entry) &&
      !entry.split("/").includes(".."),
    "Expected a relative dist/ CLI in package.bin",
  );
  return entry;
}
export function manifestFor(pkg) {
  cliEntry(pkg);
  const fields = {
    wsPort: {
      type: "number",
      title: "Inspection port",
      description:
        "Whole-number local WebSocket port. Give each MCP process its own port.",
      default: 7357,
      min: 1024,
      max: 65535,
    },
    wsHost: {
      type: "string",
      title: "Loopback address",
      description:
        "127.0.0.1 or ::1. The bundle accepts local inspection traffic only.",
      default: "127.0.0.1",
    },
    bufferSize: {
      type: "number",
      title: "History entries per actor",
      description:
        "Whole number from 1 to 10000. This is an entry limit, not a global memory budget.",
      default: 100,
      min: 1,
      max: 10000,
    },
    logLevel: {
      type: "string",
      title: "Log level",
      description: "debug, info, warn or error. Diagnostics use stderr.",
      default: "info",
    },
    allowedOrigins: {
      type: "string",
      title: "Allowed browser origins",
      description:
        "Comma-separated HTTP(S) origins; a wildcard port is supported.",
      default: "http://localhost:*,http://127.0.0.1:*",
    },
    requireOrigin: {
      type: "boolean",
      title: "Require an Origin header",
      description:
        "Reject inspection clients without an Origin header. Native adapters must supply an allowed origin.",
      default: true,
    },
  };
  const env = Object.fromEntries(
    Object.entries({
      WS_PORT: "wsPort",
      WS_HOST: "wsHost",
      BUFFER_SIZE: "bufferSize",
      LOG_LEVEL: "logLevel",
      ALLOWED_ORIGINS: "allowedOrigins",
      REQUIRE_ORIGIN: "requireOrigin",
    }).map(([key, value]) => [`XSTATE_MCP_${key}`, `\${user_config.${value}}`]),
  );
  return {
    manifest_version: "0.4",
    name: "xstate-mcp",
    display_name: "XState MCP",
    version: pkg.version,
    description:
      "Inspect and exercise local XState v5 applications through MCP.",
    author: { name: "Elias Andualem" },
    license: "MIT",
    repository: {
      type: "git",
      url: "https://github.com/eandualem/xstate-mcp.git",
    },
    homepage: "https://github.com/eandualem/xstate-mcp",
    support: "https://github.com/eandualem/xstate-mcp/issues",
    server: {
      type: "node",
      entry_point: "server/launch.mjs",
      mcp_config: {
        command: "node",
        args: ["${__dirname}/server/launch.mjs"],
        env,
      },
    },
    compatibility: {
      platforms: ["darwin", "linux"],
      runtimes: { node: "^22.0.0 || ^24.0.0" },
    },
    tools_generated: true,
    user_config: fields,
  };
}
