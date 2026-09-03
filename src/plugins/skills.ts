import { spawnSync } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { clip, errorCode, resolveUnderRoot, walkToGitRoot } from "../lib/paths";

const PROJECT_SKILL_SEGMENTS = [
  [".agents", "skills"],
  [".claude", "skills"],
  [".mastracode", "skills"],
] as const;

const GLOBAL_SKILL_SEGMENTS = PROJECT_SKILL_SEGMENTS;

const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

export type SkillRecord = {
  name: string;
  description: string;
  path: string;
  instructions: string;
  references: string[];
  scripts: string[];
  assets: string[];
  source: "project" | "global";
};

export type ParsedSkillMd = {
  name: string;
  description: string;
  body: string;
};

export type DiscoverSkillsArgs = {
  cwd: string;
  home?: string;
};

export type SkillSearchHit = {
  skillName: string;
  content: string;
  score: number;
};

type SkillLookup = { skill: SkillRecord } | { error: string };

export function parseSkillMd(text: string): ParsedSkillMd | undefined {
  const source = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const lines = source.split(/\r?\n/);
  const first = lines[0];
  if (first === undefined || first.trim() !== "---") {
    return undefined;
  }

  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line !== undefined && line.trim() === "---") {
      close = i;
      break;
    }
  }
  if (close === -1) {
    return undefined;
  }

  const fields = parseYamlMap(lines.slice(1, close));
  const name = fields.get("name");
  const description = fields.get("description");
  if (name === undefined || description === undefined) {
    return undefined;
  }
  if (!isSkillName(name)) {
    return undefined;
  }
  if (description.trim().length === 0 || description.length > MAX_DESCRIPTION_LENGTH) {
    return undefined;
  }

  return {
    name,
    description,
    body: lines.slice(close + 1).join("\n"),
  };
}

export function isSkillName(name: string): boolean {
  return name.length >= 1 && name.length <= MAX_NAME_LENGTH && SKILL_NAME_RE.test(name);
}

export function formatSkillActivation(skill: SkillRecord): string {
  const parts = [skill.instructions];
  if (skill.references.length > 0) {
    parts.push(
      `\n\n## References\n${skill.references.map((name) => `- references/${name}`).join("\n")}`,
    );
  }
  if (skill.scripts.length > 0) {
    parts.push(`\n\n## Scripts\n${skill.scripts.map((name) => `- scripts/${name}`).join("\n")}`);
  }
  if (skill.assets.length > 0) {
    parts.push(`\n\n## Assets\n${skill.assets.map((name) => `- assets/${name}`).join("\n")}`);
  }
  return parts.join("");
}

export function formatSkillsCatalog(skills: SkillRecord[]): string {
  if (skills.length === 0) {
    return "";
  }
  const ordered = skills.slice().sort((a, b) => {
    const byName = a.name.localeCompare(b.name);
    if (byName !== 0) {
      return byName;
    }
    return a.path.localeCompare(b.path);
  });
  const xml = ordered
    .map(
      (skill) => `  <skill>
    <name>${escapeXml(skill.name)}</name>
    <description>${escapeXml(skill.description)}</description>
    <location>${escapeXml(`${skill.path}/SKILL.md`)}</location>
    <source>${escapeXml(skill.source)}</source>
  </skill>`,
    )
    .join("\n");
  return `<available_skills>
${xml}
</available_skills>`;
}

export const SKILL_TOOL_INSTRUCTION =
  "IMPORTANT: Skills are NOT tools. Do not call skill names directly as tool names. " +
  'To use a skill, call the `skill` tool with the skill name as the "name" parameter. ' +
  "If multiple skills share the same name, use the skill path (shown in the location field) instead of the name to disambiguate. " +
  "When a user asks about a topic covered by an available skill, activate it immediately without asking for permission first.";

export async function discoverSkills(args: DiscoverSkillsArgs): Promise<SkillRecord[]> {
  const home = args.home ?? homedir();
  const roots: { dir: string; source: "project" | "global" }[] = [];

  for (const dir of walkToGitRoot(args.cwd)) {
    for (const segments of PROJECT_SKILL_SEGMENTS) {
      roots.push({ dir: join(dir, ...segments), source: "project" });
    }
  }
  for (const segments of GLOBAL_SKILL_SEGMENTS) {
    roots.push({ dir: join(home, ...segments), source: "global" });
  }

  const seen = new Set<string>();
  const skills: SkillRecord[] = [];

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

    for (const name of names) {
      const skillDir = join(root.dir, name);
      const parsed = await readSkillDir(skillDir);
      if (parsed === undefined) {
        continue;
      }
      const key = identityKey(skillDir);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      skills.push({
        name: parsed.name,
        description: parsed.description,
        path: skillDir,
        instructions: parsed.body,
        references: await listFiles(join(skillDir, "references")),
        scripts: await listFiles(join(skillDir, "scripts")),
        assets: await listFiles(join(skillDir, "assets")),
        source: root.source,
      });
    }
  }

  return skills;
}

