import type { LanguageModel } from "ai";

export type ModelInfo = {
  id: string;
  name: string;
};

export type Gateway = {
  listModels: () => Promise<ModelInfo[]>;
  languageModel: (modelId: string) => LanguageModel;
};
