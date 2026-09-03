import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { NeoError } from "../src/lib/errors";
import {
  loadNeonProviderConfig,
  parseNeonProviderConfig,
  resolveModelId,
} from "../src/plugins/neon-ai-gateway";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "src/cli.ts");

function neo(args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }) {
  return spawnSync("bun", [cli, ...args], {
    encoding: "utf8",
    cwd: options?.cwd ?? root,
    env: options?.env ?? process.env,
  });
}

const catalog = [
  { id: "claude-fable-5", name: "Claude Fable 5" },
  { id: "claude-opus-5", name: "Claude Opus 5" },
  { id: "gpt-5-mini", name: "GPT-5 mini" },
  { id: "gpt-5-nano", name: "GPT-5 nano" },
];

test("prints help", () => {
  const result = neo(["--help"]);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("minimal lightweight open coding subagent");
  expect(result.stdout).toContain("--model");
  expect(result.stdout).toContain("--agents-md");
  expect(result.stdout).toContain("--skills");
  expect(result.stdout).toContain("--readonly");
  expect(result.stdout).toContain("omit write and edit");
  expect(result.stdout).toContain("models");
  expect(result.stdout).toContain("sub");
  expect(result.stdout).not.toContain("reserved");
  expect(result.stdout).not.toContain("  run ");
});

test("requires a model and prompt", () => {
  const result = neo([]);
  expect(result.status).not.toBe(0);
  expect(`${result.stdout}${result.stderr}`).toMatch(/--model/);
});

test("--agents-md with no file fails before credentials", () => {
  const dir = mkdtempSync(join(tmpdir(), "neo-"));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir };
  delete env.NEON_AI_GATEWAY_TOKEN;
  delete env.NEON_AI_GATEWAY_BASE_URL;
  const result = neo(["--agents-md", "--model", "fable", "--prompt", "x"], { cwd: dir, env });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("no AGENTS.md");
  expect(result.stderr).not.toContain("missing");
});

test("--agents-md with a file reaches the credential check", () => {
  const dir = mkdtempSync(join(tmpdir(), "neo-"));
  writeFileSync(join(dir, "AGENTS.md"), "# hi\n");
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir };
  delete env.NEON_AI_GATEWAY_TOKEN;
  delete env.NEON_AI_GATEWAY_BASE_URL;
  const result = neo(["--agents-md", "--model", "fable", "--prompt", "x"], { cwd: dir, env });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("missing");
  expect(result.stderr).toContain("providers/neon.json");
});

test("rejects --prompt and --prompt-file together", () => {
  const dir = mkdtempSync(join(tmpdir(), "neo-"));
  writeFileSync(join(dir, "prompt.txt"), "hello");
  const result = neo(
    ["--model", "fable", "--prompt", "x", "--prompt-file", join(dir, "prompt.txt")],
    { cwd: dir },
  );
  expect(result.status).not.toBe(0);
  expect(`${result.stdout}${result.stderr}`).toMatch(/not both/);
});

test("models list without credentials fails before a network call", () => {
  const dir = mkdtempSync(join(tmpdir(), "neo-"));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir };
  delete env.NEON_AI_GATEWAY_TOKEN;
  delete env.NEON_AI_GATEWAY_BASE_URL;
  const result = neo(["models", "list"], { cwd: dir, env });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("missing");
  expect(result.stderr).toContain("providers/neon.json");
});

test("resolveModelId accepts a catalog id and the fable alias", () => {
  expect(resolveModelId("claude-fable-5", catalog)).toBe("claude-fable-5");
  expect(resolveModelId("fable", catalog)).toBe("claude-fable-5");
});

test("resolveModelId rejects unknown and ambiguous aliases", () => {
  expect(() => resolveModelId("nope", catalog)).toThrow(NeoError);
  expect(() => resolveModelId("5", catalog)).toThrow(/matches/);
});

test("parseNeonProviderConfig requires apiKey and baseURL", () => {
  expect(() => parseNeonProviderConfig("nope", "neon.json")).toThrow(/JSON object/);
  expect(() => parseNeonProviderConfig({}, "neon.json")).toThrow(/apiKey/);
  expect(
    parseNeonProviderConfig({ apiKey: "k", baseURL: "https://example.test/" }, "neon.json"),
  ).toEqual({ apiKey: "k", baseURL: "https://example.test" });
});

test("loadNeonProviderConfig reads ~/.config/neo/providers/neon.json", () => {
  const home = mkdtempSync(join(tmpdir(), "neo-home-"));
  mkdirSync(join(home, ".config", "neo", "providers"), { recursive: true });
  writeFileSync(
    join(home, ".config", "neo", "providers", "neon.json"),
    JSON.stringify({ apiKey: "k", baseURL: "https://example.test", projectId: "ignored" }),
  );
  const previousHome = process.env.HOME;
  const previousToken = process.env.NEON_AI_GATEWAY_TOKEN;
  const previousUrl = process.env.NEON_AI_GATEWAY_BASE_URL;
  process.env.HOME = home;
  delete process.env.NEON_AI_GATEWAY_TOKEN;
  delete process.env.NEON_AI_GATEWAY_BASE_URL;
  try {
    expect(loadNeonProviderConfig()).toEqual({ apiKey: "k", baseURL: "https://example.test" });
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousToken === undefined) {
      delete process.env.NEON_AI_GATEWAY_TOKEN;
    } else {
      process.env.NEON_AI_GATEWAY_TOKEN = previousToken;
    }
    if (previousUrl === undefined) {
      delete process.env.NEON_AI_GATEWAY_BASE_URL;
    } else {
      process.env.NEON_AI_GATEWAY_BASE_URL = previousUrl;
    }
  }
});
