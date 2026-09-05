import { ToolLoopAgent, stepCountIs } from "ai";
import { loadAgentsMd } from "./agents-md";
import type { Gateway } from "./gateway";
import { createNeonGateway, resolveModelId } from "../plugins/neon-ai-gateway";
import {
  SKILL_TOOL_INSTRUCTION,
  createSkillTools,
  discoverSkillsForFilter,
  formatSkillsCatalog,
} from "../plugins/skills";
import type { SkillsFilter } from "../plugins/skills";
import { createTools } from "../plugins/tools";

export type RunRequest = {
  model: string;
  cwd: string;
  prompt: string;
  gateway?: Gateway;
  readonly: boolean;
  agentsMd: boolean;
  skills: SkillsFilter;
  subPrompt?: string;
};

export type InstructionArgs = {
  cwd: string;
  readonly: boolean;
  agentsMd?: string;
  skillsCatalog?: string;
  subPrompt?: string;
};

export function buildInstructions(args: InstructionArgs): string {
  const parts = [
    "You are neo, a coding subagent.",
    `Working directory: ${args.cwd}.`,
    args.readonly
      ? "Use tools to inspect the working directory."
      : "Use tools to inspect and change the working directory.",
  ];

  if (args.agentsMd !== undefined) {
    parts.push(args.agentsMd);
  }
  if (args.skillsCatalog !== undefined) {
    if (args.skillsCatalog.length > 0) {
      parts.push(args.skillsCatalog);
    }
    parts.push(SKILL_TOOL_INSTRUCTION);
  }

  if (args.agentsMd === undefined && args.skillsCatalog === undefined) {
    parts.push("Do not load AGENTS.md or skill files unless the user names them.");
  } else if (args.agentsMd === undefined) {
    parts.push("Do not load AGENTS.md unless the user names them.");
  } else if (args.skillsCatalog === undefined) {
    parts.push("Do not load skill files unless the user names them.");
  }

  if (args.subPrompt !== undefined) {
    parts.push(args.subPrompt);
  }

  parts.push("The final message is the answer.");
  return parts.join("\n\n");
}

function summarizeToolInput(input: unknown): string {
  if (typeof input === "string") {
    return input;
  }
  return JSON.stringify(input);
}

export async function run(request: RunRequest): Promise<string> {
  const agentsMd = request.agentsMd ? await loadAgentsMd(request.cwd) : undefined;
  const discovered = await discoverSkillsForFilter({ cwd: request.cwd, filter: request.skills });
  const inspectTools = createTools(request.cwd, { readonly: request.readonly });
  const tools =
    discovered === undefined ? inspectTools : { ...inspectTools, ...createSkillTools(discovered) };

  const gateway = request.gateway ?? (await createNeonGateway());
  const models = await gateway.listModels();
  const modelId = resolveModelId(request.model, models);
  const agent = new ToolLoopAgent({
    model: gateway.languageModel(modelId),
    instructions: buildInstructions({
      cwd: request.cwd,
      readonly: request.readonly,
      agentsMd,
      skillsCatalog: discovered === undefined ? undefined : formatSkillsCatalog(discovered),
      subPrompt: request.subPrompt,
    }),
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
