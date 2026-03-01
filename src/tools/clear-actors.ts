import { z } from "zod";
import type { ActorStore } from "../actor-store.js";
import type { ClientRegistry } from "../client-registry.js";
import type { ToolResult } from "../errors.js";
import { safeStringify } from "../safe-stringify.js";

export const clearActorsOutputSchema = {
  cleared: z.number(),
};

export function clearActors(
  store: ActorStore,
  clientRegistry?: ClientRegistry,
): ToolResult {
  const cleared = store.size;
  store.clear();
  clientRegistry?.clear();

  const structuredContent = { cleared };

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
