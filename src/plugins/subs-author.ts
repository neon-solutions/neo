import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { Command } from "commander";
import { createPrompter, type Prompter } from "../lib/ask";
import { NeoError } from "../lib/errors";
import { errorCode } from "../lib/paths";
import {
  composeSubMd,
  discoverSubs,
  isReservedSubName,
  missingSubMessage,
  parseSubMd,
  resolveExistingCwd,
  subTargetDir,
  type ComposeSubFields,
} from "./subs";
import {
  discoverSkills,
  filterSkills,
  isSkillName,
  parseSkillsFilter,
  skillsFilterFromCli,
  skillsOnly,
  uniqueSkillRecordNames,
} from "./skills";
import type { SkillsFilter } from "./skills";

const MAX_DESCRIPTION_LENGTH = 1024;

export type CreateSubOptions = {
  description?: string;
  model?: string;
  cwd?: string;
  readonly: boolean;
  agentsMd: boolean;
  skills?: boolean | string;
  global: boolean;
  body?: string;
  bodyFile?: string;
};

export type UpdateSubOptions = {
  description?: string;
  model?: string;
  cwd?: string;
  clearCwd: boolean;
  readonly?: string;
  agentsMd?: string;
  skills?: string;
  body?: string;
  bodyFile?: string;
};

export type DeleteSubOptions = {
  yes: boolean;
};

export async function createSub(
  nameArg: string | undefined,
  opts: CreateSubOptions,
  command: Command,
  cwd: string,
): Promise<string> {
  const optBody = opts.body;
  const optBodyFile = opts.bodyFile;
  const optDescription = opts.description;
  const optModel = opts.model;
  const optCwd = opts.cwd;
  const optReadonly = opts.readonly;
  const optAgentsMd = opts.agentsMd;
  const optSkills = opts.skills;
  if (optBody !== undefined && optBodyFile !== undefined) {
    throw new NeoError("neo: use --body or --body-file, not both");
  }

  const home = homedir();
  const cli = (key: string): boolean => command.getOptionValueSource(key) === "cli";
  const wizard = needsCreateWizard(nameArg, cli);
  const prompter = wizard ? createPrompter() : undefined;

  const name = await resolveName({ given: nameArg, wizard, prompter });
  const global = await resolveGlobal({
    flagged: cli("global"),
    wizard,
    prompter,
  });
  const description = await resolveRequiredText({
    given: cli("description") ? optDescription : undefined,
    wizard,
    prompter,
    prompt: "Description: ",
    field: "description",
    parse: parseDescription,
  });
  const model = await resolveRequiredText({
    given: cli("model") ? optModel : undefined,
    wizard,
    prompter,
    prompt: "Model (see: neo models list): ",
    field: "model",
    parse: parseModel,
  });
  const cwdValue = await resolveCwd({
    given: cli("cwd") ? optCwd : undefined,
    wizard,
    prompter,
    home,
  });
  const readonly = await resolveBool({
    flagged: cli("readonly"),
    value: optReadonly,
    wizard,
    prompter,
    prompt: "readonly? [y/N] ",
  });
  const agentsMd = await resolveBool({
    flagged: cli("agentsMd"),
    value: optAgentsMd,
    wizard,
    prompter,
    prompt: "agents-md? [y/N] ",
  });
  const discoverCwd =
    cwdValue === undefined ? cwd : await resolveExistingCwd(cwdValue, home, "cwd");
  const skills = await resolveSkills({
    flagged: cli("skills"),
    value: optSkills,
    wizard,
    prompter,
    discoverCwd,
    home,
  });
  const body = await resolveBody({
    body: cli("body") ? optBody : undefined,
    bodyFile: cli("bodyFile") ? optBodyFile : undefined,
    wizard,
    prompter,
  });

  const fields: ComposeSubFields = {
    description,
    model,
    cwd: cwdValue,
    readonly,
    agentsMd,
    skills,
  };
  const text = composeSubMd(fields, body);
  const dir = subTargetDir({ cwd, home, global });
  const dest = join(dir, `${name}.md`);

  const subs = await discoverSubs({ cwd, home });
  const existing = subs.find((sub) => sub.name === name);
  if (existing !== undefined && existing.path === dest) {
    throw new NeoError(`neo: ${dest} already exists; use "neo sub update ${name}"`);
  }

  await mkdir(dir, { recursive: true });
  if (existsSync(dest)) {
    throw new NeoError(`neo: ${dest} already exists; use "neo sub update ${name}"`);
  }
  await writeFile(dest, text, "utf8");

  if (existing !== undefined) {
    if (global) {
      process.stderr.write(`neo: ${dest} is shadowed by ${existing.path}\n`);
    } else {
      process.stderr.write(`neo: also exists at ${existing.path}; project shadows it\n`);
    }
  }
  return dest;
}

