# Demo status: an agent develops a frontend with runtime evidence

Both demonstration stages have implementations and evidence:

- The [local frontend example](../examples/frontend/README.md) exercises the
  current checkout through an actual MCP client and browser assertions.
- The [Design Studio development demonstration](../examples/design-studio/README.md)
  records a coding agent diagnosing and fixing document-save recovery. Its exact
  historical server and application pins remain reproducible; its original
  Node 26 capture and independent Node 24 verification are kept distinct.

The [September 2026 review](reviews/2026-09-07.md) preserves the original findings
and proposed sequence. The criteria below explain what each stage demonstrates
and how to repeat the development exercise.

## A reproducible local example

The small XState v5 editor covers load, edit, save, validation failure and retry
using deterministic local services. Its guide provides the command sequence and
requires no model key for the automated assertions. Its application-specific
adapter tracks the two persistent actors; the general adapter remains
[#13](https://github.com/eandualem/xstate-mcp/issues/13).

A real MCP client discovers the root and child actors, reads definitions, sends
allowed events, awaits observed state/events, and inspects history and timelines.
Browser assertions verify the rendered UI. The scenarios include refresh,
reconnect, a second tab, rejected commands and an intentional save failure.
See the example's evidence manifests for exact sources, versions and checks.

The acceptance criterion remains a repeatable clean-clone run with these
assertions. Actor discovery alone does not establish a working frontend loop.

## Design Studio's coding agent improves its frontend

[Design Studio](https://github.com/eandualem/design-studio) uses XState v5, with
`appMachine` spawning `files`, `document`, `assistant`, and `artifacts` through
`AppMachineContext.Provider`. The original reviewed baseline lacked inspection.
The [pinned application change](https://github.com/eandualem/design-studio/commit/0da1b6ae93a65c376022874f2d687f23f26352a8)
adds development-only root instrumentation, hierarchy inspection, and cleanup
for hot reload and React lifecycle behavior.

Distinguish the participants:

- The **coding agent assigned to Design Studio** edits and tests frontend code
  and calls xstate-mcp as a development tool.
- The **assistant inside Design Studio** uses assistant-runtime to edit design
  documents. It did not develop the frontend feature in this demonstration.

The selected feature is recovery from a failed IndexedDB document save. The agent
recorded the original failure and its implementation decision before changing the
machine, hook and component. The result preserves the draft, adds bounded automatic
retries and a visible manual retry, and verifies persisted content after reload.
The [demo guide](../examples/design-studio/README.md) links the diff, tests, actual
MCP excerpts, screenshots and short recording.

The recorded server snapshot predates the current CLI entry point and write
handshake. Keep its pins to reproduce the evidence; the guide explains the
compatibility boundary. Integrating current core into Design Studio requires
separate application work and fresh validation. This repository's documentation
does not merge, deploy or release the application PR.

## Repeat the coding exercise

Use the [acceptance brief](../examples/design-studio/BRIEF.md) and start from the
instrumented pre-feature commit in the
[demo guide](../examples/design-studio/README.md#repeat-the-coding-exercise):

1. Give the coding agent the written brief and record the baseline commit.
2. Discover the real actor tree and explain the relevant machine.
3. Reproduce the problem through the UI; record state, history and a screenshot.
4. Implement the machine, hook and component changes with regression tests.
5. Verify actual UI interactions and MCP observations, including a rejected or
   failing action, recovery and the successful path.
6. Refresh and verify that state, UI and persisted content agree.
7. Preserve the final diff, passing checks, MCP transcript and before/after UI.

Keep Design Studio's layering: components → hooks → machines → pure libraries.
Its own contributor instructions govern application changes.

## Evidence and limits

Record source commits, dependency versions, exact commands and capture provenance.
Keep recordings and transcripts tied to the version they exercised when the code
changes. Disclose any model calls and costs only when the runtime supplies them.

The viewer should be able to answer: what evidence did the MCP reveal, what code
did the agent change because of it, and how was the result verified?

The local frontend uses deterministic mock services. The Design Studio demo uses
real browser storage with explicitly injected synthetic transaction failures.
Neither scenario needs an in-app model call or provider key; that is separate
from the coding agent's own model usage. A live assistant-runtime demonstration
remains a separate scenario.
