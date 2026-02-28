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

  return { wsPort, bufferSize, logLevel };
}
