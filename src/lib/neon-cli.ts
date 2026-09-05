import { spawnSync } from "node:child_process";
import { NeoError } from "./errors";
import { errorCode } from "./paths";

export type NeonExecResult = {
  status: number;
  stdout: string;
  stderr: string;
};

export type NeonExec = (
  args: readonly string[],
  options?: { inheritStdio?: boolean },
) => NeonExecResult;

export type NeonOrg = {
  id: string;
  name: string;
  plan: string;
};

export type NeonProject = {
  id: string;
  name: string;
  regionId: string;
};

export type NeonBranch = {
  id: string;
  name: string;
  default: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new NeoError(`neo: neon JSON is missing ${field}`);
  }
  return value;
}

export function parseOrgList(value: unknown): NeonOrg[] {
  if (!Array.isArray(value)) {
    throw new NeoError("neo: neon orgs list did not return a list");
  }
  return value.map((entry) => {
    if (!isRecord(entry)) {
      throw new NeoError("neo: neon orgs list entry is not an object");
    }
    return {
      id: requireString(entry.id, "org id"),
      name: requireString(entry.name, "org name"),
      plan: typeof entry.plan === "string" ? entry.plan : "",
    };
  });
}

export function parseProjectList(value: unknown): NeonProject[] {
  if (!Array.isArray(value)) {
    throw new NeoError("neo: neon projects list did not return a list");
  }
  return value.map((entry) => parseProject(entry));
}

export function parseCreatedProject(value: unknown): NeonProject {
  if (isRecord(value) && "project" in value) {
    return parseProject(value.project);
  }
  return parseProject(value);
}

function parseProject(value: unknown): NeonProject {
  if (!isRecord(value)) {
    throw new NeoError("neo: neon project JSON is not an object");
  }
  return {
    id: requireString(value.id, "project id"),
    name: requireString(value.name, "project name"),
    regionId: typeof value.region_id === "string" ? value.region_id : "",
  };
}

export function parseBranchList(value: unknown): NeonBranch[] {
  if (!Array.isArray(value)) {
    throw new NeoError("neo: neon branches list did not return a list");
  }
  return value.map((entry) => {
    if (!isRecord(entry)) {
      throw new NeoError("neo: neon branches list entry is not an object");
    }
    return {
      id: requireString(entry.id, "branch id"),
      name: requireString(entry.name, "branch name"),
      default: entry.default === true,
    };
  });
}

export function defaultBranchId(branches: NeonBranch[]): string {
  const marked = branches.find((branch) => branch.default);
  if (marked === undefined) {
    throw new NeoError("neo: project has no default branch");
  }
  return marked.id;
}

export function parseDotenv(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values.set(key, value);
  }
  return values;
}

export function gatewayVarsFromDotenv(text: string): { apiKey: string; baseURL: string } {
  const env = parseDotenv(text);
  const apiKey = env.get("NEON_AI_GATEWAY_TOKEN");
  const baseURL = env.get("NEON_AI_GATEWAY_BASE_URL");
  if (
    apiKey === undefined ||
    apiKey.length === 0 ||
    baseURL === undefined ||
    baseURL.length === 0
  ) {
    throw new NeoError("neo: neon env pull did not write AI Gateway credentials");
  }
  return { apiKey, baseURL };
}

export function neonFailure(args: readonly string[], result: NeonExecResult): NeoError {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit ${String(result.status)}`;
  return new NeoError(`neo: neon ${args.join(" ")} failed\n${detail}`);
}

function fromNeonSpawn(result: {
  error: Error | undefined;
  status: number | null;
  stdout: string | null;
  stderr: string | null;
}): NeonExecResult {
  if (result.error !== undefined) {
    if (errorCode(result.error) === "ENOENT") {
      throw new NeoError("neo: neon CLI not found. Install it with: npm install -g neon");
    }
    throw result.error;
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export function execNeon(
  args: readonly string[],
  options?: { inheritStdio?: boolean },
): NeonExecResult {
  const argv = [...args];
  if (options?.inheritStdio === true) {
    const result = spawnSync("neon", argv, {
      encoding: "utf8",
      stdio: "inherit",
    });
    return fromNeonSpawn({
      error: result.error,
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }
  const result = spawnSync("neon", argv, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return fromNeonSpawn({
    error: result.error,
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  });
}

export function neonJson(exec: NeonExec, args: readonly string[]): unknown {
  const withOutput = [...args, "--output", "json"];
  const result = exec(withOutput);
  if (result.status !== 0) {
    throw neonFailure(withOutput, result);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : "invalid JSON";
    throw new NeoError(`neo: neon ${args.join(" ")} did not print JSON (${detail})`);
  }
}
