import {
  dbGetSetting,
  getSession,
  resolveSession,
  updateProviderSession,
  updateRuntimeProviderState,
  type ContextRecord,
} from "../router/index.js";
import {
  findInstalledSkill,
  findSkillByName,
  listCatalogSkills,
  slugifySkillName,
  type RaviSkill,
} from "../skills/manager.js";
import type { SkillGateMetadata } from "../cli/decorators.js";
import { nats } from "../nats.js";
import type { SessionEntry } from "../router/types.js";
import { markLoadedFromSkillGate, readSkillVisibilityFromParams } from "./skill-visibility.js";
import type { RuntimeSkillVisibilitySnapshot } from "./types.js";

const SKILL_GATE_SETTING_KEY = "runtime.skillGates";

export interface ConfiguredSkillGateRule {
  tool?: string;
  command?: string;
  commandPrefix?: string;
  commandRegex?: string;
  skill: string;
}

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
  toolName: string;
}

let cachedConfiguredRulesRaw: string | null | undefined;
let cachedConfiguredRules: ConfiguredSkillGateRule[] = [];

export function configuredSkillGateForTool(toolName: string): SkillGateMetadata | undefined {
  const rule = readConfiguredSkillGateRules().find((candidate) => candidate.tool === toolName);
  return rule ? configuredRuleToGate(rule) : undefined;
}

export function configuredSkillGateForCommand(
  commandLine: string,
  options?: { executables?: readonly string[] },
): SkillGateMetadata | undefined {
  const normalizedCommand = normalizeShell(commandLine);
  for (const rule of readConfiguredSkillGateRules()) {
    if (!rule.skill.trim()) continue;

    if (rule.command && normalizeShell(rule.command) === normalizedCommand) {
      if (!configuredMatcherExecutableAllowed(rule.command, options?.executables)) continue;
      return configuredRuleToGate(rule);
    }
    if (rule.commandPrefix && commandStartsWith(normalizedCommand, normalizeShell(rule.commandPrefix))) {
      if (!configuredMatcherExecutableAllowed(rule.commandPrefix, options?.executables)) continue;
      return configuredRuleToGate(rule);
    }
    if (rule.commandRegex) {
      try {
        if (new RegExp(rule.commandRegex).test(commandLine)) {
          return configuredRuleToGate(rule);
        }
      } catch {}
    }
  }
  return undefined;
}

export function evaluateSkillGate(input: EvaluateSkillGateInput): SkillGateDecision {
  if (!input.gate) {
    return { allowed: true };
  }

  const session = resolveContextSession(input.context);
  if (!session) {
    if (input.context) {
      return {
        allowed: false,
        code: "RAVI_SKILL_GATE_CONFIG_ERROR",
        skill: input.gate.skill,
        reason: `RAVI_SKILL_GATE_CONFIG_ERROR: ${input.toolName} requires skill ${input.gate.skill}, but no runtime session is bound to this context.`,
      };
    }
    return { allowed: true };
  }

  const snapshot = readSkillVisibilityFromParams(session.runtimeSessionParams);
  if (snapshot.loadedSkills.some((loadedSkill) => loadedSkillMatchesGate(loadedSkill, input.gate!.skill))) {
    return { allowed: true };
  }

  const skill = resolveSkillForGate(input.gate.skill);
  if (!skill) {
    const reason = `RAVI_SKILL_GATE_CONFIG_ERROR: ${input.toolName} requires skill ${input.gate.skill}, but no installed or catalog skill provides it.`;
    emitSkillGateEvent(session, {
      type: "skill.gate.error",
      toolName: input.toolName,
      gate: input.gate,
      code: "RAVI_SKILL_GATE_CONFIG_ERROR",
      reason,
    });
    return {
      allowed: false,
      code: "RAVI_SKILL_GATE_CONFIG_ERROR",
      skill: input.gate.skill,
      reason,
    };
  }

  const nextSkillVisibility = markLoadedFromSkillGate(snapshot, {
    provider: session.runtimeProvider ?? "unknown",
    skill: input.gate.skill,
    source: skill.source,
    path: skill.skillFilePath,
    toolName: input.toolName,
  });
  const reason = buildSoftGateMessage(input.toolName, input.gate.skill, skill);
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

function readConfiguredSkillGateRules(): ConfiguredSkillGateRule[] {
  const raw = dbGetSetting(SKILL_GATE_SETTING_KEY);
  if (raw === cachedConfiguredRulesRaw) {
    return cachedConfiguredRules;
  }

  cachedConfiguredRulesRaw = raw;
  cachedConfiguredRules = parseConfiguredSkillGateRules(raw);
  return cachedConfiguredRules;
}

function parseConfiguredSkillGateRules(raw: string | null): ConfiguredSkillGateRule[] {
  if (!raw?.trim()) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { rules?: unknown }).rules)
      ? (parsed as { rules: unknown[] }).rules
      : [];

  return list.filter(isConfiguredSkillGateRule);
}

function isConfiguredSkillGateRule(value: unknown): value is ConfiguredSkillGateRule {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const rule = value as Record<string, unknown>;
  const hasMatcher =
    typeof rule.tool === "string" ||
    typeof rule.command === "string" ||
    typeof rule.commandPrefix === "string" ||
    typeof rule.commandRegex === "string";
  return hasMatcher && typeof rule.skill === "string";
}

function configuredRuleToGate(rule: ConfiguredSkillGateRule): SkillGateMetadata {
  return {
    skill: rule.skill.trim(),
    source: "config",
  };
}

function configuredMatcherExecutableAllowed(matcher: string, executables: readonly string[] | undefined): boolean {
  if (!executables) {
    return true;
  }
  const firstToken = normalizeShell(matcher).split(" ")[0];
  if (!firstToken) {
    return true;
  }
  const executable = firstToken.split("/").filter(Boolean).at(-1) ?? firstToken;
  return executables.includes(executable);
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

function resolveSkillForGate(skillName: string): RaviSkill | null {
  return findInstalledSkill(skillName) ?? findSkillByName(listCatalogSkills(), skillName);
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

function buildSoftGateMessage(toolName: string, skillName: string, skill: RaviSkill): string {
  return [
    `RAVI_SKILL_REQUIRED: ${toolName} requires skill ${skillName}.`,
    `The skill has been delivered and marked as loaded for this session. Read it, then retry the original tool call.`,
    "",
    skill.content,
  ].join("\n");
}

function normalizeShell(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function commandStartsWith(command: string, prefix: string): boolean {
  if (!prefix) return false;
  return command === prefix || command.startsWith(`${prefix} `) || command.includes(` ${prefix} `);
}

export function skillGateErrorPayload(decision: SkillGateDecision): Record<string, unknown> {
  return {
    code: decision.code ?? "RAVI_SKILL_REQUIRED",
    skill: decision.skill ?? null,
    message: decision.reason ?? "Skill gate denied the tool call.",
  };
}

export function loadedSkillMatchesGate(loadedSkill: string, gateSkill: string): boolean {
  return loadedSkill === gateSkill || slugifySkillName(loadedSkill) === slugifySkillName(gateSkill);
}
