# Fieldnotes: a frontend driven and verified through XState MCP

A small release-note editor with a real XState v5 workspace actor and invoked
document actor. Its first asynchronous save deliberately fails; retry succeeds
while preserving the draft. The preview and status messages render the document
snapshot. Nothing is published, uploaded by the mock service, or persisted across
page reloads. No model, API key, account or other repository is required.

![A recovered save in the editor](evidence/03-recovered.png)

## Clean-clone verification

Use Bun **1.4.2** and Node **22.23.2** or **24.20.0**. From the repository root:

```bash
bun install --frozen-lockfile
bun run demo:install
cd examples/frontend
bun run browser:install
cd ../..
bun run demo:verify
```

On Linux, install browser system dependencies with
`bun run browser:install --with-deps`. If Chrome is already installed, an optional
local alternative is `PLAYWRIGHT_CHANNEL=chrome bun run demo:verify`; the default
and CI use Playwright's pinned Chromium. Tests use their own temporary browser
profiles and ephemeral loopback ports. They never attach to an existing MCP server
or reuse a developer's browser session.

`demo:verify` builds the **current repository CLI**, builds the frontend, and runs
three real browser/MCP scenarios. It starts and cleans up its own processes. Each
MCP request has a five-second limit; state verification polls real MCP snapshots
with a five-second bound. A successful command ACK is followed by state and browser
assertions. Source/test TypeScript and formatting can be checked separately:

```bash
bun run check
cd examples/frontend
bun run check
```

The scenarios cover:

- Real actor discovery and parent/child tree, both definitions, state, eligibility,
  history/timeline, snapshot resource, and debug prompt through an SDK client.
- Edit the UI, send `SAVE` through MCP, observe the intentional failure, reject
  `DELETE_EVERYTHING`, send `RETRY`, then confirm the saved snapshot and UI.
- Disconnect inspection, edit while disconnected, reconnect with fresh registration
  and the latest state, reload, and operate two tabs with distinct actor targets.
  An ambiguous actor name is rejected; an exact ID changes only its owning tab.
- Mobile save/retry controls, no horizontal overflow, and a built production page
  that opens no inspection WebSocket. Closing tabs removes actors; teardown closes
  MCP/Vite and proves the old inspection port can be rebound.

## Use it with your coding agent

Build the root server with `bun run build`. Configure your MCP client to launch
`node` with the **absolute** path to `dist/index.js` in this checkout:

```json
{
  "mcpServers": {
    "xstate": {
      "command": "node",
      "args": ["/absolute/path/to/xstate-mcp/dist/index.js"],
      "env": {
        "XSTATE_MCP_WS_PORT": "7357",
        "XSTATE_MCP_READ_ONLY": "false",
        "XSTATE_MCP_WRITE_ALLOW": "[{\"actor\":\"*\",\"events\":[\"CHANGE_TITLE\",\"CHANGE_BODY\",\"SAVE\",\"RETRY\"]}]"
      }
    }
  }
}
```

