import {
  createRedactor,
  createWritePolicy,
  type RedactionOptions,
  type WritePolicyOptions,
} from "./inspection-policy.js";
import type { Config, LogLevel } from "./types.js";

const LOG_LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

export function loadConfig(): Config {
  const wsPort = parseInt(process.env.XSTATE_MCP_WS_PORT ?? "7357", 10);
  const bufferSize = parseInt(process.env.XSTATE_MCP_BUFFER_SIZE ?? "100", 10);
  const logLevelRaw = (
    process.env.XSTATE_MCP_LOG_LEVEL ?? "info"
  ).toLowerCase();
  const logLevel: LogLevel = LOG_LEVELS.includes(logLevelRaw as LogLevel)
    ? (logLevelRaw as LogLevel)
    : "info";

  if (isNaN(wsPort) || wsPort < 1 || wsPort > 65535) {
    throw new Error(
      `Invalid XSTATE_MCP_WS_PORT: ${process.env.XSTATE_MCP_WS_PORT}`,
    );
  }

  if (isNaN(bufferSize) || bufferSize < 1) {
    throw new Error(
      `Invalid XSTATE_MCP_BUFFER_SIZE: ${process.env.XSTATE_MCP_BUFFER_SIZE}`,
    );
  }

  const wsHost = process.env.XSTATE_MCP_WS_HOST ?? "127.0.0.1";

  const allowedOriginsRaw = process.env.XSTATE_MCP_ALLOWED_ORIGINS;
  const allowedOrigins = allowedOriginsRaw
    ? allowedOriginsRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : ["http://localhost:*", "http://127.0.0.1:*"];

  const requireOrigin =
    process.env.XSTATE_MCP_REQUIRE_ORIGIN?.toLowerCase() === "true";

  const readOnlyRaw = process.env.XSTATE_MCP_READ_ONLY ?? "true";
  if (readOnlyRaw !== "true" && readOnlyRaw !== "false")
    throw new Error("XSTATE_MCP_READ_ONLY must be true or false");
  const parseJson = (name: string, fallback: unknown): unknown => {
    if (process.env[name] === undefined) return fallback;
    try {
      return JSON.parse(process.env[name]!);
    } catch {
      throw new Error(`Invalid JSON in ${name}`);
    }
  };
  const writePolicy: WritePolicyOptions = {
    readOnly: readOnlyRaw === "true",
    allow: parseJson(
      "XSTATE_MCP_WRITE_ALLOW",
      [],
    ) as WritePolicyOptions["allow"],
  };
  const redaction = parseJson("XSTATE_MCP_REDACTION", {}) as RedactionOptions;
  createWritePolicy(writePolicy);
  createRedactor(redaction);

  return {
    writePolicy,
    redaction,
    wsPort,
    wsHost,
    bufferSize,
    logLevel,
    allowedOrigins,
    requireOrigin,
  };
}
