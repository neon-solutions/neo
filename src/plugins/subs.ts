import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { NeoError } from "../lib/errors";
import { splitFrontmatter } from "../lib/frontmatter";
import { errorCode, walkToGitRoot } from "../lib/paths";
import { isSkillName } from "./skills";

const MAX_DESCRIPTION_LENGTH = 1024;
const LIST_WRAP = 78;
const RESERVED_NAMES = new Set(["list", "help", "details"]);
const KNOWN_KEYS = new Set(["description", "model", "cwd", "readonly", "agents-md", "skills"]);

export type ParsedSub = {
  name: string;
  description: string;
  model: string;
  cwd?: string;
  readonly: boolean;
  agentsMd: boolean;
  skills: boolean;
  systemPrompt: string;
};

export type SubRecord = ParsedSub & {
  path: string;
  source: "project" | "global";
};

export type DiscoverSubsArgs = {
  cwd: string;
  home?: string;
};

export function parseSubMd(text: string, filePath: string): ParsedSub {
  const split = splitFrontmatter(text, { strict: true, source: filePath });
  if (split === undefined) {
    throw new NeoError(`neo: ${filePath}: missing YAML frontmatter`);
  }

  const name = subNameFromPath(filePath);
  for (const key of split.fields.keys()) {
    if (key === "name") {
      throw new NeoError(`neo: ${filePath}: name comes from the filename; remove the name: key`);
    }
    if (!KNOWN_KEYS.has(key)) {
      throw new NeoError(`neo: ${filePath}: unknown key "${key}"`);
    }
  }

  const description = split.fields.get("description");
  if (description === undefined || description.trim().length === 0) {
    throw new NeoError(`neo: ${filePath}: missing description`);
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw new NeoError(
      `neo: ${filePath}: description must be at most ${MAX_DESCRIPTION_LENGTH} characters`,
    );
  }

  const model = split.fields.get("model")?.trim();
  if (model === undefined || model.length === 0) {
    throw new NeoError(`neo: ${filePath}: missing model`);
  }

  const systemPrompt = split.body.trim();
  if (systemPrompt.length === 0) {
    throw new NeoError(`neo: ${filePath}: body is empty`);
  }

  const cwd = split.fields.get("cwd");
  if (cwd !== undefined) {
    const trimmed = cwd.trim();
    if (trimmed.length === 0) {
      throw new NeoError(`neo: ${filePath}: cwd must not be empty`);
    }
    if (trimmed !== "~" && !trimmed.startsWith("~/") && !isAbsolute(trimmed)) {
      throw new NeoError(`neo: ${filePath}: cwd must be an absolute path`);
    }
  }

  return {
    name,
    description,
    model,
    cwd: cwd === undefined ? undefined : cwd.trim(),
    readonly: parseBool(split.fields.get("readonly"), "readonly", filePath, false),
    agentsMd: parseBool(split.fields.get("agents-md"), "agents-md", filePath, false),
    skills: parseBool(split.fields.get("skills"), "skills", filePath, false),
    systemPrompt,
  };
}

export async function discoverSubs(args: DiscoverSubsArgs): Promise<SubRecord[]> {
  const home = args.home ?? homedir();
  const roots: { dir: string; source: "project" | "global" }[] = [];

  for (const dir of walkToGitRoot(args.cwd)) {
    roots.push({ dir: join(dir, ".agents", "subs"), source: "project" });
  }
  roots.push({ dir: join(home, ".agents", "subs"), source: "global" });

  const seen = new Set<string>();
  const subs: SubRecord[] = [];

  for (const root of roots) {
    let names: string[];
    try {
      names = await readdir(root.dir);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        continue;
      }
      throw error;
    }

    for (const name of names.sort()) {
      if (!name.endsWith(".md")) {
        continue;
      }
      const filePath = join(root.dir, name);
      let isFile = false;
      try {
        isFile = (await stat(filePath)).isFile();
      } catch (error) {
        if (errorCode(error) === "ENOENT") {
          continue;
        }
        throw error;
      }
      if (!isFile) {
        continue;
      }

      const parsed = parseSubMd(await readFile(filePath, "utf8"), filePath);
      if (RESERVED_NAMES.has(parsed.name)) {
        throw new NeoError(`neo: ${filePath}: "${parsed.name}" is reserved; rename the file`);
      }
      if (seen.has(parsed.name)) {
        continue;
      }

      const cwd =
        parsed.cwd === undefined ? undefined : await resolveExistingCwd(parsed.cwd, home, filePath);
      seen.add(parsed.name);
      subs.push({
        ...parsed,
        cwd,
        path: filePath,
        source: root.source,
      });
    }
  }

  return subs;
}

