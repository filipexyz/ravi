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
import { buildRaviRulesPromptSection } from "./ravi-rules.js";
import { buildRuntimeOperationalContextContent } from "./runtime-operational-context.js";
import type { ContextCapability, ContextRecord } from "../router/router-db.js";
import { buildSessionGoalPromptSection } from "./session-goals.js";
import { listGroupSkillRules } from "../cli/skill-gates.js";
import {
  canRunSkillsShow,
  capabilityMatchesGroupRule,
  isAdminAll,
  selectGroupCaps,
} from "./skill-capability-implication.js";
import { skillNameMatchesAllowlist } from "./skill-visibility.js";

export interface RuntimeSystemPromptInput {
  agent: AgentConfig;
  ctx?: ChannelContext;
  sessionName?: string;
  sessionKey?: string;
  cwd: string;
  extraSections?: PromptSection[];
  sessionRuntimeParams?: Record<string, unknown>;
  runtimeContext?: Pick<
    ContextRecord,
    "contextId" | "kind" | "agentId" | "sessionKey" | "sessionName" | "source" | "capabilities"
  >;
  /** Skills the runtime exposes to the agent; undefined means unfiltered (every skill visible). */
  allowedSkills?: readonly string[];
}

export interface RuntimeSystemPrompt {
  text: string;
  sections: PromptContextSection[];
}

export async function buildRuntimeSystemPrompt(input: RuntimeSystemPromptInput): Promise<RuntimeSystemPrompt> {
  const sections = [
    ...buildSystemPromptSections(input.agent.id, input.ctx, undefined, input.sessionName, {
      agentMode: input.agent.mode,
      buildingSolutions: shouldMountBuildingSolutions(input),
    }),
    buildRuntimeOperationalContextSection(input),
    ...buildSessionGoalPromptSections(input),
    ...buildStickerPromptSectionsForRuntime(input.agent, input.ctx, input.sessionRuntimeParams),
    ...(await buildWorkspacePromptSections(input.cwd)),
    ...(await buildRaviRulesPromptSections(input.cwd)),
    ...buildAgentPromptSections(input.agent),
    ...buildExtraPromptSections(input.extraSections),
  ];

  return {
    text: renderPromptSections(sections),
    sections,
  };
}

const BUILDING_SOLUTIONS_SKILL = "ravi-system-solucoes";
const BUILDING_SOLUTIONS_GROUP_RULE_IDS: ReadonlySet<string> = new Set(["bases", "pages", "triggers", "cron"]);

/**
 * "Building Solutions" sends the agent to `ravi skills show solucoes` and the
 * bases, pages, triggers and cron groups: mount it only for a non-sentinel
 * agent that can see that skill, run `ravi skills show`, and run at least one
 * of those groups.
 */
function shouldMountBuildingSolutions(input: RuntimeSystemPromptInput): boolean {
  if (input.agent.mode === "sentinel") return false;
  if (input.allowedSkills && !skillNameMatchesAllowlist(BUILDING_SOLUTIONS_SKILL, input.allowedSkills)) {
    return false;
  }
  // CLI calls inside the runtime are authorized against this context's
  // snapshot alone, so no capabilities means none of these commands can run.
  const capabilities = input.runtimeContext?.capabilities ?? [];
  return canRunSkillsShow(capabilities) && canRunBuildingSolutionsGroup(capabilities);
}

function canRunBuildingSolutionsGroup(capabilities: readonly ContextCapability[]): boolean {
  if (isAdminAll(capabilities) || selectGroupCaps(capabilities).some((cap) => cap.objectId === "*")) {
    return true;
  }
  return listGroupSkillRules()
    .filter((rule) => BUILDING_SOLUTIONS_GROUP_RULE_IDS.has(rule.id))
    .some((rule) => capabilities.some((capability) => capabilityMatchesGroupRule(capability, rule.pattern)));
}

function buildRuntimeOperationalContextSection(input: RuntimeSystemPromptInput): PromptContextSection {
  return {
    id: "runtime.operational_context",
    title: "Ravi Operational Context",
    priority: 24,
    source: "runtime",
    content: buildRuntimeOperationalContextContent({
      agentId: input.agent.id,
      sessionName: input.sessionName,
      cwd: input.cwd,
      ctx: input.ctx,
      runtimeContext: input.runtimeContext,
    }),
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

async function buildRaviRulesPromptSections(cwd: string): Promise<PromptContextSection[]> {
  const section = await buildRaviRulesPromptSection(cwd);
  return section ? [section] : [];
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

function buildSessionGoalPromptSections(input: RuntimeSystemPromptInput): PromptContextSection[] {
  const sessionKey = input.sessionKey ?? input.runtimeContext?.sessionKey;
  if (!sessionKey) return [];
  const content = buildSessionGoalPromptSection(sessionKey);
  if (!content) return [];
  return [
    {
      id: "session.goal",
      title: "Session Goal",
      priority: 23,
      source: "session-goals",
      content,
    },
  ];
}
