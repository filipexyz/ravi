import {
  buildSystemPromptSections,
  renderPromptSections,
  type PromptContextSection,
  type PromptSection,
} from "../prompt-builder.js";
import type { AgentConfig } from "../router/types.js";
import type { ChannelContext } from "./message-types.js";
import { loadAgentWorkspaceInstructions } from "./agent-instructions.js";
import { buildStickerPromptSection } from "../stickers/prompt.js";

export interface RuntimeSystemPromptInput {
  agent: AgentConfig;
  ctx?: ChannelContext;
  sessionName?: string;
  cwd: string;
  extraSections?: PromptSection[];
  sessionRuntimeParams?: Record<string, unknown>;
}

export interface RuntimeSystemPrompt {
  text: string;
  sections: PromptContextSection[];
}

export async function buildRuntimeSystemPrompt(input: RuntimeSystemPromptInput): Promise<RuntimeSystemPrompt> {
  const sections = [
    ...buildSystemPromptSections(input.agent.id, input.ctx, undefined, input.sessionName, {
      agentMode: input.agent.mode,
    }),
    ...buildStickerPromptSectionsForRuntime(input.agent, input.ctx, input.sessionRuntimeParams),
    ...(await buildWorkspacePromptSections(input.cwd)),
    ...buildAgentPromptSections(input.agent),
    ...buildExtraPromptSections(input.extraSections),
  ];

  return {
    text: renderPromptSections(sections),
    sections,
  };
}

function buildStickerPromptSectionsForRuntime(
  agent: AgentConfig,
  ctx: ChannelContext | undefined,
  sessionRuntimeParams: Record<string, unknown> | undefined,
): PromptContextSection[] {
  const section = buildStickerPromptSection(agent, ctx, {
    sessionRuntimeParams,
  });
  return section ? [section] : [];
}

async function buildWorkspacePromptSections(cwd: string): Promise<PromptContextSection[]> {
  const workspaceInstructions = await loadAgentWorkspaceInstructions(cwd);
  if (!workspaceInstructions) {
    return [];
  }

  return [
    {
      id: "workspace.instructions",
      title: "Workspace Instructions",
      priority: 25,
      source: workspaceInstructions.path,
      content: [
        `Workspace instructions loaded from ${workspaceInstructions.path}. Treat them as authoritative for this workspace.`,
        `Resolve relative file references from ${cwd}/.`,
        "",
        workspaceInstructions.content,
      ].join("\n"),
    },
  ];
}

function buildAgentPromptSections(agent: AgentConfig): PromptContextSection[] {
  const content = agent.systemPromptAppend?.trim();
  if (!content) {
    return [];
  }

  return [
    {
      id: "agent.system_prompt_append",
      title: "Agent Instructions",
      priority: 35,
      source: `agent:${agent.id}:systemPromptAppend`,
      content,
    },
  ];
}

function buildExtraPromptSections(extraSections: PromptSection[] | undefined): PromptContextSection[] {
  if (!extraSections || extraSections.length === 0) {
    return [];
  }

  return extraSections.map((section, index) => ({
    id: `extra.${section.title.toLowerCase().replace(/[^a-z0-9]+/g, ".")}`,
    title: section.title,
    content: section.content,
    priority: 100 + index,
    source: "extra",
  }));
}
