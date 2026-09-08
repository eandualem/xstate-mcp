# Contributing

xstate-mcp helps coding agents inspect and exercise running XState applications.
Keep changes focused on making the observe → act → verify loop reliable.
Read [the concepts](docs/concepts.md) and [agent instructions](AGENTS.md) first.

## Setup

Use the Bun version pinned in `.bun-version` with the committed `bun.lock`.
Supported Node.js lines are 22.23.2+ within 22.x and 24.20.0+ within 24.x;
see the [runtime policy](docs/runtime-support.md).

```bash
bun install --frozen-lockfile
bun run check
bun run build
```

The root suite runs locally without a browser, API key, model, backbone, or another
repository. WebSocket tests bind loopback ports. Real XState and Stately producer
fixtures exercise the MCP protocol; subprocess tests verify the built and packed
CLI, import-safe library, and shutdown behavior.

`bun run dev` starts the server. Use `XSTATE_MCP_WS_PORT` to avoid another MCP
process's port. Server stdout is reserved for JSON-RPC; read diagnostics on stderr.

## Changes and pull requests

- Branch from the current default branch, currently `main`, and target it with PRs.
- Keep source fixes, capabilities, and demos reviewable as separate issues/PRs.
- Use conventional commit prefixes; explain the reason for the change.
- Run `bun run check` and `bun run build` for code/dependency changes. For a
  docs-only change, validate links, configuration, and consistency with the code.
- Add behavioral regression tests for bugs. For wire protocol changes, include
  real producer messages and a real MCP client; keep fixtures versioned.
- Link the issue and summarize validation. Use `Closes #N` only when all its
  acceptance criteria are met. Leave remaining work explicit.

Instructions and local handoffs work across CLIs; see
[the agent workflow](docs/agent-workflow.md). Backbone is an optional coordination
tool and is not a build or runtime dependency.

## Releases

Run `bun run release:prepare` from a clean, committed tree to build twice,
compare archives, and exercise an isolated npm consumer. `bun run metadata:check`
checks package, MCP, and registry metadata consistency. These commands create
local verification artifacts; they do not publish a package.

Publication requires separate authorization and the tag/environment prerequisites
in the [release guide](docs/releases.md). `make publish` refuses direct publishing.
The release workflow publishes only through its explicit gated dispatch, using
the same verified archive. Do not publish incidentally while working on an issue.
