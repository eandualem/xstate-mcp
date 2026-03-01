import type { ActorStore } from "../actor-store.js";
import type { ClientRegistry } from "../client-registry.js";

export async function sendEvent(
  store: ActorStore,
  clientRegistry: ClientRegistry,
  target: string,
  event: Record<string, unknown>,
) {
  // Resolve target: try as sessionId first, then as actor name
  let sessionId = target;
  if (!store.getActor(target)) {
    const byName = store.listActors().find((a) => a.name === target);
    if (byName) {
      sessionId = byName.sessionId;
    } else {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: `Actor not found by sessionId or name: ${target}`,
            }),
          },
        ],
        isError: true,
      };
    }
  }

  const result = await clientRegistry.sendEvent(sessionId, event);

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            sessionId,
            event,
            ...result,
          },
          null,
          2,
        ),
      },
    ],
    isError: !result.success,
  };
}
