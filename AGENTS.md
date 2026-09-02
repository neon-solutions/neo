# neo

Minimal coding subagent CLI. A parent process (today: Cursor + Grok) shells out to `neo run`; neo prints the answer on stdout and exits.

## Stack

Bun for install and scripts. Node.js >= 22 at runtime. Vitest. TypeScript, `strict` + `verbatimModuleSyntax`. No `as` casts.

## Product constraints

- Loop: Vercel AI SDK `ToolLoopAgent` / `generateText` with `stopWhen`. Not Mastra. Not Pi.
- Tools (when the loop lands): `read`, `grep`, `glob`, `bash`. `--readonly` is the default.
- stderr is progress. stdout is the answer.
- No TUI, sessions, compaction, MCP, or subagents-of-subagents in v0.

## Workflow

Work on `main`. Push `main`. No feature branch, no PR.

1. Pull latest `main`.
2. Implement. Keep the commit to one concern.
3. `bun run test` and `bun run typecheck`.
4. `bun run fmt`.
5. `git push origin main`.

## Layout

```text
src/cli.ts       Commander entry
src/lib/run.ts   The run() the loop will live in
tests/           Vitest, real CLI process, no mocks
```
