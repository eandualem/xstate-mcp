import { ActorStore } from "./actor-store.js";
import { ClientRegistry } from "./client-registry.js";
import { Logger } from "./logger.js";
import { createMcpServer } from "./mcp-server.js";

export { createInspectionServer } from "./inspection-server.js";
export type {
  InspectionServer,
  InspectionServerOptions,
} from "./inspection-server.js";
export { ActorStore, ClientRegistry, Logger, createMcpServer };

/** Import-safe capability scanning: no environment, ports, or stdio. */
export function createSandboxServer() {
  const logger = new Logger("error");
  return createMcpServer(
    new ActorStore(100, logger),
    new ClientRegistry(5000, logger),
    logger,
  );
}
export default createSandboxServer;
