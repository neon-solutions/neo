# neo

A minimal lightweight open coding subagent. Private.

Parent agents spawn `neo` as a subprocess in the working directory they want inspected. The child talks to a model through the Neon AI Gateway, uses tools, and prints the answer on stdout.

```bash
neo --model fable --prompt "Review this diff"
neo --agents-md --skills --model fable --prompt "Implement the spec"
```

`--prompt-file` is the other way in. There is no `--cwd`: run neo in the directory that is the working tree.

`--readonly` omits `write` and `edit`. `bash` can still mutate.

`--agents-md` walks from the working directory up to the git root, loads every `AGENTS.md`, and concatenates farthest first so nearer files win. It fails if none are found.

`--skills` discovers Agent Skills from project `.agents/skills`, `.claude/skills`, and `.mastracode/skills` (cwd to git root) plus the same folders under `$HOME`, then attaches `skill`, `skill_search`, and `skill_read`.

```bash
neo models list
```

prints the live catalog (id and name) from this branch's gateway.

```bash
neo sub list
neo sub details pr-review
neo sub pr-review --prompt "Review PR 123. One concern: the CLI."
```

A **sub** is a named launch template: model, flags, optional cwd, and a system prompt, so the parent supplies only the task prompt. `neo sub list` prints names and descriptions, never the system prompt. `neo sub details <name>` prints the full template, including the body, and tells the parent not to repeat that body in `--prompt`. Launch flags (`--model`, `--readonly`, `--agents-md`, `--skills`) cannot be overridden; they live in the file.

Discovery: `.agents/subs/<name>.md` from the invocation directory up to the git root, then `~/.agents/subs/<name>.md`. Project shadows global. User-wide jobs belong under `~/.agents/subs/` so they resolve from a nested clone. A sub may pin `cwd` for the run (`--agents-md` and `--skills` walk that directory); there is still no `--cwd` flag.

```markdown
---
description: Critical engineering review of an open PR. Give it the repo path, the PR number or URL, and the PR's one concern.
model: sol
cwd: ~/workspaces
readonly: true
agents-md: true
skills: true
---

You are running a critical engineering review of one pull request.
```

The Neon gateway plugin reads `~/.config/neo/providers/neon.json`:

```json
{
  "apiKey": "...",
  "baseURL": "https://<branch>.aws.neon.tech"
}
```

`NEON_AI_GATEWAY_TOKEN` and `NEON_AI_GATEWAY_BASE_URL` override the file when both are set. Other gateway plugins pick their own filename under `~/.config/neo/providers/`.

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