export function lookupSkill(skills: SkillRecord[], identifier: string): SkillLookup {
  const byPath = skills.find(
    (skill) => skill.path === identifier || `${skill.path}/SKILL.md` === identifier,
  );
  if (byPath !== undefined) {
    return { skill: byPath };
  }

  const matches = skills.filter((skill) => skill.name === identifier);
  if (matches.length === 1) {
    const skill = matches[0];
    if (skill === undefined) {
      return { error: missingSkillMessage(identifier, skills) };
    }
    return { skill };
  }
  if (matches.length === 0) {
    return { error: missingSkillMessage(identifier, skills) };
  }
  const paths = matches.map((skill) => skill.path).join(", ");
  return {
    error: `Skill "${identifier}" is ambiguous. Use a path: ${paths}`,
  };
}

export function searchSkills(args: {
  skills: SkillRecord[];
  query: string;
  skillNames?: string[];
  topK?: number;
}): SkillSearchHit[] {
  const query = args.query.trim().toLowerCase();
  if (query.length === 0) {
    return [];
  }
  const topK = args.topK ?? 5;
  const names = args.skillNames;
  const scoped =
    names === undefined ? args.skills : args.skills.filter((skill) => names.includes(skill.name));

  const words = query.split(/\s+/).filter((word) => word.length > 0);
  const hits: SkillSearchHit[] = [];

  for (const skill of scoped) {
    const haystack = `${skill.name}\n${skill.description}\n${skill.instructions}`.toLowerCase();
    let score = countOccurrences(haystack, query) * 3;
    for (const word of words) {
      score += countOccurrences(haystack, word);
    }
    if (score <= 0) {
      continue;
    }
    hits.push({
      skillName: skill.name,
      content: skill.instructions,
      score,
    });
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, topK);
}

export function createSkillTools(skills: SkillRecord[]) {
  return {
    skill: tool({
      description:
        "Activate a skill to load its full instructions. You should activate skills proactively when they are relevant to the user's request without asking for permission first.",
      inputSchema: z.object({
        name: z
          .string()
          .describe(
            "The name or path of the skill to activate. Use the path when multiple skills share the same name.",
          ),
      }),
      execute: async ({ name }) => {
        const result = lookupSkill(skills, name);
        if ("error" in result) {
          return result.error;
        }
        return clip(formatSkillActivation(result.skill));
      },
    }),
    skill_search: tool({
      description:
        "Search across skill content to find relevant information. Useful when you need to find specific details within skills.",
      inputSchema: z.object({
        query: z.string().describe("The search query"),
        skillNames: z
          .array(z.string())
          .optional()
          .describe("Optional list of skill names to search within"),
        topK: z.number().optional().describe("Maximum number of results to return (default: 5)"),
      }),
      execute: async ({ query, skillNames, topK }) => {
        const results = searchSkills({ skills, query, skillNames, topK });
        if (results.length === 0) {
          return "No results found.";
        }
        return results
          .map((hit) => {
            const preview =
              hit.content.length > 200 ? `${hit.content.slice(0, 200)}...` : hit.content;
            return `[${hit.skillName}] (score: ${hit.score.toFixed(2)})\n${preview}`;
          })
          .join("\n\n");
      },
    }),
    skill_read: tool({
      description:
        "Read a file from a skill directory (references, scripts, or assets). The path is relative to the skill root.",
      inputSchema: z.object({
        skillName: z
          .string()
          .describe(
            "The name or path of the skill. Use the path when multiple skills share the same name.",
          ),
        path: z
          .string()
          .describe(
            'Path to the file relative to the skill root (e.g. "references/colors.md", "scripts/run.sh")',
          ),
        startLine: z
          .number()
          .optional()
          .describe("Starting line number (1-indexed). If omitted, starts from the beginning."),
        endLine: z
          .number()
          .optional()
          .describe("Ending line number (1-indexed, inclusive). If omitted, reads to the end."),
      }),
      execute: async ({ skillName, path, startLine, endLine }) => {
        const result = lookupSkill(skills, skillName);
        if ("error" in result) {
          return result.error;
        }
        const absolute = resolveUnderRoot(result.skill.path, path);
        let content: string;
        try {
          content = await readFile(absolute, "utf8");
        } catch (error) {
          if (errorCode(error) === "ENOENT") {
            const available = [
              ...result.skill.references.map((name) => `references/${name}`),
              ...result.skill.scripts.map((name) => `scripts/${name}`),
              ...result.skill.assets.map((name) => `assets/${name}`),
            ];
            const fileList =
              available.length > 0 ? `\nAvailable files: ${available.join(", ")}` : "";
            return `File "${path}" not found in skill "${skillName}".${fileList}`;
          }
          throw error;
        }
        if (content.slice(0, 1000).includes("\0")) {
          return `Binary file: ${absolute} (${Buffer.byteLength(content)} bytes)`;
        }
        return clip(extractLines(path, content, startLine, endLine));
      },
    }),
  };
}

