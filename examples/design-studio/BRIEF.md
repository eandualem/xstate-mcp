# Design Studio: recover an unsaved document

This is the coding-agent brief for [xstate-mcp #18](https://github.com/eandualem/xstate-mcp/issues/18)
and the coordinated [Design Studio issue](https://github.com/eandualem/design-studio/issues/1).
The feature belongs in Design Studio; this repository tracks the integration and
its evidence. Follow Design Studio's own contributor and XState instructions.

## Starting point

Design Studio baseline: `e1bd77533decbb0a139c152cd5c0a8ae8d3eca81`.

Source review found that a failed IndexedDB save sets `saveError`, renders the
current draft and returns to `open.ready`. The UI displays “not saved,” with error
text in a tooltip. The document event union and hook expose no retry action.
Verify this in the running application before changing the behavior. Do not use a
Mermaid syntax error as a substitute: that is an existing, different recovery path.

The developer is the **coding agent working on Design Studio's source**. The
assistant panel inside the app edits design documents through assistant-runtime;
it is not the developer in this demonstration.

## Useful change

Give a user a way to recover an unsaved draft after browser storage temporarily
fails. Preserve the current document and its text. Follow the repository's bounded
automatic retry convention, then expose a visible manual retry when automatic
attempts are exhausted. Report saving, failure and actual persistence accurately.
Editing during retry must save the latest draft without duplicate concurrent work.
A successful recovery must survive reopening the document after a page reload.

Keep transitions, retry decisions and side effects in the machine; expose the
necessary state and grouped actions through the hook; render them in the component.
Use named guards and machine descriptions. Add regression tests that fail before
the feature and pass after it. Do not change the theme or the runtime's contracts.

## Required development sequence

1. Record the baseline and install from its lockfile. Use a fresh browser profile
   containing only synthetic documents. Record exact runtime/dependency versions.
2. Add opt-in development inspection at the root provider in a separate commit.
   Include spawned and invoked actors, machine definitions, latest snapshot replay,
   bounded buffering, and React StrictMode, HMR and unmount cleanup. Production
   must open no inspection socket. Apply narrow write controls and redact before
   transfer. Do not expose chat messages, attachments or real design documents.
3. Open an actual MCP stdio session. Discover actors and read the document machine
   definition and state. Inject an explicitly labeled IndexedDB failure through
   browser testing, reproduce the UI problem, and collect state/history and a
   screenshot. Keep the original MCP request/results and record the resulting
   implementation decision before editing the recovery behavior.
4. Change the machine, hook and component, and add meaningful tests. Preserve the
   distinction between a command acknowledgement and completed persistence.
5. Use actual MCP calls and browser assertions to verify a rejected/failing action,
   retry exhaustion, recovery and persisted content after reload. Check refresh
   actor identity and instrumentation cleanup. Run lint, tests and production build.
6. Capture a short recording and before/after screenshots. Associate each with its
   source commit and the corresponding MCP observations. Record the final diff,
   checks, exact commands and any remaining limitations.

The coding agent may call MCP through its native integration or a persistent SDK
stdio session accessed through terminal tools. Requests must reach the real server,
and their results must inform the agent's work. A replay or a script written after
the fix is useful regression evidence, but does not prove this development sequence.

## Dependencies and disclosure

To repeat the original exercise, use the historical development snapshot with the
write/redaction controls from [PR #32](https://github.com/eandualem/xstate-mcp/pull/32),
source commit
[`16c7a0004dce3f676eab0b5606be1e3542c89449`](https://github.com/eandualem/xstate-mcp/commit/16c7a0004dce3f676eab0b5606be1e3542c89449),
preserved on
[`archive/demo-evidence/design-studio-server-16c7a00`](https://github.com/eandualem/xstate-mcp/tree/archive/demo-evidence/design-studio-server-16c7a00).
It was unmerged when captured. Its browser-safe helper is available only through
`xstate-mcp/inspection-policy`; its package root starts the CLI. Record the source
commit as well as the package and MCP-advertised versions. Follow the
[pinned setup and compatibility notes](README.md#run-the-example); current core
requires changes to this historical application's adapter and harness.

The [small frontend demonstration](../frontend/README.md) is a reference for the
current server. Its two-actor adapter is specific to that example;
Design Studio needs its own complete hierarchy and React lifecycle coverage.

The document/storage scenario needs no in-app assistant model call or provider key.
Storage failures are injected test fixtures, not a claim about normal IndexedDB
reliability. Disclose the coding agent's actual runtime and model separately. Report
usage and cost only when the runtime supplies them; “unavailable” is preferable to
an invented zero-cost claim. A full live assistant-runtime demonstration is outside
this bounded feature.

MCP data can reach the coding client's model provider and logs. Use synthetic
content throughout, redact before transfer, and inspect the final transcript and
recording before committing them. Do not include private prompts, credentials,
account data or unrelated terminal content.
