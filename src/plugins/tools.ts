import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { NeoError } from "../lib/errors";

const BASH_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 200_000;

function resolveUnderCwd(cwd: string, path: string): string {
  const absolute = resolve(cwd, path);
  const rel = relative(cwd, absolute);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new NeoError(`neo: path is outside the working directory: ${path}`);
  }
  return absolute;
}

function clip(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n[truncated]`;
}

function runCommand(args: { command: string; argv: string[]; cwd: string; timeoutMs: number }): {
  code: number;
  stdout: string;
  stderr: string;
} {
  const previous = process.cwd();
  process.chdir(args.cwd);
  try {
    const result = spawnSync(args.command, args.argv, {
      encoding: "utf8",
      timeout: args.timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const spawnError = result.error;
    if (spawnError) {
      if (spawnError.message.includes("ETIMEDOUT")) {
        throw new NeoError(`neo: ${args.command} timed out after ${args.timeoutMs}ms`);
      }
      throw spawnError;
    }
    const status = result.status;
    return {
      code: status === null ? 1 : status,
      stdout: clip(result.stdout),
      stderr: clip(result.stderr),
    };
  } finally {
    process.chdir(previous);
  }
}

export function createTools(cwd: string) {
  return {
    read: tool({
      description: "Read a file relative to the working directory.",
      inputSchema: z.object({
        path: z.string().describe("File path relative to the working directory"),
      }),
      execute: async ({ path }) => {
        const absolute = resolveUnderCwd(cwd, path);
        return clip(await readFile(absolute, "utf8"));
      },
    }),
    grep: tool({
      description: "Search file contents with ripgrep.",
      inputSchema: z.object({
        pattern: z.string().describe("ripgrep pattern"),
        path: z.string().optional().describe("Optional path relative to the working directory"),
      }),
      execute: async ({ pattern, path }) => {
        const target = path === undefined ? cwd : resolveUnderCwd(cwd, path);
        const result = runCommand({
          command: "rg",
          argv: ["-n", "--color", "never", "--", pattern, target],
          cwd,
          timeoutMs: BASH_TIMEOUT_MS,
        });
        if (result.code === 1) {
          return "no matches";
        }
        if (result.code !== 0) {
          return clip(result.stderr || `rg exited ${result.code}`);
        }
        return result.stdout;
      },
    }),
    glob: tool({
      description: "Find files matching a glob pattern under the working directory.",
      inputSchema: z.object({
        pattern: z.string().describe("Glob pattern, for example **/*.ts"),
      }),
      execute: async ({ pattern }) => {
        const result = runCommand({
          command: "rg",
          argv: ["--files", "--color", "never", "-g", pattern],
          cwd,
          timeoutMs: BASH_TIMEOUT_MS,
        });
        if (result.code === 1) {
          return "no matches";
        }
        if (result.code !== 0) {
          return clip(result.stderr || `rg exited ${result.code}`);
        }
        const lines = result.stdout.split("\n").filter((line) => line.length > 0);
        if (lines.length === 0) {
          return "no matches";
        }
        const shown = lines.slice(0, 200);
        if (lines.length > 200) {
          shown.push("[truncated]");
        }
        return shown.join("\n");
      },
    }),
    bash: tool({
      description: "Run a bash command in the working directory.",
      inputSchema: z.object({
        command: z.string().describe("Bash command"),
      }),
      execute: async ({ command }) => {
        const result = runCommand({
          command: "bash",
          argv: ["-lc", command],
          cwd,
          timeoutMs: BASH_TIMEOUT_MS,
        });
        const output = [result.stdout, result.stderr].filter((part) => part.length > 0);
        if (result.code !== 0) {
          output.push(`exit ${result.code}`);
        }
        return output.join("\n") || "(no output)";
      },
    }),
  };
}