export async function updateSub(
  nameArg: string,
  opts: UpdateSubOptions,
  command: Command,
  cwd: string,
): Promise<string> {
  const name = parseSubName(nameArg);
  const optBody = opts.body;
  const optBodyFile = opts.bodyFile;
  const optDescription = opts.description;
  const optModel = opts.model;
  const optCwd = opts.cwd;
  const optReadonly = opts.readonly;
  const optAgentsMd = opts.agentsMd;
  const optSkills = opts.skills;
  if (optBody !== undefined && optBodyFile !== undefined) {
    throw new NeoError("neo: use --body or --body-file, not both");
  }
  const cli = (key: string): boolean => command.getOptionValueSource(key) === "cli";
  const cwdFlagged = cli("cwd");
  const clearCwd = cli("clearCwd");
  if (cwdFlagged && clearCwd) {
    throw new NeoError("neo: use --cwd or --clear-cwd, not both");
  }
  const changing =
    cli("description") ||
    cli("model") ||
    cwdFlagged ||
    clearCwd ||
    cli("readonly") ||
    cli("agentsMd") ||
    cli("skills") ||
    cli("body") ||
    cli("bodyFile");
  if (!changing) {
    throw new NeoError(
      "neo: sub update requires a flag. Use --description, --model, --cwd, --clear-cwd, --readonly, --agents-md, --skills, --body, or --body-file.",
    );
  }

  const home = homedir();
  const subs = await discoverSubs({ cwd, home });
  const sub = subs.find((entry) => entry.name === name);
  if (sub === undefined) {
    throw new NeoError(missingSubMessage(name, subs));
  }

  const parsed = parseSubMd(await readFile(sub.path, "utf8"), sub.path);
  const description = cli("description")
    ? parseDescription(mustTrimmed(optDescription, "description"))
    : parsed.description;
  const model = cli("model") ? parseModel(mustTrimmed(optModel, "model")) : parsed.model;
  let nextCwd = parsed.cwd;
  if (clearCwd) {
    nextCwd = undefined;
  } else if (cwdFlagged) {
    nextCwd = await requireCwd(mustTrimmed(optCwd, "cwd"), home);
  }
  const readonly = cli("readonly")
    ? parseTrueFalse(mustTrimmed(optReadonly, "readonly"), "readonly")
    : parsed.readonly;
  const agentsMd = cli("agentsMd")
    ? parseTrueFalse(mustTrimmed(optAgentsMd, "agents-md"), "agents-md")
    : parsed.agentsMd;
  const skills = cli("skills")
    ? parseSkillsFilter(mustTrimmed(optSkills, "skills"))
    : parsed.skills;
  if (cli("skills") && skills.kind === "only") {
    const discoverFrom =
      nextCwd === undefined ? (sub.cwd ?? cwd) : await resolveExistingCwd(nextCwd, home, sub.path);
    filterSkills(await discoverSkills({ cwd: discoverFrom, home }), skills.names);
  }
  const body = cli("body")
    ? parseBody(mustTrimmed(optBody, "body"))
    : cli("bodyFile")
      ? parseBody(await readBodyFile(mustTrimmed(optBodyFile, "body-file")))
      : parsed.systemPrompt;

  const text = composeSubMd({ description, model, cwd: nextCwd, readonly, agentsMd, skills }, body);
  await writeFile(sub.path, text, "utf8");
  return sub.path;
}

