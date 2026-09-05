# neo

A minimal lightweight open coding subagent.

```sh
curl -fsSL https://getneo.sh | bash
```

Supports macOS arm64 and Linux x86_64. Installs to `~/.local/bin`. Re-run to upgrade. `rg` must be on PATH.

Each push to `main` replaces the rolling GitHub Release tag `latest`.

Parent agents spawn `neo` as a subprocess in the working directory they want inspected. The child talks to a model through the Neon AI Gateway, uses tools, and prints the answer on stdout.

```bash
neo --model fable --prompt "Review this diff"
neo --agents-md --skills --model fable --prompt "Implement the spec"
```

`--prompt-file` is the other way in. There is no `--cwd`: run neo in the directory that is the working tree.

`--readonly` omits `write` and `edit`. `bash` can still mutate.

`--agents-md` walks from the working directory up to the git root, loads every `AGENTS.md`, and concatenates farthest first so nearer files win. It fails if none are found.

`--skills` discovers Agent Skills from project `.agents/skills`, `.claude/skills`, and `.mastracode/skills` (cwd to git root) plus the same folders under `$HOME`, then attaches `skill`, `skill_search`, and `skill_read`. Pass comma-separated names to load a subset: `--skills tdd,good-code-comments`.

```bash
neo models list
```

prints the live catalog (id and name) from this branch's gateway.

```bash
neo sub list
neo sub details pr-review
neo sub pr-review --prompt "Review PR 123. One concern: the CLI."
neo sub create
neo sub create eng-review \
  --description "Critical engineering review of an open PR." \
  --model sol \
  --cwd ~/workspaces \
  --readonly --agents-md --skills tdd,good-code-comments \
  --body-file /tmp/system-prompt.md
neo sub update eng-review --model fable
neo sub delete eng-review --yes
```

A **sub** is a named launch template: model, flags, optional cwd, and a system prompt, so the parent supplies only the task prompt. `neo sub list` prints names and descriptions, never the system prompt. `neo sub details <name>` prints the full template, including the body, and tells the parent not to repeat that body in `--prompt`. Launch flags (`--model`, `--readonly`, `--agents-md`, `--skills`) cannot be overridden; they live in the file.

`neo sub create` writes that file. With no flags it prompts on stderr (name, project vs global, description, model, cwd, readonly / agents-md / skills, then the system prompt until Ctrl-D) and prints the path on stdout. The skills step lists skills in the sub's cwd (all selected). Enter keeps the current set (`skills: true` when all stay on), `none` turns them off, `all` turns them all on, and numbers toggle rows. Pass every required flag (`name`, `--description`, `--model`, `--body` or `--body-file`) and it does not prompt; `--skills` is all, `--skills tdd,foo` is an allowlist. `--global` writes to `~/.agents/subs/`, otherwise the project `.agents/subs/` (git root, or the invocation directory if there is no git). `neo sub update <name>` changes fields on the discovered file (project shadows global), including `--skills true|false|<names>`. `neo sub delete <name>` removes that file after `y/N`; `--yes` skips the confirm. `list`, `help`, `details`, `create`, `update`, and `delete` are reserved filenames.

Discovery: `.agents/subs/<name>.md` from the invocation directory up to the git root, then `~/.agents/subs/<name>.md`. Project shadows global. `update` and `delete` act on the winner; a shadowed global is edited by removing the project file first, or by editing the global file directly. User-wide jobs belong under `~/.agents/subs/` so they resolve from a nested clone. A sub may pin `cwd` for the run (`--agents-md` and `--skills` walk that directory); there is still no `--cwd` flag on launch.

```markdown
---
description: Critical engineering review of an open PR. Give it the repo path, the PR number or URL, and the PR's one concern.
model: sol
cwd: ~/workspaces
readonly: true
agents-md: true
skills:
  - tdd
  - good-code-comments
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

If the file is missing, a terminal `neo` run offers Neon AI Gateway, signs in with the Neon CLI (`neon auth` when needed), lets you pick an org and a project (or create one), mints a branch credential, and writes that file. Non-interactive runs still fail until the file exists.

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
