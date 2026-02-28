import type { ActorStore } from "../actor-store.js";

export function getMachineDefinition(store: ActorStore, sessionId: string) {
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

  if (actor.definition === null || actor.definition === undefined) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            sessionId: actor.sessionId,
            name: actor.name,
            definition: null,
            note: "No machine definition available for this actor",
          }),
        },
      ],
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
            definition: actor.definition,
          },
          null,
          2,
        ),
      },
    ],
  };
}