export async function deleteSub(
  nameArg: string,
  opts: DeleteSubOptions,
  cwd: string,
): Promise<string> {
  const name = parseSubName(nameArg);
  const yes = opts.yes;
  const home = homedir();
  const subs = await discoverSubs({ cwd, home });
  const sub = subs.find((entry) => entry.name === name);
  if (sub === undefined) {
    throw new NeoError(missingSubMessage(name, subs));
  }

  if (!yes) {
    const prompter = createPrompter();
    const answer = await prompter.ask(`Delete ${sub.path}? [y/N] `);
    if (answer === undefined || !isYes(answer)) {
      throw new NeoError("neo: delete aborted");
    }
  }

  const globalPath = join(home, ".agents", "subs", `${name}.md`);
  const revealsGlobal =
    sub.source === "project" && sub.path !== globalPath && existsSync(globalPath);
  await unlink(sub.path);
  if (revealsGlobal) {
    process.stderr.write(`neo: ${globalPath} is now visible\n`);
  }
  return sub.path;
}

function needsCreateWizard(name: string | undefined, cli: (key: string) => boolean): boolean {
  return (
    name === undefined ||
    name.trim().length === 0 ||
    !cli("description") ||
    !cli("model") ||
    (!cli("body") && !cli("bodyFile"))
  );
}

async function resolveName(args: {
  given: string | undefined;
  wizard: boolean;
  prompter: Prompter | undefined;
}): Promise<string> {
  if (args.given !== undefined && args.given.trim().length > 0) {
    return parseSubName(args.given);
  }
  if (!args.wizard || args.prompter === undefined) {
    throw new NeoError("neo: missing name");
  }
  for (;;) {
    const line = await args.prompter.ask("Name: ");
    if (line === undefined) {
      throw new NeoError("neo: missing name");
    }
    try {
      return parseSubName(line);
    } catch (error) {
      if (error instanceof NeoError) {
        process.stderr.write(`${error.message}\n`);
        continue;
      }
      throw error;
    }
  }
}

async function resolveGlobal(args: {
  flagged: boolean;
  wizard: boolean;
  prompter: Prompter | undefined;
}): Promise<boolean> {
  if (args.flagged) {
    return true;
  }
  if (!args.wizard || args.prompter === undefined) {
    return false;
  }
  for (;;) {
    const line = await args.prompter.ask("Location (project/global) [project]: ");
    if (line === undefined) {
      return false;
    }
    const value = line.trim().toLowerCase();
    if (value.length === 0 || value === "project") {
      return false;
    }
    if (value === "global") {
      return true;
    }
    process.stderr.write("neo: location must be project or global\n");
  }
}

async function resolveRequiredText(args: {
  given: string | undefined;
  wizard: boolean;
  prompter: Prompter | undefined;
  prompt: string;
  field: string;
  parse: (raw: string) => string;
}): Promise<string> {
  if (args.given !== undefined) {
    return args.parse(args.given);
  }
  if (!args.wizard || args.prompter === undefined) {
    throw new NeoError(`neo: missing ${args.field}`);
  }
  for (;;) {
    const line = await args.prompter.ask(args.prompt);
    if (line === undefined) {
      throw new NeoError(`neo: missing ${args.field}`);
    }
    try {
      return args.parse(line);
    } catch (error) {
      if (error instanceof NeoError) {
        process.stderr.write(`${error.message}\n`);
        continue;
      }
      throw error;
    }
  }
}

