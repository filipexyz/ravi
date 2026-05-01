import { normalizeSkillGateInput, type SkillGateInput, type SkillGateMetadata } from "./decorators.js";

export interface ResolveCommandSkillGateInput {
  groupPath: string;
  command: string;
  method: string;
  groupSkillGate?: SkillGateInput;
  commandSkillGate?: SkillGateInput;
  methodSkillGate?: SkillGateMetadata | false;
}

const DEFAULT_RAVI_GROUP_SKILLS: Record<string, string> = {
  agents: "ravi-system-agents-manager",
  artifacts: "ravi-system-artifacts",
  audio: "ravi-system-audio",
  contacts: "ravi-system-contacts-manager",
  context: "ravi-dev-context-cli",
  "context.credentials": "ravi-dev-context-cli",
  cron: "ravi-system-cron-manager",
  daemon: "ravi-system-daemon-manager",
  eval: "ravi-system-tasks-eval",
  events: "ravi-system-events",
  heartbeat: "ravi-system-heartbeat-manager",
  image: "ravi-system-image",
  "image.atlas": "ravi-system-image",
  instances: "ravi-system-instances-manager",
  "instances.pending": "ravi-system-instances-manager",
  "instances.routes": "ravi-system-routes-manager",
  permissions: "ravi-system-permissions-manager",
  projects: "ravi-system-projects",
  "projects.resources": "ravi-system-projects",
  "projects.tasks": "ravi-system-projects",
  "projects.workflows": "ravi-system-projects",
  "prox.calls": "ravi-system-prox-calls",
  "prox.calls.profiles": "ravi-system-prox-calls",
  "prox.calls.rules": "ravi-system-prox-calls",
  "prox.calls.tools": "ravi-system-prox-calls",
  "prox.calls.voice-agents": "ravi-system-prox-calls",
  routes: "ravi-system-routes-manager",
  sessions: "ravi-system-sessions",
  "sessions.runtime": "ravi-system-sessions",
  settings: "ravi-system-settings-manager",
  skills: "ravi-system-skill-creator",
  specs: "ravi-system-specs",
  stickers: "ravi-system-stickers",
  tasks: "ravi-system-tasks",
  "tasks.automations": "ravi-system-tasks",
  "tasks.deps": "ravi-system-tasks",
  "tasks.profiles": "ravi-system-tasks",
  triggers: "ravi-system-trigger-manager",
  video: "ravi-system-video",
  "whatsapp.dm": "ravi-system-whatsapp-manager",
  "whatsapp.group": "ravi-system-whatsapp-manager",
};

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

  const inferred = DEFAULT_RAVI_GROUP_SKILLS[input.groupPath];
  if (!inferred) {
    return undefined;
  }

  return {
    skill: inferred,
    source: "inferred",
  };
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
    const inferred = DEFAULT_RAVI_GROUP_SKILLS[groupPath];
    if (inferred) {
      return {
        skill: inferred,
        source: "inferred",
      };
    }
  }

  return undefined;
}

function normalizeCliSegment(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}
