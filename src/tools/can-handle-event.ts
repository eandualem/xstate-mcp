import { z } from "zod";
import type { ActorStore } from "../actor-store.js";
import { actorNotFoundResult, type ToolResult } from "../errors.js";
import { safeStringify } from "../safe-stringify.js";

export const canHandleEventOutputSchema = {
  sessionId: z.string(),
  canHandle: z.boolean(),
  currentState: z.unknown(),
  matchedTransitions: z.array(z.string()),
  note: z.string().optional(),
};

export function canHandleEvent(
  store: ActorStore,
  sessionId: string,
  eventType: string,
): ToolResult {
  const actor = store.getActor(sessionId);

  if (!actor) {
    return actorNotFoundResult(sessionId, store);
  }

  if (!actor.definition || typeof actor.definition !== "object") {
    const structuredContent = {
      sessionId,
      canHandle: false,
      currentState: actor.currentSnapshot?.value ?? null,
      matchedTransitions: [] as string[],
      note: "No machine definition available — cannot check transitions",
    };
    return {
      content: [
        {
          type: "text" as const,
          text: safeStringify(structuredContent),
        },
      ],
      structuredContent,
    };
  }

  const currentState = actor.currentSnapshot?.value ?? null;
  const matchedTransitions = findTransitions(
    actor.definition as Record<string, unknown>,
    currentState,
    eventType,
  );

  const structuredContent = {
    sessionId,
    canHandle: matchedTransitions.length > 0,
    currentState,
    matchedTransitions,
    note:
      matchedTransitions.length > 0
        ? "Guards are not evaluated — transition may still be rejected at runtime"
        : undefined,
  };

  return {
    content: [
      {
        type: "text" as const,
        text: safeStringify(structuredContent, 2),
      },
    ],
    structuredContent,
  };
}

/**
 * Walk the machine definition to find transitions matching the event type
 * in the current state. Checks nested/parallel states.
 */
function findTransitions(
  definition: Record<string, unknown>,
  currentState: unknown,
  eventType: string,
): string[] {
  const matched: string[] = [];
  const states = definition.states as
    Record<string, Record<string, unknown>> | undefined;

  if (!states) return matched;

  // Check root-level "on" handlers
  const rootOn = definition.on as Record<string, unknown> | undefined;
  if (rootOn && eventType in rootOn) {
    matched.push(`(root).on.${eventType}`);
  }

  // Resolve which states to check based on currentState
  const activeStates = resolveActiveStates(currentState);

  for (const activeState of activeStates) {
    const stateNode = states[activeState.name];
    if (!stateNode) continue;

    checkStateNode(
      stateNode,
      activeState.name,
      eventType,
      matched,
      activeState.childValue,
    );
  }

  // Also check wildcard "*" transitions
  if (rootOn && "*" in rootOn) {
    matched.push(`(root).on.*`);
  }

  return matched;
}

interface ActiveState {
  name: string;
  childValue: unknown;
}

function resolveActiveStates(currentState: unknown): ActiveState[] {
  if (typeof currentState === "string") {
    return [{ name: currentState, childValue: undefined }];
  }
  if (typeof currentState === "object" && currentState !== null) {
    // Parallel/compound state: { panel: "closed", data: "loaded" }
    return Object.entries(currentState as Record<string, unknown>).map(
      ([key, value]) => ({
        name: key,
        childValue: value,
      }),
    );
  }
  return [];
}

function checkStateNode(
  stateNode: Record<string, unknown>,
  path: string,
  eventType: string,
  matched: string[],
  activeChildValue?: unknown,
): void {
  const on = stateNode.on as Record<string, unknown> | undefined;
  if (on) {
    if (eventType in on) {
      matched.push(`${path}.on.${eventType}`);
    }
    if ("*" in on) {
      matched.push(`${path}.on.*`);
    }
  }

  // Check "always" transitions (eventless)
  if (eventType === "" && stateNode.always) {
    matched.push(`${path}.always`);
  }

  // Recurse into nested states
  const nestedStates = stateNode.states as
    Record<string, Record<string, unknown>> | undefined;
  if (nestedStates) {
    if (typeof activeChildValue === "string") {
      // Simple child: e.g. value = { panel: "closed" } → activeChildValue = "closed"
      if (nestedStates[activeChildValue]) {
        checkStateNode(
          nestedStates[activeChildValue],
          `${path}.${activeChildValue}`,
          eventType,
          matched,
        );
      }
    } else if (
      typeof activeChildValue === "object" &&
      activeChildValue !== null
    ) {
      // Deep nesting: e.g. value = { panel: { view: "detail" } }
      // → activeChildValue = { view: "detail" }, iterate entries
      for (const [childName, nextChildValue] of Object.entries(
        activeChildValue as Record<string, unknown>,
      )) {
        if (nestedStates[childName]) {
          checkStateNode(
            nestedStates[childName],
            `${path}.${childName}`,
            eventType,
            matched,
            nextChildValue,
          );
        }
      }
    } else {
      // No info — fall back to initial
      const childName = stateNode.initial as string | undefined;
      if (childName && nestedStates[childName]) {
        checkStateNode(
          nestedStates[childName],
          `${path}.${childName}`,
          eventType,
          matched,
        );
      }
    }
  }
}
