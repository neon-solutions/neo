import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "src/cli.ts");

function neo(args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NEON_AI_GATEWAY_TOKEN;
  delete env.NEON_AI_GATEWAY_BASE_URL;
  return spawnSync("bun", [cli, ...args], {
    encoding: "utf8",
    cwd: root,
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
