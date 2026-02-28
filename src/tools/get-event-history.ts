import type { ActorStore } from "../actor-store.js";

const DEFAULT_LIMIT = 20;

export function getEventHistory(
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
          text: JSON.stringify({
            error: `Actor not found: ${sessionId}`,
          }),
        },
      ],
      isError: true,
    };
  }

  const effectiveLimit = limit ?? DEFAULT_LIMIT;
  const events = actor.eventHistory.getRecent(effectiveLimit);

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            sessionId: actor.sessionId,
            events,
            totalInBuffer: actor.eventHistory.size,
            bufferCapacity: actor.eventHistory.capacity,
          },
          null,
          2,
        ),
      },
    ],
  };
}
