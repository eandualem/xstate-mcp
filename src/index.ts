import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { Logger } from "./logger.js";
import { ActorStore } from "./actor-store.js";
import { ClientRegistry } from "./client-registry.js";
import { createWsServer } from "./ws-server.js";
import { createMcpServer } from "./mcp-server.js";

const SEND_EVENT_TIMEOUT_MS = 5000;

async function main() {
  const config = loadConfig();
  const logger = new Logger(config.logLevel);

  logger.info("xstate-mcp starting", {
    wsHost: config.wsHost,
    wsPort: config.wsPort,
    bufferSize: config.bufferSize,
    logLevel: config.logLevel,
  });

  const store = new ActorStore(config.bufferSize, logger);
  const clientRegistry = new ClientRegistry(SEND_EVENT_TIMEOUT_MS, logger);
  const wss = createWsServer({
    port: config.wsPort,
    host: config.wsHost,
    store,
    clientRegistry,
    logger,
    allowedOrigins: config.allowedOrigins,
    requireOrigin: config.requireOrigin,
  });
  const mcpServer = createMcpServer(store, clientRegistry, logger);

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  logger.info("MCP server connected via stdio");

  const shutdown = () => {
    logger.info("Shutting down...");
    wss.close(() => {
      logger.info("WebSocket server closed");
    });
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err}\n`);
  process.exit(1);
});
