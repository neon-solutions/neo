#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command, InvalidArgumentError } from "commander";
import { NotImplementedError, run } from "./lib/run";

function requireValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new InvalidArgumentError("value must not be empty");
  }
  return trimmed;
}

async function main(argv: string[]): Promise<void> {
  const program = new Command();
  program
    .name("neo")
    .description("A minimal lightweight open coding subagent.")
    .showHelpAfterError();

  program
    .command("run")
    .description("Run one subagent turn and print the answer")
    .requiredOption("-m, --model <id>", "model id (for example fable)", requireValue)
    .option("--cwd <dir>", "working directory", process.cwd())
    .option("-p, --prompt <text>", "prompt text")
    .option("--prompt-file <path>", "read the prompt from a file")
    .option("--readonly", "restrict tools to read-only use", true)
    .option("--no-readonly", "allow write tools")
    .action(
      async (opts: {
        model: string;
        cwd: string;
        prompt?: string;
        promptFile?: string;
        readonly: boolean;
      }) => {
        const fromFile = opts.promptFile
          ? readFileSync(resolve(opts.promptFile), "utf8")
          : undefined;
        const prompt = (opts.prompt ?? fromFile ?? "").trim();
        if (prompt.length === 0) {
          program.error("neo run requires --prompt or --prompt-file");
        }
        const text = await run({
          model: opts.model,
          cwd: resolve(opts.cwd),
          prompt,
          readonly: opts.readonly,
        });
        process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
      },
    );

  await program.parseAsync(argv);
}

main(process.argv).catch((error: unknown) => {
  if (error instanceof NotImplementedError) {
    console.error(error.message);
    process.exitCode = 2;
    return;
  }
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
