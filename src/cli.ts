#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command, InvalidArgumentError } from "commander";
import { loadCwdEnv, readGatewayCredentials } from "./lib/env";
import { NeoError } from "./lib/errors";
import { listModels, run } from "./lib/run";
import { createNeonGateway } from "./plugins/neon-ai-gateway";

function requireValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new InvalidArgumentError("value must not be empty");
  }
  return trimmed;
}

type RunOptions = {
  model?: string;
  prompt?: string;
  promptFile?: string;
  readonly: boolean;
};

async function runAgent(opts: RunOptions): Promise<void> {
  if (opts.prompt !== undefined && opts.promptFile !== undefined) {
    throw new NeoError("neo: use --prompt or --prompt-file, not both");
  }
  const fromFile =
    opts.promptFile === undefined ? undefined : readFileSync(resolve(opts.promptFile), "utf8");
  const prompt = (opts.prompt ?? fromFile ?? "").trim();
  if (opts.model === undefined || prompt.length === 0) {
    throw new NeoError("neo requires --model and --prompt (or --prompt-file)");
  }

  const cwd = process.cwd();
  loadCwdEnv(cwd);
  const gateway = createNeonGateway(readGatewayCredentials());
  const text = await run({
    model: opts.model,
    cwd,
    prompt,
    gateway,
  });
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

async function printModels(): Promise<void> {
  const cwd = process.cwd();
  loadCwdEnv(cwd);
  const gateway = createNeonGateway(readGatewayCredentials());
  const text = await listModels(gateway);
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

async function main(argv: string[]): Promise<void> {
  const program = new Command();
  program
    .name("neo")
    .description("A minimal lightweight open coding subagent.")
    .showHelpAfterError()
    .option("-m, --model <id>", "model id (catalog id or alias, for example fable)", requireValue)
    .option("-p, --prompt <text>", "prompt text")
    .option("--prompt-file <path>", "read the prompt from a file")
    .option("--readonly", "reserved; v1 has no write tools", true)
    .option("--no-readonly")
    .action(async (opts: RunOptions) => {
      await runAgent(opts);
    });

  program
    .command("models")
    .description("Inspect models from the Neon AI Gateway")
    .command("list")
    .description("List model ids and names available on this gateway")
    .action(async () => {
      await printModels();
    });

  await program.parseAsync(argv);
}

main(process.argv).catch((error: unknown) => {
  if (error instanceof NeoError || error instanceof InvalidArgumentError) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
