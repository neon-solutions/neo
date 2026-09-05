import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { NeoError } from "../src/lib/errors";
import {
  defaultBranchId,
  execNeon,
  gatewayVarsFromDotenv,
  neonJson,
  parseBranchList,
  parseCreatedProject,
  parseDotenv,
  parseOrgList,
  parseProjectList,
  type NeonExec,
  type NeonExecResult,
} from "../src/lib/neon-cli";
import type { Prompter } from "../src/lib/ask";
import {
  ensureNeonProviderConfig,
  loadNeonProviderConfig,
  neonProviderConfigPath,
  readNeonProviderConfig,
  writeNeonProviderConfig,
} from "../src/plugins/neon-ai-gateway";
import {
  DEFAULT_NEON_PROJECT_NAME,
  DEFAULT_NEON_REGION,
  setupNeonGateway,
} from "../src/plugins/neon-setup";

const originalHome = process.env.HOME;
const originalToken = process.env.NEON_AI_GATEWAY_TOKEN;
const originalUrl = process.env.NEON_AI_GATEWAY_BASE_URL;

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalToken === undefined) {
    delete process.env.NEON_AI_GATEWAY_TOKEN;
  } else {
    process.env.NEON_AI_GATEWAY_TOKEN = originalToken;
  }
  if (originalUrl === undefined) {
    delete process.env.NEON_AI_GATEWAY_BASE_URL;
  } else {
    process.env.NEON_AI_GATEWAY_BASE_URL = originalUrl;
  }
});

function isolateHome(): string {
  const home = mkdtempSync(join(tmpdir(), "neo-home-"));
  process.env.HOME = home;
  delete process.env.NEON_AI_GATEWAY_TOKEN;
  delete process.env.NEON_AI_GATEWAY_BASE_URL;
  return home;
}

function scripted(answers: string[]): Prompter {
  let index = 0;
  return {
    async ask(question: string): Promise<string | undefined> {
      process.stderr.write(question);
      if (index >= answers.length) {
        return undefined;
      }
      const line = answers[index];
      index += 1;
      return line;
    },
    async askBody(): Promise<string | undefined> {
      return undefined;
    },
  };
}

function flag(args: readonly string[], name: string): string {
  const i = args.indexOf(name);
  if (i === -1) {
    throw new Error(`missing ${name} in ${args.join(" ")}`);
  }
  const value = args[i + 1];
  if (value === undefined) {
    throw new Error(`missing value for ${name}`);
  }
  return value;
}

function fakeNeon(options: { authed?: boolean; envPull?: NeonExecResult }): {
  exec: NeonExec;
  calls: { args: string[]; inheritStdio: boolean }[];
} {
  let authed = options.authed ?? true;
  const calls: { args: string[]; inheritStdio: boolean }[] = [];
  const projects = [{ id: "old-project", name: "existing", region_id: "aws-us-west-2" }];
  const exec: NeonExec = (args, spawnOptions) => {
    const inheritStdio = spawnOptions?.inheritStdio === true;
    calls.push({ args: [...args], inheritStdio });
    const [cmd, sub] = args;
    if (cmd === "auth") {
      authed = true;
      return { status: 0, stdout: "", stderr: "" };
    }
    if (cmd === "me") {
      if (!authed) {
        return { status: 1, stdout: "", stderr: "the Neon API rejected the API key" };
      }
      return { status: 0, stdout: JSON.stringify({ email: "a@b.test" }), stderr: "" };
    }
    if (cmd === "orgs" && sub === "list") {
      return {
        status: 0,
        stdout: JSON.stringify([
          { id: "org-a", name: "Alpha", plan: "free" },
          { id: "org-b", name: "Beta", plan: "launch" },
        ]),
        stderr: "",
      };
    }
    if (cmd === "projects" && sub === "list") {
      return { status: 0, stdout: JSON.stringify(projects), stderr: "" };
    }
    if (cmd === "projects" && sub === "create") {
      const created = {
        id: "new-project",
        name: flag(args, "--name"),
        region_id: flag(args, "--region-id"),
      };
      projects.push(created);
      return { status: 0, stdout: JSON.stringify({ project: created }), stderr: "" };
    }
    if (cmd === "branches" && sub === "list") {
      return {
        status: 0,
        stdout: JSON.stringify([
          { id: "br-dev", name: "dev", default: false },
          { id: "br-main", name: "main", default: true },
        ]),
        stderr: "",
      };
    }
    if (cmd === "env" && sub === "pull") {
      if (options.envPull !== undefined) {
        return options.envPull;
      }
      const file = flag(args, "--file");
      writeFileSync(
        file,
        `NEON_AI_GATEWAY_TOKEN=nt_live_test\nNEON_AI_GATEWAY_BASE_URL=https://gw.example.test/\n`,
      );
      return { status: 0, stdout: "", stderr: "" };
    }
    return { status: 1, stdout: "", stderr: `unexpected ${args.join(" ")}` };
  };
  return { exec, calls };
}

test("parseOrgList and parseProjectList read CLI JSON arrays", () => {
  expect(parseOrgList([{ id: "org-1", name: "Acme", plan: "launch" }])).toEqual([
    { id: "org-1", name: "Acme", plan: "launch" },
  ]);
  expect(parseProjectList([{ id: "p1", name: "app", region_id: "aws-us-east-2" }])).toEqual([
    { id: "p1", name: "app", regionId: "aws-us-east-2" },
  ]);
});

