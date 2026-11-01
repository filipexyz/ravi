// The Knowledge exposure gate (contract §11.3). Knowledge reads what the org
// said and published, so no agent that people outside the org can reach may
// be able to read local files or run code: such an agent could be talked into
// leaking what an operator turn left behind. An agent is an offender when it
// is reachable by outsiders and its profile is not on the allowlist.

import { readCachedActorBinding } from "../../cloud-auth/actor-bindings.js";
import { readCloudCredentials } from "../../cloud-auth/storage.js";
import { getContact } from "../../contacts.js";
import { getAgentRuntimePermissionsConfigFromDefaults } from "../../permissions/agent-default-capabilities-provider.js";
import type { InstanceConfig } from "../../router/router-db.js";
import { dbGetAgent, dbListAgents, dbListInstances, dbListRoutes, getDefaultAgentId } from "../../router/router-db.js";
import type { AgentConfig, RouteConfig } from "../../router/types.js";
import { dbListTriggers } from "../../triggers/triggers-db.js";
import { OWNER_CONTACT_TAG } from "../owner.js";

export type KnowledgeExposureOffender = { agentId: string; profile: string; reasons: string[] };
export type KnowledgeExposureReport = { ok: boolean; offenders: KnowledgeExposureOffender[]; checkedAgents: number };

export type KnowledgeExposureTrigger = { id: string; agentId?: string; topic: string; enabled: boolean };

export interface KnowledgeExposureDeps {
  listAgents?: () => AgentConfig[];
  listInstances?: () => InstanceConfig[];
  listRoutes?: () => RouteConfig[];
  /** Triggers as `{agentId, topic, enabled}`; a missing agentId means the default agent. */
  listTriggers?: () => KnowledgeExposureTrigger[];
  defaultAgentId?: () => string;
  isLinkedContact?: (contactId: string) => boolean;
  /** The contact a DM route pattern names, with its tags; null when unknown. */
  contactForPattern?: (pattern: string) => { id: string; tags: string[] } | null;
}

/**
 * Explicit capabilities an outsider-reachable `explicit-only` agent may hold.
 * An allowlist: anything else may read or send local files.
 */
const SAFE_EXPLICIT_CAPABILITIES = new Set([
  "use:tool:Bash",
  "execute:executable:ravi",
  "execute:executable:date",
  "execute:executable:pwd",
  "execute:group:knowledge",
  "read:knowledge:*",
  "mutate:knowledge:remember",
  "execute:group:self",
  "execute:group:identity",
]);
const SAFE_KNOWLEDGE_READ = /^read:knowledge:[a-z][a-z-]*$/;

/** Capability prefixes that grant a tool, a process or a command group. */
const EXEC_CAPABILITY_PREFIXES = [
  "use:tool:",
  "use:toolgroup:",
  "execute:executable:",
  "execute:group:",
  "admin:system:",
];

/**
 * Trigger topics whose events only Ravi itself or the operator produce. Any
 * other topic (mail, inbound interactions, Console inbox, watches, webhooks,
 * contacts and chats pending, page comments, custom topics) can carry what an
 * outsider wrote, so a trigger on it makes its agent reachable by outsiders.
 * A wildcard topic counts as internal only inside one of these trees.
 */
const INTERNAL_TRIGGER_TOPICS: RegExp[] = [
  /^ravi\.session\./,
  /^ravi\.[^.]+\.cli\./,
  /^ravi\._cli\./,
  /^ravi\.approval\./,
  /^ravi\.audit\./,
  /^ravi\.task\./,
  /^ravi\.tts(?:\.|$)/,
  /^ravi\.artifacts\./,
  /^ravi\.tags\./,
  /^ravi\.inbox\.system\./,
];

export function triggerTopicCarriesOutsideContent(topic: string): boolean {
  const trimmed = topic.trim();
  return !INTERNAL_TRIGGER_TOPICS.some((pattern) => pattern.test(trimmed));
}

type Profile = "bootstrap" | "chat-only" | "explicit-only" | "full-access";

export function inspectKnowledgeExposure(deps: KnowledgeExposureDeps = {}): KnowledgeExposureReport {
  const agents = (deps.listAgents ?? dbListAgents)();
  const allInstances = (deps.listInstances ?? dbListInstances)();
  const live = (instance: InstanceConfig) => instance.enabled !== false && !instance.deletedAt;
  const instances = allInstances.filter(live);
  const disabledAccounts = new Set(allInstances.filter((instance) => !live(instance)).map((instance) => instance.name));
  const routes = (deps.listRoutes ?? dbListRoutes)();
  const isLinked = deps.isLinkedContact ?? defaultIsLinkedContact();
  const contactForPattern = deps.contactForPattern ?? defaultContactForPattern;
  const triggers = (deps.listTriggers ?? dbListTriggers)().filter((trigger) => trigger.enabled);
  const defaultAgent = (deps.defaultAgentId ?? getDefaultAgentId)();

  const offenders: KnowledgeExposureOffender[] = [];
  for (const agent of agents) {
    const reach = [
      ...reachabilityReasons(agent.id, instances, routes, disabledAccounts, isLinked, contactForPattern),
      ...triggerReachabilityReasons(agent.id, triggers, defaultAgent),
    ];
    if (reach.length === 0) continue;
    const safety = profileSafety(agent);
    if (safety.safe) continue;
    offenders.push({ agentId: agent.id, profile: safety.profile, reasons: [...reach, ...safety.reasons] });
  }
  offenders.sort((a, b) => a.agentId.localeCompare(b.agentId));
  return { ok: offenders.length === 0, offenders, checkedAgents: agents.length };
}

