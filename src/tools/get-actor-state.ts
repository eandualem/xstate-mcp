import type { ActorStore } from "../actor-store.js";

export function getActorState(store: ActorStore, sessionId: string) {
  const actor = store.getActor(sessionId);

  if (!actor) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            error: `Actor not found: ${sessionId}`,
          }),
        },
      ],
      isError: true,
    };
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            sessionId: actor.sessionId,
            name: actor.name,
            status: actor.currentSnapshot?.status ?? "unknown",
            value: actor.currentSnapshot?.value ?? null,
            context: actor.currentSnapshot?.context ?? null,
            parentId: actor.parentId,
            updatedAt: actor.updatedAt,
          },
          null,
          2,
        ),
      },
    ],
  };
}
