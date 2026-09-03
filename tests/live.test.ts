import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "src/cli.ts");

function neo(args: string[], options?: { cwd?: string }) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NEON_AI_GATEWAY_TOKEN;
  delete env.NEON_AI_GATEWAY_BASE_URL;
  return spawnSync("bun", [cli, ...args], {
    encoding: "utf8",
    cwd: options?.cwd ?? root,
    env,
    timeout: 120_000,
  });
}

test("models list prints live catalog ids and names", () => {
  const result = neo(["models", "list"]);
  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(/claude-fable-5\s+Claude Fable 5/);
});

test("fable answers a short prompt", () => {
  const result = neo([
    "--model",
    "fable",
    "--prompt",
    "Reply with the single word pong and nothing else.",
  ]);
  expect(result.status).toBe(0);
  expect(result.stdout.toLowerCase()).toContain("pong");
}, 120_000);

test("write creates a file in the working directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "neo-live-write-"));
  const result = neo(
    [
      "--model",
      "fable",
      "--prompt",
      "Create a file named ping.txt whose entire contents are the word ping. Do not print anything except a brief confirmation.",
    ],
    { cwd: dir },
  );
  expect(result.status).toBe(0);
  expect(readFileSync(join(dir, "ping.txt"), "utf8").trim()).toBe("ping");
}, 120_000);

test("agents-md injects the file into the system prompt", () => {
  const dir = mkdtempSync(join(tmpdir(), "neo-live-agents-"));
  mkdirSync(join(dir, ".git"));
  writeFileSync(join(dir, "AGENTS.md"), "The project nonce is neo-agents-md-nonce-7f3a.\n");
  const result = neo(
    [
      "--agents-md",
      "--model",
      "fable",
      "--prompt",
      "Reply with only the project nonce from AGENTS.md.",
    ],
    { cwd: dir },
  );
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("neo-agents-md-nonce-7f3a");
}, 120_000);
