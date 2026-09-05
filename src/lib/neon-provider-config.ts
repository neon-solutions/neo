import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { NeoError } from "./errors";

export type NeonProviderConfig = {
  apiKey: string;
  baseURL: string;
};

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function neonProviderConfigPath(): string {
  const home = process.env.HOME;
  if (typeof home !== "string" || home.length === 0) {
    throw new NeoError("neo: HOME is not set");
  }
  return join(home, ".config", "neo", "providers", "neon.json");
}

export function parseNeonProviderConfig(value: unknown, path: string): NeonProviderConfig {
  if (!isRecord(value)) {
    throw new NeoError(`neo: ${path} must be a JSON object`);
  }
  const apiKey = value.apiKey;
  const baseURL = value.baseURL;
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    throw new NeoError(`neo: ${path} is missing apiKey`);
  }
  if (typeof baseURL !== "string" || baseURL.trim().length === 0) {
    throw new NeoError(`neo: ${path} is missing baseURL`);
  }
  return { apiKey: apiKey.trim(), baseURL: baseURL.trim().replace(/\/+$/, "") };
}

export function readNeonProviderConfig(): NeonProviderConfig | undefined {
  const envKey = process.env.NEON_AI_GATEWAY_TOKEN?.trim() ?? "";
  const envUrl = process.env.NEON_AI_GATEWAY_BASE_URL?.trim() ?? "";
  if (envKey.length > 0 || envUrl.length > 0) {
    if (envKey.length === 0 || envUrl.length === 0) {
      throw new NeoError(
        "neo: NEON_AI_GATEWAY_TOKEN and NEON_AI_GATEWAY_BASE_URL must both be set",
      );
    }
    return { apiKey: envKey, baseURL: envUrl.replace(/\/+$/, "") };
  }

  const path = neonProviderConfigPath();
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : "invalid JSON";
    throw new NeoError(`neo: ${path} is not JSON (${detail})`);
  }
  return parseNeonProviderConfig(body, path);
}

export function loadNeonProviderConfig(): NeonProviderConfig {
  const config = readNeonProviderConfig();
  if (config === undefined) {
    throw new NeoError(`neo: missing ${neonProviderConfigPath()}`);
  }
  return config;
}

export function writeNeonProviderConfig(config: NeonProviderConfig): void {
  const path = neonProviderConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(path, 0o600);
}

export function missingProviderMessage(path: string): string {
  return `neo: missing ${path}. Run neo in a terminal to set up the Neon AI Gateway.`;
}