/**
 * `chat-only`, or `explicit-only` with no capability that starts with
 * `use:tool:`, `use:toolgroup:`, `execute:executable:`, `execute:group:` or
 * `admin:system:` (contract §11.3). Unknown agents are not no-exec.
 */
export function agentHasNoExec(agentId: string, deps: { getAgent?: (id: string) => AgentConfig | null } = {}): boolean {
  let agent: AgentConfig | null = null;
  try {
    agent = (deps.getAgent ?? dbGetAgent)(agentId);
  } catch {
    return false;
  }
  return agent ? agentConfigHasNoExec(agent) : false;
}

export function agentConfigHasNoExec(agent: Pick<AgentConfig, "defaults">): boolean {
  const { profile, capabilities } = readProfile(agent);
  if (profile === "chat-only") return true;
  if (profile !== "explicit-only") return false;
  return !capabilities.some((capability) => EXEC_CAPABILITY_PREFIXES.some((prefix) => capability.startsWith(prefix)));
}

function reachabilityReasons(
  agentId: string,
  instances: InstanceConfig[],
  routes: RouteConfig[],
  disabledAccounts: Set<string>,
  isLinked: (contactId: string) => boolean,
  contactForPattern: (pattern: string) => { id: string; tags: string[] } | null,
): string[] {
  const reasons: string[] = [];
  for (const instance of instances) {
    if (instance.agent !== agentId) continue;
    if (instance.dmPolicy === "open") reasons.push(`instance ${instance.name} admits open DMs`);
    if (instance.dmPolicy === "pairing") reasons.push(`instance ${instance.name} admits DMs by pairing`);
    if (instance.groupPolicy === "open") reasons.push(`instance ${instance.name} admits open groups`);
    if (instance.groupPolicy === "allowlist") reasons.push(`instance ${instance.name} admits allowlisted groups`);
  }
  for (const route of routes) {
    if (route.agent !== agentId || disabledAccounts.has(route.accountId)) continue;
    const pattern = route.pattern.trim();
    const lower = pattern.toLowerCase();
    if (lower.startsWith("group:") || lower.startsWith("thread:")) {
      reasons.push(`route ${pattern} on ${route.accountId} reaches a group`);
      continue;
    }
    if (pattern.includes("*")) {
      reasons.push(`route ${pattern} on ${route.accountId} is a wildcard`);
      continue;
    }
    if (!dmPatternIsOperatorSide(pattern, isLinked, contactForPattern)) {
      reasons.push(`route ${pattern} on ${route.accountId} reaches a contact who is not the owner or linked`);
    }
  }
  return reasons;
}

function triggerReachabilityReasons(
  agentId: string,
  triggers: KnowledgeExposureTrigger[],
  defaultAgent: string,
): string[] {
  const reasons: string[] = [];
  for (const trigger of triggers) {
    if ((trigger.agentId || defaultAgent) !== agentId) continue;
    if (!triggerTopicCarriesOutsideContent(trigger.topic)) continue;
    reasons.push(`trigger ${trigger.id} on ${trigger.topic} can carry outside content`);
  }
  return reasons;
}

function dmPatternIsOperatorSide(
  pattern: string,
  isLinked: (contactId: string) => boolean,
  contactForPattern: (pattern: string) => { id: string; tags: string[] } | null,
): boolean {
  try {
    const contact = contactForPattern(pattern);
    if (!contact) return false;
    return contact.tags.includes(OWNER_CONTACT_TAG) || isLinked(contact.id);
  } catch {
    return false;
  }
}

function profileSafety(agent: AgentConfig): { safe: boolean; profile: string; reasons: string[] } {
  const { profile, capabilities } = readProfile(agent);
  switch (profile) {
    case "chat-only":
      return { safe: true, profile, reasons: [] };
    case "explicit-only": {
      const unsafe = capabilities.filter((capability) => !isSafeExplicitCapability(capability));
      return {
        safe: unsafe.length === 0,
        profile,
        reasons: unsafe.map(
          (capability) => `profile explicit-only grants ${capability}, which is not on the allowlist`,
        ),
      };
    }
    case "full-access":
      return { safe: false, profile, reasons: ["profile full-access can read files and run any command"] };
    default:
      return { safe: false, profile, reasons: ["profile bootstrap can read files (bun, cat)"] };
  }
}

function isSafeExplicitCapability(capability: string): boolean {
  return SAFE_EXPLICIT_CAPABILITIES.has(capability) || SAFE_KNOWLEDGE_READ.test(capability);
}

/** The agent's profile (unset means the bootstrap floor) and its explicit capabilities as strings. */
function readProfile(agent: Pick<AgentConfig, "defaults">): { profile: Profile; capabilities: string[] } {
  const config = getAgentRuntimePermissionsConfigFromDefaults(agent.defaults ?? null);
  const capabilities = (config?.capabilities ?? []).flatMap((capability) => {
    if (typeof capability === "string") return [capability.trim()];
    if (!capability.permission || !capability.objectType || !capability.objectId) return [];
    return [`${capability.permission}:${capability.objectType}:${capability.objectId}`];
  });
  return { profile: config?.profile ?? "bootstrap", capabilities };
}

function defaultIsLinkedContact(): (contactId: string) => boolean {
  let installationId: string | null = null;
  try {
    installationId = readCloudCredentials()?.installationId ?? null;
  } catch {
    installationId = null;
  }
  return (contactId) => {
    // Without a login no binding can be checked against this installation.
    if (!installationId) return false;
    try {
      return (
        readCachedActorBinding(contactId, process.env, Date.now(), { requireInstallationId: installationId }) !== null
      );
    } catch {
      return false;
    }
  };
}

function defaultContactForPattern(pattern: string): { id: string; tags: string[] } | null {
  const contact = getContact(pattern);
  return contact ? { id: contact.id, tags: contact.tags ?? [] } : null;
}
