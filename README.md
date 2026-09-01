# neo

A minimal lightweight open coding subagent. Private while the loop is being built.

Parent agents (Cursor, and later anything else) spawn `neo run` as a subprocess. The child talks to a model the parent cannot host, uses tools in a working directory, and prints the answer on stdout.

```bash
bun src/cli.ts run --model fable --prompt "Review this diff" --cwd /path/to/repo
```

`--prompt-file` is the other way in. `--readonly` is the default.

The agent loop is not implemented yet. `neo run` parses flags and exits 2 until it is.

## Develop

```bash
bun install
bun run test
bun run typecheck
bun src/cli.ts --help
```

Apache-2.0.