async function resolveCwd(args: {
  given: string | undefined;
  wizard: boolean;
  prompter: Prompter | undefined;
  home: string;
}): Promise<string | undefined> {
  if (args.given !== undefined) {
    return await requireCwd(args.given, args.home);
  }
  if (!args.wizard || args.prompter === undefined) {
    return undefined;
  }
  for (;;) {
    const line = await args.prompter.ask("cwd (absolute or ~/, empty to skip): ");
    if (line === undefined || line.trim().length === 0) {
      return undefined;
    }
    try {
      return await requireCwd(line, args.home);
    } catch (error) {
      if (error instanceof NeoError) {
        process.stderr.write(`${error.message}\n`);
        continue;
      }
      throw error;
    }
  }
}

async function resolveBool(args: {
  flagged: boolean;
  value: boolean;
  wizard: boolean;
  prompter: Prompter | undefined;
  prompt: string;
}): Promise<boolean> {
  if (args.flagged) {
    return args.value;
  }
  if (!args.wizard || args.prompter === undefined) {
    return false;
  }
  for (;;) {
    const line = await args.prompter.ask(args.prompt);
    if (line === undefined) {
      return false;
    }
    const parsed = parseYesNo(line, false);
    if (parsed !== undefined) {
      return parsed;
    }
    process.stderr.write("neo: enter y or n\n");
  }
}

async function resolveSkills(args: {
  flagged: boolean;
  value: boolean | string | undefined;
  wizard: boolean;
  prompter: Prompter | undefined;
  discoverCwd: string;
  home: string;
}): Promise<SkillsFilter> {
  if (args.flagged) {
    const filter = skillsFilterFromCli(args.value);
    if (filter.kind === "only") {
      filterSkills(await discoverSkills({ cwd: args.discoverCwd, home: args.home }), filter.names);
    }
    return filter;
  }
  if (!args.wizard || args.prompter === undefined) {
    return { kind: "off" };
  }
  return await pickSkills(args.prompter, args.discoverCwd, args.home);
}

async function pickSkills(
  prompter: Prompter,
  discoverCwd: string,
  home: string,
): Promise<SkillsFilter> {
  const discovered = await discoverSkills({ cwd: discoverCwd, home });
  const names = uniqueSkillRecordNames(discovered);
  const selected = new Set(names);

  const accept = (): SkillsFilter => {
    if (selected.size === 0 || names.length === 0) {
      return { kind: "off" };
    }
    if (selected.size === names.length) {
      return { kind: "all" };
    }
    const chosen = names.filter((name) => selected.has(name));
    return skillsOnly(chosen);
  };

  for (;;) {
    writeSkillsMenu(names, selected);
    const line = await prompter.ask("> ");
    if (line === undefined) {
      return accept();
    }
    const value = line.trim().toLowerCase();
    if (value.length === 0) {
      return accept();
    }
    if (value === "n" || value === "no" || value === "none" || value === "off") {
      return { kind: "off" };
    }
    if (value === "y" || value === "yes" || value === "all") {
      return { kind: "all" };
    }
    if (names.length === 0) {
      process.stderr.write("neo: enter none, all, or press Enter\n");
      continue;
    }
    const toggles = parseSkillToggles(line, names.length);
    if (toggles === undefined) {
      process.stderr.write("neo: enter none, all, numbers to toggle, or press Enter\n");
      continue;
    }
    for (const index of toggles) {
      const name = names[index];
      if (name === undefined) {
        continue;
      }
      if (selected.has(name)) {
        selected.delete(name);
      } else {
        selected.add(name);
      }
    }
  }
}

function writeSkillsMenu(names: string[], selected: Set<string>): void {
  if (names.length === 0) {
    process.stderr.write("Skills (none in cwd). Enter or none to skip, all to enable:\n");
    return;
  }
  const label =
    selected.size === 0
      ? "none selected"
      : selected.size === names.length
        ? "all selected"
        : `${selected.size} selected`;
  process.stderr.write(`Skills (${label}). Enter to accept, none, all, or numbers to toggle:\n`);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    if (name === undefined) {
      continue;
    }
    const mark = selected.has(name) ? "x" : " ";
    process.stderr.write(`  [${mark}] ${i + 1}. ${name}\n`);
  }
}

