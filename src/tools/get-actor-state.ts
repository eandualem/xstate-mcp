import { z } from "zod";
import type { ActorStore } from "../actor-store.js";
import { actorNotFoundResult } from "../errors.js";

export const getActorStateOutputSchema = {
  sessionId: z.string(),
  name: z.string(),
  status: z.string(),
  value: z.unknown(),
  context: z.unknown(),
  parentId: z.string().nullable(),
  updatedAt: z.string(),
};

export function getActorState(store: ActorStore, sessionId: string) {
  const actor = store.getActor(sessionId);

  if (!actor) {
    return actorNotFoundResult(sessionId, store);
  }

  const structuredContent = {
    sessionId: actor.sessionId,
    name: actor.name,
    status: actor.currentSnapshot?.status ?? "unknown",
    value: actor.currentSnapshot?.value ?? null,
    context: actor.currentSnapshot?.context ?? null,
    parentId: actor.parentId,
    updatedAt: actor.updatedAt,
  };

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
