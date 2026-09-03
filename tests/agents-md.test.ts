import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { loadAgentsMd } from "../src/lib/agents-md";
import { NeoError } from "../src/lib/errors";
import { walkToGitRoot } from "../src/lib/paths";

const dirs: string[] = [];

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "neo-agents-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("walkToGitRoot stops at .git and does not walk past it", () => {
  const root = tmp();
  mkdirSync(join(root, ".git"));
  const nested = join(root, "src", "app");
  mkdirSync(nested, { recursive: true });
  expect(walkToGitRoot(nested)).toEqual([nested, join(root, "src"), root]);
});

test("walkToGitRoot stays at cwd when there is no git repo", () => {
  const dir = tmp();
  expect(walkToGitRoot(dir)).toEqual([dir]);
});

test("loadAgentsMd concatenates farthest to nearest", async () => {
  const root = tmp();
  mkdirSync(join(root, ".git"));
  const nested = join(root, "pkg");
  mkdirSync(nested);
  writeFileSync(join(root, "AGENTS.md"), "root rules");
  writeFileSync(join(nested, "AGENTS.md"), "pkg rules");

  const text = await loadAgentsMd(nested);
  expect(text.startsWith("# AGENTS.md\n\n")).toBe(true);
  const rootAt = text.indexOf("root rules");
  const pkgAt = text.indexOf("pkg rules");
  expect(rootAt).toBeGreaterThan(-1);
  expect(pkgAt).toBeGreaterThan(rootAt);
});

test("loadAgentsMd ignores a parent repo outside the git root", async () => {
  const parent = tmp();
  mkdirSync(join(parent, ".git"));
  writeFileSync(join(parent, "AGENTS.md"), "parent-nonce-should-not-appear");
  const child = join(parent, "nested-repo");
  mkdirSync(child);
  mkdirSync(join(child, ".git"));
  writeFileSync(join(child, "AGENTS.md"), "child-only");

  const text = await loadAgentsMd(child);
  expect(text).toContain("child-only");
  expect(text).not.toContain("parent-nonce-should-not-appear");
});

test("loadAgentsMd throws when no file exists", async () => {
  const dir = tmp();
  await expect(loadAgentsMd(dir)).rejects.toThrow(NeoError);
  await expect(loadAgentsMd(dir)).rejects.toThrow(/no AGENTS.md/);
});
