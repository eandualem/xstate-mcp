import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ActorStore } from "./actor-store.js";
import type { ClientRegistry } from "./client-registry.js";
import type { Logger } from "./logger.js";
import { listActors } from "./tools/list-actors.js";
import { getActorState } from "./tools/get-actor-state.js";
import { getEventHistory } from "./tools/get-event-history.js";
import { getMachineDefinition } from "./tools/get-machine-definition.js";
import { clearActors } from "./tools/clear-actors.js";
import { getActorTree } from "./tools/get-actor-tree.js";
import { canHandleEvent } from "./tools/can-handle-event.js";
import { getStateTimeline } from "./tools/get-state-timeline.js";
import { sendEvent } from "./tools/send-event.js";

export function createMcpServer(
  store: ActorStore,
  clientRegistry: ClientRegistry,
  logger: Logger,
): McpServer {
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

  // --- Tier 1 tools ---

  server.registerTool(
    "clear_actors",
    {
      title: "Clear Actors",
      description:
        "Remove all actors from the registry. Useful for resetting state between debugging sessions.",
    },
    () => {
      logger.debug("Tool called: clear_actors");
      return clearActors(store);
    },
  );

  server.registerTool(
    "get_actor_tree",
    {
      title: "Get Actor Tree",
      description:
        "Get the hierarchical tree of all actors showing parent-child relationships, current states, and statuses.",
    },
    () => {
      logger.debug("Tool called: get_actor_tree");
      return getActorTree(store);
    },
  );

  server.registerTool(
    "can_handle_event",
    {
      title: "Can Handle Event",
      description:
        "Check whether an actor can handle a given event type in its current state. Performs static analysis of the machine definition — guards are not evaluated.",
      inputSchema: {
        sessionId: z
          .string()
          .describe("The actor's session ID (from list_actors)"),
        eventType: z
          .string()
          .describe("The event type to check (e.g. 'SUBMIT', 'user.click')"),
      },
    },
    ({ sessionId, eventType }) => {
      logger.debug(`Tool called: can_handle_event(${sessionId}, ${eventType})`);
      return canHandleEvent(store, sessionId, eventType);
    },
  );

  // --- Tier 2 tools ---

  server.registerTool(
    "get_state_timeline",
    {
      title: "Get State Timeline",
      description:
        "Get the history of state transitions for an actor, showing from/to state values and triggering events.",
      inputSchema: {
        sessionId: z
          .string()
          .describe("The actor's session ID (from list_actors)"),
        limit: z
          .number()
          .optional()
          .describe("Max transitions to return (default: 50)"),
      },
    },
    ({ sessionId, limit }) => {
      logger.debug(`Tool called: get_state_timeline(${sessionId}, ${limit})`);
      return getStateTimeline(store, sessionId, limit);
    },
  );

  // --- Tier 3 tools ---

  server.registerTool(
    "send_event",
    {
      title: "Send Event",
      description:
        "Send an event to an XState actor via the connected browser client. Target can be a sessionId or actor name. Requires the browser to have a response handler for 'xstate-mcp.send' messages.",
      inputSchema: {
        target: z
          .string()
          .describe(
            "Actor sessionId or name (name resolution tries sessionId first, then actor name)",
          ),
        event: z
          .object({ type: z.string() })
          .passthrough()
          .describe(
            "The event to send (must have a 'type' field, e.g. { type: 'SUBMIT', data: ... })",
          ),
      },
    },
    async ({ target, event }) => {
      logger.debug(`Tool called: send_event(${target}, ${event.type})`);
      return sendEvent(store, clientRegistry, target, event);
    },
  );

  logger.info("MCP server created with 9 tools registered");
  return server;
}
