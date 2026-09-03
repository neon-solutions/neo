# neo

Minimal coding subagent CLI. A parent process (today: Cursor + Grok) shells out to `neo`; neo prints the answer on stdout and exits.

```bash
neo --model fable --prompt "Review this diff"
neo --agents-md --skills --model fable --prompt "Implement the spec"
neo models list
neo sub list
neo sub pr-review --prompt "Review PR 123. One concern: the CLI."
```

## Stack

Bun for install and scripts. Node.js >= 22 at runtime. Vitest. TypeScript, `strict` + `verbatimModuleSyntax`. No `as` casts. Local binary: `bun run binary` (scriptc `--dynamic`, Node >= 24 to compile) writes `~/.local/bin/neo`.

## Product constraints

- Loop: Vercel AI SDK `ToolLoopAgent` with `stopWhen: stepCountIs(20)`. Not Mastra. Not Pi.
- Gateway: Neon AI Gateway plugin (`@neon/ai-sdk-provider`). Credentials from `~/.config/neo/providers/neon.json` (`apiKey`, `baseURL`). `NEON_AI_GATEWAY_*` overrides when both are set.
- Tools: `read`, `grep`, `glob`, `ls`, `bash`, plus `write` and `edit` unless `--readonly`. `grep` and `glob` both shell out to `rg` (`glob` is `rg --files -g`). `--readonly` omits `write` and `edit`; `bash` can still mutate.
- `--agents-md` loads every `AGENTS.md` from cwd up to the git root (farthest first). Fails if none exist. Off by default.
- `--skills` discovers Agent Skills (Mastra layout and `skill` / `skill_search` / `skill_read` tools) and injects the catalog. Off by default.
- `neo sub <name>` loads a launch template from `.agents/subs/<name>.md` (cwd to git root) or `~/.agents/subs/<name>.md`. Frontmatter pins model, flags, and optional cwd; the body is the system prompt. `list` prints names and descriptions, never the body. Templates are sealed: do not pass `--model` / `--readonly` / `--agents-md` / `--skills` on a sub launch. Off until a matching file exists; neo ships none.
- stderr is progress. stdout is the answer.
- No TUI, sessions, compaction, MCP, or subagents-of-subagents in v1. A sub is a parent-facing launch template, not neo spawning neo.
- Do not read AGENTS.md or load skills unless the matching flag is set or the user names them.

## Workflow

Work on `main`. Push `main`. No feature branch, no PR.

1. Pull latest `main`.
2. Implement. Keep the commit to one concern.
3. `bun run test` and `bun run typecheck`.
4. `bun run fmt`.
5. `git push origin main`.

## Layout

```text
src/cli.ts                       Commander entry
src/lib/run.ts                   ToolLoopAgent loop
src/lib/gateway.ts               Gateway seam
src/lib/agents-md.ts             --agents-md walk-up loader
src/lib/frontmatter.ts           YAML frontmatter split (skills + subs)
src/lib/edit.ts                  unique non-overlapping replacements
src/lib/paths.ts                 cwd/git-root path guards
src/plugins/neon-ai-gateway.ts   First gateway plugin (~/.config/neo/providers/neon.json)
src/plugins/tools.ts             read, grep, glob, ls, bash, write, edit
src/plugins/skills.ts            --skills plugin (discover, catalog, skill tools)
src/plugins/subs.ts              neo sub plugin (discover, list, sealed launch)
tests/                           Vitest, real CLI process, no mocks
neon.ts                          preview.aiGateway
```
