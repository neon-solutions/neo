import { spawn } from "node:child_process";
import { glob, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
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

function runCommand(args: {
  command: string;
  argv: string[];
  cwd: string;
  timeoutMs: number;
}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(args.command, args.argv, {
      cwd: args.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new NeoError(`neo: ${args.command} timed out after ${args.timeoutMs}ms`));
    }, args.timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({
        code,
        stdout: clip(Buffer.concat(stdoutChunks).toString("utf8")),
        stderr: clip(Buffer.concat(stderrChunks).toString("utf8")),
      });
    });
  });
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
        const result = await runCommand({
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
        const matches: string[] = [];
        const iterator = glob(pattern, { cwd });
        for await (const match of iterator) {
          matches.push(join(cwd, match));
          if (matches.length >= 200) {
            matches.push("[truncated]");
            break;
          }
        }
        return matches.length === 0 ? "no matches" : matches.join("\n");
      },
    }),
    bash: tool({
      description: "Run a bash command in the working directory.",
      inputSchema: z.object({
        command: z.string().describe("Bash command"),
      }),
      execute: async ({ command }) => {
        const result = await runCommand({
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
