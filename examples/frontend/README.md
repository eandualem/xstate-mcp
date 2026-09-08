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
four real browser/MCP scenarios plus a teardown failure regression. It starts and
cleans up its own processes. Each
MCP request has a five-second limit; `wait_for_state` and `wait_for_event`
use four-second server bounds, with observation cursors for SAVE and RETRY. A successful command ACK is followed by state and browser
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
- Synthetic persisted `pagehide`/`pageshow` events retain editable actors across
  repeated restores; ordinary `pagehide` disposes them. This checks lifecycle
  handling, not whether a particular browser chooses to cache the page.

## Use it with your coding agent

Build the root server with `bun run build`. Configure your MCP client to launch
`node` with the **absolute** path to `dist/cli.js` in this checkout:

```json
{
  "mcpServers": {
    "xstate": {
      "command": "node",
      "args": ["/absolute/path/to/xstate-mcp/dist/cli.js"],
      "env": {
        "XSTATE_MCP_WS_PORT": "7357",
        "XSTATE_MCP_READ_ONLY": "false",
        "XSTATE_MCP_WRITE_ALLOW": "[{\"actor\":\"*\",\"events\":[\"CHANGE_TITLE\",\"CHANGE_BODY\",\"SAVE\",\"RETRY\"]}]"
      }
    }
  }
}
```

The test harness discovers the executable from the root `package.json`
`bin.xstate-mcp` entry. `dist/index.js` is the importable library. The write
environment prepares for #32; this checkpoint ignores it and the demo adapter
enforces its own narrow command policy.

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

1. Discover `workspace` and `document` with `list_actors` (SDK clients send
   `arguments: {}` for this discovery call).
   Use the returned public `sessionId` in MCP requests; `localSessionId` belongs
   to the application adapter. The two actors share a `connectionId`, and each
   tab or inspection reconnect has its own connection.
2. Read the tree, document definition, and current snapshot. Edit the title in the
   browser and verify the preview changes.
3. Save the snapshot cursor, then call `send_event` with the discovered document
   session ID and `{ "type": "SAVE" }`.
4. Use `wait_for_event` for `SAVE` and `wait_for_state` for `error`, both after the
   saved cursor; verify the alert and unchanged draft in the UI.
5. Try `{ "type": "DELETE_EVERYTHING" }` and confirm rejection without changing state.
6. Send `{ "type": "RETRY" }`, wait for that event and `saved` after the failure
   cursor, and verify the success message,
   `attempts: 2`, and `revision: 1` using both MCP and the browser.

Stop Vite with Ctrl-C and let the MCP client stop its owned server. Reload resets
the local mock data; inspection reconnect preserves the running draft. Neither
behavior provides persistence or uses a production save service.

## What the evidence proves

[Evidence and screenshot guide](evidence/README.md) includes a sanitized transcript
captured from the actual test client, screenshots of those browser states, source
hashes and runtime versions. This is a **deterministic test run, not a recorded
model/agent session**. A future Design Studio coding-agent demonstration is #18.

Fresh runs produce `test-results/**/sanitized-transcript.json` and numbered PNGs.
The transcript records tool calls/results, elapsed times, browser checkpoint
labels and screenshot filenames. Public session IDs, local IDs and connection
IDs are replaced consistently with per-tab aliases. Fresh transcripts separately
hash the frontend sources, all server TypeScript sources and configuration, and
the built server JavaScript actually exercised. They record the installed server
dependency versions as well as the frontend toolchain. The
source commit identifies the code checkout used when capturing the evidence.
Failures retain a Playwright trace for local diagnosis. CI uploads the report and
evidence with a 14-day retention period.

Fresh transcripts record each teardown result and the port-rebinding observation
before cleanup assertions run. If Git metadata is unavailable, `sourceCommit` is
null and the lookup error is recorded; file hashes still identify the sources.
The selected checked-in evidence preserves its original source and transcript
format.

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
It starts only in a Vite development build. The server enforces socket ownership
and gives MCP callers scoped public actor IDs. The adapter continues using its
local IDs on the wire. The reusable adapter, React Strict Mode support and
authentication are outside this example's scope.

It sends the proposed protocol-v1 hello before inspection. The pinned server base ignores
that message; #31 negotiates it. Explicit handshake rejection closes the socket
without falling back to writes. A connection label means a socket is open, not
proof that capabilities were negotiated. Server write authorization and capability
negotiation remain separate checks when #31/#32 are integrated.

This integration preparation uses server base `64bd2822bca4371a58c42d6c3a072c36e99d05f5`,
which includes dependency, producer/envelope validation, scoped identity, managed
CLI lifecycle, actor results/history, event eligibility, and bounded waits.
This is a checkpoint before connection negotiation, write/redaction policy and
release metadata are combined. The checked-in captures retain their original
source pins; fresh `test-results/` transcripts identify each tested checkout.

This checkpoint exposes eleven tools. Verification uses server waits for observed
states and SAVE/RETRY events; discovery and actor removal still use bounded client
polling because those are actor-list observations. A declared guarded SAVE yields
`canHandle: null`; actual eligibility is checked by the application's
`snapshot.can(event)`, then verified through observed state and the browser.
The frontend workflow adds real MCP/browser gates on Node 22/24; broader contract
CI remains #7. Keep these scenarios when integrating the remaining core changes.

Exact frontend versions: XState **5.32.6**, Vite **8.2.2**, Playwright **1.63.0**,
MCP client SDK **1.30.0**, TypeScript **5.9.3**, Node types **22.20.1**, Prettier
**3.8.2**. The isolated `bun.lock` pins transitive dependencies without refreshing
the root graph. The prepared server lock pins SDK **1.30.0**, ws **8.21.3** and
Zod **4.5.4**. Capture files record the
actual browser and Node versions used.
