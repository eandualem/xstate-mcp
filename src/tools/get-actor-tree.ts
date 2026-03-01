import { z } from "zod";
import type { ActorStore } from "../actor-store.js";
import type { ToolResult } from "../errors.js";

interface TreeNode {
  sessionId: string;
  name: string;
  state: unknown;
  status: string;
  children: TreeNode[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const treeNodeSchema: z.ZodType<any> = z.lazy(() =>
  z.object({
    sessionId: z.string(),
    name: z.string(),
    state: z.any(),
    status: z.string(),
    children: z.array(treeNodeSchema),
  }),
);

export const getActorTreeOutputSchema = {
  tree: z.array(treeNodeSchema),
  totalActors: z.number(),
};

export function getActorTree(store: ActorStore): ToolResult {
  const actors = store.listActors();

  // Build parent → children map
  const childrenMap = new Map<string | null, typeof actors>();
  for (const actor of actors) {
    const parentId = actor.parentId;
    if (!childrenMap.has(parentId)) {
      childrenMap.set(parentId, []);
    }
    childrenMap.get(parentId)!.push(actor);
  }

  function buildNode(actor: (typeof actors)[0]): TreeNode {
    const children = childrenMap.get(actor.sessionId) ?? [];
    return {
      sessionId: actor.sessionId,
      name: actor.name,
      state: actor.currentSnapshot?.value ?? null,
      status: actor.currentSnapshot?.status ?? "unknown",
      children: children.map(buildNode),
    };
  }

  // Root actors have null parentId or parentId not in the actor set
  const knownIds = new Set(actors.map((a) => a.sessionId));
  const roots = actors.filter(
    (a) => a.parentId === null || !knownIds.has(a.parentId),
  );

  const tree = roots.map(buildNode);
  const structuredContent = { tree, totalActors: actors.length };

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
