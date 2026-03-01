import type { ActorStore } from "../actor-store.js";

export function clearActors(store: ActorStore) {
  const cleared = store.size;
  store.clear();

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ cleared }),
      },
    ],
  };
}
