import { actorIdentity } from "./actor-identity.js";
import {
  connectionHealthOutputSchema,
  MAX_HEALTH_CONNECTIONS,
} from "./connection-health.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ActorStore } from "./actor-store.js";
import type { ClientRegistry } from "./client-registry.js";
import type { Logger } from "./logger.js";
import { listActors, listActorsOutputSchema } from "./tools/list-actors.js";
import {
  getActorState,
  getActorStateOutputSchema,
} from "./tools/get-actor-state.js";
import {
  getEventHistory,
  getEventHistoryOutputSchema,
} from "./tools/get-event-history.js";
import {
  getMachineDefinition,
  getMachineDefinitionOutputSchema,
} from "./tools/get-machine-definition.js";
import { clearActors, clearActorsOutputSchema } from "./tools/clear-actors.js";
import {
  getActorTree,
  getActorTreeOutputSchema,
} from "./tools/get-actor-tree.js";
import {
  canHandleEvent,
  canHandleEventOutputSchema,
} from "./tools/can-handle-event.js";
import {
  getStateTimeline,
  getStateTimelineOutputSchema,
} from "./tools/get-state-timeline.js";
import { sendEvent, sendEventOutputSchema } from "./tools/send-event.js";
import { debugActor } from "./prompts/debug-actor.js";
import { explainMachine } from "./prompts/explain-machine.js";
import { traceEventFlow } from "./prompts/trace-event-flow.js";
import { safeStringify } from "./safe-stringify.js";
import { actorSnapshotData } from "./actor-snapshot.js";
import {
  ActorWaits,
  waitForStateInputSchema,
  waitForEventInputSchema,
  waitOutputSchema,
} from "./actor-waits.js";

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export function createMcpServer(
  store: ActorStore,
  clientRegistry: ClientRegistry,
  logger: Logger,
): McpServer {
  const server = new McpServer({
    name: "xstate-mcp",
    version: "1.0.0",
  });
  const waits = new ActorWaits(store);

  // --- Tools ---

  server.registerTool(
    "get_connection_health",
    {
      title: "Connection Health",
      description:
        "Diagnose the inspection listener, connected applications, capability negotiation, rejected frames and freshness. Contains bounded metadata and counters, never actor payloads. Start here when list_actors is empty or before send_event.",
      inputSchema: {
        limit: z.number().int().min(1).max(MAX_HEALTH_CONNECTIONS).optional(),
        connectionId: z.string().uuid().optional(),
        offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
      },
      outputSchema: connectionHealthOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    ({ limit, connectionId, offset }) => {
      const structuredContent = clientRegistry.getHealth(
        limit,
        connectionId,
        offset,
      );
      return {
        content: [
          { type: "text" as const, text: safeStringify(structuredContent, 2) },
        ],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "list_actors",
    {
      title: "List Actors",
      description:
        "List all registered XState actors with summary information including current state, status, and child count.",
      inputSchema: {
        connectionId: z
          .string()
          .optional()
          .describe(
            "Filter to an application connection from list_actors. Reconnects get a new ID.",
          ),
        status: z
          .enum(["active", "done", "stopped", "error"])
          .optional()
          .describe("Filter actors by status. Omit to return all actors."),
      },
      outputSchema: listActorsOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    ({ status, connectionId }) => {
      logger.debug(`Tool called: list_actors(status=${status ?? "all"})`);
      return listActors(store, status, connectionId);
    },
  );

  server.registerTool(
    "get_actor_state",
    {
      title: "Get Actor State",
      description:
        "Get the current snapshot for a specific XState actor, including state value, context, status, output, and sanitized error details.",
      inputSchema: {
        sessionId: z
          .string()
          .describe(
            "The actor's opaque, connection-scoped sessionId from list_actors (not localSessionId)",
          ),
        excludeContext: z
          .boolean()
          .optional()
          .describe(
            "If true, replaces context with '[excluded]' to reduce output size",
          ),
        contextMaxChars: z
          .number()
          .optional()
          .describe(
            "Truncate serialized context to this many characters. Adds '[truncated, full size: N]' suffix.",
          ),
      },
      outputSchema: getActorStateOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    ({ sessionId, excludeContext, contextMaxChars }) => {
      logger.debug(`Tool called: get_actor_state(${sessionId})`);
      return getActorState(store, sessionId, {
        excludeContext,
        contextMaxChars,
      });
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
          .describe(
            "The actor's opaque, connection-scoped sessionId from list_actors (not localSessionId)",
          ),
        limit: z
          .number()
          .optional()
          .describe("Max events to return (default: 20)"),
      },
      outputSchema: getEventHistoryOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
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
          .describe(
            "The actor's opaque, connection-scoped sessionId from list_actors (not localSessionId)",
          ),
      },
      outputSchema: getMachineDefinitionOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
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
        "Discard retained inspection data and pending commands. Does not stop application actors. Available in application read-only mode.",
      outputSchema: clearActorsOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    () => {
      logger.debug("Tool called: clear_actors");
      return clearActors(store, clientRegistry);
    },
  );

  server.registerTool(
    "get_actor_tree",
    {
      title: "Get Actor Tree",
      description:
        "Get the hierarchical tree of all actors showing parent-child relationships, current states, and statuses.",
      inputSchema: {
        connectionId: z
          .string()
          .optional()
          .describe("Filter to an application connection from list_actors."),
      },
      outputSchema: getActorTreeOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    ({ connectionId }) => {
      logger.debug("Tool called: get_actor_tree");
      return getActorTree(store, connectionId);
    },
  );

  server.registerTool(
    "can_handle_event",
    {
      title: "Can Handle Event",
      description:
        "Inspect static event eligibility in the current snapshot using XState v5 event precedence. canHandle is true/false for structural evidence, or null when unknown (including guards or missing data). Guards are never executed; a match does not guarantee a runtime transition.",
      inputSchema: {
        sessionId: z
          .string()
          .describe(
            "The actor's opaque, connection-scoped sessionId from list_actors (not localSessionId)",
          ),
        eventType: z
          .string()
          .describe("The event type to check (e.g. 'SUBMIT', 'user.click')"),
      },
      outputSchema: canHandleEventOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
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
        "Get bounded history of state, context, and lifecycle changes for an actor, including changed fields, from/to statuses, results, and triggering events.",
      inputSchema: {
        sessionId: z
          .string()
          .describe(
            "The actor's opaque, connection-scoped sessionId from list_actors (not localSessionId)",
          ),
        limit: z
          .number()
          .optional()
          .describe("Max transitions to return (default: 50)"),
      },
      outputSchema: getStateTimelineOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    ({ sessionId, limit }) => {
      logger.debug(`Tool called: get_state_timeline(${sessionId}, ${limit})`);
      return getStateTimeline(store, sessionId, limit);
    },
  );

  server.registerTool(
    "wait_for_state",
    {
      title: "Wait for Actor State",
      description:
        "Wait for an exact state value, status, or both. Provide at least one predicate. With an after cursor, only a newer snapshot can match; otherwise the current snapshot may match immediately. No guards/actions or sends are executed.",
      inputSchema: waitForStateInputSchema,
      outputSchema: waitOutputSchema,
      annotations: { ...READ_ONLY_ANNOTATIONS, idempotentHint: false },
    },
    (input, extra) => waits.waitForState(input, extra.signal),
  );
  server.registerTool(
    "wait_for_event",
    {
      title: "Wait for Actor Event",
      description:
        "Wait for an exact event type observed after a cursor. Without after, only future events match. With after, retained history is checked first; evicted history returns history_lost. Observing an event does not prove a transition.",
      inputSchema: waitForEventInputSchema,
      outputSchema: waitOutputSchema,
      annotations: { ...READ_ONLY_ANNOTATIONS, idempotentHint: false },
    },
    (input, extra) => waits.waitForEvent(input, extra.signal),
  );

  // --- Tier 3 tools ---

  server.registerTool(
    "send_event",
    {
      title: "Send Event",
      description:
        "Send an application event (may cause destructive external side effects). Requires negotiated send_event support and explicit server and adapter write permission. Target can be a sessionId or actor name. Success acknowledges dispatch only; verify the resulting state separately.",
      inputSchema: {
        target: z
          .string()
          .describe(
            "Opaque sessionId from list_actors, or a unique actor name. Duplicate names require the exact sessionId.",
          ),
        event: z
          .object({ type: z.string() })
          .passthrough()
          .describe(
            "The event to send (must have a 'type' field, e.g. { type: 'SUBMIT', data: ... })",
          ),
      },
      outputSchema: sendEventOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ target, event }) => {
      logger.debug(`Tool called: send_event(${target}, ${event.type})`);
      return sendEvent(store, clientRegistry, target, event);
    },
  );

  // --- Resources ---

  server.registerResource(
    "actors",
    "xstate://actors",
    {
      description: "List of all registered XState actors",
      mimeType: "application/json",
    },
    () => {
      const actors = store.listActors().map((actor) => ({
        sessionId: actor.sessionId,
        ...actorIdentity(actor),
        name: actor.name,
        currentState: actor.currentSnapshot?.value ?? null,
        status: actor.currentSnapshot?.status ?? "unknown",
      }));

      return {
        contents: [
          {
            uri: "xstate://actors",
            mimeType: "application/json",
            text: safeStringify(actors, 2),
          },
        ],
      };
    },
  );

  const snapshotTemplate = new ResourceTemplate(
    "xstate://actor/{sessionId}/snapshot",
    {
      list: () => {
        return {
          resources: store.listActors().map((actor) => ({
            uri: `xstate://actor/${actor.sessionId}/snapshot`,
            name: `${actor.name} snapshot`,
            description: `Current state of ${actor.name} (${actor.sessionId})`,
            mimeType: "application/json",
          })),
        };
      },
      complete: {
        sessionId: (value: string) => {
          const actors = store.listActors();
          return actors
            .filter(
              (a) => a.sessionId.startsWith(value) || a.name.startsWith(value),
            )
            .map((a) => a.sessionId);
        },
      },
    },
  );

  server.registerResource(
    "actor_snapshot",
    snapshotTemplate,
    {
      description: "Current state snapshot of a specific XState actor",
      mimeType: "application/json",
    },
    (_uri, variables) => {
      const sessionId = String(variables.sessionId);
      const actor = store.getActor(sessionId);
      if (!actor) {
        return {
          contents: [
            {
              uri: `xstate://actor/${sessionId}/snapshot`,
              mimeType: "application/json",
              text: JSON.stringify({ error: `Actor not found: ${sessionId}` }),
            },
          ],
        };
      }

      return {
        contents: [
          {
            uri: `xstate://actor/${sessionId}/snapshot`,
            mimeType: "application/json",
            text: safeStringify(actorSnapshotData(actor), 2),
          },
        ],
      };
    },
  );

  const definitionTemplate = new ResourceTemplate(
    "xstate://actor/{sessionId}/definition",
    {
      list: () => {
        return {
          resources: store
            .listActors()
            .filter((a) => a.definition !== null)
            .map((actor) => ({
              uri: `xstate://actor/${actor.sessionId}/definition`,
              name: `${actor.name} definition`,
              description: `Machine definition for ${actor.name} (${actor.sessionId})`,
              mimeType: "application/json",
            })),
        };
      },
      complete: {
        sessionId: (value: string) => {
          const actors = store.listActors();
          return actors
            .filter(
              (a) => a.sessionId.startsWith(value) || a.name.startsWith(value),
            )
            .map((a) => a.sessionId);
        },
      },
    },
  );

  server.registerResource(
    "actor_definition",
    definitionTemplate,
    {
      description: "Machine definition of a specific XState actor",
      mimeType: "application/json",
    },
    (_uri, variables) => {
      const sessionId = String(variables.sessionId);
      const actor = store.getActor(sessionId);
      if (!actor) {
        return {
          contents: [
            {
              uri: `xstate://actor/${sessionId}/definition`,
              mimeType: "application/json",
              text: JSON.stringify({ error: `Actor not found: ${sessionId}` }),
            },
          ],
        };
      }

      return {
        contents: [
          {
            uri: `xstate://actor/${sessionId}/definition`,
            mimeType: "application/json",
            text: safeStringify(
              {
                sessionId: actor.sessionId,
                ...actorIdentity(actor),
                name: actor.name,
                definition: actor.definition,
              },
              2,
            ),
          },
        ],
      };
    },
  );

  // --- Resource subscription notifications ---

  let disposed = false;
  const notifySnapshot = (sessionId: string) => {
    if (disposed || !server.isConnected()) return;
    void server.server
      .sendResourceUpdated({
        uri: `xstate://actor/${sessionId}/snapshot`,
      })
      .catch(() => logger.debug("Resource notification transport closed"));
  };
  const notifyList = () => {
    if (!disposed && server.isConnected()) {
      void server.server
        .sendResourceListChanged()
        .catch(() =>
          logger.debug("Resource-list notification could not be delivered"),
        );
    }
  };
  const unsubscribe = [
    store.onActorRegistered((sessionId) => {
      notifyList();
      notifySnapshot(sessionId);
    }),
    store.onSnapshotUpdated(notifySnapshot),
    store.onActorRemoved(notifyList),
    store.onCleared(notifyList),
  ];
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    waits.dispose();
    for (const remove of unsubscribe) remove();
  };
  const originalClose = server.close.bind(server);
  let closing: Promise<void> | undefined;
  server.close = () => {
    dispose();
    return (closing ??= Promise.resolve().then(originalClose));
  };
  const originalConnect = server.connect.bind(server);
  server.connect = async (transport) => {
    if (disposed)
      throw new Error("MCP server is closed; create a new instance");
    await originalConnect(transport);
  };
  server.server.onclose = dispose;

  // --- Prompts ---

  server.registerPrompt(
    "debug_actor",
    {
      title: "Debug Actor",
      description:
        "Analyze an XState actor for state consistency issues, missed transitions, and context validity.",
      argsSchema: {
        sessionId: z.string().describe("The actor's session ID to debug"),
      },
    },
    ({ sessionId }) => {
      return debugActor(store, sessionId);
    },
  );

  server.registerPrompt(
    "explain_machine",
    {
      title: "Explain Machine",
      description:
        "Explain an XState machine's states, transitions, guards, and current position in plain language.",
      argsSchema: {
        sessionId: z.string().describe("The actor's session ID to explain"),
      },
    },
    ({ sessionId }) => {
      return explainMachine(store, sessionId);
    },
  );

  server.registerPrompt(
    "trace_event_flow",
    {
      title: "Trace Event Flow",
      description:
        "Trace the sequence of events and state transitions for an XState actor, explaining each step.",
      argsSchema: {
        sessionId: z.string().describe("The actor's session ID to trace"),
      },
    },
    ({ sessionId }) => {
      return traceEventFlow(store, sessionId);
    },
  );

  logger.info(
    "MCP server created with 12 tools, 3 resources, and 3 prompts registered",
  );
  return server;
}
