import { actorIdentity, actorIdentityOutputSchema } from "../actor-identity.js";
import { z } from "zod";
import type { ActorStore } from "../actor-store.js";
import type { ToolResult } from "../errors.js";
import { safeStringify } from "../safe-stringify.js";

interface TreeNode {
  sessionId: string;
  connectionId: string | null;
  localSessionId: string;
  applicationName: string | null;
  name: string;
  state: unknown;
  status: string;
  children: TreeNode[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const treeNodeSchema: z.ZodType<any> = z.lazy(() =>
  z.object({
    sessionId: z.string(),
    ...actorIdentityOutputSchema,
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

export function getActorTree(
  store: ActorStore,
  connectionId?: string,
): ToolResult {
  const actors = store
    .listActors()
    .filter((a) => !connectionId || a.connectionId === connectionId);

  // Build parent → children map
  const childrenMap = new Map<string | null, typeof actors>();
  for (const actor of actors) {
    const parentId = actor.parentId;
    if (!childrenMap.has(parentId)) {
      childrenMap.set(parentId, []);
    }
    childrenMap.get(parentId)!.push(actor);
  }

  function buildNode(
    actor: (typeof actors)[0],
    visited: Set<string>,
  ): TreeNode {
    const children = childrenMap.get(actor.sessionId) ?? [];
    return {
      sessionId: actor.sessionId,
      ...actorIdentity(actor),
      name: actor.name,
      state: actor.currentSnapshot?.value ?? null,
      status: actor.currentSnapshot?.status ?? "unknown",
      children: children
        .filter((child) => !visited.has(child.sessionId))
        .map((child) => {
          visited.add(child.sessionId);
          return buildNode(child, visited);
        }),
    };
  }

  // Root actors have null parentId or parentId not in the actor set
  const knownIds = new Set(actors.map((a) => a.sessionId));
  const roots = actors.filter(
    (a) => a.parentId === null || !knownIds.has(a.parentId),
  );

  const visited = new Set<string>(roots.map((r) => r.sessionId));
  const tree = roots.map((root) => buildNode(root, visited));
  const structuredContent = { tree, totalActors: actors.length };

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