function parseSkillToggles(line: string, count: number): number[] | undefined {
  const parts = line
    .trim()
    .split(/[\s,]+/)
    .filter((part) => part.length > 0);
  if (parts.length === 0) {
    return undefined;
  }
  const indexes: number[] = [];
  for (const part of parts) {
    if (!/^[1-9][0-9]*$/.test(part)) {
      return undefined;
    }
    const n = Number(part);
    if (n < 1 || n > count) {
      return undefined;
    }
    indexes.push(n - 1);
  }
  return indexes;
}

async function resolveBody(args: {
  body: string | undefined;
  bodyFile: string | undefined;
  wizard: boolean;
  prompter: Prompter | undefined;
}): Promise<string> {
  if (args.body !== undefined) {
    return parseBody(args.body);
  }
  if (args.bodyFile !== undefined) {
    return parseBody(await readBodyFile(args.bodyFile));
  }
  if (!args.wizard || args.prompter === undefined) {
    throw new NeoError("neo: missing body");
  }
  const line = await args.prompter.askBody("System prompt (end with Ctrl-D):");
  if (line === undefined) {
    throw new NeoError("neo: missing body");
  }
  return parseBody(line);
}

function parseSubName(raw: string): string {
  const name = raw.trim();
  if (name.length === 0) {
    throw new NeoError("neo: missing name");
  }
  if (isReservedSubName(name)) {
    throw new NeoError(`neo: "${name}" is reserved; choose a different name`);
  }
  if (!isSkillName(name)) {
    throw new NeoError(`neo: filename must be kebab-case (got "${name}")`);
  }
  return name;
}

function parseDescription(raw: string): string {
  if (raw.includes("\n") || raw.includes("\r")) {
    throw new NeoError("neo: description must be a single line");
  }
  const description = raw.trim();
  if (description.length === 0) {
    throw new NeoError("neo: missing description");
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw new NeoError(`neo: description must be at most ${MAX_DESCRIPTION_LENGTH} characters`);
  }
  return description;
}

function parseModel(raw: string): string {
  const model = raw.trim();
  if (model.length === 0) {
    throw new NeoError("neo: missing model");
  }
  return model;
}

function parseBody(raw: string): string {
  const body = raw.trim();
  if (body.length === 0) {
    throw new NeoError("neo: missing body");
  }
  return body;
}

function parseTrueFalse(raw: string, key: string): boolean {
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  throw new NeoError(`neo: ${key} must be true or false`);
}

function parseYesNo(raw: string, defaultValue: boolean): boolean | undefined {
  const value = raw.trim().toLowerCase();
  if (value.length === 0) {
    return defaultValue;
  }
  if (value === "y" || value === "yes") {
    return true;
  }
  if (value === "n" || value === "no") {
    return false;
  }
  return undefined;
}

function isYes(raw: string): boolean {
  const value = raw.trim().toLowerCase();
  return value === "y" || value === "yes";
}

function mustTrimmed(value: string | undefined, field: string): string {
  if (value === undefined) {
    throw new NeoError(`neo: missing ${field}`);
  }
  return value;
}

async function requireCwd(raw: string, home: string): Promise<string> {
  const cwd = raw.trim();
  if (cwd.length === 0) {
    throw new NeoError("neo: cwd must not be empty");
  }
  if (cwd !== "~" && !cwd.startsWith("~/") && !isAbsolute(cwd)) {
    throw new NeoError("neo: cwd must be an absolute path");
  }
  await resolveExistingCwd(cwd, home, "cwd");
  return cwd;
}

async function readBodyFile(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await readFile(absolute, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new NeoError(`neo: --body-file not found: ${path}`);
    }
    throw error;
  }
}
