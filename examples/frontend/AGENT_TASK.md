# Agent task: make a failed save easy to recover

You are developing the Fieldnotes frontend in this directory. Use the repository's
XState MCP server to inspect actual runtime behavior while editing the UI. No model
API key is required by the application or its tests.

The checked-in example includes a reference recovery UI. A useful follow-on task is
to improve it: show the last successful revision beside the current draft, with an
accessible explanation when they differ. Preserve the existing save/retry behavior.

Before editing, run the example, discover its workspace/document actors, and read
the document definition and snapshot. The local mock deliberately fails the first
save and succeeds on retry. This is fixture behavior, not a real service outage.

Acceptance:

- Preserve title/body through a failed save. Show a visible, keyboard-accessible
  retry action and honest error/saving/saved messages.
- Save the observation cursor before sending SAVE/RETRY. Use bounded
  `wait_for_event` and `wait_for_state`, then inspect the visible frontend.
- After retry, the UI and MCP agree on `saved`, `attempts: 2`, `revision: 1`, and the
  saved document. Rejected events do not change the draft or attempt count.
- Keep changes in the model, renderer or styles as appropriate. Do not replace
  runtime observations with hard-coded UI state or access actors through a test hook.
- Verify on desktop and mobile, after reconnect/refresh, and with a second tab.
- Run the quality checks and `bun run demo:verify` from the repository root.
- Report the code changes, relevant real MCP calls, before/after UI screenshots,
  and any limits. Do not describe an ACK as proof of completed async work.

The supplied evidence is produced by a deterministic MCP client and Playwright.
Do not present it as a transcript of a model thinking or writing frontend code.
A future #18 recording should show the coding agent's actual edits and decisions.
