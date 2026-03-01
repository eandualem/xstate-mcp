import { z } from "zod";
import type { ActorStore } from "../actor-store.js";
import type { ToolResult } from "../errors.js";

export const clearActorsOutputSchema = {
  cleared: z.number(),
};

export function clearActors(store: ActorStore): ToolResult {
  const cleared = store.size;
  store.clear();

  const structuredContent = { cleared };

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(structuredContent),
      },
    ],
    structuredContent,
  };
}
