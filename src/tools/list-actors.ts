import type { ActorStore } from "../actor-store.js";

export function listActors(store: ActorStore) {
  const actors = store.listActors().map((actor) => ({
    sessionId: actor.sessionId,
    name: actor.name,
    currentState: actor.currentSnapshot?.value ?? null,
    status: actor.currentSnapshot?.status ?? "unknown",
    childCount: store.getChildCount(actor.sessionId),
  }));

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ actors, totalActors: actors.length }, null, 2),
      },
    ],
  };
}
