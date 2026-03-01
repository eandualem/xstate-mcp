import { z } from "zod";
import type { ActorStore } from "../actor-store.js";
import type { ToolResult } from "../errors.js";

export const listActorsOutputSchema = {
  actors: z.array(
    z.object({
      sessionId: z.string(),
      name: z.string(),
      currentState: z.unknown(),
      status: z.string(),
      childCount: z.number(),
    }),
  ),
  totalActors: z.number(),
};

export function listActors(store: ActorStore): ToolResult {
  const actors = store.listActors().map((actor) => ({
    sessionId: actor.sessionId,
    name: actor.name,
    currentState: actor.currentSnapshot?.value ?? null,
    status: actor.currentSnapshot?.status ?? "unknown",
    childCount: store.getChildCount(actor.sessionId),
  }));

  const structuredContent = { actors, totalActors: actors.length };

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(structuredContent, null, 2),
      },
    ],
    structuredContent,
  };
}
