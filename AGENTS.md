# neo

Minimal coding subagent CLI. A parent process (today: Cursor + Grok) shells out to `neo`; neo prints the answer on stdout and exits.

```bash
neo --model fable --prompt "Review this diff"
neo --agents-md --skills --model fable --prompt "Implement the spec"
neo models list
neo sub list
neo sub details pr-review
neo sub pr-review --prompt "Review PR 123. One concern: the CLI."
neo sub create
neo sub update pr-review --model fable
neo sub delete pr-review --yes
```

## Stack

Bun for install and scripts. Node.js >= 22 at runtime. Vitest. TypeScript, `strict` + `verbatimModuleSyntax`. No `as` casts. Local binary: `bun run binary` (scriptc `--dynamic`, Node >= 24 to compile) writes `~/.local/bin/neo`.

## Product constraints

- Loop: Vercel AI SDK `ToolLoopAgent` with `stopWhen: stepCountIs(20)`. Not Mastra. Not Pi.
- Gateway: Neon AI Gateway plugin (`@neon/ai-sdk-provider`). Credentials from `~/.config/neo/providers/neon.json` (`apiKey`, `baseURL`). `NEON_AI_GATEWAY_*` overrides when both are set. A TTY run with no credentials starts a Neon CLI wizard (the only provider): `neon auth` if needed, pick org, pick or create project, mint via `neon env pull -s ai-gateway`, write the file. Non-TTY still errors.
- Tools: `read`, `grep`, `glob`, `ls`, `bash`, plus `write` and `edit` unless `--readonly`. `grep` and `glob` both shell out to `rg` (`glob` is `rg --files -g`). `--readonly` omits `write` and `edit`; `bash` can still mutate.
- `--agents-md` loads every `AGENTS.md` from cwd up to the git root (farthest first). Fails if none exist. Off by default.
- `--skills` discovers Agent Skills (Mastra layout and `skill` / `skill_search` / `skill_read` tools) and injects the catalog. Off by default. `--skills tdd,foo` loads only those names; a missing name fails.
- `neo sub <name>` loads a launch template from `.agents/subs/<name>.md` (cwd to git root) or `~/.agents/subs/<name>.md`. Frontmatter pins model, flags, and optional cwd; the body is the system prompt. `skills: true` loads every discovered skill; a YAML list is an allowlist. `list` prints names and descriptions, never the body. `details <name>` prints the full template so the parent knows what not to repeat in `--prompt`. `create` writes a template (interactive wizard, or all flags and no prompts). The wizard skills step selects all by default; `none` / `all` / numbers toggle. `update` edits the discovered file. `delete` removes it (`--yes` skips the confirm). Templates are sealed: do not pass `--model` / `--readonly` / `--agents-md` / `--skills` on a sub launch. Off until a matching file exists; neo ships none. `list`, `help`, `details`, `create`, `update`, and `delete` are reserved filenames.
- stderr is progress. stdout is the answer.
- No TUI, sessions, compaction, MCP, or subagents-of-subagents in v1. A sub is a parent-facing launch template, not neo spawning neo.
- Do not read AGENTS.md or load skills unless the matching flag is set or the user names them.

## Workflow

Work on `main`. Push `main`. No feature branch, no PR.

1. Pull latest `main`.
2. Implement. Keep the commit to one concern.
3. `bun run test` and `bun run typecheck`.
4. `bun run fmt`.
5. `git push origin main`. That push runs `.github/workflows/publish.yml`: typecheck, `bun run test:ci` (non-live), scriptc binaries for linux-x86_64 and darwin-arm64, then clobber the rolling `latest` GitHub Release. A red run is a finding to fix, not a reason to re-push past it.

The installer URL `https://getneo.sh` (Vercel project `neo`, personal team `andrelandgraf`) proxies `setup.sh` from GitHub `main`, so a `setup.sh` change is live without a Vercel redeploy. The `*.vercel.app` aliases still work. Changing `install/` needs `vercel deploy --cwd install --prod --yes --project neo`. Keep Deployment Protection / SSO off or `curl | bash` hits the Vercel login wall.

## Layout

```text
src/cli.ts                       Commander entry
src/lib/run.ts                   ToolLoopAgent loop
src/lib/gateway.ts               Gateway seam
src/lib/agents-md.ts             --agents-md walk-up loader
src/lib/frontmatter.ts           YAML frontmatter split (skills + subs)
src/lib/edit.ts                  unique non-overlapping replacements
src/lib/paths.ts                 cwd/git-root path guards
src/lib/ask.ts                   stderr prompts, stdin answers (create / delete)
src/plugins/neon-ai-gateway.ts   First gateway plugin (~/.config/neo/providers/neon.json)
src/plugins/neon-setup.ts        TTY wizard: Neon CLI auth, org/project, mint credentials
src/lib/neon-cli.ts              neon subprocess + JSON/env parsers
src/lib/neon-provider-config.ts  neon.json + NEON_AI_GATEWAY_* read/write
src/plugins/tools.ts             read, grep, glob, ls, bash, write, edit
src/plugins/skills.ts            --skills plugin (discover, catalog, skill tools)
src/plugins/subs.ts              neo sub plugin (discover, list, sealed launch)
src/plugins/subs-author.ts       neo sub create / update / delete
tests/                           Vitest, real CLI process, no mocks
setup.sh                         curl | bash installer (rolling `latest` release)
install/                         Vercel proxy at https://getneo.sh
.github/workflows/publish.yml    push to main → rolling `latest` release
neon.ts                          preview.aiGateway
```
