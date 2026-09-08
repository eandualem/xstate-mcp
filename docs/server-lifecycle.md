# Library, CLI, and server lifecycle

The package has separate library, CLI, and browser-policy entry points:

- `import ... from "xstate-mcp"` loads the ESM library in `dist/index.js`, with
  declarations in `dist/index.d.ts`. Importing it reads no process configuration,
  binds no port, installs no signal listeners, and attaches no stdio transport.
- The `xstate-mcp` executable runs `dist/cli.js`. Only this entry reads
  `XSTATE_MCP_*` environment variables and owns process stdio and signal handling.

- `import ... from "xstate-mcp/inspection-policy"` loads the browser-safe policy
  helpers without server startup or Node transport dependencies.

`npx xstate-mcp` and the installed command continue to work. Commands that invoke
`node dist/index.js` directly must change to **`node dist/cli.js`**. The former
file is now an import-safe library and will not launch the bridge. `bun run dev`
and `smithery.yaml` use the new executable entry.

## Capability scanning

The default export remains `createSandboxServer`, also available as a named
export. It returns an unconnected MCP server with the tools, resource templates,
and prompts registered, an empty actor store, and no WebSocket listener.

```typescript
import createSandboxServer from "xstate-mcp";

const server = createSandboxServer();
try {
  await server.connect(scannerTransport); // a transport supplied by the scanner
  // The scanning client can list tools, prompts, resources, and templates.
} finally {
  await server.close();
}
```

No environment settings are read even when calling this factory. Existing
capability-scanning integrations can continue using the default export. The
checked-in Smithery command configuration launches the CLI; the factory supports
library-based scanners independently. No live hosted Smithery scan is needed by
the test suite or claimed as part of this change.

## Embedding a full inspection bridge

`createInspectionServer(options?)` constructs an idle bridge. Its defaults match
the CLI's connection defaults, but it never reads the environment. Pass an MCP
transport to `start()` to begin listening:

```typescript
import { createInspectionServer } from "xstate-mcp";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const bridge = createInspectionServer({
  wsHost: "127.0.0.1",
  wsPort: 7357,
  bufferSize: 100,
  logLevel: "info",
});

try {
  await bridge.start(new StdioServerTransport());
  // start resolves only after the inspection listener and MCP transport start.
  // The host should call bridge.close() for its own stop/EOF/signal events.
  await bridge.closed;
} finally {
  await bridge.close();
}
```

The factory exposes `store`, `clientRegistry`, and `mcpServer` for embedding, plus
`address` (null while idle/closed) and `closed`. A `wsPort` of `0` chooses an
available port; inspect `address` after `start()` to discover it. The HTTP listener
serves WebSocket upgrades, not an HTTP MCP endpoint.

Options are `wsPort`, `wsHost`, `bufferSize`, `logLevel`, `allowedOrigins`,
`requireOrigin`, `shutdownTimeoutMs`, `writePolicy`, and `redaction`. Defaults are port 7357, host 127.0.0.1,
100 history entries, info logging, localhost/127.0.0.1 HTTP origins with any port,
optional Origin header, and a 1000ms shutdown budget. `shutdownTimeoutMs` must be
an integer from 1 through 30000 and is an embedding option, not a CLI environment
setting. Hosts own their process signals and stream end/error handling; the
library never pauses process stdin or calls `process.exit`. Application writes
default to disabled; use explicit paired `writePolicy` rules and an independently
negotiated adapter. `redaction` extends default payload filtering before retention
and verification waits. See [write controls and redaction](write-controls-and-redaction.md).

`start()` takes ownership of the supplied transport. It waits for the inspection
port to bind before connecting MCP, so a bind failure cannot advertise a working
bridge. A startup failure rejects after cleanup, including closing the supplied
transport. A second `start()` is rejected without touching the extra transport.
Closing during startup cancels the pending listen/connection; a late completion
cannot restart the bridge. Instances are terminal after shutdown; create a new
instance for another debugging session.

