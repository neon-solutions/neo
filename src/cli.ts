#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { NeoError } from "./lib/errors";
import { listModels, run } from "./lib/run";
import { createNeonGateway } from "./plugins/neon-ai-gateway";
import { discoverSubs, formatSubDetails, formatSubsList, missingSubMessage } from "./plugins/subs";

function requireValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new NeoError("neo: value must not be empty");
  }
  return trimmed;
}

type PromptOptions = {
  prompt?: string;
  promptFile?: string;
};

type RunOptions = PromptOptions & {
  model?: string;
  readonly: boolean;
  agentsMd: boolean;
  skills: boolean;
};

const ROOT_LAUNCH_FLAGS = ["model", "readonly", "agentsMd", "skills"] as const;

function readPrompt(opts: PromptOptions): string {
  if (opts.prompt !== undefined && opts.promptFile !== undefined) {
    throw new NeoError("neo: use --prompt or --prompt-file, not both");
  }
  const fromFile =
    opts.promptFile === undefined ? undefined : readFileSync(resolve(opts.promptFile), "utf8");
  const prompt = (opts.prompt ?? fromFile ?? "").trim();
  if (prompt.length === 0) {
    throw new NeoError("neo requires --prompt (or --prompt-file)");
  }
  return prompt;
}

function assertSealedRootFlags(program: Command): void {
  for (const flag of ROOT_LAUNCH_FLAGS) {
    if (program.getOptionValueSource(flag) === "cli") {
      throw new NeoError(
        "neo: sub templates are sealed; do not pass --model, --readonly, --agents-md, or --skills",
      );
    }
  }
}

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

  const text = await run({
    model: opts.model,
    cwd: process.cwd(),
    prompt,
    readonly: opts.readonly,
    agentsMd: opts.agentsMd,
    skills: opts.skills,
  });
  writeAnswer(text);
}

async function runSub(name: string, opts: PromptOptions): Promise<void> {
  const prompt = readPrompt(opts);
  const subs = await discoverSubs({ cwd: process.cwd() });
  const sub = subs.find((entry) => entry.name === name);
  if (sub === undefined) {
    throw new NeoError(missingSubMessage(name, subs));
  }

  const text = await run({
    model: sub.model,
    cwd: sub.cwd ?? process.cwd(),
    prompt,
    readonly: sub.readonly,
    agentsMd: sub.agentsMd,
    skills: sub.skills,
    subPrompt: sub.systemPrompt,
  });
  writeAnswer(text);
}

async function printModels(): Promise<void> {
  const gateway = createNeonGateway();
  const text = await listModels(gateway);
  writeAnswer(text);
}

async function printSubs(): Promise<void> {
  const subs = await discoverSubs({ cwd: process.cwd() });
  writeAnswer(formatSubsList(subs));
}

async function printSubDetails(name: string): Promise<void> {
  const subs = await discoverSubs({ cwd: process.cwd() });
  const sub = subs.find((entry) => entry.name === name);
  if (sub === undefined) {
    throw new NeoError(missingSubMessage(name, subs));
  }
  writeAnswer(formatSubDetails(sub));
}

function writeAnswer(text: string): void {
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

async function main(argv: string[]): Promise<void> {
  const program = new Command();
  program
    .name("neo")
    .description("A minimal lightweight open coding subagent.")
    .showHelpAfterError()
    .enablePositionalOptions()
    .option("-m, --model <id>", "model id (catalog id or alias, for example fable)", requireValue)
    .option("-p, --prompt <text>", "prompt text")
    .option("--prompt-file <path>", "read the prompt from a file")
    .option("--readonly", "omit write and edit tools (bash can still mutate)", false)
    .option("--no-readonly")
    .option(
      "--agents-md",
      "load AGENTS.md files from the working directory up to the git root into the system prompt",
      false,
    )
    .option(
      "--skills",
      "discover Agent Skills and attach skill, skill_search, and skill_read",
      false,
    )
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

  const sub = program.command("sub").description("Run a named launch template");
  sub.enablePositionalOptions();
  sub
    .command("list")
    .description("List available subs")
    .action(async () => {
      assertSealedRootFlags(program);
      await printSubs();
    });
  sub
    .command("details")
    .description("Print a sub's full template")
    .argument("<name>", "sub name")
    .action(async (name: string) => {
      assertSealedRootFlags(program);
      await printSubDetails(name);
    });
  sub
    .argument("[name]", "sub name")
    .option("-p, --prompt <text>", "prompt text")
    .option("--prompt-file <path>", "read the prompt from a file")
    .action(async (name: string | undefined, opts: PromptOptions) => {
      if (name === undefined) {
        sub.help();
        return;
      }
      assertSealedRootFlags(program);
      await runSub(name, opts);
    });

  await program.parseAsync(argv);
}

main(process.argv).catch((error: unknown) => {
  if (error instanceof NeoError) {
    console.error(error.message);
    process.exit(1);
  }
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
