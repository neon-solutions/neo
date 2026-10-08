# Contributing

Treat this like any other neon-solutions CLI.

## Setup

```bash
bun install
neon link --project-id mute-dawn-75832467 -y
bun run test
bun run typecheck
```

Bun is the package manager. Node.js 22+ is the runtime. Live tests need `~/.config/neo/providers/neon.json` or both `NEON_AI_GATEWAY_*` env vars.

## Changes

Work on `main`. Push `main`. No feature branch, no PR. Keep a commit to one concern. Tests use Vitest against the real CLI (`bun src/cli.ts`); do not mock the filesystem or the process.

`bun run fmt` before you push. CI on `main` runs `bun run test:ci` (everything except `tests/live.test.ts`) plus typecheck, then publishes binaries. `bun run test` including live tests remains the pre-push gate.

A change that touches how `ai` or another npm package runs also needs the live tests against the compiled binary, because scriptc runs npm code in an embedded engine with a smaller web-platform surface than Node:

```bash
scriptc build src/cli.ts --dynamic -o .scriptc/neo
NEO_BIN=$PWD/.scriptc/neo bunx vitest run tests/live.test.ts
```

`packages/readable-stream-tee` installs `ReadableStream.prototype.tee` inside that engine, which `ToolLoopAgent.stream` needs.

## Plugins

Capabilities are plugins. Keep the core limited to the loop, the CLI, and plugin seams.

The first implementation of a layer is that layer's first plugin. "Let's only support the Neon AI Gateway for now" means the gateway layer starts with a Neon AI Gateway plugin. If the seam does not exist yet, add the seam with the plugin.

See `AGENTS.md` for the product constraints (AI SDK loop, Neon AI Gateway plugin, `--agents-md` and `--skills` off by default, `neo sub` launch templates).
