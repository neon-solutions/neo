import { createNeon } from "@neon/ai-sdk-provider";
import type { Prompter } from "../lib/ask";
import type { NeonExec } from "../lib/neon-cli";
import { NeoError } from "../lib/errors";
import type { Gateway, ModelInfo } from "../lib/gateway";
import {
  loadNeonProviderConfig,
  missingProviderMessage,
  neonProviderConfigPath,
  parseNeonProviderConfig,
  readNeonProviderConfig,
  writeNeonProviderConfig,
  type NeonProviderConfig,
} from "../lib/neon-provider-config";
import { setupNeonGateway } from "./neon-setup";

export {
  loadNeonProviderConfig,
  missingProviderMessage,
  neonProviderConfigPath,
  parseNeonProviderConfig,
  readNeonProviderConfig,
  writeNeonProviderConfig,
};
export type { NeonProviderConfig };

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

export type EnsureNeonProviderConfigOptions = {
  interactive?: boolean;
  exec?: NeonExec;
  prompter?: Prompter;
};

export async function ensureNeonProviderConfig(
  options: EnsureNeonProviderConfigOptions = {},
): Promise<NeonProviderConfig> {
  const existing = readNeonProviderConfig();
  if (existing !== undefined) {
    return existing;
  }
  const interactive = options.interactive ?? process.stdin.isTTY === true;
  if (!interactive) {
    throw new NeoError(missingProviderMessage(neonProviderConfigPath()));
  }
  return await setupNeonGateway({
    exec: options.exec,
    prompter: options.prompter,
  });
}

export async function createNeonGateway(): Promise<Gateway> {
  const config = await ensureNeonProviderConfig();
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
