import { ToolLoopAgent, stepCountIs } from "ai";
import type { Gateway } from "./gateway";
import { createTools } from "../plugins/tools";
import { resolveModelId } from "../plugins/neon-ai-gateway";

export type RunRequest = {
  model: string;
  cwd: string;
  prompt: string;
  gateway: Gateway;
};

function summarizeToolInput(input: unknown): string {
  if (typeof input === "string") {
    return input;
  }
  return JSON.stringify(input);
}

export async function run(request: RunRequest): Promise<string> {
  const models = await request.gateway.listModels();
  const modelId = resolveModelId(request.model, models);
  const tools = createTools(request.cwd);
  const agent = new ToolLoopAgent({
    model: request.gateway.languageModel(modelId),
    instructions: [
      "You are neo, a coding subagent.",
      `Working directory: ${request.cwd}.`,
      "Use tools to inspect the working directory.",
      "Do not load AGENTS.md or skill files unless the user names them.",
      "The final message is the answer.",
    ].join(" "),
    tools,
    stopWhen: stepCountIs(20),
  });

  const result = await agent.generate({
    prompt: request.prompt,
    onToolExecutionStart: ({ toolCall }) => {
      const target = summarizeToolInput(toolCall.input);
      process.stderr.write(`${toolCall.toolName} ${target}\n`);
    },
  });

  return result.text;
}

export async function listModels(gateway: Gateway): Promise<string> {
  const listed = await gateway.listModels();
  const models = listed.slice().sort((a, b) => a.id.localeCompare(b.id));
  const idWidth = models.reduce((width, model) => Math.max(width, model.id.length), 0);
  return models.map((model) => `${model.id.padEnd(idWidth)}  ${model.name}`).join("\n");
}
