import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { NeoError } from "./errors";

export const MAX_OUTPUT_CHARS = 200_000;

export function clip(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n[truncated]`;
}

export function errorCode(error: unknown): string | undefined {
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return undefined;
}

export function resolveUnderRoot(root: string, path: string): string {
  if (path.trim().length === 0) {
    throw new NeoError("neo: path must not be empty");
  }
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new NeoError(`neo: path is outside the working directory: ${path}`);
  }
  return absolute;
}

export function walkToGitRoot(start: string): string[] {
  const startAbs = resolve(start);
  const dirs: string[] = [];
  let current = startAbs;
  for (;;) {
    dirs.push(current);
    if (existsSync(join(current, ".git"))) {
      return dirs;
    }
    const parent = dirname(current);
    if (parent === current) {
      return [startAbs];
    }
    current = parent;
  }
}