test("parseCreatedProject reads the wrapped project object", () => {
  expect(
    parseCreatedProject({
      project: { id: "p1", name: "neo", region_id: "aws-us-east-2" },
    }),
  ).toEqual({ id: "p1", name: "neo", regionId: "aws-us-east-2" });
});

test("defaultBranchId uses the default flag", () => {
  expect(
    defaultBranchId([
      { id: "br-a", name: "dev", default: false },
      { id: "br-b", name: "main", default: true },
    ]),
  ).toBe("br-b");
  expect(() => defaultBranchId([{ id: "br-a", name: "dev", default: false }])).toThrow(
    /no default branch/,
  );
});

test("gatewayVarsFromDotenv reads quoted token and URL", () => {
  const vars = gatewayVarsFromDotenv(
    `NEON_AI_GATEWAY_TOKEN="nt_live_x"\nNEON_AI_GATEWAY_BASE_URL='https://gw.test/'\n`,
  );
  expect(vars).toEqual({ apiKey: "nt_live_x", baseURL: "https://gw.test/" });
  expect(parseDotenv("# skip\nFOO=bar\n").get("FOO")).toBe("bar");
  expect(() => gatewayVarsFromDotenv("FOO=bar\n")).toThrow(/did not write/);
});

test("neonJson appends --output json and parses stdout", () => {
  const exec: NeonExec = (args) => {
    expect(args).toEqual(["orgs", "list", "--output", "json"]);
    return { status: 0, stdout: "[1]", stderr: "" };
  };
  expect(neonJson(exec, ["orgs", "list"])).toEqual([1]);
});

test("execNeon throws when the binary is missing", () => {
  const previous = process.env.PATH;
  process.env.PATH = "/usr/bin:/bin";
  try {
    expect(() => execNeon(["me"])).toThrow(/neon CLI not found/);
  } finally {
    process.env.PATH = previous;
  }
});

test("readNeonProviderConfig is undefined when the file is missing", () => {
  isolateHome();
  expect(readNeonProviderConfig()).toBeUndefined();
  expect(() => loadNeonProviderConfig()).toThrow(/missing/);
});

test("ensureNeonProviderConfig does not start the wizard without a TTY", async () => {
  isolateHome();
  await expect(ensureNeonProviderConfig({ interactive: false })).rejects.toThrow(
    /Run neo in a terminal/,
  );
});

test("setupNeonGateway writes neon.json from an existing project", async () => {
  isolateHome();
  const { exec, calls } = fakeNeon({});
  const config = await setupNeonGateway({
    exec,
    prompter: scripted(["", "2", ""]),
  });
  expect(config).toEqual({
    apiKey: "nt_live_test",
    baseURL: "https://gw.example.test",
  });
  const path = neonProviderConfigPath();
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(config);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  const pull = calls.find((call) => call.args[0] === "env");
  expect(pull?.args).toContain("--project-id");
  expect(pull?.args).toContain("old-project");
  expect(pull?.args).toContain("br-main");
  expect(pull?.args).toContain("-s");
  expect(pull?.args).toContain("ai-gateway");
  expect(calls.some((call) => call.args[1] === "list" && call.args.includes("org-b"))).toBe(true);
});

test("setupNeonGateway creates a project in aws-us-east-2", async () => {
  isolateHome();
  const { exec, calls } = fakeNeon({});
  await setupNeonGateway({
    exec,
    prompter: scripted(["", "2", "2", ""]),
  });
  const create = calls.find((call) => call.args[0] === "projects" && call.args[1] === "create");
  expect(create?.args).toContain(DEFAULT_NEON_PROJECT_NAME);
  expect(create?.args).toContain(DEFAULT_NEON_REGION);
  expect(create?.args).toContain("--no-secrets");
  expect(create?.args).toContain("org-b");
  const pull = calls.find((call) => call.args[0] === "env");
  expect(pull?.args).toContain("new-project");
});

test("setupNeonGateway runs neon auth when me fails", async () => {
  isolateHome();
  const { exec, calls } = fakeNeon({ authed: false });
  await setupNeonGateway({
    exec,
    prompter: scripted(["", "2", "1"]),
  });
  expect(calls[0]?.args).toEqual(["me", "--output", "json"]);
  expect(calls[1]?.args).toEqual(["auth"]);
  expect(calls[1]?.inheritStdio).toBe(true);
});

test("setupNeonGateway surfaces env pull errors", async () => {
  isolateHome();
  const { exec } = fakeNeon({
    envPull: { status: 1, stdout: "", stderr: "upgrade to a paid plan" },
  });
  await expect(setupNeonGateway({ exec, prompter: scripted(["", "2", "1"]) })).rejects.toThrow(
    /upgrade to a paid plan/,
  );
});

test("writeNeonProviderConfig is what ensure reuses on the next call", async () => {
  isolateHome();
  writeNeonProviderConfig({ apiKey: "k", baseURL: "https://gw.test" });
  const config = await ensureNeonProviderConfig({
    interactive: true,
    exec: () => {
      throw new Error("wizard should not run");
    },
    prompter: scripted([]),
  });
  expect(config).toEqual({ apiKey: "k", baseURL: "https://gw.test" });
});
