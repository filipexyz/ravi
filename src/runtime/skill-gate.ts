import { readFileSync } from "node:fs";
import {
  dbListSkillGateRules,
  getSession,
  resolveSession,
  updateProviderSession,
  updateRuntimeProviderState,
  type ContextRecord,
} from "../router/index.js";
import { parseBashCommand } from "../bash/parser.js";
import {
  inferRaviCommandSkillGate,
  resolveRuntimeToolSkillGate,
  type SkillGateMetadata,
  type SkillGateRuleConfig,
} from "../cli/skill-gates.js";
import { nats } from "../nats.js";
import type { SessionEntry } from "../router/types.js";
import { resolveRuntimeContext } from "./context-registry.js";
import { resolveManagedSkillPolicyForContext } from "./skill-policy-runtime.js";
import type { SkillCatalogEntry } from "./skill-policy.js";
import { markLoadedFromSkillGate, readSkillVisibilityFromParams } from "./skill-visibility.js";
import type { RuntimeSkillVisibilitySnapshot } from "./types.js";

export type ConfiguredSkillGateRule = SkillGateRuleConfig;

export interface SkillGateDecision {
  allowed: boolean;
  reason?: string;
  code?: "RAVI_SKILL_REQUIRED" | "RAVI_SKILL_GATE_CONFIG_ERROR";
  skill?: string;
  skillVisibility?: RuntimeSkillVisibilitySnapshot;
}

export interface EvaluateSkillGateInput {
  gate?: SkillGateMetadata;
  context?: ContextRecord | null;
  localOperator?: boolean;
  toolName: string;
}

export interface EvaluateRuntimeToolSkillGateInput {
  toolName: string;
  context?: ContextRecord | null;
  localOperator?: boolean;
  onSkillGatePersisted?: (skillVisibility: RuntimeSkillVisibilitySnapshot) => void;
}

export interface EvaluateRuntimeCommandSkillGateInput {
  commandLine: string;
  context?: ContextRecord | null;
  localOperator?: boolean;
  toolName?: string;
  executables?: readonly string[];
  onSkillGatePersisted?: (skillVisibility: RuntimeSkillVisibilitySnapshot) => void;
}

export function runtimeSkillGateForTool(toolName: string): SkillGateMetadata | undefined {
  return resolveRuntimeToolSkillGate({ toolName }, { rules: readConfiguredSkillGateRules() });
}

export function runtimeSkillGateForCommand(
  commandLine: string,
  options?: { executables?: readonly string[] },
): SkillGateMetadata | undefined {
  const executables = options?.executables ?? parseBashCommand(commandLine).executables;
  return inferRaviCommandSkillGate(commandLine, { executables, rules: readConfiguredSkillGateRules() });
}

export function evaluateRuntimeToolSkillGate(input: EvaluateRuntimeToolSkillGateInput): SkillGateDecision {
  return evaluateResolvedRuntimeSkillGate({
    gate: runtimeSkillGateForTool(input.toolName),
    context: input.context,
    localOperator: input.localOperator,
    toolName: input.toolName,
    onSkillGatePersisted: input.onSkillGatePersisted,
  });
}

export function evaluateRuntimeCommandSkillGate(input: EvaluateRuntimeCommandSkillGateInput): SkillGateDecision {
  return evaluateResolvedRuntimeSkillGate({
    gate: runtimeSkillGateForCommand(input.commandLine, { executables: input.executables }),
    context: input.context,
    localOperator: input.localOperator,
    toolName: input.toolName ?? "Bash",
    onSkillGatePersisted: input.onSkillGatePersisted,
  });
}

function evaluateResolvedRuntimeSkillGate(
  input: EvaluateSkillGateInput & {
    onSkillGatePersisted?: (skillVisibility: RuntimeSkillVisibilitySnapshot) => void;
  },
): SkillGateDecision {
  const decision = evaluateSkillGate(input);
  if (decision.skillVisibility) {
    input.onSkillGatePersisted?.(decision.skillVisibility);
  }
  return decision;
}

export function evaluateSkillGate(input: EvaluateSkillGateInput): SkillGateDecision {
  if (!input.gate) {
    return { allowed: true };
  }

  if (!input.context && input.localOperator === true) return { allowed: true };

  const context = input.context
    ? resolveRuntimeContext(input.context.contextKey, { touch: false, readOnly: true })
    : null;
  if (!context || context.contextId !== input.context?.contextId || context.agentId !== input.context.agentId) {
    return configurationError(input, "no live managed context is bound to this call.");
  }
  const session = resolveContextSession(context);
  if (!session || session.agentId !== context.agentId) {
    return configurationError(input, "no matching runtime session is bound to this context.");
  }

  let skill: SkillCatalogEntry | undefined;
  const gateSkill = input.gate.skill;
  try {
    const policy = resolveManagedSkillPolicyForContext(context);
    skill = policy.skills.find((entry) => skillMatchesIdentity(entry, gateSkill));
  } catch {
    return configurationError(input, "the current skill policy could not be resolved.", session);
  }
  if (!skill) return configurationError(input, "the skill is not visible in the current skill policy.", session);

  // Delivery evidence never substitutes for current authority, including after revocation.
  const snapshot = readSkillVisibilityFromParams(session.runtimeSessionParams);
  const selectedSkill = skill;
  if (snapshot.loadedSkills.some((loaded) => skillMatchesIdentity(selectedSkill, loaded))) return { allowed: true };

  let content: string;
  try {
    content = readSelectedSkillContent(skill);
  } catch {
    return configurationError(input, "the selected skill resource could not be read.", session);
  }

  const nextSkillVisibility = markLoadedFromSkillGate(snapshot, {
    provider: session.runtimeProvider ?? "unknown",
    skill: skill.id,
    source: "skill-policy",
    path: skill.resource.path,
    toolName: input.toolName,
  });
  const reason = buildSoftGateMessage(input.toolName, input.gate.skill, content);
  persistSkillGateVisibility(
    session,
    nextSkillVisibility,
    input.toolName,
    input.gate,
    `RAVI_SKILL_REQUIRED: ${input.toolName} requires skill ${input.gate.skill}; skill delivered and marked as loaded.`,
  );

  return {
    allowed: false,
    code: "RAVI_SKILL_REQUIRED",
    skill: input.gate.skill,
    reason,
    skillVisibility: nextSkillVisibility,
  };
}

