import { normalizeSkillGateInput, type SkillGateInput, type SkillGateMetadata } from "./decorators.js";

export interface ResolveCommandSkillGateInput {
  groupPath: string;
  command: string;
  method: string;
  groupSkillGate?: SkillGateInput;
  commandSkillGate?: SkillGateInput;
  methodSkillGate?: SkillGateMetadata | false;
}

interface RaviGroupSkillRule {
  pattern: RegExp;
  skill: string;
}

const DEFAULT_RAVI_GROUP_SKILL_RULES: RaviGroupSkillRule[] = [
  { pattern: /^agents(?:[._]|$)/, skill: "ravi-system-agents-manager" },
  { pattern: /^artifacts(?:[._]|$)/, skill: "ravi-system-artifacts" },
  { pattern: /^audio(?:[._]|$)/, skill: "ravi-system-audio" },
  { pattern: /^contacts(?:[._]|$)/, skill: "ravi-system-contacts-manager" },
  { pattern: /^context(?:[._]|$)/, skill: "ravi-dev-context-cli" },
  { pattern: /^cron(?:[._]|$)/, skill: "ravi-system-cron-manager" },
  { pattern: /^daemon(?:[._]|$)/, skill: "ravi-system-daemon-manager" },
  { pattern: /^eval(?:[._]|$)/, skill: "ravi-system-tasks-eval" },
  { pattern: /^events(?:[._]|$)/, skill: "ravi-system-events" },
  { pattern: /^heartbeat(?:[._]|$)/, skill: "ravi-system-heartbeat-manager" },
  { pattern: /^image(?:[._]|$)/, skill: "ravi-system-image" },
  { pattern: /^(?:routes|instances[._]routes)(?:[._]|$)/, skill: "ravi-system-routes-manager" },
  { pattern: /^instances(?:[._]|$)/, skill: "ravi-system-instances-manager" },
  { pattern: /^permissions(?:[._]|$)/, skill: "ravi-system-permissions-manager" },
  { pattern: /^projects(?:[._]|$)/, skill: "ravi-system-projects" },
  { pattern: /^prox[._]calls(?:[._]|$)/, skill: "ravi-system-prox-calls" },
  { pattern: /^sessions(?:[._]|$)/, skill: "ravi-system-sessions" },
  { pattern: /^settings(?:[._]|$)/, skill: "ravi-system-settings-manager" },
  { pattern: /^skills(?:[._]|$)/, skill: "ravi-system-skill-creator" },
  { pattern: /^specs(?:[._]|$)/, skill: "ravi-system-specs" },
  { pattern: /^stickers(?:[._]|$)/, skill: "ravi-system-stickers" },
  { pattern: /^tasks(?:[._]|$)/, skill: "ravi-system-tasks" },
  { pattern: /^triggers(?:[._]|$)/, skill: "ravi-system-trigger-manager" },
  { pattern: /^video(?:[._]|$)/, skill: "ravi-system-video" },
  { pattern: /^whatsapp(?:[._]|$)/, skill: "ravi-system-whatsapp-manager" },
];

const RAVI_GATE_EXEMPT_COMMANDS = new Set([
  "skills.list",
  "skills.show",
  "skills.sync",
  "tools.list",
  "tools.show",
  "tools.manifest",
  "tools.schema",
  "context.visibility",
  "sessions.visibility",
]);

export function resolveCommandSkillGate(input: ResolveCommandSkillGateInput): SkillGateMetadata | undefined {
  const fullName = `${input.groupPath}.${input.command}`;
  if (RAVI_GATE_EXEMPT_COMMANDS.has(fullName)) {
    return undefined;
  }

  if (input.methodSkillGate !== undefined) {
    return input.methodSkillGate === false ? undefined : input.methodSkillGate;
  }

  const commandGate = normalizeSkillGateInput(input.commandSkillGate, "command");
  if (commandGate !== undefined) {
    return commandGate === false ? undefined : commandGate;
  }

  const groupGate = normalizeSkillGateInput(input.groupSkillGate, "group");
  if (groupGate !== undefined) {
    return groupGate === false ? undefined : groupGate;
  }

  return inferRaviGroupSkillGate(input.groupPath);
}

export function resolveRuntimeToolSkillGate(input: {
  toolName: string;
  metadataSkillGate?: SkillGateMetadata;
}): SkillGateMetadata | undefined {
  if (isExemptRaviToolName(input.toolName)) {
    return undefined;
  }
  return input.metadataSkillGate ?? inferRaviToolSkillGate(input.toolName);
}

export function inferRaviToolSkillGate(toolName: string): SkillGateMetadata | undefined {
  if (isExemptRaviToolName(toolName)) {
    return undefined;
  }
  return inferRaviGroupSkillGate(toolName);
}

export function inferRaviCommandSkillGate(
  commandLine: string,
  options?: { executables?: readonly string[] },
): SkillGateMetadata | undefined {
  if (options?.executables && !options.executables.includes("ravi")) {
    return undefined;
  }

  const match = /(?:^|[\s;&|])(?:[^\s;&|'"]+\/)?ravi\s+([a-z][a-z0-9-]*)(?:\s+([a-z][a-z0-9-]*))?/i.exec(commandLine);
  if (!match) {
    return undefined;
  }

  const first = normalizeCliSegment(match[1]);
  const second = normalizeCliSegment(match[2]);
  if (second && RAVI_GATE_EXEMPT_COMMANDS.has(`${first}.${second}`)) {
    return undefined;
  }
  const candidates = second ? [`${first}.${second}`, first] : [first];
  for (const groupPath of candidates) {
    const inferred = inferRaviGroupSkillGate(groupPath);
    if (inferred) {
      return inferred;
    }
  }

  return undefined;
}

export function inferRaviGroupSkillGate(groupOrToolName: string): SkillGateMetadata | undefined {
  const normalized = normalizeGateTarget(groupOrToolName);
  const matched = DEFAULT_RAVI_GROUP_SKILL_RULES.find((rule) => rule.pattern.test(normalized));
  if (!matched) {
    return undefined;
  }

  return {
    skill: matched.skill,
    source: "inferred",
  };
}

function normalizeCliSegment(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function normalizeGateTarget(value: string): string {
  return value.trim().toLowerCase();
}

function isExemptRaviToolName(toolName: string): boolean {
  const normalized = normalizeGateTarget(toolName);
  for (const fullName of RAVI_GATE_EXEMPT_COMMANDS) {
    if (normalized === fullName.replace(/\./g, "_")) {
      return true;
    }
  }
  return false;
}