export function formatSubsList(subs: SubRecord[], home?: string): string {
  if (subs.length === 0) {
    return "No subs found. Add <name>.md under .agents/subs/ (project) or ~/.agents/subs/ (global).";
  }
  const homeDir = home ?? homedir();
  const ordered = subs.slice().sort((a, b) => a.name.localeCompare(b.name));
  return ordered
    .map((sub) => {
      const header = `${sub.name}  (${formatMeta(sub, homeDir)})`;
      return `${header}\n${wrapPrefixed(sub.description, "  ", LIST_WRAP)}`;
    })
    .join("\n\n");
}

export function formatSubDetails(sub: SubRecord, home?: string): string {
  const homeDir = home ?? homedir();
  const frontmatter = ["---", `description: ${sub.description}`, `model: ${sub.model}`];
  if (sub.cwd !== undefined) {
    frontmatter.push(`cwd: ${displayHome(sub.cwd, homeDir)}`);
  }
  if (sub.readonly) {
    frontmatter.push("readonly: true");
  }
  if (sub.agentsMd) {
    frontmatter.push("agents-md: true");
  }
  if (sub.skills) {
    frontmatter.push("skills: true");
  }
  frontmatter.push("---");
  return [
    `${sub.name}  (${sub.source})`,
    sub.path,
    "",
    "Pass only the task brief in --prompt. Do not repeat the system prompt.",
    "",
    ...frontmatter,
    sub.systemPrompt,
  ].join("\n");
}

export function missingSubMessage(name: string, subs: SubRecord[]): string {
  if (subs.length === 0) {
    return `neo: sub "${name}" not found. Available: none`;
  }
  const listed = subs
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((sub) => sub.name)
    .join(", ");
  return `neo: sub "${name}" not found. Available: ${listed}`;
}

function subNameFromPath(filePath: string): string {
  const file = basename(filePath);
  if (!file.endsWith(".md")) {
    throw new NeoError(`neo: ${filePath}: sub files must end in .md`);
  }
  const name = file.slice(0, -".md".length);
  if (!isSkillName(name)) {
    throw new NeoError(`neo: ${filePath}: filename must be kebab-case (got "${name}")`);
  }
  return name;
}

function parseBool(
  raw: string | undefined,
  key: string,
  filePath: string,
  fallback: boolean,
): boolean {
  if (raw === undefined) {
    return fallback;
  }
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  throw new NeoError(`neo: ${filePath}: ${key} must be true or false`);
}

async function resolveExistingCwd(raw: string, home: string, filePath: string): Promise<string> {
  let expanded: string;
  if (raw === "~") {
    expanded = home;
  } else if (raw.startsWith("~/")) {
    expanded = join(home, raw.slice(2));
  } else {
    expanded = raw;
  }
  if (!isAbsolute(expanded)) {
    throw new NeoError(`neo: ${filePath}: cwd must be an absolute path`);
  }
  const cwd = resolve(expanded);
  let isDirectory = false;
  try {
    isDirectory = (await stat(cwd)).isDirectory();
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new NeoError(`neo: ${filePath}: cwd does not exist: ${cwd}`);
    }
    throw error;
  }
  if (!isDirectory) {
    throw new NeoError(`neo: ${filePath}: cwd is not a directory: ${cwd}`);
  }
  return cwd;
}

function formatMeta(sub: SubRecord, home: string): string {
  const parts = [sub.model];
  if (sub.readonly) {
    parts.push("readonly");
  }
  if (sub.agentsMd) {
    parts.push("agents-md");
  }
  if (sub.skills) {
    parts.push("skills");
  }
  if (sub.cwd !== undefined) {
    parts.push(`cwd ${displayHome(sub.cwd, home)}`);
  }
  return parts.join(", ");
}

function displayHome(path: string, home: string): string {
  if (path === home) {
    return "~";
  }
  const rel = relative(home, path);
  if (rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel)) {
    return `~/${rel}`;
  }
  return path;
}

function wrapPrefixed(text: string, prefix: string, width: number): string {
  const words = text
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  const lines: string[] = [];
  let current = prefix;
  for (const word of words) {
    const candidate = current === prefix ? `${prefix}${word}` : `${current} ${word}`;
    if (candidate.length > width && current !== prefix) {
      lines.push(current);
      current = `${prefix}${word}`;
    } else {
      current = candidate;
    }
  }
  if (current !== prefix) {
    lines.push(current);
  }
  return lines.join("\n");
}
