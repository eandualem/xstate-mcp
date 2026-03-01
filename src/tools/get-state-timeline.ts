import type { ActorStore } from "../actor-store.js";

export function getStateTimeline(
  store: ActorStore,
  sessionId: string,
  limit?: number,
) {
  const actor = store.getActor(sessionId);

  if (!actor) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ error: `Actor not found: ${sessionId}` }),
        },
      ],
      isError: true,
    };
  }

  const effectiveLimit = limit ?? 50;
  const transitions = actor.transitionHistory.getRecent(effectiveLimit);

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            sessionId,
            name: actor.name,
            currentState: actor.currentSnapshot?.value ?? null,
            totalTransitions: actor.transitionHistory.total,
            transitions,
          },
          null,
          2,
        ),
      },
    ],
  };
}
