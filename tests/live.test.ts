import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "src/cli.ts");
// NEO_BIN runs the suite against a compiled scriptc binary instead of `bun src/cli.ts`.
const neoBin = process.env.NEO_BIN;
const command = neoBin ?? "bun";
const commandArgs = (args: string[]) => (neoBin === undefined ? [cli, ...args] : args);

function neoEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NEON_AI_GATEWAY_TOKEN;
  delete env.NEON_AI_GATEWAY_BASE_URL;
  return env;
}

function neo(args: string[], options?: { cwd?: string }) {
  return spawnSync(command, commandArgs(args), {
    encoding: "utf8",
    cwd: options?.cwd ?? root,
    env: neoEnv(),
    timeout: 120_000,
  });
}

// spawnSync blocks the Vitest worker; past ~60s its RPC times out.
function neoAsync(
  args: string[],
  options: { cwd: string },
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs(args), { cwd: options.cwd, env: neoEnv() });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
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

test("a run past 20 tool steps still answers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "neo-live-steps-"));
  const hops = 25;
  for (let hop = 1; hop <= hops; hop++) {
    const contents =
      hop === hops ? "final answer: neo-steps-nonce-91c2" : `next file: hop-${hop + 1}.txt`;
    writeFileSync(join(dir, `hop-${hop}.txt`), `${contents}\n`);
  }
  const result = await neoAsync(
    [
      "--model",
      "gpt-6-astra",
      "--prompt",
      "Read hop-1.txt with the read tool. It names the next file to read. Keep following the chain, one read call per file, until a file contains the final answer. Do not use bash, grep, glob, or ls. Reply with only the final answer.",
    ],
    { cwd: dir },
  );
  expect(result.status).toBe(0);
  expect(
    result.stderr.split("\n").filter((line) => line.startsWith("read ")).length,
  ).toBeGreaterThan(20);
  expect(result.stdout).toContain("neo-steps-nonce-91c2");
}, 400_000);

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

test("sub system prompt is injected without the parent pasting it", () => {
  const dir = mkdtempSync(join(tmpdir(), "neo-live-sub-"));
  mkdirSync(join(dir, ".git"));
  mkdirSync(join(dir, ".agents", "subs"), { recursive: true });
  writeFileSync(
    join(dir, ".agents", "subs", "e2e-nonce.md"),
    `---
description: Repeat a nonce in every answer.
model: fable
---
Include the word kestrel-7f3a in every answer.
`,
  );
  const result = neo(["sub", "e2e-nonce", "--prompt", "Reply with the single word pong."], {
    cwd: dir,
  });
  expect(result.status).toBe(0);
  expect(result.stdout.toLowerCase()).toContain("pong");
  expect(result.stdout).toContain("kestrel-7f3a");
}, 120_000);

test("readonly sub has no write tool", () => {
  const dir = mkdtempSync(join(tmpdir(), "neo-live-sub-ro-"));
  mkdirSync(join(dir, ".git"));
  mkdirSync(join(dir, ".agents", "subs"), { recursive: true });
  writeFileSync(
    join(dir, ".agents", "subs", "e2e-readonly.md"),
    `---
description: Readonly check.
model: fable
readonly: true
---
You have no write or edit tools.
`,
  );
  const result = neo(
    [
      "sub",
      "e2e-readonly",
      "--prompt",
      "Do not use bash. Create ping.txt containing ping using the write tool. If no write tool exists, reply with exactly NO-WRITE-TOOL.",
    ],
    { cwd: dir },
  );
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("NO-WRITE-TOOL");
  expect(() => readFileSync(join(dir, "ping.txt"), "utf8")).toThrow();
}, 120_000);
