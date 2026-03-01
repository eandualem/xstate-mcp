import type { ActorStore } from "../actor-store.js";
import { safeStringify } from "../safe-stringify.js";

export function explainMachine(store: ActorStore, sessionId: string) {
  const actor = store.getActor(sessionId);

  if (!actor) {
    return {
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Actor "${sessionId}" was not found. There are ${store.size} registered actor(s). Use the list_actors tool to find valid session IDs.`,
          },
        },
      ],
    };
  }

  const state = actor.currentSnapshot;
  const sections = [
    `Explain this XState v5 state machine in plain language. Make it understandable to someone who hasn't seen the code.`,
    ``,
    `## Actor: ${actor.name} (${actor.sessionId})`,
    `- Current state: ${safeStringify(state?.value ?? null)}`,
    `- Status: ${state?.status ?? "unknown"}`,
  ];

  if (actor.definition) {
    sections.push(
      ``,
      `## Machine Definition`,
      `\`\`\`json`,
      safeStringify(actor.definition, 2),
      `\`\`\``,
    );
  } else {
    sections.push(
      ``,
      `_No machine definition available. Explain what can be inferred from the actor's current state and context._`,
    );
  }

  if (state?.context !== null && state?.context !== undefined) {
    sections.push(
      ``,
      `## Current Context`,
      `\`\`\`json`,
      safeStringify(state.context, 2),
      `\`\`\``,
    );
  }

  sections.push(
    ``,
    `## Explanation Tasks`,
    `1. **Purpose** — What does this machine do? What problem does it solve?`,
    `2. **States** — List each state and what it represents. Note which is the initial state and any final states.`,
    `3. **Transitions** — For each state, what events cause transitions and where do they go?`,
    `4. **Guards** — What conditions gate transitions? What do they check?`,
    `5. **Current position** — Where is the machine right now (state: ${safeStringify(state?.value ?? null)})? What can happen next from here?`,
  );

  return {
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: sections.join("\n"),
        },
      },
    ],
  };
}
