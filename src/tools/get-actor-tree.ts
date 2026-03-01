import type { ActorStore } from "../actor-store.js";

interface TreeNode {
  sessionId: string;
  name: string;
  state: unknown;
  status: string;
  children: TreeNode[];
}

export function getActorTree(store: ActorStore) {
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

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ tree, totalActors: actors.length }, null, 2),
      },
    ],
  };
}
