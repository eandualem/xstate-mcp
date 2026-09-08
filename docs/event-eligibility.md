# Static event eligibility

`can_handle_event(sessionId, eventType)` examines the stored snapshot and supplied
machine definition. It never creates an XState interpreter, executes guards or
actions, or asks the application to evaluate an event. XState is a development
dependency for regression tests, not a runtime dependency of this tool.

## Result and migration

`canHandle` is now **boolean or null**. Consumers of the old boolean-only schema
must handle all three values explicitly:

- `true`: the supplied definition selects at least one transition with a target
  or actions. This is structural evidence, not a guarantee that a live guard will
  pass, the actor will still be in that state, or the state value will change.
- `false`: the supplied evidence selects no handler, selects only forbidden
  transitions, or the stored actor status is `done`, `stopped` or `error`.
- `null`: a usable definition/snapshot is unavailable or incomplete, a selected
  candidate has a guard, or the analysis cannot establish selection safely.

All successful tool results include `analysis: "static"`, `reason`,
`matchedTransitions`, `blockedTransitions`, `currentState`, `sessionId` and `note`.
The text JSON and `structuredContent` agree. An unknown actor still returns the
existing tool error; unknown eligibility for a known actor is a successful result
with `canHandle: null`.

Reasons for boolean results are `transition_found`, `no_transition`,
`forbidden_transition` and `actor_inactive`. Unknown reasons are
`guard_not_evaluated`, `definition_unavailable`, `definition_incomplete`,
`snapshot_unavailable`, `unsupported_event` and `version_dependent`.

`matchedTransitions` lists the selected structural handler paths, or the guarded
candidate where analysis stopped. `blockedTransitions` lists selected forbidden
paths. Ancestors and less-specific patterns masked by an unconditional selection
are absent. Paths retain the existing notation, such as `panel.open.on.GO` or
`(root).on.user.*`; array alternatives share their declaration's path. Unknown
results may have partial evidence; their arrays are not exhaustive possibilities.

## Selection behavior

For each active region, inspect the deepest active state first and fall back to
its parent only if nothing is selected. An explicit forbidden transition is a
selection: it blocks that branch's ancestor even though it contributes no handler.
Parallel regions can select independently; a forbidden region does not block an
eligible sibling. The parallel parent is considered only if every region has no
selection. If child selection is unknown, ancestor fallback remains unknown.

Within one node, exact events take priority, then matching partial wildcards from
longest to shortest, then `*`. Alternatives are considered in declaration order;
an unconditional candidate masks the later ones. At the first guard, the answer
is unknown without running it or speculating about fallback. Forbidden forms
include `{}`, `undefined`, an empty target string or an empty actions array with
no target. An action-only transition is eligible. An explicit `target: []` follows
XState's `snapshot.can` semantics: it is considered a target even though it need
not change anything.

The regression matrix uses real **XState 5.28.0 and 5.32.6** actors, both raw
configuration and serialized machine definitions, for exact/global/partial
wildcards, nested and parallel selection, masking, forbidden transitions, guard
uncertainty and completion. In these v5 releases `user.*` matches both
`user.save` and the bare `user`, but does not match `users.save`. This is measured
runtime behavior, not an assumption about general glob syntax.

One measured version difference is `on: { GO: [], '*': handler }`: 5.28 suppresses
the wildcard for `GO`, while 5.32 tries it. With that empty exact list present in
the supplied definition, the tool returns `version_dependent`. The wire protocol
does not negotiate XState runtime versions. See the versioned implementation of
[getCandidates in 5.28](https://github.com/statelyai/xstate/blob/xstate%405.28.0/packages/core/src/stateUtils.ts)
and [5.32.6](https://github.com/statelyai/xstate/blob/xstate%405.32.6/packages/core/src/stateUtils.ts).
The general [transition documentation](https://stately.ai/docs/transitions)
describes child selection and forbidden transitions; the pinned regression
fixtures establish the v5 details used here.

A completed actor reports `actor_inactive` even when its detached
`snapshot.can(event)` still returns true. The actor has stopped processing events;
tests verify that sending to it leaves its snapshot unchanged. The empty event
type is unsupported: it is not a request to analyze `always`. For raw configs,
internal `xstate.*` events are unsupported because generated handlers require a
compiled definition. A compiled definition can expose those handlers in `on`.

## Evidence limits and the agent workflow

Missing active branches, missing child values, incomplete parallel snapshots,
malformed selected transitions and missing `on`/`states` in a compiled definition
produce unknown. A partial snapshot never falls back to the declared initial
state: the live child may have moved. Cycles, more than 128 nesting levels or more
than 4,096 visited active nodes also stop analysis with `definition_incomplete`.
This is not a complete validator for every possible machine definition.

Ordinary `JSON.stringify(machine.toJSON())` can omit inline guards and empty
transition lists; raw config serialization can omit functions and `undefined`
handlers too. The tool cannot detect every omission or recover that code. Its
true/false answers always describe the supplied evidence, and the returned note
always states this limitation. Adapters should preserve guard-presence markers
and complete definitions. A retained guard marker yields unknown. An integration
test deliberately drops an inline guard: the tool finds a structural match, but
the live actor rejects the event. No runtime guard capability is claimed.

Agents should distinguish `null` from `false`, inspect `reason`, and obtain better
inspection evidence when necessary. When an action is appropriate, send the full
event payload and verify the resulting snapshot and event history. For frontend
work, also verify the rendered UI. Neither `canHandle: true` nor a successful
`send_event` acknowledgement proves that a transition occurred.