function readConfiguredSkillGateRules(): SkillGateRuleConfig[] {
  return dbListSkillGateRules().map((rule) => ({
    id: rule.id,
    skill: rule.skill ?? null,
    disabled: rule.disabled,
    pattern: rule.pattern,
    groupRegex: rule.groupRegex,
    tool: rule.tool,
    toolPrefix: rule.toolPrefix,
    toolRegex: rule.toolRegex,
    command: rule.command,
    commandPrefix: rule.commandPrefix,
    commandRegex: rule.commandRegex,
  }));
}

function resolveContextSession(context: ContextRecord | null | undefined): SessionEntry | null {
  if (!context) {
    return null;
  }
  return (
    (context.sessionKey ? getSession(context.sessionKey) : null) ??
    (context.sessionName ? resolveSession(context.sessionName) : null)
  );
}

function configurationError(input: EvaluateSkillGateInput, detail: string, session?: SessionEntry): SkillGateDecision {
  const reason = `RAVI_SKILL_GATE_CONFIG_ERROR: ${input.toolName} requires skill ${input.gate?.skill}, but ${detail}`;
  if (session && input.gate) {
    emitSkillGateEvent(session, {
      type: "skill.gate.error",
      toolName: input.toolName,
      gate: input.gate,
      code: "RAVI_SKILL_GATE_CONFIG_ERROR",
      reason,
    });
  }
  return { allowed: false, code: "RAVI_SKILL_GATE_CONFIG_ERROR", skill: input.gate?.skill, reason };
}

function skillMatchesIdentity(skill: SkillCatalogEntry, value: string): boolean {
  const identity = value.trim().toLowerCase();
  return [skill.id, ...skill.aliases].some((name) => name.trim().toLowerCase() === identity);
}

function readSelectedSkillContent(skill: SkillCatalogEntry): string {
  if (skill.resource.files) {
    const file = skill.resource.files.find((entry) => entry.path === "SKILL.md");
    if (!file) throw new Error("Selected skill resource has no SKILL.md.");
    return file.content;
  }
  return readFileSync(skill.resource.path, "utf8");
}

function persistSkillGateVisibility(
  session: SessionEntry,
  skillVisibility: RuntimeSkillVisibilitySnapshot,
  toolName: string,
  gate: SkillGateMetadata,
  reason: string,
): void {
  const runtimeSessionParams: Record<string, unknown> = {
    ...(session.runtimeSessionParams ?? {}),
    skillVisibility,
  };
  const persistedSessionId =
    session.runtimeSessionDisplayId ??
    session.providerSessionId ??
    session.sdkSessionId ??
    (typeof runtimeSessionParams.sessionId === "string" ? runtimeSessionParams.sessionId : undefined);

  if (persistedSessionId) {
    updateProviderSession(session.sessionKey, session.runtimeProvider, persistedSessionId, {
      runtimeSessionParams,
      runtimeSessionDisplayId: session.runtimeSessionDisplayId ?? persistedSessionId,
    });
  } else {
    updateRuntimeProviderState(session.sessionKey, session.runtimeProvider, { runtimeSessionParams });
  }

  emitSkillGateEvent(session, {
    type: "skill.gate.loaded",
    toolName,
    gate,
    code: "RAVI_SKILL_REQUIRED",
    reason,
    skillVisibility,
  });
}

function emitSkillGateEvent(
  session: SessionEntry,
  event: {
    type: "skill.gate.loaded" | "skill.gate.error";
    toolName: string;
    gate: SkillGateMetadata;
    code: SkillGateDecision["code"];
    reason: string;
    skillVisibility?: RuntimeSkillVisibilitySnapshot;
  },
): void {
  if (!session.name) {
    return;
  }

  nats
    .emit(`ravi.session.${session.name}.runtime`, {
      type: event.type,
      toolName: event.toolName,
      skill: event.gate.skill,
      source: event.gate.source,
      code: event.code,
      reason: event.reason,
      sessionKey: session.sessionKey,
      sessionName: session.name,
      agentId: session.agentId,
      ...(event.skillVisibility ? { skillVisibility: event.skillVisibility } : {}),
    })
    .catch(() => {});
}

function buildSoftGateMessage(toolName: string, skillName: string, content: string): string {
  return [
    `RAVI_SKILL_REQUIRED: ${toolName} requires skill ${skillName}.`,
    `The skill has been delivered and marked as loaded for this session. Read it, then retry the original tool call.`,
    "",
    content,
  ].join("\n");
}

export function skillGateErrorPayload(decision: SkillGateDecision): Record<string, unknown> {
  return {
    code: decision.code ?? "RAVI_SKILL_REQUIRED",
    skill: decision.skill ?? null,
    message: decision.reason ?? "Skill gate denied the tool call.",
  };
}