Lower-level `ActorStore`, `ClientRegistry`, `Logger`, and `createMcpServer` are
also exported. A host assembling those pieces itself owns their overall lifecycle.
`createInspectionServer` supplies that coordination for the common case.

## Shutdown contract

`close()` is idempotent and returns the same promise on every call. That promise
is also `closed`, which settles on automatic shutdown after the MCP transport
closes or after the exposed MCP server closes. During teardown the bridge:

1. Stops accepting connections and processing inspection messages.
2. Cancels any pending startup and detaches its MCP-owned store callbacks.
3. Fails pending application commands with `Server shutting down`, clears actor
   data and routing, and rejects further commands.
4. Closes MCP and sends WebSocket close code 1001 to connected applications.
5. Allows up to 250ms for socket close handshakes (at most half a shorter shutdown
   budget), then terminates remaining WebSockets and raw HTTP/TCP connections.
6. Releases SDK callbacks/request handlers and finishes within the configured
   budget while the event loop is responsive.

If an embedding transport rejects or never finishes `close()`, the bridge still
releases its owned routes, listeners, and sockets, then rejects `close()`/`closed`
with the error or timeout. The host remains responsible for resources internal to
its custom transport. Shutdown does not replay or finish application actions.
An interrupted MCP caller may receive a failed command result or a transport-close
error, depending on which message reached the client first.

Store callback registration methods now return independent, idempotent removal
functions. Closing an MCP server removes its registrations and stops resource
notifications. Closing a registry is terminal; clearing it alone remains a reset.
After `ClientRegistry.close()`, new client/session registrations throw
`Client registry is closed`, `getSession()` returns no session, and sends return
`Server shutting down`. Calling `clear()` after close does not reopen it.
The WebSocket receiver stops accepting inspection for a closed registry.
These cleanup changes do not implement the resource subscription protocol in
[#4](https://github.com/eandualem/xstate-mcp/issues/4).

The CLI invokes shutdown for SIGINT, SIGTERM, stdin EOF/closure, and stdio errors.
Normal signal/EOF teardown exits with status 0. Configuration, bind, and cleanup
errors exit nonzero with diagnostics on stderr. Stdout remains JSON-RPC only.
The CLI handles a closed stderr pipe from startup through process exit, including
diagnostics after cleanup. A broken pipe triggers normal shutdown; it does not
turn a successful cleanup into an uncaught stream error.
A final **1500ms CLI deadline** allows the normal 1000ms bridge cleanup to finish
and then exits with status 1 if blocked stdio writes or another active handle keep
the process alive. That fallback can discard buffered output; it avoids hanging
when an MCP client ends stdin while refusing to read a large response. It is not
used for a normal clean exit and does not exist in the library.

## Verification

The Vitest global setup builds and packs current sources before any parallel test
suites run. The CLI lifecycle, envelope, and runtime compatibility suites all use
that build; they never clean or overwrite `dist/` while another suite is using it.
Older npm versions may run `prepare` during packing despite `--ignore-scripts`;
that work also completes before the test workers start.
`tests/cli-lifecycle.test.ts` launches real subprocesses.
It checks import/configuration isolation, occupied ports before MCP initialization,
SIGINT/SIGTERM/EOF with real XState actors and pending commands, repeated shutdown,
a nonresponsive WebSocket, early EOF, stdout backpressure, and closed stderr
during startup, a live session, and after cleanup. It also extracts the
prepared npm archive, imports its public exports, type-checks an external consumer,
scans capabilities, and runs the packed CLI. Packed-package tests reuse the exact
installed dependencies without publishing or downloading new runtime versions.

`tests/inspection-server.test.ts` covers real WebSocket/MCP round trips, transport
closure, idempotence, partial startup failure/cancellation, callback disposal,
raw TCP cleanup, custom transport failures/timeouts, and port reuse.
