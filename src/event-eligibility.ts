/** Static evidence only: never reconstruct a machine or execute application code. */
export interface Eligibility {
  canHandle: boolean | null;
  reason:
    | "transition_found"
    | "no_transition"
    | "forbidden_transition"
    | "guard_not_evaluated"
    | "definition_unavailable"
    | "definition_incomplete"
    | "snapshot_unavailable"
    | "actor_inactive"
    | "unsupported_event"
    | "version_dependent";
  matchedTransitions: string[];
  blockedTransitions: string[];
}

type Node = Record<string, unknown>;
const own = (node: Node, key: string) => Object.hasOwn(node, key);
const record = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function unavailable(reason: Eligibility["reason"]): Eligibility {
  return {
    canHandle: null,
    reason,
    matchedTransitions: [],
    blockedTransitions: [],
  };
}
const none = (): Eligibility => ({
  ...unavailable("no_transition"),
  canHandle: false,
});
const selected = (result: Eligibility) =>
  result.matchedTransitions.length > 0 || result.blockedTransitions.length > 0;

/** XState v5 treats a trailing .* as matching the bare prefix too. */
function matches(event: string, descriptor: string): boolean {
  if (descriptor === event || descriptor === "*") return true;
  if (!descriptor.endsWith(".*")) return false;
  const prefix = descriptor.slice(0, -2);
  if (prefix.includes("*")) return false;
  return event === prefix || event.startsWith(`${prefix}.`);
}

function local(node: Node, path: string, event: string): Eligibility {
  if (node.on === undefined) return none();
  if (!record(node.on)) return unavailable("definition_incomplete");
  const on = node.on;
  const wildcards = Object.keys(on)
    .filter((key) => key !== event && matches(event, key))
    .sort((a, b) => b.length - a.length);
  const exact = own(on, event);
  // XState 5.28 skips wildcard fallback for an empty exact list; 5.32 tries it.
  // The inspection protocol does not negotiate the producer's runtime version.
  if (
    exact &&
    Array.isArray(on[event]) &&
    on[event].length === 0 &&
    wildcards.length
  ) {
    return unavailable("version_dependent");
  }
  const descriptors = exact ? [event] : wildcards;
  for (const descriptor of descriptors) {
    const raw = on[descriptor];
    const candidates = Array.isArray(raw) ? raw : [raw];
    const location = `${path}.on.${descriptor}`;
    for (const candidate of candidates) {
      // undefined in a config is an explicit forbidden transition. Its compiled
      // JSON counterpart is an object with no target and an empty actions list.
      const transition =
        typeof candidate === "string"
          ? { target: candidate }
          : candidate === undefined
            ? {}
            : candidate;
      if (!record(transition)) return unavailable("definition_incomplete");
      if (own(transition, "guard") && transition.guard !== undefined) {
        return {
          ...unavailable("guard_not_evaluated"),
          matchedTransitions: [location],
        };
      }
      const { target, actions } = transition;
      if (
        target !== undefined &&
        typeof target !== "string" &&
        !(
          Array.isArray(target) &&
          target.every((item) => typeof item === "string")
        )
      ) {
        return unavailable("definition_incomplete");
      }
      const validAction = (value: unknown) =>
        typeof value === "string" ||
        typeof value === "function" ||
        record(value);
      // JSON turns inline action functions in arrays into null. The length is
      // still evidence of an action; this tool does not execute or inspect it.
      if (
        actions !== undefined &&
        !validAction(actions) &&
        !(
          Array.isArray(actions) &&
          actions.every((item) => item === null || validAction(item))
        )
      ) {
        return unavailable("definition_incomplete");
      }
      const hasTarget =
        Array.isArray(target) ||
        (typeof target === "string" && target.length > 0);
      const hasActions = Array.isArray(actions)
        ? actions.length > 0
        : actions !== undefined;
      return hasTarget || hasActions
        ? {
            canHandle: true,
            reason: "transition_found",
            matchedTransitions: [location],
            blockedTransitions: [],
          }
        : {
            canHandle: false,
            reason: "forbidden_transition",
            matchedTransitions: [],
            blockedTransitions: [location],
          };
    }
  }
  return none();
}

export function analyzeEventEligibility(
  definition: unknown,
  value: unknown,
  event: string,
): Eligibility {
  if (!record(definition)) return unavailable("definition_unavailable");
  if (
    !own(definition, "states") &&
    !own(definition, "on") &&
    !own(definition, "type")
  ) {
    return unavailable("definition_incomplete");
  }
  if (event === "") return unavailable("unsupported_event");
  if (value === undefined || value === null)
    return unavailable("snapshot_unavailable");
  const compiled = own(definition, "transitions");
  if (event.startsWith("xstate.") && !compiled)
    return unavailable("unsupported_event");
  let visits = 0;
  const visiting = new Set<Node>();

  function visit(
    node: Node,
    state: unknown,
    path: string,
    depth: number,
  ): Eligibility {
    // Inspection data is untrusted; an incomplete or excessive tree is unknown.
    if (++visits > 4096 || depth > 128 || visiting.has(node))
      return unavailable("definition_incomplete");
    visiting.add(node);
    try {
      if (compiled && (!record(node.on) || !record(node.states)))
        return unavailable("definition_incomplete");
      if (own(node, "states") && !record(node.states))
        return unavailable("definition_incomplete");
      if (own(node, "on") && node.on !== undefined && !record(node.on))
        return unavailable("definition_incomplete");
      if (
        node.type !== undefined &&
        !["atomic", "compound", "parallel", "final"].includes(String(node.type))
      )
        return unavailable("definition_incomplete");
      const states = (node.states ?? {}) as Node;
      const children = Object.keys(states).filter(
        (key) => !(record(states[key]) && states[key].type === "history"),
      );
      const active =
        typeof state === "string"
          ? { [state]: undefined }
          : record(state)
            ? state
            : state === undefined
              ? {}
              : null;
      if (!active) return unavailable("snapshot_unavailable");
      const keys = Object.keys(active);
      if (children.length > 0) {
        if (node.type === "atomic" || node.type === "final")
          return unavailable("definition_incomplete");
        if (
          keys.length === 0 ||
          (node.type !== "parallel" && keys.length !== 1)
        )
          return unavailable("snapshot_unavailable");
        if (
          node.type === "parallel" &&
          (keys.length !== children.length ||
            children.some((key) => !own(active, key)))
        )
          return unavailable("snapshot_unavailable");
      } else if (keys.length || node.type === "compound") {
        return unavailable("definition_incomplete");
      }
      const results: Eligibility[] = [];
      for (const key of keys) {
        if (
          !own(states, key) ||
          !record(states[key]) ||
          states[key].type === "history"
        )
          return unavailable("definition_incomplete");
        const child = visit(
          states[key],
          active[key],
          path === "(root)" ? key : `${path}.${key}`,
          depth + 1,
        );
        results.push(child);
      }
      // Unknown child selection could mask any ancestor; do not invent fallback.
      const unknown = results.find((result) => result.canHandle === null);
      if (unknown) return unknown;
      const chosen = results.filter(selected);
      if (chosen.length) {
        const handles = chosen.some((result) => result.canHandle);
        return {
          canHandle: handles,
          reason: handles ? "transition_found" : "forbidden_transition",
          matchedTransitions: chosen.flatMap(
            (result) => result.matchedTransitions,
          ),
          blockedTransitions: chosen.flatMap(
            (result) => result.blockedTransitions,
          ),
        };
      }
      return local(node, path, event);
    } finally {
      visiting.delete(node);
    }
  }
  return visit(definition, value, "(root)", 0);
}
