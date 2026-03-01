import { z } from "zod";
import type { ActorStore } from "../actor-store.js";
import type { ClientRegistry } from "../client-registry.js";
import { actorNotFoundResult, type ToolResult } from "../errors.js";

export const sendEventOutputSchema = {
  sessionId: z.string(),
  event: z.record(z.unknown()),
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
    const byName = store.listActors().find((a) => a.name === target);
    if (byName) {
      sessionId = byName.sessionId;
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
        text: JSON.stringify(structuredContent, null, 2),
      },
    ],
    structuredContent,
    isError: !result.success,
  };
}
