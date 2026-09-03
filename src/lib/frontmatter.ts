import { NeoError } from "./errors";

export type SplitFrontmatter = {
  fields: Map<string, string>;
  body: string;
};

export type ParseYamlMapOptions = {
  strict?: boolean;
  source?: string;
};

export function splitFrontmatter(
  text: string,
  options?: ParseYamlMapOptions,
): SplitFrontmatter | undefined {
  // scriptc: startsWith("\uFEFF") is true for a leading "-".
  const source = text.length > 0 && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = source.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
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

  return {
    fields: parseYamlMap(lines.slice(1, close), options),
    body: lines.slice(close + 1).join("\n"),
  };
}

export function parseYamlMap(lines: string[], options?: ParseYamlMapOptions): Map<string, string> {
  const fields = new Map<string, string>();
  const strict = options?.strict === true;
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
      if (strict) {
        throw yamlError(options?.source, `malformed YAML: ${trimmed}`);
      }
      continue;
    }
    const key = match[1];
    const raw = match[2];
    if (key === undefined) {
      if (strict) {
        throw yamlError(options?.source, `malformed YAML: ${trimmed}`);
      }
      continue;
    }
    if (strict && fields.has(key)) {
      throw yamlError(options?.source, `duplicate key "${key}"`);
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

function yamlError(source: string | undefined, detail: string): NeoError {
  if (source === undefined) {
    return new NeoError(`neo: ${detail}`);
  }
  return new NeoError(`neo: ${source}: ${detail}`);
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
