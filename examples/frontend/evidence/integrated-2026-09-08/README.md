# Integrated frontend evidence — 2026-09-08

These are fresh captures of the current MCP/frontend loop, separate from the
[original recording](../README.md). All original files remain unchanged.
This is a deterministic SDK client and real Chromium browser run; it does not
record a model developing the frontend. The separate Design Studio demonstration
is tracked in [#18](https://github.com/eandualem/xstate-mcp/issues/18).

## Exact source and runtime

Both captures ran the clean source commit
[`5c3b2d0f8cfbcf133613b6f38a7fa778ed298662`](https://github.com/eandualem/xstate-mcp/commit/5c3b2d0f8cfbcf133613b6f38a7fa778ed298662),
tree `87aa428b47dc78deee69ab0d4302362318a4f3dd`, on merged core/release base
`714b6eb6bd3dfbb9e44d30dd7afc29deca56145a`. Subsequent evidence/docs commits do not
change the tested source. Build this checkout; historical npm versions do not
provide this integrated behavior.

- Server: **xstate-mcp 1.1.0-dev.0**, SDK **1.30.0**, ws **8.21.3**, Zod **4.5.4**.
- Runtime: **Node 22.23.2** and **Node 24.20.0**; Bun **1.4.2**.
- Frontend: XState **5.32.6**, Vite **8.2.2**, Playwright **1.63.0**,
  Chromium **153.0.8010.12**; exact remaining frontend versions are in each transcript.

Each schema-3 transcript records its source commit, frontend source hashes,
34 server source/configuration hashes, three actual server JavaScript artifact
hashes, installed server dependencies, runtime versions, MCP calls/results and
cleanup observations. The source and built server hashes match across both Node
runs. [SHA256SUMS](SHA256SUMS) identifies the copied transcripts and screenshots.

## Observed behavior

Both Node runs passed all **six** browser/teardown tests, including the five
scenarios captured below and the synthetic cleanup/provenance-failure regression.
The same source tree passed all **482 core tests** plus lint, formatting, source
types and metadata checks on both Node versions; frontend source/test/config types,
formatting, CLI build and frontend production build also passed.

- Save/recovery: [Node 22](node22/save-recovery.json), [Node 24](node24/save-recovery.json).
  Twelve tools and current server version are discovered. Negotiated health and
  public actor IDs agree. UI editing precedes MCP SAVE; cursor-bounded event/state
  waits observe the intentional failure and successful RETRY. The rendered alert,
  preserved draft, saved revision, resource and debug prompt agree with MCP.
  Server policy rejects DELETE_EVERYTHING; the adapter independently rejects SAVE
  to the workspace actor. The shared browser guard redacts the fake access token
  before WebSocket transfer, and server responses redact a client-supplied password.
- Negotiation: [Node 22](node22/negotiation.json), [Node 24](node24/negotiation.json).
  Playwright holds the real server hello response: the UI remains editable and no
  actors/inspection are sent yet. An altered unsupported protocol response closes
  the socket without registration. The visible reconnect action negotiates a new
  socket and publishes the unchanged live draft.
- Reconnect/tabs: [Node 22](node22/reconnect.json), [Node 24](node24/reconnect.json).
  Offline edits survive reconnect; reload resets the mock draft. Two tabs receive
  distinct scoped IDs. Ambiguous names reject, and exact targets change only the
  selected tab, including its focused input.
- Page lifecycle: [Node 22](node22/page-lifecycle.json), [Node 24](node24/page-lifecycle.json).
  Synthetic persisted pagehide/pageshow pairs preserve editable actors; ordinary
  pagehide disposes them. This does not claim actual browser cache admission.
- Mobile/production: [Node 22](node22/mobile-production.json), [Node 24](node24/mobile-production.json).
  Visible save/retry controls recover at 390px width without horizontal overflow.
  The built production page opens no inspection WebSocket.

Every real scenario records fulfilled client, transport and Vite cleanup and
`portReleased: true`. The app remains a two-persistent-actor demo; invoked promise
actors are not exported. HMR disposal remains implemented, but these captures do
not contain a dedicated HMR replacement test. No external save service, deployment,
package publication, paid model call or recording of an agent's reasoning occurred.

## Screenshots

The PNGs below come from the Node 24 run. Node 22 independently reran the same
browser assertions; its transcripts are linked above.

1. [Editable draft](01-editor.png)
2. [Failed save with preserved draft and visible retry](02-save-error.png)
3. [Successful recovery](03-recovered.png)
4. [Reconnected draft](04-reconnected.png)
5. [Only the selected second tab changed](05-second-tab.png)
6. [Mobile recovery](06-mobile.png)

## Reproduce

Check out the source commit above, then follow the
[clean-clone verification instructions](../../README.md#clean-clone-verification).
Run `bun run demo:verify` separately under each supported Node version. Fresh
outputs go to ignored `test-results/`; they never overwrite this curated evidence.
The original frontend source remains available on the separate remote branch
`archive/demo-evidence/frontend-source-84a84cd`.
