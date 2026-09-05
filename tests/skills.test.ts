import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { buildInstructions } from "../src/lib/run";
import {
  discoverSkills,
  filterSkills,
  formatSkillActivation,
  formatSkillsCatalog,
  lookupSkill,
  parseSkillMd,
  parseSkillsFilter,
  searchSkills,
  skillsFilterFromCli,
} from "../src/plugins/skills";

const dirs: string[] = [];

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "neo-skills-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseSkillMd reads name, folded description, and body", () => {
  const parsed = parseSkillMd(`---
name: demo-skill
description: >-
  First sentence.
  Second sentence.
---

# Demo

Do the thing.
`);
  expect(parsed).toEqual({
    name: "demo-skill",
    description: "First sentence. Second sentence.",
    body: "\n# Demo\n\nDo the thing.\n",
  });
});

test("parseSkillMd last duplicate key wins", () => {
  const parsed = parseSkillMd(`---
name: demo-skill
description: first
description: second
---
body
`);
  expect(parsed?.description).toBe("second");
});

test("parseSkillMd rejects missing frontmatter, bad names, and empty descriptions", () => {
  expect(parseSkillMd("# no frontmatter")).toBeUndefined();
  expect(
    parseSkillMd(`---
name: Bad_Name
description: ok
---
`),
  ).toBeUndefined();
  expect(
    parseSkillMd(`---
name: -leading
description: ok
---
`),
  ).toBeUndefined();
  expect(
    parseSkillMd(`---
name: ok
description: "   "
---
`),
  ).toBeUndefined();
});

test("discoverSkills finds project and global skills and skips name/dir mismatches", async () => {
  const cwd = tmp();
  const home = tmp();
  mkdirSync(join(cwd, ".git"));
  mkdirSync(join(cwd, ".agents", "skills", "demo-skill"), { recursive: true });
  writeFileSync(
    join(cwd, ".agents", "skills", "demo-skill", "SKILL.md"),
    `---
name: demo-skill
description: A demo skill for tests.
---

Use this skill in tests.
`,
  );
  mkdirSync(join(cwd, ".agents", "skills", "demo-skill", "references"));
  writeFileSync(join(cwd, ".agents", "skills", "demo-skill", "references", "notes.md"), "ref");
  mkdirSync(join(cwd, ".agents", "skills", "wrong-dir"), { recursive: true });
  writeFileSync(
    join(cwd, ".agents", "skills", "wrong-dir", "SKILL.md"),
    `---
name: other-name
description: This name does not match the directory.
---
`,
  );
  mkdirSync(join(home, ".agents", "skills", "global-skill"), { recursive: true });
  writeFileSync(
    join(home, ".agents", "skills", "global-skill", "SKILL.md"),
    `---
name: global-skill
description: A global skill.
---

Global body.
`,
  );

  const skills = await discoverSkills({ cwd, home });
  expect(skills.map((skill) => skill.name).sort()).toEqual(["demo-skill", "global-skill"]);
  const demo = skills.find((skill) => skill.name === "demo-skill");
  expect(demo?.source).toBe("project");
  expect(demo?.references).toEqual(["notes.md"]);
  expect(demo?.instructions).toContain("Use this skill in tests.");
});

test("lookupSkill disambiguates duplicate names by path", async () => {
  const cwd = tmp();
  const home = tmp();
  mkdirSync(join(cwd, ".agents", "skills", "dup"), { recursive: true });
  mkdirSync(join(home, ".agents", "skills", "dup"), { recursive: true });
  const body = `---
name: dup
description: Duplicate name.
---

body
`;
  writeFileSync(join(cwd, ".agents", "skills", "dup", "SKILL.md"), body);
  writeFileSync(join(home, ".agents", "skills", "dup", "SKILL.md"), body);

  const skills = await discoverSkills({ cwd, home });
  expect(skills).toHaveLength(2);
  const ambiguous = lookupSkill(skills, "dup");
  expect("error" in ambiguous).toBe(true);

  const first = skills[0];
  expect(first).toBeDefined();
  if (first === undefined) {
    throw new Error("expected a skill");
  }
  const byPath = lookupSkill(skills, first.path);
  expect("skill" in byPath).toBe(true);
});

