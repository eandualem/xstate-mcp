import { z } from "zod";
import type { ActorStore } from "../actor-store.js";
import { actorNotFoundResult, type ToolResult } from "../errors.js";
import { safeStringify } from "../safe-stringify.js";
import { analyzeEventEligibility, unavailable } from "../event-eligibility.js";

export const canHandleEventOutputSchema = {
  sessionId: z.string(),
  canHandle: z.boolean().nullable(),
  analysis: z.literal("static"),
  reason: z.enum([
    "transition_found",
    "no_transition",
    "forbidden_transition",
    "guard_not_evaluated",
    "definition_unavailable",
    "definition_incomplete",
    "snapshot_unavailable",
    "actor_inactive",
    "unsupported_event",
    "version_dependent",
  ]),
  currentState: z.unknown(),
  matchedTransitions: z.array(z.string()),
  blockedTransitions: z.array(z.string()),
  note: z.string(),
};

export function canHandleEvent(
  store: ActorStore,
  sessionId: string,
  eventType: string,
): ToolResult {
  const actor = store.getActor(sessionId);
  if (!actor) return actorNotFoundResult(sessionId, store);
  const snapshot = actor.currentSnapshot;
  const currentState = snapshot?.value ?? null;
  const eligibility =
    snapshot && ["done", "stopped", "error"].includes(snapshot.status)
      ? { ...unavailable("actor_inactive"), canHandle: false }
      : !snapshot || snapshot.status !== "active"
        ? unavailable("snapshot_unavailable")
        : analyzeEventEligibility(actor.definition, currentState, eventType);
  const structuredContent = {
    sessionId,
    ...eligibility,
    analysis: "static" as const,
    currentState,
    note: "Static evidence from the supplied definition and snapshot; guards are not evaluated and serialization may omit them. null means unknown. A structural match does not guarantee a transition; verify state after sending the full event.",
  };
  return {
    content: [{ type: "text", text: safeStringify(structuredContent, 2) }],
    structuredContent,
  };
}
