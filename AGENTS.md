# neo

Minimal coding subagent CLI. A parent process (today: Cursor + Grok) shells out to `neo`; neo prints the answer on stdout and exits.

```bash
neo --model fable --prompt "Review this diff"
neo models list
```

## Stack

Bun for install and scripts. Node.js >= 22 at runtime. Vitest. TypeScript, `strict` + `verbatimModuleSyntax`. No `as` casts.

## Product constraints

- Loop: Vercel AI SDK `ToolLoopAgent` with `stopWhen: stepCountIs(20)`. Not Mastra. Not Pi.
- Gateway: Neon AI Gateway plugin (`@neon/ai-sdk-provider`). Credentials from `NEON_AI_GATEWAY_*`, plus cwd `.env.local` if present.
- Tools: `read`, `grep`, `glob`, `bash`. `--readonly` is reserved; v1 has no write tools.
- stderr is progress. stdout is the answer.
- No TUI, sessions, compaction, MCP, or subagents-of-subagents in v1.
- Do not read AGENTS.md or load skills unless the user names them.

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
src/plugins/neon-ai-gateway.ts   First gateway plugin
src/plugins/tools.ts             read, grep, glob, bash
tests/                           Vitest, real CLI process, no mocks
neon.ts                          preview.aiGateway
```