test("searchSkills ranks a matching skill and formatSkillsCatalog emits XML", async () => {
  const cwd = tmp();
  mkdirSync(join(cwd, ".agents", "skills", "search-me"), { recursive: true });
  writeFileSync(
    join(cwd, ".agents", "skills", "search-me", "SKILL.md"),
    `---
name: search-me
description: Find neon branches in this skill.
---

Instructions about neon branches.
`,
  );
  const skills = await discoverSkills({ cwd, home: tmp() });
  const hits = searchSkills({ skills, query: "neon branches" });
  expect(hits[0]?.skillName).toBe("search-me");
  expect(hits[0]?.score).toBeGreaterThan(0);

  const catalog = formatSkillsCatalog(skills);
  expect(catalog).toContain("<available_skills>");
  expect(catalog).toContain("<name>search-me</name>");
  expect(catalog).toContain("<source>project</source>");

  const demo = skills[0];
  expect(demo).toBeDefined();
  if (demo === undefined) {
    throw new Error("expected a skill");
  }
  expect(formatSkillActivation(demo)).toContain("Instructions about neon branches.");
});

test("buildInstructions drops the skip line for each enabled plugin", () => {
  const base = buildInstructions({ cwd: "/tmp/x", readonly: false });
  expect(base).toContain("Do not load AGENTS.md or skill files unless the user names them.");
  expect(base).toContain("inspect and change");

  const withAgents = buildInstructions({
    cwd: "/tmp/x",
    readonly: true,
    agentsMd: "# AGENTS.md\n\nhi",
  });
  expect(withAgents).toContain("# AGENTS.md");
  expect(withAgents).toContain("Do not load skill files");
  expect(withAgents).not.toContain("Do not load AGENTS.md or skill files");

  const withSkills = buildInstructions({
    cwd: "/tmp/x",
    readonly: false,
    skillsCatalog: "<available_skills>\n</available_skills>",
  });
  expect(withSkills).toContain("Skills are NOT tools");
  expect(withSkills).toContain("Do not load AGENTS.md unless the user names them.");
  expect(withSkills).not.toContain("Do not load skill files unless the user names them.");

  const withSub = buildInstructions({
    cwd: "/tmp/x",
    readonly: true,
    agentsMd: "# AGENTS.md\n\nrepo rules",
    subPrompt: "You are the pr-review sub.",
  });
  const agentsAt = withSub.indexOf("repo rules");
  const subAt = withSub.indexOf("You are the pr-review sub.");
  const finalAt = withSub.indexOf("The final message is the answer.");
  expect(agentsAt).toBeGreaterThan(-1);
  expect(subAt).toBeGreaterThan(agentsAt);
  expect(finalAt).toBeGreaterThan(subAt);
});

test("parseSkillsFilter and filterSkills select a subset", async () => {
  expect(parseSkillsFilter(undefined)).toEqual({ kind: "off" });
  expect(parseSkillsFilter("true")).toEqual({ kind: "all" });
  expect(parseSkillsFilter("false")).toEqual({ kind: "off" });
  expect(parseSkillsFilter("tdd, tdd, good-code-comments")).toEqual({
    kind: "only",
    names: ["tdd", "good-code-comments"],
  });
  expect(parseSkillsFilter("[tdd, foo-bar]")).toEqual({
    kind: "only",
    names: ["tdd", "foo-bar"],
  });
  expect(() => parseSkillsFilter("Not_Kebab")).toThrow(/invalid skill name/);
  expect(skillsFilterFromCli(undefined)).toEqual({ kind: "off" });
  expect(skillsFilterFromCli(true)).toEqual({ kind: "all" });
  expect(skillsFilterFromCli("tdd,foo")).toEqual({ kind: "only", names: ["tdd", "foo"] });

  const cwd = tmp();
  mkdirSync(join(cwd, ".agents", "skills", "alpha-skill"), { recursive: true });
  mkdirSync(join(cwd, ".agents", "skills", "beta-skill"), { recursive: true });
  writeFileSync(
    join(cwd, ".agents", "skills", "alpha-skill", "SKILL.md"),
    `---
name: alpha-skill
description: Alpha.
---
A.
`,
  );
  writeFileSync(
    join(cwd, ".agents", "skills", "beta-skill", "SKILL.md"),
    `---
name: beta-skill
description: Beta.
---
B.
`,
  );
  const skills = await discoverSkills({ cwd, home: tmp() });
  const filtered = filterSkills(skills, ["beta-skill"]);
  expect(filtered.map((skill) => skill.name)).toEqual(["beta-skill"]);
  expect(() => filterSkills(skills, ["missing-skill"])).toThrow(/skill not found/);
});
