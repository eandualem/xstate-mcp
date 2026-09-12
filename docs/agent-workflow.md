# Working across coding agents

`AGENTS.md` is the shared project instruction file. Contributor documentation,
architecture, issues, and review findings are tracked in this repository. A fresh
clone should be enough to understand the work without a previous agent's memory.

## CLI entry points

- Agents supporting `AGENTS.md` can read it directly, including
  [Codex](https://learn.chatgpt.com/docs/agent-configuration/agents-md) and
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

### Validate paths separately from runtime loading

Checking import syntax, rule frontmatter, and referenced paths establishes that
the configuration is consistent. Asking an agent to name its instructions can
pass simply because it searches for and reads those files. Neither check proves
automatic loading in a new runtime.

For a runtime smoke check, use an isolated disposable copy of the project with
the same CLI entry points, outside the working checkout:

1. Add a temporary instruction to the copy's `AGENTS.md`: “Begin your first reply
   with `LOAD-CHECK-<nonce>`.” Replace `<nonce>` with a fresh random value. Keep
   that value only in the instruction file, never in the launch prompt or an
   adapter; this exercises the adapter's reference to the shared file too.
2. Start a **new conversation** in that directory with the CLI and configuration
   being tested. Do not resume/fork an old conversation or explicitly attach the
   instruction file. Use an incurious prompt such as “What is 2 + 2?” that asks
   nothing about instructions, files, or the marker.
3. Preserve the first response and tool trace. The expected marker must appear
   before any model-requested file read/search could discover it. If the runtime
   exposes startup context, verify the instruction arrived there. A later marker
   after a tool read is evidence of explicit reading, not automatic loading.
4. Remove only the temporary marker instruction and repeat in another new
   conversation with the same prompt. This negative control must not produce the
   marker. Unexpected markers or missing/ambiguous traces make the check
   inconclusive; investigate rather than reporting a pass.
5. Record the date, CLI/version, launch directory and mode, entry-point contents,
   prompt, responses, and loading evidence in a sanitized note or issue comment.
   Remove the disposable copy. Never commit the marker to project instructions.

Test each CLI separately; one passing runtime does not establish the others.
An explicit-read Cursor rule must be reported as such if its trace shows a file
read. A fresh managed launch's injected shared brief and skill catalog are also
distinct evidence from this project-file smoke check. A next-start template or
skill preview alone does not prove a running session received that content.

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

No backbone service is required to build or test xstate-mcp. Managed sessions use
the injected base brief for coordination and the shared `project-context` policy
for handoff/evidence hygiene. The local memory layout and fresh-clone fallback
above apply across runtimes. CLI adapters only point to `AGENTS.md`; they do not
maintain separate memory or coordination procedures.

The managed `xstate` skill selection is for frontend application work, not a
requirement to introduce Next.js conventions into the protocol server. Generic
user skills and runtime-owned additions are separate from backbone's selection.

The previous Lovely Universe symlink tree and universal private skills are not
dependencies. The old instructions are historical reference, reconciled in
[the concepts document](concepts.md), rather than imported at runtime.
