import { actorIdentity } from "../actor-identity.js";
import { z } from "zod";
import type { ActorStore } from "../actor-store.js";
import type { ClientRegistry } from "../client-registry.js";
import { actorNotFoundResult, type ToolResult } from "../errors.js";
import { safeStringify } from "../safe-stringify.js";

export const sendEventOutputSchema = {
  sessionId: z.string(),
  event: z.record(z.string(), z.unknown()),
  success: z.boolean(),
  error: z.string().optional(),
};

export async function sendEvent(
  store: ActorStore,
  clientRegistry: ClientRegistry,
  target: string,
  event: Record<string, unknown>,
): Promise<ToolResult> {
  // Resolve target: try as sessionId first, then as actor name
  let sessionId = target;
  if (!store.getActor(target)) {
    const matches = store.listActors().filter((a) => a.name === target);
    if (matches.length === 1) {
      sessionId = matches[0].sessionId;
    } else if (matches.length > 1) {
      const ambiguousContent = {
        error: `Ambiguous actor name: "${target}" matches ${matches.length} actors`,
        matches: matches.map((a) => ({
          sessionId: a.sessionId,
          ...actorIdentity(a),
          name: a.name,
        })),
        suggestion: "Use a specific sessionId instead of the actor name.",
      };
      return {
        content: [
          {
            type: "text" as const,
            text: safeStringify(ambiguousContent, 2),
          },
        ],
        isError: true,
      };
    } else {
      return actorNotFoundResult(target, store);
    }
  }

  const result = await clientRegistry.sendEvent(sessionId, event);

  const structuredContent = {
    sessionId,
    event,
    ...result,
  };

  return {
    content: [
      {
        type: "text" as const,
        text: safeStringify(structuredContent, 2),
      },
    ],
    structuredContent,
    isError: !result.success,
  };
}
