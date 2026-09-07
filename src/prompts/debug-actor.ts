import type { ActorStore } from "../actor-store.js";
import { safeStringify } from "../safe-stringify.js";

export function debugActor(store: ActorStore, sessionId: string) {
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
  const events = actor.eventHistory.getRecent(30);
  const transitions = actor.transitionHistory.getRecent(20);

  const sections = [
    `You are debugging an XState v5 actor. Analyze it for problems and suggest fixes.`,
    ``,
    `## Actor: ${actor.name} (${actor.sessionId})`,
    `- Status: ${state?.status ?? "unknown"}`,
    `- Current state value: ${safeStringify(state?.value ?? null)}`,
    `- Context: ${safeStringify(state?.context ?? null, 2)}`,
    `- Output: ${safeStringify(state?.output ?? null)}`,
    `- Error: ${safeStringify(state?.error ?? null)}`,
    `- Parent: ${actor.parentId ?? "none (root actor)"}`,
    `- Created: ${actor.createdAt}`,
    `- Last updated: ${actor.updatedAt}`,
  ];

  if (actor.definition) {
    sections.push(
      ``,
      `## Machine Definition`,
      `\`\`\`json`,
      safeStringify(actor.definition, 2),
      `\`\`\``,
    );
  }

  if (transitions.length > 0) {
    sections.push(
      ``,
      `## Recent Snapshot Changes (${transitions.length} of ${actor.transitionHistory.total} total)`,
      `\`\`\`json`,
      safeStringify(transitions, 2),
      `\`\`\``,
    );
  }

  if (events.length > 0) {
    sections.push(
      ``,
      `## Recent Events (${events.length} of ${actor.eventHistory.size} in buffer)`,
      `\`\`\`json`,
      safeStringify(events, 2),
      `\`\`\``,
    );
  }

  sections.push(
    ``,
    `## Analysis Tasks`,
    `1. **State consistency** — Is the current state value valid given the machine definition? Are there any impossible states?`,
    `2. **Missed transitions** — Based on the event history, were there events that should have caused transitions but didn't?`,
    `3. **Context validity** — Does the context data make sense for the current state? Are there stale or missing values?`,
    `4. **Event flow** — Do the events follow the expected sequence? Are there unexpected event types or missing expected ones?`,
    `5. **Stuck states** — Is the actor stuck in a state it shouldn't be in? What event would move it forward?`,
    `6. **Lifecycle results** — Check status, output, and error before calling an actor stuck. Timeline type distinguishes state, context, and lifecycle changes; changes lists every changed field. A done, error, or stopped actor may have no state value. Missing error details may have been lost by the adapter.`,
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