That CLI path matches current main. After the pending factory/CLI split (#26), use
the executable in the root `package.json` `bin.xstate-mcp` entry instead; the test
harness already reads this entry. The write environment prepares for #32; current
main ignores it and the demo adapter enforces its own narrow command policy.

Start the frontend in another terminal:

```bash
bun run demo:dev
```

Open <http://127.0.0.1:5173>. The footer reports the development inspection
connection. The UI works before the MCP server starts; the adapter retains the two
actors and their latest snapshots until the socket opens. For another inspection
port, set `VITE_XSTATE_MCP_URL=ws://127.0.0.1:PORT` for `demo:dev` and configure the
same server port in the MCP client. Restart Vite after changing that setting.

Give any coding agent [the task brief](AGENT_TASK.md). A manual verification loop:

1. Discover `workspace` and `document` with `list_actors` (SDK clients should send
   `arguments: {}` for optional-only tools on the baseline SDK).
2. Read the tree, document definition, and current snapshot. Edit the title in the
   browser and verify the preview changes.
3. Call `send_event` with the discovered document session ID and `{ "type": "SAVE" }`.
4. Observe `saving`, then `error`; verify the alert and unchanged draft in the UI.
5. Try `{ "type": "DELETE_EVERYTHING" }` and confirm rejection without changing state.
6. Send `{ "type": "RETRY" }`, await `saved`, and verify the success message,
   `attempts: 2`, and `revision: 1` using both MCP and the browser.

Stop Vite with Ctrl-C and let the MCP client stop its owned server. Reload resets
the local mock data; inspection reconnect preserves the running draft. Neither
behavior is persistence or a production save service.

## What the evidence proves

[Evidence and screenshot guide](evidence/README.md) includes a sanitized transcript
captured from the actual test client, screenshots of those browser states, source
hashes and runtime versions. This is a **deterministic test run, not a recorded
model/agent session**. A future Design Studio coding-agent demonstration is #18.

Fresh runs produce `test-results/**/sanitized-transcript.json` and numbered PNGs.
The transcript records tool calls/results, elapsed times, browser checkpoint
labels and screenshot filenames. Session IDs are replaced consistently with
per-tab aliases. Source hashes identify the exact runtime and test files; the
source commit identifies the code checkout used when capturing the evidence.
Failures retain a Playwright trace for local diagnosis. CI uploads the report and
evidence with a 14-day retention period.

Only fixture document contents are used in captured evidence. The adapter explicitly
projects supported snapshot fields and event payloads, keeping live actor references
and a deliberate fake access token off the wire. Tests check both WebSocket frames
and MCP results for that token before the transcript sanitizer runs. The mock
service never makes a network request. The development inspector **does** transmit
draft contents to the MCP server; your coding client may forward them to its model
provider or retain them. Use demo data. General configurable redaction is #15 / #32.

## Deliberate scope and integration

The frontend uses plain TypeScript/DOM and XState; there is no framework or hidden
host workspace. `src/model.ts` contains the deterministic machines/services,
`src/main.ts` renders/subscribes and sends UI events, and `src/demo-inspector.ts`
bridges inspection/commands on one socket. The adapter is specific to this closed
demo and only tracks its two persistent actors. Invoked mock-service promise
actors are intentionally not exported.

The adapter starts after actors exist, re-registers current snapshots on reconnect,
keeps at most 50 disconnected events, uses a fresh UUID generation for producer IDs,
and disposes on page exit/hot module replacement. It permits only valid `SAVE`,
`RETRY`, `CHANGE_TITLE` (120 characters) and `CHANGE_BODY` (4000 characters) events
on the document actor, checking current `snapshot.can(event)` before dispatch.
It starts only in a Vite development build. This is not the reusable adapter,
React Strict Mode support, authentication, or server-side socket ownership from #13/#25.

It sends the proposed protocol-v1 hello before inspection. Current main ignores
that message; #31 negotiates it. Explicit handshake rejection closes the socket
without falling back to writes. A connection label means a socket is open, not
proof that capabilities were negotiated. Server write authorization and capability
negotiation remain separate checks when #31/#32 are integrated.

This branch runs against current main's nine tools. It uses **bounded MCP polling**,
not the still-unmerged `wait_for_state` tool from #24. It does not claim wildcard/
forbidden-transition correctness from #28 or the complete contract CI from #7.
The frontend workflow adds its own real MCP/browser gates on Node 22/24. Preserve
these scenarios when integrating those dependencies, then switch the wait helper
to the merged bounded-wait API. The test harness already discovers tool names,
reads the configured CLI executable, and supplies narrowly scoped write opt-in.

Exact frontend versions: XState **5.32.6**, Vite **8.2.2**, Playwright **1.63.0**,
MCP client SDK **1.30.0**, TypeScript **5.9.3**, Node types **22.20.1**, Prettier
**3.8.2**. The isolated `bun.lock` pins transitive dependencies without refreshing
the root graph. Current main's server lock pins SDK **1.27.1**, ws **8.19.0** and
Zod **3.25.76**; server dependency updates remain #27. Capture files record the
actual browser and Node versions used.
