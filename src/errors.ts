import type { ActorStore } from "./actor-store.js";

/** Standard MCP tool result shape with optional structured content. */
export type ToolResult = {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/**
 * Returns a standardized MCP error result for "actor not found" cases.
 * Includes actor count and a suggestion to call list_actors,
 * enabling the LLM to self-recover.
 */
export function actorNotFoundResult(
  sessionId: string,
  store: ActorStore,
): ToolResult {
  const actorCount = store.size;
  const suggestion =
    actorCount > 0
      ? `There are ${actorCount} registered actor(s). Use the list_actors tool to see available session IDs.`
      : "No actors are currently registered. Ensure the browser is connected and has started XState actors.";

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          error: `Actor not found: ${sessionId}`,
          actorCount,
          suggestion,
        }),
      },
    ],
    isError: true,
  };
}
