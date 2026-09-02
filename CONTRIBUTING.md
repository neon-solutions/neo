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

Work on `main`. Push `main`. No feature branch, no PR. Keep a commit to one concern. Tests use Vitest against the real CLI (`bun src/cli.ts`); do not mock the filesystem or the process.

`bun run fmt` before you push.

## Plugins

Capabilities are plugins. Keep the core limited to the loop, the CLI, and plugin seams.

The first implementation of a layer is that layer's first plugin. "Let's only support the Neon AI Gateway for now" means the gateway layer starts with a Neon AI Gateway plugin. If the seam does not exist yet, add the seam with the plugin.

See `AGENTS.md` for the product constraints (AI SDK loop, no Mastra/Pi, readonly default).
