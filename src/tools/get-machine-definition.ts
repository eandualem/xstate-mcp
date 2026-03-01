import { z } from "zod";
import type { ActorStore } from "../actor-store.js";
import { actorNotFoundResult, type ToolResult } from "../errors.js";
import { safeStringify } from "../safe-stringify.js";

export const getMachineDefinitionOutputSchema = {
  sessionId: z.string(),
  name: z.string(),
  definition: z.unknown(),
  note: z.string().optional(),
};

export function getMachineDefinition(
  store: ActorStore,
  sessionId: string,
): ToolResult {
  const actor = store.getActor(sessionId);

  if (!actor) {
    return actorNotFoundResult(sessionId, store);
  }

  if (actor.definition === null || actor.definition === undefined) {
    const structuredContent = {
      sessionId: actor.sessionId,
      name: actor.name,
      definition: null,
      note: "No machine definition available for this actor",
    };
    return {
      content: [
        {
          type: "text" as const,
          text: safeStringify(structuredContent),
        },
      ],
      structuredContent,
    };
  }

  const structuredContent = {
    sessionId: actor.sessionId,
    name: actor.name,
    definition: actor.definition,
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
