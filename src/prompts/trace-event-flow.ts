import type { ActorStore } from "../actor-store.js";
import { safeStringify } from "../safe-stringify.js";

export function traceEventFlow(store: ActorStore, sessionId: string) {
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
  const transitions = actor.transitionHistory.toArray();
  const events = actor.eventHistory.toArray();

  const sections = [
    `Trace the event flow for this XState v5 actor. Walk through each event and transition chronologically, explaining what happened and why.`,
    ``,
    `## Actor: ${actor.name} (${actor.sessionId})`,
    `- Current state: ${safeStringify(state?.value ?? null)}`,
    `- Status: ${state?.status ?? "unknown"}`,
    `- Output: ${safeStringify(state?.output ?? null)}`,
    `- Error: ${safeStringify(state?.error ?? null)}`,
    `- Total snapshot changes recorded: ${actor.transitionHistory.total}`,
    `- Total events in buffer: ${actor.eventHistory.size}`,
  ];

  if (transitions.length > 0) {
    sections.push(
      ``,
      `## Snapshot Changes (chronological)`,
      `\`\`\`json`,
      safeStringify(transitions, 2),
      `\`\`\``,
    );
  } else {
    sections.push(``, `_No snapshot changes recorded yet._`);
  }

  if (events.length > 0) {
    sections.push(
      ``,
      `## Events (chronological)`,
      `\`\`\`json`,
      safeStringify(events, 2),
      `\`\`\``,
    );
  } else {
    sections.push(``, `_No events recorded yet._`);
  }

  if (actor.definition) {
    sections.push(
      ``,
      `## Machine Definition (for reference)`,
      `\`\`\`json`,
      safeStringify(actor.definition, 2),
      `\`\`\``,
    );
  }

  sections.push(
    ``,
    `## Trace Tasks`,
    `1. **Chronological walkthrough** — For each timeline entry, use type and changes to distinguish state transitions, context changes, and lifecycle results. Explain the triggering event, from/to values and statuses, output, and error when present.`,
    `2. **Events without transitions** — Identify any events that did NOT cause a state transition. Why? Were they handled silently, or ignored?`,
    `3. **Timing patterns** — Are there unusual gaps or bursts in the event flow? What do they suggest?`,
    `4. **Current state reasoning** — Given the full event history, explain why the machine ended up in its current state (${safeStringify(state?.value ?? null)}).`,
    `5. **Lifecycle results** — Explain completion, failure, or stop even when there is no state value. Missing error details may have been lost by the adapter.`,
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
