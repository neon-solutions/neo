import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { NeoError } from "../src/lib/errors";
import { composeSubMd, parseSubMd, subTargetDir } from "../src/plugins/subs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "src/cli.ts");
const dirs: string[] = [];

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "neo-subs-author-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function neo(args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string }) {
  return spawnSync("bun", [cli, ...args], {
    encoding: "utf8",
    cwd: options?.cwd ?? root,
    env: options?.env ?? process.env,
    input: options?.input ?? "",
  });
}

function isolatedEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.NEON_AI_GATEWAY_TOKEN;
  delete env.NEON_AI_GATEWAY_BASE_URL;
  return env;
}

function writeSub(dir: string, name: string, contents: string): string {
  const folder = join(dir, ".agents", "subs");
  mkdirSync(folder, { recursive: true });
  const path = join(folder, `${name}.md`);
  writeFileSync(path, contents);
  return path;
}

function writeSkill(dir: string, name: string): void {
  const folder = join(dir, ".agents", "skills", name);
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, "SKILL.md"),
    `---
name: ${name}
description: ${name} skill.
---
Instructions for ${name}.
`,
  );
}

function gitRepo(): { cwd: string; home: string; env: NodeJS.ProcessEnv } {
  const cwd = tmp();
  const home = tmp();
  mkdirSync(join(cwd, ".git"));
  return { cwd, home, env: isolatedEnv(home) };
}

function canonical(path: string): string {
  return join(realpathSync(dirname(path)), basename(path));
}

function expectPrintedPath(stdout: string, dest: string): void {
  expect(canonical(stdout.trim())).toBe(canonical(dest));
}

test("composeSubMd round-trips a minimal sub", () => {
  const text = composeSubMd(
    {
      description: "A tiny sub.",
      model: "fable",
      readonly: false,
      agentsMd: false,
      skills: { kind: "off" },
    },
    "Do the thing.",
  );
  expect(text).toBe(`---
description: A tiny sub.
model: fable
---
Do the thing.
`);
  expect(parseSubMd(text, "/tmp/tiny.md")).toEqual({
    name: "tiny",
    description: "A tiny sub.",
    model: "fable",
    cwd: undefined,
    readonly: false,
    agentsMd: false,
    skills: { kind: "off" },
    systemPrompt: "Do the thing.",
  });
});

test("composeSubMd round-trips all fields and omits false booleans", () => {
  const text = composeSubMd(
    {
      description: "Critical engineering review of an open PR.",
      model: "sol",
      cwd: "~/workspaces",
      readonly: true,
      agentsMd: true,
      skills: { kind: "all" },
    },
    "You are running a critical engineering review.",
  );
  expect(text).toBe(`---
description: Critical engineering review of an open PR.
model: sol
cwd: ~/workspaces
readonly: true
agents-md: true
skills: true
---
You are running a critical engineering review.
`);
  expect(parseSubMd(text, "/tmp/pr-review.md")).toEqual({
    name: "pr-review",
    description: "Critical engineering review of an open PR.",
    model: "sol",
    cwd: "~/workspaces",
    readonly: true,
    agentsMd: true,
    skills: { kind: "all" },
    systemPrompt: "You are running a critical engineering review.",
  });
});

