import { z } from "zod";
import type { ActorStore } from "../actor-store.js";
import { actorNotFoundResult, type ToolResult } from "../errors.js";
import { safeStringify } from "../safe-stringify.js";

export const getStateTimelineOutputSchema = {
  sessionId: z.string(),
  name: z.string(),
  currentState: z.unknown(),
  totalTransitions: z.number(),
  transitions: z.array(
    z.object({
      fromValue: z.unknown(),
      toValue: z.unknown(),
      event: z.string(),
      timestamp: z.string(),
    }),
  ),
};

export function getStateTimeline(
  store: ActorStore,
  sessionId: string,
  limit?: number,
): ToolResult {
  const actor = store.getActor(sessionId);

  if (!actor) {
    return actorNotFoundResult(sessionId, store);
  }

  const effectiveLimit = limit ?? 50;
  const transitions = actor.transitionHistory.getRecent(effectiveLimit);

  const structuredContent = {
    sessionId,
    name: actor.name,
    currentState: actor.currentSnapshot?.value ?? null,
    totalTransitions: actor.transitionHistory.total,
    transitions,
  };

  return {
    content: [
      {
        type: "text" as const,
        text: safeStringify(structuredContent, 2),
      },
    ],
    structuredContent,
  };
}
