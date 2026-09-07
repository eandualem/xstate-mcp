# Demo plan: an agent develops a frontend with runtime evidence

This is a proposed sequence. No new demo or Design Studio integration has been
implemented by the repository review. Resolve the reliability issues in the
[review roadmap](reviews/2026-09-07.md) before recording a demo.

## First gate: a reproducible local example

Build a small XState v5 frontend (for example, an editor with load, edit, save,
validation error, and retry states) using a supported first-party adapter. Provide
one documented command sequence, deterministic local services, and no model key
requirement for its automated assertions.

Verify a real MCP client can discover the root and child actors, read definitions,
send an allowed event, await the result, and inspect the event/timeline evidence.
Then use a browser tool to verify the rendered UI. Repeat after refresh,
reconnect, and a second tab. Include an invalid event and an intentional failure.

The first release gate is a repeatable clean-clone run with those assertions,
not a screenshot of `list_actors` containing hand-authored data.

## Flagship: Design Studio's coding agent improves its frontend

[Design Studio](https://github.com/eandualem/design-studio) already uses XState v5.
The local review found `appMachine` spawning `files`, `document`, `assistant`, and
`artifacts`, mounted through `AppMachineContext.Provider`. It has no inspection
callback connected yet. Add instrumentation at the root provider in development
only, with cleanup for hot reload and React lifecycle behavior.

Distinguish the participants:

- The **coding agent assigned to Design Studio** edits and tests frontend code
  and calls xstate-mcp as a development tool.
- The **assistant inside Design Studio** uses assistant-runtime to edit design
  documents. Its existing host actions do not make it a frontend coding agent.

Choose a small feature or bug that fits Design Studio's intentionally narrow
scope. A candidate is a visible, recoverable error state for document or Mermaid
rendering, with a retry action. The feature selection remains open; first verify
the chosen behavior is missing and useful.

Suggested recording sequence:

1. Give the coding agent a written frontend acceptance brief and a baseline commit.
2. Let it discover the real actor tree and explain the relevant machine.
3. Reproduce the problem through the UI; record state, event history, and screenshot.
4. Let the agent implement the machine, hook, and component changes and tests.
5. Verify through actual UI interactions and MCP observations. Show one rejected
   or failing action and its recovery, as well as the successful path.
6. Refresh and repeat. Demonstrate the state and UI remain consistent.
7. Show the final diff, passing tests, MCP tool transcript, and before/after UI.

Keep Design Studio's layering: components → hooks → machines → pure libraries.
Its own contributor instructions govern changes there. This roadmap is scoped to
xstate-mcp; coordinate any Design Studio PR as an explicit follow-up task.

## Artifacts and success criteria

Deliver a runnable example, an exact setup guide, a short screen recording, and
a sanitized transcript that ties tool calls to the actual frontend development.
Record commit IDs and dependency versions; note any real model calls and costs.

The viewer should be able to answer: what evidence did the MCP reveal, what code
did the agent change because of it, and how was the result verified? A viewer
following the guide should reproduce the result from a clean clone.

For the simple demo, deterministic mocks exercise the workflow without paid
services. A later Design Studio demonstration can use the real runtime if the
selected scenario needs it. Clearly label mock and live runs.
