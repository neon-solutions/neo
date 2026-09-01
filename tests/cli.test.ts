import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "src/cli.ts");

function neo(args: string[]) {
  return spawnSync("bun", [cli, ...args], {
    encoding: "utf8",
    cwd: root,
  });
}

test("prints help", () => {
  const result = neo(["--help"]);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("minimal lightweight open coding subagent");
  expect(result.stdout).toContain("run");
});

test("run requires a prompt", () => {
  const result = neo(["run", "--model", "fable"]);
  expect(result.status).not.toBe(0);
  expect(`${result.stdout}${result.stderr}`).toMatch(/--prompt|--prompt-file/);
});

test("run with a prompt is not implemented yet", () => {
  const result = neo(["run", "--model", "fable", "--prompt", "say hi"]);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("the agent loop is not implemented yet");
});
