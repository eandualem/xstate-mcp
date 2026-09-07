# Working across coding agents

`AGENTS.md` is the shared project instruction file. Contributor documentation,
architecture, issues, and review findings are tracked in this repository. A fresh
clone should be enough to understand the work without a previous agent's memory.

## CLI entry points

- Agents supporting `AGENTS.md` can read it directly, including Codex and
  [OpenCode](https://opencode.ai/v2/docs/instructions).
- [Claude Code](https://code.claude.com/docs/en/memory) imports it through
  `CLAUDE.md` using `@AGENTS.md`.
- [Gemini CLI](https://geminicli.com/docs/cli/gemini-md/) imports it through
  `GEMINI.md` using `@./AGENTS.md`.
- [Aider](https://aider.chat/docs/config/aider_conf.html) loads it as a read-only
  file through the repository's `.aider.conf.yml`.
- `.cursor/rules/project.mdc` points editor sessions to the same instructions.
- For another CLI, explicitly load `AGENTS.md` as project context, then ask it
  to read the relevant tracked docs and local handoff. Do not copy the entire
  instruction file into a second independently maintained file.

These files configure project context. They do not choose a model, install a
CLI, change approval/sandbox settings, or grant MCP access. Configure this server
in the consuming agent separately using the command/environment in `README.md`.
Some coding CLIs can edit the repository without supporting MCP consumption.

Validation here checks configuration syntax and local references, not a live
model session in every CLI. For a smoke check, start your chosen CLI in the repo
and ask it to name the project instructions, quality command, and current handoff.

## Shared local memory

Use the same optional, git-ignored layout as agent-backbone:

```text
.backbone/memory/
  HANDOFF.md
  INDEX.md
  notes/
```

`HANDOFF.md` records the date, active objective, branch, changed files, issue/PR
links, verified results, known failures, running processes, and next steps. Rewrite
it when handing off so another runtime can continue. `INDEX.md` lists durable
notes with their dates and relevance. Record decisions with their source.

If these files are absent, start from the tracked docs and GitHub issues and
create them when useful. Keep durable product decisions in tracked documentation
or issues too: local memory does not travel with a clone. Never put credentials,
application payloads, or private conversations in the repository or memory.

Memory is evidence, not authority. Recheck stale measurements and follow the
current user request. Provider-specific private memory is only a cache.

## Optional backbone coordination

No backbone service is required to build or test xstate-mcp. If running under
backbone, use its playbooks before first use and put `[from:<agent-name>]` first
in issue acknowledgements. Use repository issues for the roadmap, with explicit
dependencies and acceptance criteria. A queued issue notification is context;
finish the active task before starting another implementation.

The previous Lovely Universe symlink tree and universal private skills are not
dependencies. The old instructions are historical reference, reconciled in
[the concepts document](concepts.md), rather than imported at runtime.
