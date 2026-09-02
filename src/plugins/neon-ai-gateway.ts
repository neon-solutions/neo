import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createNeon } from "@neon/ai-sdk-provider";
import { NeoError } from "../lib/errors";
import type { Gateway, ModelInfo } from "../lib/gateway";

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

function parseModel(value: unknown): ModelInfo {
  if (!isRecord(value)) {
    throw new NeoError("neo: gateway /v1/models returned a non-object entry");
  }
  const id = value.id;
  const name = value.name;
  if (typeof id !== "string" || id.length === 0) {
    throw new NeoError("neo: gateway /v1/models entry is missing id");
  }
  if (typeof name !== "string" || name.length === 0) {
    throw new NeoError(`neo: gateway /v1/models entry ${id} is missing name`);
  }
  return { id, name };
}

function parseModelsResponse(value: unknown): ModelInfo[] {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw new NeoError("neo: gateway /v1/models did not return a list");
  }
  const data = value.data;
  const models: ModelInfo[] = [];
  for (const entry of data) {
    models.push(parseModel(entry));
  }
  return models;
}

export function resolveModelId(query: string, models: ModelInfo[]): string {
  const exact = models.find((model) => model.id === query);
  if (exact) {
    return exact.id;
  }

  const claudeAlias = `claude-${query}-5`;
  const claudeMatch = models.find((model) => model.id === claudeAlias);
  if (claudeMatch) {
    return claudeMatch.id;
  }

  const suffix = `-${query}`;
  const suffixMatches = models.filter((model) => model.id.endsWith(suffix));
  const [suffixMatch, ...rest] = suffixMatches;
  if (suffixMatch !== undefined && rest.length === 0) {
    return suffixMatch.id;
  }
  if (suffixMatches.length > 1) {
    const ids = suffixMatches.map((model) => model.id).join(", ");
    throw new NeoError(`neo: model "${query}" matches ${ids}`);
  }

  throw new NeoError(`neo: unknown model "${query}"`);
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

export function loadNeonProviderConfig(): NeonProviderConfig {
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
      throw new NeoError(`neo: missing ${path}`);
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

export function createNeonGateway(): Gateway {
  const config = loadNeonProviderConfig();
  const neon = createNeon({
    baseURL: config.baseURL,
    apiKey: config.apiKey,
  });

  return {
    async listModels(): Promise<ModelInfo[]> {
      const response = await fetch(`${config.baseURL}/v1/models`, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
      });
      const text = await response.text();
      if (!response.ok) {
        throw new NeoError(`neo: gateway /v1/models failed (${response.status})`);
      }
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : "invalid JSON";
        throw new NeoError(`neo: gateway /v1/models returned non-JSON (${detail})`);
      }
      return parseModelsResponse(body);
    },
    languageModel(modelId: string) {
      return neon(modelId);
    },
  };
}
