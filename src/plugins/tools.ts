import { spawnSync } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { applyEdits } from "../lib/edit";
import { NeoError } from "../lib/errors";
import { clip, errorCode, resolveUnderRoot } from "../lib/paths";

const BASH_TIMEOUT_MS = 30_000;
const LS_MAX_ENTRIES = 500;

export type CreateToolsOptions = {
  readonly: boolean;
};

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

function sliceLines(args: {
  path: string;
  text: string;
  offset: number | undefined;
  limit: number | undefined;
}): string {
  if (args.offset === undefined && args.limit === undefined) {
    return args.text;
  }
  const lines = args.text.length === 0 ? [] : args.text.split("\n");
  const start = args.offset ?? 1;
  const count = args.limit ?? Math.max(0, lines.length - start + 1);
  if (start > lines.length) {
    return `${args.path} has ${lines.length} lines. offset ${start} is past the end of the file.`;
  }
  const end = Math.min(lines.length, start + count - 1);
  const slice = lines.slice(start - 1, end).join("\n");
  return `${args.path} (lines ${start}-${end} of ${lines.length})\n${slice}`;
}

export function createTools(cwd: string, options: CreateToolsOptions) {
  const inspect = {
    read: tool({
      description: "Read a file relative to the working directory.",
      inputSchema: z.object({
        path: z.string().describe("File path relative to the working directory"),
        offset: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("1-indexed line to start reading from"),
        limit: z.number().int().positive().optional().describe("Maximum number of lines to return"),
      }),
      execute: async ({ path, offset, limit }) => {
        const absolute = resolveUnderRoot(cwd, path);
        const text = await readFile(absolute, "utf8");
        return clip(sliceLines({ path, text, offset, limit }));
      },
    }),
    grep: tool({
      description: "Search file contents with ripgrep.",
      inputSchema: z.object({
        pattern: z.string().describe("ripgrep pattern"),
        path: z.string().optional().describe("Optional path relative to the working directory"),
      }),
      execute: async ({ pattern, path }) => {
        const target = path === undefined ? cwd : resolveUnderRoot(cwd, path);
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
    ls: tool({
      description: "List a directory relative to the working directory. Directories end with /.",
      inputSchema: z.object({
        path: z
          .string()
          .optional()
          .describe("Directory path relative to the working directory. Defaults to ."),
      }),
      execute: async ({ path }) => {
        const absolute = path === undefined ? cwd : resolveUnderRoot(cwd, path);
        let names: string[];
        try {
          const info = await stat(absolute);
          if (!info.isDirectory()) {
            throw new NeoError(`neo: not a directory: ${path ?? "."}`);
          }
          names = await readdir(absolute);
        } catch (error) {
          if (error instanceof NeoError) {
            throw error;
          }
          if (errorCode(error) === "ENOENT") {
            throw new NeoError(`neo: directory not found: ${path ?? "."}`);
          }
          throw error;
        }
        names.sort();
        const entries: string[] = [];
        for (const name of names) {
          const info = await stat(join(absolute, name));
          entries.push(info.isDirectory() ? `${name}/` : name);
        }
        const shown = entries.slice(0, LS_MAX_ENTRIES);
        if (entries.length > LS_MAX_ENTRIES) {
          shown.push("[truncated]");
        }
        return shown.join("\n") || "(empty)";
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

  if (options.readonly) {
    return inspect;
  }

  return {
    ...inspect,
    write: tool({
      description: "Create or overwrite a file relative to the working directory.",
      inputSchema: z.object({
        path: z.string().describe("File path relative to the working directory"),
        content: z.string().describe("File contents"),
      }),
      execute: async ({ path, content }) => {
        const absolute = resolveUnderRoot(cwd, path);
        await mkdir(dirname(absolute), { recursive: true });
        await writeFile(absolute, content, "utf8");
        return `wrote ${path} (${Buffer.byteLength(content)} bytes)`;
      },
    }),
    edit: tool({
      description:
        "Replace unique, non-overlapping substrings in a file. Each oldText is matched against the original file, not sequentially.",
      inputSchema: z.object({
        path: z.string().describe("File path relative to the working directory"),
        edits: z
          .array(
            z.object({
              oldText: z
                .string()
                .describe("Exact text to find in the original file. Must be unique."),
              newText: z.string().describe("Replacement text"),
            }),
          )
          .min(1),
      }),
      execute: async ({ path, edits }) => {
        const absolute = resolveUnderRoot(cwd, path);
        const original = await readFile(absolute, "utf8");
        const next = applyEdits(original, edits);
        await writeFile(absolute, next, "utf8");
        return `edited ${path} (${edits.length} replacements)`;
      },
    }),
  };
}
