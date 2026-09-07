import { z } from "zod";
import type { ActorStore } from "../actor-store.js";
import { actorNotFoundResult, type ToolResult } from "../errors.js";
import { safeStringify } from "../safe-stringify.js";

const DEFAULT_LIMIT = 20;

export const getEventHistoryOutputSchema = {
  sessionId: z.string(),
  events: z.array(
    z.object({
      event: z.record(z.string(), z.unknown()),
      sourceId: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
  totalInBuffer: z.number(),
  bufferCapacity: z.number(),
};

export function getEventHistory(
  store: ActorStore,
  sessionId: string,
  limit?: number,
): ToolResult {
  const actor = store.getActor(sessionId);

  if (!actor) {
    return actorNotFoundResult(sessionId, store);
  }

  const effectiveLimit = limit ?? DEFAULT_LIMIT;
  const events = actor.eventHistory.getRecent(effectiveLimit);

  const structuredContent = {
    sessionId: actor.sessionId,
    events,
    totalInBuffer: actor.eventHistory.size,
    bufferCapacity: actor.eventHistory.capacity,
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
