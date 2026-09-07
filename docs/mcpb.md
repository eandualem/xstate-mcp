# Local MCPB distribution for Smithery

Build a local `.mcpb` archive from the **same npm tarball and source commit** as the
server package. A client runs the server locally over stdio; the application's
inspection WebSocket connects to loopback on that computer. No remote hosting is
needed for this distribution.

This is a development packaging path. The current main-based source still needs
[the lifecycle split](https://github.com/eandualem/xstate-mcp/pull/26),
[consistent release versions](https://github.com/eandualem/xstate-mcp/pull/30) and
[combined integration/contract verification](https://github.com/eandualem/xstate-mcp/issues/35).
A successful bundle smoke run does not mean those changes have merged or a Smithery
listing exists. The evidence records the remaining release gates explicitly.

## Build and verify

Use Bun **1.4.2** and Node **24.20.0** on macOS or Linux. From a clean clone:

```bash
bun install --frozen-lockfile
bun run mcpb:install
bun run check
bun run mcpb:check
bun run mcpb:build
bun run mcpb:verify
```

`artifacts/mcpb/` contains the npm tarball, MCPB archive, `build-evidence.json` and
a platform/runtime-specific verification report. The build performs two fresh
server builds and compares their npm archive bytes. It copies runtime code from
that tarball, installs only production dependencies from the source `bun.lock`
with lifecycle scripts and optional native accelerators disabled, and packs the
result with `@anthropic-ai/mcpb` **2.1.2**. The packaging/client tools have their own
frozen lockfile in `tools/mcpb`; they are not bundled with the server.

The official packer's ZIP payload is canonicalized using sorted paths, fixed
permissions and a fixed ZIP date, then packed again and compared. Evidence records
both archive hashes, every bundled file hash, source commit/dirty status, source
and tooling lock hashes, launcher hash and tool/runtime versions. Checksums provide
integrity checking; they are not a publisher signature. Build dependencies, source
checkout state, local environment files and npm credentials are excluded.

The verifier installs the actual archive in a fresh temporary directory using the
official MCPB unpacker and configuration resolver. A real MCP SDK client starts the
manifest command with an isolated working directory, home and module environment.
It discovers an actual XState 5.32.6 actor, sends `RUN`, verifies `idle → running`
in both the actor and MCP snapshot resource, checks required-origin rejection,
rejects malformed numeric configuration and verifies shutdown/port release. The
server uses only the bundled runtime dependencies; installation needs no model key
and the running server needs no package registry access.

Repeat `bun run mcpb:verify` with Node **22.23.2** to verify the **same archive**.
CI builds once on Node 24 and runs clean consumers on both Node versions on Linux.
The consumer jobs install only the independent client tools, with no root server
or development dependencies. All generated reports are uploaded as CI artifacts.

## Supported client and platform boundary

The automated, supported reference client is the MCP SDK 1.30.0 with MCPB 2.1.2's
public unpack/configuration APIs on macOS and Linux, Node 22/24. This exercises the
actual bundle loader and protocol without paid model calls. Claude Desktop UI
installation, its embedded Node version, Windows and other hosts are **not yet
verified** by this suite; do not advertise those combinations as tested.

MCPB's upstream project supplies the loader code used by Claude Desktop and describes
its desktop installation flow. A maintainer can additionally open the final bundle
in a compatible MCPB host and record that client's exact version, runtime, settings,
real-actor verification and cleanup before adding it to the supported-client list.
A Node runtime outside 22/24 receives a clear startup error from this bundle.

## Configuration

The manifest exposes the following settings; they resolve to the existing
`XSTATE_MCP_*` environment variables before the real package CLI starts:

- `wsPort`: whole number 1024–65535, default 7357. Give simultaneous MCP processes
  different ports and connect the frontend to the chosen port.
- `wsHost`: `127.0.0.1` or `::1`; default IPv4 loopback. Remote binding is rejected.
- `bufferSize`: whole number 1–10000, default 100 history entries per actor.
  This does not establish a global retained-byte budget; that remains issue #11.
- `logLevel`: `debug`, `info`, `warn` or `error`, default `info`; stderr only.
- `allowedOrigins`: comma-separated HTTP(S) origins, at most 32; wildcard ports
  are supported. Default: `http://localhost:*,http://127.0.0.1:*`.
- `requireOrigin`: default `true`. Native WebSocket adapters must supply an allowed
  Origin header, or the user must explicitly disable this requirement.

A small bundle launcher validates these values before importing the **actual
`package.bin` CLI**. It does not import the library root as a startup shortcut or
replace the server's shutdown logic. The builder also accepts an explicit source
checkout and output directory for prerequisite testing:

```bash
node tools/mcpb/build.mjs --source /path/to/xstate-mcp-checkout --output /path/to/candidate
node tools/mcpb/verify.mjs /path/to/candidate/xstate-mcp-VERSION.mcpb
```

The source checkout must already have a frozen installation. Its npm tarball,
production dependencies, version and CLI entry remain tied to that checkout.
When the package declares separate library/CLI entries, the clean consumer also
imports the installed library and closes its factory without starting the CLI.

The current main-based source permits writes through an application command handler
and does not yet contain #32's paired write/redaction controls. Use synthetic data
for this development candidate. The reference verifier supplies narrow write opt-in
settings and negotiates capabilities when present, so it also tests the intended
future contracts. A supported release must reconcile those controls in the actual
manifest/adapter setup under #35; this packaging change does not implement them.

## Maintainer publication is separate

[Smithery's local publishing contract](https://smithery.ai/docs/build/publish)
accepts a pre-built MCPB bundle. The old `smithery.yaml` command-function deployment
is retired. The [release API](https://smithery.ai/docs/api-reference/servers/publish-a-server)
uses a multipart `bundle` upload for stdio distribution. An npm tarball is a distinct
artifact and is not uploaded in its place.

Before publication, integrate and review the lifecycle/version/contracts work,
select the stable version through the repository release process, build from that
clean reviewed commit, and verify the same bundle on both Node versions. Then run:

```bash
bun run mcpb:release-check
```

This refuses dirty/stale source, prerelease versions, modified artifacts, missing
Node verification, mismatched MCP/package versions, an absent CLI/library split,
unverified library imports or missing graceful EOF shutdown. It performs **no
upload**. Also complete the broader package audit/contract and intended-host checks;
this local gate does not replace the release workflow or certify a desktop client.

The original main-based candidate intentionally fails release checking: package
version 1.0.1 still advertises MCP version 1.0.0, has a combined CLI/library entry,
and needs SIGTERM after stdin EOF. These are tracked prerequisites, not hidden
packaging successes. The verifier records them even when the bundle round trip
passes. Never publish that candidate as a reconciled release.

After reviewing the artifact and confirming ownership of the intended Smithery
namespace, a maintainer may use the separately pinned CLI version checked for this
guide (`@smithery/cli` 4.11.1):

```bash
npx --yes @smithery/cli@4.11.1 mcp publish ./artifacts/mcpb/xstate-mcp-VERSION.mcpb -n YOUR_NAMESPACE/xstate-mcp
```

Replace both placeholders deliberately. Authenticate through Smithery's supported
flow; keep credentials outside the repository and bundle. Do not modify or claim
an existing listing without checking namespace ownership. Download the published
bundle and compare its checksum with the tested archive before declaring the
Smithery path verified. npm publication remains independent. No build/test/CI step
uploads to Smithery, publishes npm, creates a release tag or opens a remote server.

## Pinned primary contracts

- [MCPB schema 0.4 at commit 70fe3b34](https://github.com/modelcontextprotocol/mcpb/blob/70fe3b34cd6dff1b3bba046638edc72a6467a4fb/schemas/mcpb-manifest-v0.4.schema.json), vendored with URL/date/SHA-256 in `tools/mcpb/schema/`.
- [MCPB toolchain and host integration](https://github.com/modelcontextprotocol/mcpb). At the verification date, the installed 2.1.2 tool supports schema 0.4 even though the prose manifest guide still labels 0.3 as current. Both the pinned JSON schema and tool validator run here.
- Smithery local publishing and stdio release API linked above, checked 2026-09-07.
