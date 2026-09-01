# Contributing

This repo is private. If you have access, treat it like any other neon-solutions CLI.

## Setup

```bash
bun install
bun run test
bun run typecheck
```

Bun is the package manager. Node.js 22+ is the runtime.

## Changes

Branch from `main`. Keep a PR to one concern. Tests use Vitest against the real CLI (`bun src/cli.ts`); do not mock the filesystem or the process.

`bun run fmt` before you push.

See `AGENTS.md` for the product constraints (AI SDK loop, no Mastra/Pi, readonly default).