function extractLines(
  path: string,
  content: string,
  startLine: number | undefined,
  endLine: number | undefined,
): string {
  const lines = content.length === 0 ? [] : content.split("\n");
  if (startLine === undefined && endLine === undefined) {
    return content;
  }
  const start = startLine ?? 1;
  const end = endLine ?? lines.length;
  if (start > end) {
    return `File "${path}" has ${lines.length} lines (valid range 1-${lines.length}). Requested range ${start}-${end} is empty because startLine is greater than endLine.`;
  }
  if (start > lines.length) {
    return `File "${path}" has ${lines.length} lines (valid range 1-${lines.length}). Requested startLine ${start} is past the end of the file. The file has been fully read; stop paginating.`;
  }
  const last = Math.min(end, lines.length);
  const slice = lines.slice(start - 1, last).join("\n");
  return `${path} (lines ${start}-${last} of ${lines.length})\n${slice}`;
}

async function readSkillDir(skillDir: string): Promise<ParsedSkillMd | undefined> {
  let text: string;
  try {
    text = await readFile(join(skillDir, "SKILL.md"), "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") {
      return undefined;
    }
    throw error;
  }
  const parsed = parseSkillMd(text);
  if (parsed === undefined) {
    return undefined;
  }
  if (parsed.name !== basename(skillDir)) {
    return undefined;
  }
  return parsed;
}

async function listFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return files;
    }
    throw error;
  }
  for (const name of names) {
    const info = await stat(join(dir, name));
    if (info.isFile()) {
      files.push(name);
    }
  }
  return files.sort();
}

function identityKey(dir: string): string {
  const result = spawnSync("realpath", [dir], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status === 0) {
    const out = result.stdout.trim();
    if (out.length > 0) {
      return out;
    }
  }
  return resolve(dir);
}

function missingSkillMessage(identifier: string, skills: SkillRecord[]): string {
  if (skills.length === 0) {
    return `Skill "${identifier}" not found. Available skills: none`;
  }
  const listed = skills.map((skill) => `${skill.name} (${skill.path})`).join(", ");
  return `Skill "${identifier}" not found. Available skills: ${listed}`;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }
  let count = 0;
  let from = 0;
  for (;;) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) {
      return count;
    }
    count += 1;
    from = index + needle.length;
  }
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function parseYamlMap(lines: string[]): Map<string, string> {
  const fields = new Map<string, string>();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) {
      break;
    }
    i += 1;
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (match === null) {
      continue;
    }
    const key = match[1];
    const raw = match[2];
    if (key === undefined) {
      continue;
    }
    const indicator = (raw ?? "").trim();
    if (
      indicator === ">" ||
      indicator === ">-" ||
      indicator === ">+" ||
      indicator === "|" ||
      indicator === "|-" ||
      indicator === "|+"
    ) {
      const collected: string[] = [];
      while (i < lines.length) {
        const next = lines[i];
        if (next === undefined) {
          break;
        }
        if (next.length === 0 || next.startsWith(" ") || next.startsWith("\t")) {
          collected.push(next);
          i += 1;
          continue;
        }
        break;
      }
      const folded = indicator.startsWith(">");
      fields.set(key, folded ? foldYaml(collected) : literalYaml(collected));
      continue;
    }
    fields.set(key, unquoteYaml(stripYamlComment(raw ?? "").trim()));
  }
  return fields;
}

function stripYamlComment(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    return raw;
  }
  const hash = raw.indexOf(" #");
  if (hash === -1) {
    return raw;
  }
  return raw.slice(0, hash);
}

function unquoteYaml(value: string): string {
  if (value.length < 2) {
    return value;
  }
  const start = value.charAt(0);
  const end = value.charAt(value.length - 1);
  if ((start === '"' && end === '"') || (start === "'" && end === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

function commonIndent(lines: string[]): number {
  let min: number | undefined;
  for (const line of lines) {
    if (line.trim().length === 0) {
      continue;
    }
    const match = /^[ \t]*/.exec(line);
    const n = match === null ? 0 : match[0].length;
    if (min === undefined || n < min) {
      min = n;
    }
  }
  return min ?? 0;
}

function stripIndent(lines: string[], indent: number): string[] {
  return lines.map((line) => {
    if (line.length === 0) {
      return line;
    }
    let n = 0;
    while (n < indent && n < line.length) {
      const ch = line.charAt(n);
      if (ch !== " " && ch !== "\t") {
        break;
      }
      n += 1;
    }
    return line.slice(n);
  });
}

function foldYaml(lines: string[]): string {
  const stripped = stripIndent(lines, commonIndent(lines));
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const line of stripped) {
    if (line.trim().length === 0) {
      if (current.length > 0) {
        paragraphs.push(current.join(" "));
        current = [];
      }
      continue;
    }
    current.push(line.trim());
  }
  if (current.length > 0) {
    paragraphs.push(current.join(" "));
  }
  return paragraphs.join("\n\n");
}

function literalYaml(lines: string[]): string {
  return stripIndent(lines, commonIndent(lines)).join("\n").replace(/\n+$/u, "");
}