test("composeSubMd quotes values the bare form cannot round-trip", () => {
  const description = 'Review #1: "fast" path';
  const text = composeSubMd(
    {
      description,
      model: "fable",
      readonly: false,
      agentsMd: false,
      skills: { kind: "off" },
    },
    "Body.",
  );
  expect(parseSubMd(text, "/tmp/quoted.md").description).toBe(description);
  expect(text).toContain("description:");
  expect(text).not.toMatch(/^description: Review #1: "fast" path$/m);
});

test("composeSubMd round-trips a description with both quotes and a hash comment", () => {
  const description = `he said "hi" and 'bye' # nope`;
  const text = composeSubMd(
    {
      description,
      model: "fable",
      readonly: false,
      agentsMd: false,
      skills: { kind: "off" },
    },
    "Body.",
  );
  expect(parseSubMd(text, "/tmp/awkward.md").description).toBe(description);
});

test("composeSubMd round-trips unicode and a colon in description", () => {
  const description = "München: café review";
  const text = composeSubMd(
    {
      description,
      model: "fable",
      readonly: false,
      agentsMd: false,
      skills: { kind: "off" },
    },
    "Body.",
  );
  expect(parseSubMd(text, "/tmp/unicode.md").description).toBe(description);
});

test("composeSubMd round-trips a multiline description via block scalar", () => {
  const description = "Line one.\nLine two.";
  const text = composeSubMd(
    {
      description,
      model: "fable",
      readonly: false,
      agentsMd: false,
      skills: { kind: "off" },
    },
    "Body.",
  );
  expect(parseSubMd(text, "/tmp/multiline.md").description).toBe(description);
});

test("composeSubMd throws when the body is empty", () => {
  expect(() =>
    composeSubMd(
      {
        description: "Empty body.",
        model: "fable",
        readonly: false,
        agentsMd: false,
        skills: { kind: "off" },
      },
      "  \n",
    ),
  ).toThrow(NeoError);
  expect(() =>
    composeSubMd(
      {
        description: "Empty body.",
        model: "fable",
        readonly: false,
        agentsMd: false,
        skills: { kind: "off" },
      },
      "  \n",
    ),
  ).toThrow(/body is empty/);
});

test("subTargetDir uses git root for project and home for global", () => {
  const cwd = tmp();
  const nested = join(cwd, "src");
  const home = tmp();
  mkdirSync(join(cwd, ".git"));
  mkdirSync(nested);
  expect(subTargetDir({ cwd: nested, home, global: false })).toBe(join(cwd, ".agents", "subs"));
  expect(subTargetDir({ cwd: nested, home, global: true })).toBe(join(home, ".agents", "subs"));
});

test("subTargetDir without git uses the invocation directory", () => {
  const cwd = tmp();
  const home = tmp();
  expect(subTargetDir({ cwd, home, global: false })).toBe(join(cwd, ".agents", "subs"));
});

test("neo sub --help lists create, update, and delete", () => {
  const result = neo(["sub", "--help"]);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("create");
  expect(result.stdout).toContain("update");
  expect(result.stdout).toContain("delete");
});

test("neo sub create with full flags writes a project template and does not prompt", () => {
  const { cwd, home, env } = gitRepo();
  mkdirSync(join(home, "workspaces"));
  const bodyFile = join(cwd, "prompt.md");
  writeFileSync(bodyFile, "You are running a critical engineering review.\n");
  const result = neo(
    [
      "sub",
      "create",
      "eng-review",
      "--description",
      "Critical engineering review of an open PR.",
      "--model",
      "sol",
      "--cwd",
      "~/workspaces",
      "--readonly",
      "--agents-md",
      "--skills",
      "--body-file",
      bodyFile,
    ],
    { cwd, env },
  );
  const dest = join(cwd, ".agents", "subs", "eng-review.md");
  expect(result.status).toBe(0);
  expectPrintedPath(result.stdout, dest);
  expect(result.stderr).toBe("");
  expect(existsSync(dest)).toBe(true);
  expect(parseSubMd(readFileSync(dest, "utf8"), dest)).toEqual({
    name: "eng-review",
    description: "Critical engineering review of an open PR.",
    model: "sol",
    cwd: "~/workspaces",
    readonly: true,
    agentsMd: true,
    skills: { kind: "all" },
    systemPrompt: "You are running a critical engineering review.",
  });

  const details = neo(["sub", "details", "eng-review"], { cwd, env });
  expect(details.status).toBe(0);
  expect(details.stdout).toContain("Critical engineering review of an open PR.");
  expect(details.stdout).toContain("You are running a critical engineering review.");
  expect(details.stdout).toContain("readonly: true");

  const launch = neo(["sub", "eng-review", "--prompt", "x"], { cwd, env });
  expect(launch.status).toBe(1);
  expect(launch.stderr).toContain("no AGENTS.md");
  expect(launch.stderr).toContain(join(home, "workspaces"));
  expect(launch.stderr).not.toContain("providers/neon.json");
});

test("neo sub create --global writes under HOME", () => {
  const { cwd, home, env } = gitRepo();
  const result = neo(
    [
      "sub",
      "create",
      "tiny",
      "--description",
      "A tiny sub.",
      "--model",
      "fable",
      "--body",
      "Do the thing.",
      "--global",
    ],
    { cwd, env },
  );
  const dest = join(home, ".agents", "subs", "tiny.md");
  expect(result.status).toBe(0);
  expectPrintedPath(result.stdout, dest);
  expect(existsSync(dest)).toBe(true);
  const listed = neo(["sub", "list"], { cwd, env });
  expect(listed.stdout).toContain("tiny");
  expect(listed.stdout).toContain("A tiny sub.");
});

test("neo sub create with only required flags defaults optional fields", () => {
  const { cwd, env } = gitRepo();
  const result = neo(
    [
      "sub",
      "create",
      "tiny",
      "--description",
      "A tiny sub.",
      "--model",
      "fable",
      "--body",
      "Do the thing.",
    ],
    { cwd, env },
  );
  const dest = join(cwd, ".agents", "subs", "tiny.md");
  expect(result.status).toBe(0);
  expectPrintedPath(result.stdout, dest);
  expect(result.stderr).toBe("");
  expect(readFileSync(dest, "utf8")).toBe(`---
description: A tiny sub.
model: fable
---
Do the thing.
`);
});

test("neo sub create missing required field with closed stdin does not write", () => {
  const { cwd, env } = gitRepo();
  const result = neo(
    ["sub", "create", "tiny", "--description", "A tiny sub.", "--model", "fable"],
    {
      cwd,
      env,
    },
  );
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("missing body");
  expect(existsSync(join(cwd, ".agents", "subs", "tiny.md"))).toBe(false);
});

test("neo sub create rejects reserved, non-kebab, existing, bad cwd, both bodies, and multiline description", () => {
  const { cwd, env } = gitRepo();
  const dest = writeSub(
    cwd,
    "tiny",
    `---
description: Existing.
model: fable
---
Body.
`,
  );

  const reserved = neo(
    ["sub", "create", "create", "--description", "X.", "--model", "fable", "--body", "Body."],
    { cwd, env },
  );
  expect(reserved.status).toBe(1);
  expect(reserved.stdout).toBe("");
  expect(reserved.stderr).toContain("reserved");

  const kebab = neo(
    ["sub", "create", "NotKebab", "--description", "X.", "--model", "fable", "--body", "Body."],
    { cwd, env },
  );
  expect(kebab.status).toBe(1);
  expect(kebab.stderr).toContain("kebab-case");

  const exists = neo(
    ["sub", "create", "tiny", "--description", "X.", "--model", "fable", "--body", "Body."],
    { cwd, env },
  );
  expect(exists.status).toBe(1);
  expect(exists.stderr).toContain(dest);
  expect(exists.stderr).toContain("already exists");
  expect(exists.stderr).toContain("neo sub update tiny");

  const missingCwd = neo(
    [
      "sub",
      "create",
      "other",
      "--description",
      "X.",
      "--model",
      "fable",
      "--body",
      "Body.",
      "--cwd",
      "/tmp/neo-sub-missing-cwd-does-not-exist",
    ],
    { cwd, env },
  );
  expect(missingCwd.status).toBe(1);
  expect(missingCwd.stderr).toContain("does not exist");
  expect(existsSync(join(cwd, ".agents", "subs", "other.md"))).toBe(false);

  const relative = neo(
    [
      "sub",
      "create",
      "other",
      "--description",
      "X.",
      "--model",
      "fable",
      "--body",
      "Body.",
      "--cwd",
      "workspaces",
    ],
    { cwd, env },
  );
  expect(relative.status).toBe(1);
  expect(relative.stderr).toContain("absolute path");

  writeFileSync(join(cwd, "prompt.md"), "Body.\n");
  const both = neo(
    [
      "sub",
      "create",
      "other",
      "--description",
      "X.",
      "--model",
      "fable",
      "--body",
      "Body.",
      "--body-file",
      join(cwd, "prompt.md"),
    ],
    { cwd, env },
  );
  expect(both.status).toBe(1);
  expect(both.stderr).toMatch(/not both/);

  const multiline = neo(
    [
      "sub",
      "create",
      "other",
      "--description",
      "line one\nline two",
      "--model",
      "fable",
      "--body",
      "Body.",
    ],
    { cwd, env },
  );
  expect(multiline.status).toBe(1);
  expect(multiline.stderr).toContain("single line");
});

test("neo sub create round-trips a description with hash and quotes", () => {
  const { cwd, env } = gitRepo();
  const description = 'Review #1: "fast" path';
  const result = neo(
    [
      "sub",
      "create",
      "quoted",
      "--description",
      description,
      "--model",
      "fable",
      "--body",
      "Body.",
    ],
    { cwd, env },
  );
  expect(result.status).toBe(0);
  const details = neo(["sub", "details", "quoted"], { cwd, env });
  expect(details.status).toBe(0);
  expect(details.stdout).toContain(description);
});

test("neo sub create rejects a root sealed --model", () => {
  const { cwd, env } = gitRepo();
  const result = neo(
    ["--model", "fable", "sub", "create", "tiny", "--description", "X.", "--body", "Body."],
    { cwd, env },
  );
  expect(result.status).toBe(1);
  expect(`${result.stdout}${result.stderr}`).toMatch(/sealed|unknown option/i);
});

test("neo sub create wizard reads stdin and writes prompts to stderr", () => {
  const { cwd, home, env } = gitRepo();
  mkdirSync(join(home, "workspaces"));
  const result = neo(["sub", "create"], {
    cwd,
    env,
    input:
      "eng-review\n\nA review sub.\nsol\n~/workspaces\ny\ny\nn\nBody line one.\nBody line two.\n",
  });
  const dest = join(cwd, ".agents", "subs", "eng-review.md");
  expect(result.status).toBe(0);
  expectPrintedPath(result.stdout, dest);
  expect(result.stderr).toContain("Name: ");
  expect(result.stderr).toContain("Location (project/global) [project]: ");
  expect(result.stderr).toContain("Description: ");
  expect(result.stderr).toContain("Model (see: neo models list): ");
  expect(result.stderr).toContain("cwd (absolute or ~/, empty to skip): ");
  expect(result.stderr).toContain("readonly? [y/N] ");
  expect(result.stderr).toContain("agents-md? [y/N] ");
  expect(result.stderr).toContain("Skills (none in cwd).");
  expect(result.stderr).toContain("System prompt (end with Ctrl-D):");
  const parsed = parseSubMd(readFileSync(dest, "utf8"), dest);
  expect(parsed.name).toBe("eng-review");
  expect(parsed.description).toBe("A review sub.");
  expect(parsed.model).toBe("sol");
  expect(parsed.cwd).toBe("~/workspaces");
  expect(parsed.readonly).toBe(true);
  expect(parsed.agentsMd).toBe(true);
  expect(parsed.skills).toEqual({ kind: "off" });
  expect(parsed.systemPrompt).toBe("Body line one.\nBody line two.");
});

test("neo sub create wizard re-prompts an invalid name", () => {
  const { cwd, env } = gitRepo();
  const result = neo(["sub", "create"], {
    cwd,
    env,
    input: "CREATE\neng-review\n\nA review sub.\nfable\n\nn\nn\nn\nBody.\n",
  });
  expect(result.status).toBe(0);
  expect(result.stderr).toContain("kebab-case");
  expect(existsSync(join(cwd, ".agents", "subs", "eng-review.md"))).toBe(true);
});

test("neo sub create wizard errors when stdin ends at a required prompt", () => {
  const { cwd, env } = gitRepo();
  const result = neo(["sub", "create"], {
    cwd,
    env,
    input: "eng-review\n\nA review sub.\n",
  });
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("missing model");
  expect(existsSync(join(cwd, ".agents", "subs", "eng-review.md"))).toBe(false);
});

test("neo sub create with empty stdin fails at the name prompt", () => {
  const { cwd, env } = gitRepo();
  const result = neo(["sub", "create"], { cwd, env, input: "" });
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("missing name");
});

test("neo sub create warns when a project sub shadows a global", () => {
  const { cwd, home, env } = gitRepo();
  writeSub(
    home,
    "eng-review",
    `---
description: Global review.
model: fable
---
Global body.
`,
  );
  const result = neo(
    [
      "sub",
      "create",
      "eng-review",
      "--description",
      "Project review.",
      "--model",
      "sol",
      "--body",
      "Project body.",
    ],
    { cwd, env },
  );
  expect(result.status).toBe(0);
  expect(result.stderr).toContain("also exists at");
  expect(result.stderr).toContain(join(home, ".agents", "subs", "eng-review.md"));
  const listed = neo(["sub", "list"], { cwd, env });
  expect(listed.stdout).toContain("Project review.");
  expect(listed.stdout).not.toContain("Global review.");
});

test("neo sub update --model rewrites only that field", () => {
  const { cwd, home, env } = gitRepo();
  const dest = writeSub(
    cwd,
    "eng-review",
    `---
description: Critical engineering review of an open PR.
model: sol
cwd: ~/workspaces
readonly: true
agents-md: true
skills: true
---
You are running a critical engineering review.
`,
  );
  mkdirSync(join(home, "workspaces"));
  const result = neo(["sub", "update", "eng-review", "--model", "fable"], { cwd, env });
  expect(result.status).toBe(0);
  expectPrintedPath(result.stdout, dest);
  expect(parseSubMd(readFileSync(dest, "utf8"), dest)).toEqual({
    name: "eng-review",
    description: "Critical engineering review of an open PR.",
    model: "fable",
    cwd: "~/workspaces",
    readonly: true,
    agentsMd: true,
    skills: { kind: "all" },
    systemPrompt: "You are running a critical engineering review.",
  });
});

test("neo sub update clears readonly and cwd and replaces the body", () => {
  const { cwd, home, env } = gitRepo();
  const dest = writeSub(
    cwd,
    "eng-review",
    `---
description: Review.
model: sol
cwd: ~/workspaces
readonly: true
---
Old body.
`,
  );
  mkdirSync(join(home, "workspaces"));
  const bodyFile = join(cwd, "new-prompt.md");
  writeFileSync(bodyFile, "New body.\n");
  const result = neo(
    ["sub", "update", "eng-review", "--readonly", "false", "--clear-cwd", "--body-file", bodyFile],
    { cwd, env },
  );
  expect(result.status).toBe(0);
  const text = readFileSync(dest, "utf8");
  expect(text).not.toContain("readonly");
  expect(text).not.toContain("cwd:");
  expect(parseSubMd(text, dest).systemPrompt).toBe("New body.");
  expect(parseSubMd(text, dest).readonly).toBe(false);
  expect(parseSubMd(text, dest).cwd).toBeUndefined();
});

test("neo sub update rejects no flags, unknown name, cwd conflicts, and both bodies", () => {
  const { cwd, env } = gitRepo();
  const dest = writeSub(
    cwd,
    "eng-review",
    `---
description: Review.
model: sol
---
Body.
`,
  );
  const none = neo(["sub", "update", "eng-review"], { cwd, env });
  expect(none.status).toBe(1);
  expect(none.stdout).toBe("");
  expect(none.stderr).toContain("requires a flag");

  const unknown = neo(["sub", "update", "nope", "--model", "fable"], { cwd, env });
  expect(unknown.status).toBe(1);
  expect(unknown.stderr).toContain("not found");
  expect(unknown.stderr).toContain("eng-review");

  const conflict = neo(["sub", "update", "eng-review", "--cwd", "/tmp", "--clear-cwd"], {
    cwd,
    env,
  });
  expect(conflict.status).toBe(1);
  expect(conflict.stderr).toMatch(/not both/);

  const missingCwd = neo(
    ["sub", "update", "eng-review", "--cwd", "/tmp/neo-sub-missing-cwd-does-not-exist"],
    { cwd, env },
  );
  expect(missingCwd.status).toBe(1);
  expect(missingCwd.stderr).toContain("does not exist");
  expect(parseSubMd(readFileSync(dest, "utf8"), dest).cwd).toBeUndefined();

  writeFileSync(join(cwd, "prompt.md"), "Body.\n");
  const both = neo(
    ["sub", "update", "eng-review", "--body", "A.", "--body-file", join(cwd, "prompt.md")],
    { cwd, env },
  );
  expect(both.status).toBe(1);
  expect(both.stderr).toMatch(/not both/);
});

test("neo sub update edits the project file when it shadows a global", () => {
  const { cwd, home, env } = gitRepo();
  const project = writeSub(
    cwd,
    "eng-review",
    `---
description: Project review.
model: sol
---
Project body.
`,
  );
  const global = writeSub(
    home,
    "eng-review",
    `---
description: Global review.
model: fable
---
Global body.
`,
  );
  const before = readFileSync(global, "utf8");
  const result = neo(["sub", "update", "eng-review", "--model", "fable"], { cwd, env });
  expect(result.status).toBe(0);
  expectPrintedPath(result.stdout, project);
  expect(parseSubMd(readFileSync(project, "utf8"), project).model).toBe("fable");
  expect(readFileSync(global, "utf8")).toBe(before);
});

test("neo sub delete --yes removes the file", () => {
  const { cwd, env } = gitRepo();
  const dest = writeSub(
    cwd,
    "tiny",
    `---
description: A tiny sub.
model: fable
---
Do the thing.
`,
  );
  const result = neo(["sub", "delete", "tiny", "--yes"], { cwd, env });
  expect(result.status).toBe(0);
  expectPrintedPath(result.stdout, dest);
  expect(existsSync(dest)).toBe(false);
  const listed = neo(["sub", "list"], { cwd, env });
  expect(listed.stdout).toContain("No subs found.");
});

test("neo sub delete confirms on stdin", () => {
  const { cwd, env } = gitRepo();
  const dest = writeSub(
    cwd,
    "tiny",
    `---
description: A tiny sub.
model: fable
---
Do the thing.
`,
  );
  const yes = neo(["sub", "delete", "tiny"], { cwd, env, input: "y\n" });
  expect(yes.status).toBe(0);
  expectPrintedPath(yes.stdout, dest);
  expect(yes.stderr).toContain(`Delete ${canonical(dest)}? [y/N] `);
  expect(existsSync(dest)).toBe(false);
});

test("neo sub delete aborts on n and on EOF", () => {
  const { cwd, env } = gitRepo();
  const dest = writeSub(
    cwd,
    "tiny",
    `---
description: A tiny sub.
model: fable
---
Do the thing.
`,
  );
  const no = neo(["sub", "delete", "tiny"], { cwd, env, input: "n\n" });
  expect(no.status).toBe(1);
  expect(no.stdout).toBe("");
  expect(no.stderr).toContain("delete aborted");
  expect(existsSync(dest)).toBe(true);

  const eof = neo(["sub", "delete", "tiny"], { cwd, env, input: "" });
  expect(eof.status).toBe(1);
  expect(eof.stdout).toBe("");
  expect(eof.stderr).toContain("delete aborted");
  expect(existsSync(dest)).toBe(true);
});

test("neo sub delete un-shadows a global template", () => {
  const { cwd, home, env } = gitRepo();
  const project = writeSub(
    cwd,
    "eng-review",
    `---
description: Project review.
model: sol
---
Project body.
`,
  );
  writeSub(
    home,
    "eng-review",
    `---
description: Global review.
model: fable
---
Global body.
`,
  );
  const result = neo(["sub", "delete", "eng-review", "--yes"], { cwd, env });
  expect(result.status).toBe(0);
  expectPrintedPath(result.stdout, project);
  expect(result.stderr).toContain(join(home, ".agents", "subs", "eng-review.md"));
  expect(result.stderr).toContain("now visible");
  const listed = neo(["sub", "list"], { cwd, env });
  expect(listed.stdout).toContain("Global review.");
});

test("neo sub delete unknown name and reserved name fail", () => {
  const { cwd, env } = gitRepo();
  writeSub(
    cwd,
    "tiny",
    `---
description: A tiny sub.
model: fable
---
Do the thing.
`,
  );
  const unknown = neo(["sub", "delete", "nope", "--yes"], { cwd, env });
  expect(unknown.status).toBe(1);
  expect(unknown.stderr).toContain("not found");

  const reserved = neo(["sub", "delete", "details", "--yes"], { cwd, env });
  expect(reserved.status).toBe(1);
  expect(reserved.stderr).toContain("reserved");
});

test("composeSubMd round-trips a skills allowlist", () => {
  const text = composeSubMd(
    {
      description: "Filtered review.",
      model: "fable",
      readonly: false,
      agentsMd: false,
      skills: { kind: "only", names: ["alpha-skill", "beta-skill"] },
    },
    "Body.",
  );
  expect(text).toBe(`---
description: Filtered review.
model: fable
skills:
  - alpha-skill
  - beta-skill
---
Body.
`);
  expect(parseSubMd(text, "/tmp/filtered.md").skills).toEqual({
    kind: "only",
    names: ["alpha-skill", "beta-skill"],
  });
});

test("neo sub create --skills names writes an allowlist", () => {
  const { cwd, env } = gitRepo();
  writeSkill(cwd, "alpha-skill");
  writeSkill(cwd, "beta-skill");
  const result = neo(
    [
      "sub",
      "create",
      "filtered",
      "--description",
      "Filtered review.",
      "--model",
      "fable",
      "--skills",
      "alpha-skill,beta-skill",
      "--body",
      "Body.",
    ],
    { cwd, env },
  );
  expect(result.status).toBe(0);
  const dest = join(cwd, ".agents", "subs", "filtered.md");
  expect(parseSubMd(readFileSync(dest, "utf8"), dest).skills).toEqual({
    kind: "only",
    names: ["alpha-skill", "beta-skill"],
  });
  const listed = neo(["sub", "list"], { cwd, env });
  expect(listed.stdout).toContain("skills alpha-skill, beta-skill");
});

test("neo sub create --skills rejects a name that is not in cwd", () => {
  const { cwd, env } = gitRepo();
  writeSkill(cwd, "alpha-skill");
  const result = neo(
    [
      "sub",
      "create",
      "filtered",
      "--description",
      "Filtered review.",
      "--model",
      "fable",
      "--skills",
      "missing-skill",
      "--body",
      "Body.",
    ],
    { cwd, env },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("skill not found");
  expect(result.stderr).toContain("missing-skill");
  expect(existsSync(join(cwd, ".agents", "subs", "filtered.md"))).toBe(false);
});

test("neo sub create wizard toggles a subset", () => {
  const { cwd, env } = gitRepo();
  writeSkill(cwd, "alpha-skill");
  writeSkill(cwd, "beta-skill");
  const subset = neo(["sub", "create"], {
    cwd,
    env,
    input: "filtered\n\nFiltered review.\nfable\n\nn\nn\n2\n\nBody.\n",
  });
  expect(subset.status).toBe(0);
  expect(subset.stderr).toContain("Skills (all selected).");
  expect(subset.stderr).toContain("1. alpha-skill");
  expect(subset.stderr).toContain("2. beta-skill");
  expect(subset.stderr).toContain("Skills (1 selected).");
  const dest = join(cwd, ".agents", "subs", "filtered.md");
  expect(parseSubMd(readFileSync(dest, "utf8"), dest).skills).toEqual({
    kind: "only",
    names: ["alpha-skill"],
  });
});

test("neo sub create wizard Enter keeps all skills as skills: true", () => {
  const { cwd, env } = gitRepo();
  writeSkill(cwd, "alpha-skill");
  writeSkill(cwd, "beta-skill");
  const result = neo(["sub", "create"], {
    cwd,
    env,
    input: "all-skills\n\nAll skills.\nfable\n\nn\nn\n\nBody.\n",
  });
  expect(result.status).toBe(0);
  const dest = join(cwd, ".agents", "subs", "all-skills.md");
  expect(readFileSync(dest, "utf8")).toContain("skills: true");
  expect(parseSubMd(readFileSync(dest, "utf8"), dest).skills).toEqual({ kind: "all" });
});

test("neo sub update --skills sets an allowlist", () => {
  const { cwd, env } = gitRepo();
  writeSkill(cwd, "alpha-skill");
  const dest = writeSub(
    cwd,
    "tiny",
    `---
description: A tiny sub.
model: fable
skills: true
---
Do the thing.
`,
  );
  const result = neo(["sub", "update", "tiny", "--skills", "alpha-skill"], { cwd, env });
  expect(result.status).toBe(0);
  expect(parseSubMd(readFileSync(dest, "utf8"), dest).skills).toEqual({
    kind: "only",
    names: ["alpha-skill"],
  });
});

test("neo sub update --skills false turns skills off", () => {
  const { cwd, env } = gitRepo();
  const dest = writeSub(
    cwd,
    "tiny",
    `---
description: A tiny sub.
model: fable
skills: true
---
Do the thing.
`,
  );
  const result = neo(["sub", "update", "tiny", "--skills", "false"], { cwd, env });
  expect(result.status).toBe(0);
  const text = readFileSync(dest, "utf8");
  expect(text).not.toContain("skills");
  expect(parseSubMd(text, dest).skills).toEqual({ kind: "off" });
});

test("neo sub update --skills rejects a name that is not in cwd", () => {
  const { cwd, env } = gitRepo();
  const dest = writeSub(
    cwd,
    "tiny",
    `---
description: A tiny sub.
model: fable
skills: true
---
Do the thing.
`,
  );
  const result = neo(["sub", "update", "tiny", "--skills", "missing-skill"], { cwd, env });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("skill not found");
  expect(parseSubMd(readFileSync(dest, "utf8"), dest).skills).toEqual({ kind: "all" });
});
