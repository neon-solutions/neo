# neo

A minimal lightweight open coding subagent. Private.

Parent agents spawn `neo` as a subprocess in the working directory they want inspected. The child talks to a model through the Neon AI Gateway, uses tools, and prints the answer on stdout.

```bash
neo --model fable --prompt "Review this diff"
```

`--prompt-file` is the other way in. There is no `--cwd`: run neo in the directory that is the working tree. `--readonly` is reserved; v1 has no write tools.

```bash
neo models list
```

prints the live catalog (id and name) from this branch's gateway.

The Neon gateway plugin reads `~/.config/neo/providers/neon.json`:

```json
{
  "apiKey": "...",
  "baseURL": "https://<branch>.aws.neon.tech"
}
```

`NEON_AI_GATEWAY_TOKEN` and `NEON_AI_GATEWAY_BASE_URL` override the file when both are set. Other gateway plugins pick their own filename under `~/.config/neo/providers/`.

v1 does not read AGENTS.md and does not load skills.

## Design

Capabilities are plugins. The core is the loop, the CLI, and the seams those plugins plug into.

A layer that currently has one implementation still lives behind that seam. "Let's only support the Neon AI Gateway for now" means the gateway layer starts with a Neon AI Gateway plugin.

## Develop

```bash
bun install
neon link --project-id mute-dawn-75832467 -y
bun run test
bun run typecheck
bun src/cli.ts --help
```

Local binary (scriptc, Node >= 24 to compile, clang):

```bash
npm install -g scriptc
bun run binary
neo --help
```

That writes `~/.local/bin/neo`. `ai` / commander need `--dynamic` (embedded JS engine). Keep `bun src/cli.ts` for day-to-day.

Apache-2.0.
