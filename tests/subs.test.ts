import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { NeoError } from "../src/lib/errors";
import { discoverSubs, formatSubDetails, formatSubsList, parseSubMd } from "../src/plugins/subs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "src/cli.ts");
const dirs: string[] = [];

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "neo-subs-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function neo(args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }) {
  return spawnSync("bun", [cli, ...args], {
    encoding: "utf8",
    cwd: options?.cwd ?? root,
    env: options?.env ?? process.env,
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

const fullBody = `---
description: Critical engineering review of an open PR. Give it the repo path, the PR number or URL, and the PR's one concern.
model: sol
cwd: ~/workspaces
readonly: true
agents-md: true
skills: true
---
You are running a critical engineering review.
BODY-NONCE-kestrel
`;

test("parseSubMd reads all keys and keeps the body", () => {
  const parsed = parseSubMd(fullBody, "/tmp/pr-review.md");
  expect(parsed).toEqual({
    name: "pr-review",
    description:
      "Critical engineering review of an open PR. Give it the repo path, the PR number or URL, and the PR's one concern.",
    model: "sol",
    cwd: "~/workspaces",
    readonly: true,
    agentsMd: true,
    skills: true,
    systemPrompt: "You are running a critical engineering review.\nBODY-NONCE-kestrel",
  });
});

test("parseSubMd strips a real UTF-8 BOM", () => {
  const parsed = parseSubMd(
    `\uFEFF---
description: Bom.
model: fable
---
Body.
`,
    "/tmp/bom.md",
  );
  expect(parsed.model).toBe("fable");
  expect(parsed.systemPrompt).toBe("Body.");
});

test("parseSubMd defaults when only description and model are set", () => {
  const parsed = parseSubMd(
    `---
description: A tiny sub.
model: fable
---
Do the thing.
`,
    "/tmp/tiny.md",
  );
  expect(parsed.readonly).toBe(false);
  expect(parsed.agentsMd).toBe(false);
  expect(parsed.skills).toBe(false);
  expect(parsed.cwd).toBeUndefined();
  expect(parsed.model).toBe("fable");
});

test("parseSubMd accepts quoted booleans and rejects True and yes", () => {
  const quoted = parseSubMd(
    `---
description: Quoted flags.
model: fable
readonly: "true"
---
Body.
`,
    "/tmp/quoted.md",
  );
  expect(quoted.readonly).toBe(true);

  expect(() =>
    parseSubMd(
      `---
description: Bad bool.
model: fable
readonly: True
---
Body.
`,
      "/tmp/true-case.md",
    ),
  ).toThrow(/true or false/);

  expect(() =>
    parseSubMd(
      `---
description: Bad bool.
model: fable
readonly: yes
---
Body.
`,
      "/tmp/yes.md",
    ),
  ).toThrow(/true or false/);
});

test("parseSubMd errors name the file", () => {
  const file = "/tmp/broken.md";
  const cases: { text: string; pattern: RegExp }[] = [
    {
      text: "# no frontmatter\n",
      pattern: /missing YAML frontmatter/,
    },
    {
      text: `---
model: fable
---
Body.
`,
      pattern: /missing description/,
    },
    {
      text: `---
description: No model.
---
Body.
`,
      pattern: /missing model/,
    },
    {
      text: `---
description: Empty body.
model: fable
---
`,
      pattern: /body is empty/,
    },
    {
      text: `---
description: Typo.
model: fable
readony: true
---
Body.
`,
      pattern: /unknown key "readony"/,
    },
    {
      text: `---
name: pr-review
description: Named.
model: fable
---
Body.
`,
      pattern: /name comes from the filename/,
    },
    {
      text: `---
description: Relative cwd.
model: fable
cwd: workspaces
---
Body.
`,
      pattern: /absolute path/,
    },
    {
      text: `---
description: Malformed.
model: fable
readonly true
---
Body.
`,
      pattern: /malformed YAML/,
    },
    {
      text: `---
description: Dup.
model: fable
readonly: true
readonly: false
---
Body.
`,
      pattern: /duplicate key "readonly"/,
    },
  ];

  for (const entry of cases) {
    expect(() => parseSubMd(entry.text, file)).toThrow(NeoError);
    expect(() => parseSubMd(entry.text, file)).toThrow(entry.pattern);
    expect(() => parseSubMd(entry.text, file)).toThrow(/\/tmp\/broken\.md/);
  }

  expect(() => parseSubMd(fullBody, "/tmp/NotKebab.md")).toThrow(/kebab-case/);
});

test("formatSubsList prints meta and description, not the body", () => {
  const listed = formatSubsList(
    [
      {
        name: "pr-review",
        description: "Critical engineering review of an open PR.",
        model: "sol",
        cwd: "/Users/me/workspaces",
        readonly: true,
        agentsMd: true,
        skills: true,
        systemPrompt: "BODY-NONCE-kestrel",
        path: "/tmp/pr-review.md",
        source: "project",
      },
    ],
    "/Users/me",
  );
  expect(listed).toContain("pr-review");
  expect(listed).toContain("sol");
  expect(listed).toContain("readonly");
  expect(listed).toContain("agents-md");
  expect(listed).toContain("skills");
  expect(listed).toContain("cwd ~/workspaces");
  expect(listed).toContain("Critical engineering review of an open PR.");
  expect(listed).not.toContain("BODY-NONCE-kestrel");
});

test("formatSubDetails prints the full template and the do-not-repeat line", () => {
  const details = formatSubDetails(
    {
      name: "pr-review",
      description: "Critical engineering review of an open PR.",
      model: "sol",
      cwd: "/Users/me/workspaces",
      readonly: true,
      agentsMd: true,
      skills: true,
      systemPrompt: "BODY-NONCE-kestrel",
      path: "/tmp/pr-review.md",
      source: "project",
    },
    "/Users/me",
  );
  expect(details).toContain("pr-review  (project)");
  expect(details).toContain("/tmp/pr-review.md");
  expect(details).toContain(
    "Pass only the task brief in --prompt. Do not repeat the system prompt.",
  );
  expect(details).toContain("description: Critical engineering review of an open PR.");
  expect(details).toContain("model: sol");
  expect(details).toContain("cwd: ~/workspaces");
  expect(details).toContain("readonly: true");
  expect(details).toContain("agents-md: true");
  expect(details).toContain("skills: true");
  expect(details).toContain("BODY-NONCE-kestrel");
});

test("discoverSubs expands ~ cwd and skips a shadowed global", async () => {
  const cwd = tmp();
  const home = tmp();
  const work = join(home, "workspaces");
  mkdirSync(work);
  mkdirSync(join(cwd, ".git"));
  writeSub(
    cwd,
    "pr-review",
    `---
description: Project review.
model: sol
cwd: ~/workspaces
readonly: true
---
Project body.
`,
  );
  writeSub(
    home,
    "pr-review",
    `---
description: Global review.
model: fable
---
Global body.
`,
  );
  writeSub(
    home,
    "writing",
    `---
description: Drafts outbound prose.
model: fable
---
Write.
`,
  );

  const subs = await discoverSubs({ cwd, home });
  expect(subs.map((sub) => sub.name).sort()).toEqual(["pr-review", "writing"]);
  const review = subs.find((sub) => sub.name === "pr-review");
  expect(review?.description).toBe("Project review.");
  expect(review?.source).toBe("project");
  expect(review?.cwd).toBe(work);
  expect(review?.readonly).toBe(true);
});

test("neo sub list prints project and global subs and hides the body", () => {
  const cwd = tmp();
  const home = tmp();
  mkdirSync(join(cwd, ".git"));
  writeSub(
    cwd,
    "pr-review",
    `---
description: Project review sub.
model: sol
readonly: true
---
SECRET-BODY-ONE
`,
  );
  writeSub(
    home,
    "writing",
    `---
description: Global writing sub.
model: fable
---
SECRET-BODY-TWO
`,
  );

  const result = neo(["sub", "list"], { cwd, env: isolatedEnv(home) });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("pr-review");
  expect(result.stdout).toContain("writing");
  expect(result.stdout).toContain("Project review sub.");
  expect(result.stdout).toContain("Global writing sub.");
  expect(`${result.stdout}${result.stderr}`).not.toContain("SECRET-BODY-ONE");
  expect(`${result.stdout}${result.stderr}`).not.toContain("SECRET-BODY-TWO");
});

test("neo sub list shadows a global sub of the same name", () => {
  const cwd = tmp();
  const home = tmp();
  mkdirSync(join(cwd, ".git"));
  writeSub(
    cwd,
    "pr-review",
    `---
description: Project wins.
model: sol
---
project
`,
  );
  writeSub(
    home,
    "pr-review",
    `---
description: Global loses.
model: fable
---
global
`,
  );

  const result = neo(["sub", "list"], { cwd, env: isolatedEnv(home) });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("Project wins.");
  expect(result.stdout).not.toContain("Global loses.");
});

test("neo sub list is empty with a hint", () => {
  const cwd = tmp();
  const home = tmp();
  const result = neo(["sub", "list"], { cwd, env: isolatedEnv(home) });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("No subs found.");
  expect(result.stdout).toContain(".agents/subs/");
});

test("neo sub unknown name lists available subs", () => {
  const cwd = tmp();
  const home = tmp();
  mkdirSync(join(cwd, ".git"));
  writeSub(
    cwd,
    "pr-review",
    `---
description: Review.
model: sol
---
Body.
`,
  );
  const result = neo(["sub", "nope", "--prompt", "x"], { cwd, env: isolatedEnv(home) });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("not found");
  expect(result.stderr).toContain("pr-review");
});

test("neo sub requires a prompt before credentials", () => {
  const cwd = tmp();
  const home = tmp();
  mkdirSync(join(cwd, ".git"));
  writeSub(
    cwd,
    "pr-review",
    `---
description: Review.
model: sol
---
Body.
`,
  );
  const result = neo(["sub", "pr-review"], { cwd, env: isolatedEnv(home) });
  expect(result.status).toBe(1);
  expect(`${result.stdout}${result.stderr}`).toMatch(/--prompt/);
  expect(result.stderr).not.toContain("providers/neon.json");
});

test("neo sub rejects --prompt and --prompt-file together", () => {
  const cwd = tmp();
  const home = tmp();
  mkdirSync(join(cwd, ".git"));
  writeSub(
    cwd,
    "pr-review",
    `---
description: Review.
model: sol
---
Body.
`,
  );
  writeFileSync(join(cwd, "prompt.txt"), "hello");
  const result = neo(
    ["sub", "pr-review", "--prompt", "x", "--prompt-file", join(cwd, "prompt.txt")],
    { cwd, env: isolatedEnv(home) },
  );
  expect(result.status).not.toBe(0);
  expect(`${result.stdout}${result.stderr}`).toMatch(/not both/);
});

test("neo sub rejects root launch flags before and after the command", () => {
  const cwd = tmp();
  const home = tmp();
  mkdirSync(join(cwd, ".git"));
  writeSub(
    cwd,
    "pr-review",
    `---
description: Review.
model: sol
---
Body.
`,
  );
  const after = neo(["sub", "pr-review", "--model", "fable", "--prompt", "x"], {
    cwd,
    env: isolatedEnv(home),
  });
  expect(after.status).toBe(1);
  expect(`${after.stdout}${after.stderr}`).toMatch(/sealed|unknown option/i);

  const before = neo(["--model", "fable", "sub", "pr-review", "--prompt", "x"], {
    cwd,
    env: isolatedEnv(home),
  });
  expect(before.status).toBe(1);
  expect(`${before.stdout}${before.stderr}`).toMatch(/sealed|unknown option/i);
});

test("neo sub list fails when cwd does not exist", () => {
  const cwd = tmp();
  const home = tmp();
  mkdirSync(join(cwd, ".git"));
  const path = writeSub(
    cwd,
    "pr-review",
    `---
description: Review.
model: sol
cwd: /tmp/neo-sub-missing-cwd-does-not-exist
---
Body.
`,
  );
  const result = neo(["sub", "list"], { cwd, env: isolatedEnv(home) });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(path);
  expect(result.stderr).toContain("does not exist");
});

test("reserved list.md fails on any sub invocation", () => {
  const cwd = tmp();
  const home = tmp();
  mkdirSync(join(cwd, ".git"));
  const path = writeSub(
    cwd,
    "list",
    `---
description: Reserved.
model: fable
---
Body.
`,
  );
  const result = neo(["sub", "list"], { cwd, env: isolatedEnv(home) });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(path);
  expect(result.stderr).toContain("reserved");
});

test("reserved details.md fails on any sub invocation", () => {
  const cwd = tmp();
  const home = tmp();
  mkdirSync(join(cwd, ".git"));
  const path = writeSub(
    cwd,
    "details",
    `---
description: Reserved.
model: fable
---
Body.
`,
  );
  const result = neo(["sub", "details", "details"], { cwd, env: isolatedEnv(home) });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(path);
  expect(result.stderr).toContain("reserved");
});

test("broken frontmatter fails list loudly", () => {
  const cwd = tmp();
  const home = tmp();
  mkdirSync(join(cwd, ".git"));
  const path = writeSub(
    cwd,
    "pr-review",
    `---
description: Broken.
model: fable
readonly true
---
Body.
`,
  );
  const result = neo(["sub", "list"], { cwd, env: isolatedEnv(home) });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(path);
  expect(result.stderr).toMatch(/malformed YAML/);
});

test("valid sub launch reaches the credential check", () => {
  const cwd = tmp();
  const home = tmp();
  mkdirSync(join(cwd, ".git"));
  writeSub(
    cwd,
    "pr-review",
    `---
description: Review.
model: sol
---
Body.
`,
  );
  const result = neo(["sub", "pr-review", "--prompt", "x"], { cwd, env: isolatedEnv(home) });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("missing");
  expect(result.stderr).toContain("providers/neon.json");
});

test("template cwd is used for agents-md before credentials", () => {
  const invocation = tmp();
  const pinned = tmp();
  const home = tmp();
  mkdirSync(join(invocation, ".git"));
  writeFileSync(join(invocation, "AGENTS.md"), "invocation-should-not-count\n");
  mkdirSync(join(invocation, ".agents", "subs"), { recursive: true });
  writeFileSync(
    join(invocation, ".agents", "subs", "pr-review.md"),
    `---
description: Review.
model: sol
cwd: ${pinned}
agents-md: true
---
Body.
`,
  );

  const result = neo(["sub", "pr-review", "--prompt", "x"], {
    cwd: invocation,
    env: isolatedEnv(home),
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("no AGENTS.md");
  expect(result.stderr).toContain(pinned);
  expect(result.stderr).not.toContain("providers/neon.json");
});

test("neo sub with no name prints help", () => {
  const result = neo(["sub"]);
  expect(result.status).toBe(0);
  expect(`${result.stdout}${result.stderr}`).toContain("list");
  expect(`${result.stdout}${result.stderr}`).toContain("details");
});

test("neo sub details prints the body and the do-not-repeat line", () => {
  const cwd = tmp();
  const home = tmp();
  mkdirSync(join(cwd, ".git"));
  const path = writeSub(
    cwd,
    "pr-review",
    `---
description: Project review sub.
model: sol
readonly: true
---
SECRET-BODY-ONE
`,
  );
  const result = neo(["sub", "details", "pr-review"], { cwd, env: isolatedEnv(home) });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("pr-review  (project)");
  expect(result.stdout).toContain(path);
  expect(result.stdout).toContain(
    "Pass only the task brief in --prompt. Do not repeat the system prompt.",
  );
  expect(result.stdout).toContain("SECRET-BODY-ONE");
  expect(result.stdout).toContain("readonly: true");
  expect(result.stdout).not.toContain("agents-md: true");
});

test("neo sub details unknown name lists available subs", () => {
  const cwd = tmp();
  const home = tmp();
  mkdirSync(join(cwd, ".git"));
  writeSub(
    cwd,
    "pr-review",
    `---
description: Review.
model: sol
---
Body.
`,
  );
  const result = neo(["sub", "details", "nope"], { cwd, env: isolatedEnv(home) });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("not found");
  expect(result.stderr).toContain("pr-review");
});

test("neo sub details requires a name", () => {
  const result = neo(["sub", "details"]);
  expect(result.status).not.toBe(0);
  expect(`${result.stdout}${result.stderr}`).toMatch(/name|required|missing/i);
});
