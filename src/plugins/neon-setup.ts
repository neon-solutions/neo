import { mkdtempSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrompter, type Prompter } from "../lib/ask";
import { NeoError } from "../lib/errors";
import {
  defaultBranchId,
  execNeon,
  gatewayVarsFromDotenv,
  neonFailure,
  neonJson,
  parseBranchList,
  parseCreatedProject,
  parseOrgList,
  parseProjectList,
  type NeonExec,
  type NeonOrg,
  type NeonProject,
} from "../lib/neon-cli";
import {
  neonProviderConfigPath,
  parseNeonProviderConfig,
  writeNeonProviderConfig,
  type NeonProviderConfig,
} from "./neon-ai-gateway";

export const DEFAULT_NEON_PROJECT_NAME = "neo";
export const DEFAULT_NEON_REGION = "aws-us-east-2";

export type SetupNeonGatewayOptions = {
  exec?: NeonExec;
  prompter?: Prompter;
};

export async function setupNeonGateway(
  options: SetupNeonGatewayOptions = {},
): Promise<NeonProviderConfig> {
  const exec = options.exec ?? execNeon;
  const prompter = options.prompter ?? createPrompter();

  process.stderr.write("neo: no AI gateway credentials.\n\n");
  process.stderr.write("  1. Neon AI Gateway\n");
  await pickIndex(prompter, "Number [1]: ", 1, 0);

  await ensureNeonAuth(exec);

  const orgs = parseOrgList(neonJson(exec, ["orgs", "list"]));
  if (orgs.length === 0) {
    throw new NeoError("neo: this Neon account has no organizations");
  }
  writeOrgMenu(orgs);
  const orgIndex = await pickIndex(
    prompter,
    orgPrompt(orgs),
    orgs.length,
    orgs.length === 1 ? 0 : undefined,
  );
  const org = orgs[orgIndex];
  if (org === undefined) {
    throw new NeoError("neo: no organization selected");
  }

  const projects = parseProjectList(neonJson(exec, ["projects", "list", "--org-id", org.id]));
  writeProjectMenu(projects);
  const choice = await pickIndex(prompter, projectPrompt(projects), projects.length + 1, 0);
  const project =
    choice === projects.length ? await createProject(exec, prompter, org) : projects[choice];
  if (project === undefined) {
    throw new NeoError("neo: no project selected");
  }

  const branches = parseBranchList(
    neonJson(exec, ["branches", "list", "--project-id", project.id]),
  );
  const branchId = defaultBranchId(branches);
  const config = pullGatewayConfig(exec, project.id, branchId);
  writeNeonProviderConfig(config);
  process.stderr.write(`neo: wrote ${neonProviderConfigPath()}\n`);
  return config;
}

async function ensureNeonAuth(exec: NeonExec): Promise<void> {
  const me = exec(["me", "--output", "json"]);
  if (me.status === 0) {
    process.stderr.write("neo: using Neon CLI credentials.\n");
    return;
  }
  process.stderr.write("neo: signing in with neon auth...\n");
  const auth = exec(["auth"], { inheritStdio: true });
  if (auth.status !== 0) {
    throw neonFailure(["auth"], auth);
  }
  const again = exec(["me", "--output", "json"]);
  if (again.status !== 0) {
    throw neonFailure(["me"], again);
  }
}

async function createProject(
  exec: NeonExec,
  prompter: Prompter,
  org: NeonOrg,
): Promise<NeonProject> {
  const line = await prompter.ask(`Project name [${DEFAULT_NEON_PROJECT_NAME}]: `);
  if (line === undefined) {
    throw new NeoError("neo: cancelled");
  }
  const name = line.trim().length === 0 ? DEFAULT_NEON_PROJECT_NAME : line.trim();
  process.stderr.write(`neo: creating project ${name} in ${DEFAULT_NEON_REGION}...\n`);
  const created = neonJson(exec, [
    "projects",
    "create",
    "--name",
    name,
    "--org-id",
    org.id,
    "--region-id",
    DEFAULT_NEON_REGION,
    "--no-secrets",
  ]);
  return parseCreatedProject(created);
}

function pullGatewayConfig(
  exec: NeonExec,
  projectId: string,
  branchId: string,
): NeonProviderConfig {
  const dir = mkdtempSync(join(tmpdir(), "neo-ai-gateway-"));
  const file = join(dir, "ai.env");
  // Always pass project and branch so a linked cwd cannot mint a different gateway.
  const args = [
    "env",
    "pull",
    "--project-id",
    projectId,
    "--branch",
    branchId,
    "-s",
    "ai-gateway",
    "--file",
    file,
  ] as const;
  try {
    const result = exec(args);
    if (result.status !== 0) {
      throw neonFailure(args, result);
    }
    const text = readFileSync(file, "utf8");
    const vars = gatewayVarsFromDotenv(text);
    return parseNeonProviderConfig(vars, "neon env pull");
  } finally {
    try {
      unlinkSync(file);
    } catch {
      // temp file may not exist if env pull failed before writing
    }
  }
}

function writeOrgMenu(orgs: NeonOrg[]): void {
  process.stderr.write("\nOrganizations:\n");
  for (let i = 0; i < orgs.length; i++) {
    const org = orgs[i];
    if (org === undefined) {
      continue;
    }
    const plan = org.plan.length > 0 ? `  ${org.plan}` : "";
    process.stderr.write(`  ${String(i + 1)}. ${org.name}${plan}\n`);
  }
}

function writeProjectMenu(projects: NeonProject[]): void {
  process.stderr.write("\nProjects:\n");
  for (let i = 0; i < projects.length; i++) {
    const project = projects[i];
    if (project === undefined) {
      continue;
    }
    const region = project.regionId.length > 0 ? `  ${project.regionId}` : "";
    process.stderr.write(`  ${String(i + 1)}. ${project.name}${region}\n`);
  }
  process.stderr.write(`  ${String(projects.length + 1)}. Create a new project\n`);
}

function orgPrompt(orgs: NeonOrg[]): string {
  return orgs.length === 1 ? "Number [1]: " : "Number: ";
}

function projectPrompt(projects: NeonProject[]): string {
  return "Number [1]: ";
}

async function pickIndex(
  prompter: Prompter,
  prompt: string,
  count: number,
  emptyDefault: number | undefined,
): Promise<number> {
  for (;;) {
    const line = await prompter.ask(prompt);
    if (line === undefined) {
      throw new NeoError("neo: cancelled");
    }
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      if (emptyDefault === undefined) {
        process.stderr.write(`neo: enter a number 1–${String(count)}\n`);
        continue;
      }
      return emptyDefault;
    }
    if (!/^[1-9][0-9]*$/.test(trimmed)) {
      process.stderr.write(`neo: enter a number 1–${String(count)}\n`);
      continue;
    }
    const n = Number(trimmed);
    if (n < 1 || n > count) {
      process.stderr.write(`neo: enter a number 1–${String(count)}\n`);
      continue;
    }
    return n - 1;
  }
}
