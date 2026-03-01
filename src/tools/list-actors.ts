import { z } from "zod";
import type { ActorStore } from "../actor-store.js";
import type { ToolResult } from "../errors.js";
import { safeStringify } from "../safe-stringify.js";

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

export function listActors(store: ActorStore, status?: string): ToolResult {
  let allActors = store.listActors();
  if (status) {
    allActors = allActors.filter(
      (a) => (a.currentSnapshot?.status ?? "unknown") === status,
    );
  }
  const actors = allActors.map((actor) => ({
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
        text: safeStringify(structuredContent, 2),
      },
    ],
    structuredContent,
  };
}
