import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NeoError } from "./errors";

export type GatewayCredentials = {
  token: string;
  baseUrl: string;
};

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export function loadCwdEnv(cwd: string): void {
  let text: string;
  try {
    text = readFileSync(join(cwd, ".env.local"), "utf8");
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    const value = stripQuotes(line.slice(eq + 1).trim());
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export function readGatewayCredentials(): GatewayCredentials {
  const token = process.env.NEON_AI_GATEWAY_TOKEN?.trim() ?? "";
  const baseUrl = process.env.NEON_AI_GATEWAY_BASE_URL?.trim() ?? "";
  if (token.length === 0 || baseUrl.length === 0) {
    throw new NeoError("neo: NEON_AI_GATEWAY_TOKEN and NEON_AI_GATEWAY_BASE_URL are required");
  }
  return { token, baseUrl: baseUrl.replace(/\/+$/, "") };
}
