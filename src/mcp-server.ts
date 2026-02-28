import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ActorStore } from "./actor-store.js";
import type { Logger } from "./logger.js";
import { listActors } from "./tools/list-actors.js";
import { getActorState } from "./tools/get-actor-state.js";
import { getEventHistory } from "./tools/get-event-history.js";
import { getMachineDefinition } from "./tools/get-machine-definition.js";

export function createMcpServer(store: ActorStore, logger: Logger): McpServer {
  const server = new McpServer({
    name: "xstate-mcp",
    version: "1.0.0",
  });

  server.registerTool(
    "list_actors",
    {
      title: "List Actors",
      description:
        "List all registered XState actors with summary information including current state, status, and child count.",
    },
    () => {
      logger.debug("Tool called: list_actors");
      return listActors(store);
    },
  );

  server.registerTool(
    "get_actor_state",
    {
      title: "Get Actor State",
      description:
        "Get the full current snapshot for a specific XState actor, including state value, context, and status.",
      inputSchema: {
        sessionId: z
          .string()
          .describe("The actor's session ID (from list_actors)"),
      },
    },
    ({ sessionId }) => {
      logger.debug(`Tool called: get_actor_state(${sessionId})`);
      return getActorState(store, sessionId);
    },
  );

  server.registerTool(
    "get_event_history",
    {
      title: "Get Event History",
      description:
        "Get recent events for an XState actor from the ring buffer. Returns events in chronological order.",
      inputSchema: {
        sessionId: z
          .string()
          .describe("The actor's session ID (from list_actors)"),
        limit: z
          .number()
          .optional()
          .describe("Max events to return (default: 20)"),
      },
    },
    ({ sessionId, limit }) => {
      logger.debug(`Tool called: get_event_history(${sessionId}, ${limit})`);
      return getEventHistory(store, sessionId, limit);
    },
  );

  server.registerTool(
    "get_machine_definition",
    {
      title: "Get Machine Definition",
      description:
        "Get the XState machine's JSON definition including states, transitions, guards, and actions.",
      inputSchema: {
        sessionId: z
          .string()
          .describe("The actor's session ID (from list_actors)"),
      },
    },
    ({ sessionId }) => {
      logger.debug(`Tool called: get_machine_definition(${sessionId})`);
      return getMachineDefinition(store, sessionId);
    },
  );

  logger.info("MCP server created with 4 tools registered");
  return server;
}
