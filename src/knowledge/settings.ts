// Knowledge settings keys (contract §13.1). Settings rows, not
// `agents.defaults` JSON: `ravi agents set <id> defaults` replaces the whole
// object and would wipe `runtimePermissions`. The validators run in
// `ravi settings set` (src/cli/commands/settings.ts); the reader below is
// lenient about anything written around them.

import { dbGetAgent, dbGetInstance, dbGetSetting } from "../router/router-db.js";
import { logger } from "../utils/logger.js";

const log = logger.child("knowledge:settings");

export const KNOWLEDGE_CONTACT_MEMORY_AGENTS_SETTING = "knowledge.contactMemory.agents";
export const KNOWLEDGE_PROJECT_SETTING = "knowledge.project";
export const KNOWLEDGE_CURATOR_AGENT_SETTING = "knowledge.curator.agent";
export const KNOWLEDGE_DIGEST_TIME_SETTING = "knowledge.digest.time";
export const KNOWLEDGE_DIGEST_TIMEZONE_SETTING = "knowledge.digest.timezone";
export const KNOWLEDGE_OWNER_TARGET_SETTING = "knowledge.owner.target";
export const KNOWLEDGE_EGRESS_ALLOW_SETTING = "knowledge.egress.allow";

export const DEFAULT_KNOWLEDGE_DIGEST_TIME = "08:00";

export interface KnowledgeSettings {
  contactMemoryAgents: string[];
  project: string | null;
  curatorAgent: string | null;
  digestTime: string;
  digestTimezone: string;
  ownerTarget: string | null;
  /** Hosts allowed in packet replies for this instance (`knowledge.egress.allow`), or null when unrestricted. */
  egressAllow(instanceName: string): string[] | null;
}

export interface KnowledgeSettingsDeps {
  getSetting?: (key: string) => string | null;
}

export function knowledgeSettings(deps: KnowledgeSettingsDeps = {}): KnowledgeSettings {
  const read = (key: string): string | null => {
    try {
      const value = (deps.getSetting ?? dbGetSetting)(key)?.trim();
      return value ? value : null;
    } catch {
      return null;
    }
  };
  const digestTime = read(KNOWLEDGE_DIGEST_TIME_SETTING);
  const digestTimezone = read(KNOWLEDGE_DIGEST_TIMEZONE_SETTING);
  const egressRaw = read(KNOWLEDGE_EGRESS_ALLOW_SETTING);
  let egressMap: Map<string, string[]> | "invalid" | null = null;
  const egress = (): Map<string, string[]> | "invalid" | null => {
    if (egressMap === null && egressRaw) egressMap = parseEgressAllowLenient(egressRaw);
    return egressMap;
  };
  return {
    contactMemoryAgents: parseAgentCsv(read(KNOWLEDGE_CONTACT_MEMORY_AGENTS_SETTING)),
    project: read(KNOWLEDGE_PROJECT_SETTING),
    curatorAgent: read(KNOWLEDGE_CURATOR_AGENT_SETTING),
    digestTime: digestTime && DIGEST_TIME.test(digestTime) ? digestTime : DEFAULT_KNOWLEDGE_DIGEST_TIME,
    digestTimezone: digestTimezone && isValidTimezone(digestTimezone) ? digestTimezone : systemTimezone(),
    ownerTarget: read(KNOWLEDGE_OWNER_TARGET_SETTING),
    egressAllow(instanceName: string): string[] | null {
      const map = egress();
      if (map === null) return null;
      // A value that no longer parses fails closed: no other host passes.
      if (map === "invalid") return [];
      return map.get(instanceName.trim()) ?? null;
    },
  };
}

// ---------------------------------------------------------------------------
// Validators (`ravi settings set`). Each throws an Error whose message the
// settings command shows after "Invalid value for <key>: ".
// ---------------------------------------------------------------------------

export interface KnowledgeSettingValidatorDeps {
  agentExists?: (agentId: string) => boolean;
  /** The instance's channel, or null when no instance has that name. */
  instanceChannel?: (instanceName: string) => string | null;
}

const DIGEST_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CHANNEL_ID = /^[a-z][a-z0-9_-]{0,63}$/;
const HOST_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

export function validateContactMemoryAgents(value: string, deps: KnowledgeSettingValidatorDeps = {}): void {
  const ids = value.split(",").map((id) => id.trim());
  if (ids.length === 0 || ids.some((id) => !id)) {
    throw new Error("Must be a comma-separated list of agent ids, with no empty entry");
  }
  for (const id of ids) assertAgent(id, deps);
}

export function validateCuratorAgent(value: string, deps: KnowledgeSettingValidatorDeps = {}): void {
  assertAgent(value.trim(), deps);
}

export function validateKnowledgeProject(value: string): void {
  const project = value.trim();
  if (!project || /\s/.test(project) || project.length > 200) {
    throw new Error("Must be a Console project ref (slug or id), with no spaces");
  }
}

export function validateDigestTime(value: string): void {
  if (!DIGEST_TIME.test(value.trim())) throw new Error("Must be HH:MM in 24-hour time, for example 08:00");
}

export function validateDigestTimezone(value: string): void {
  if (!isValidTimezone(value.trim()))
    throw new Error(`Invalid timezone: ${value}. Use an IANA zone such as America/Sao_Paulo`);
}

/** `<channel>:<accountId>:<to>`, where `<accountId>` is an existing instance of that channel. */
export function validateOwnerTarget(value: string, deps: KnowledgeSettingValidatorDeps = {}): void {
  const parsed = parseOwnerTarget(value);
  if (!parsed) throw new Error("Must be <channel>:<instance name>:<to>, for example whatsapp:main:5511999999999");
  const channel = (deps.instanceChannel ?? defaultInstanceChannel)(parsed.accountId);
  if (channel === null) throw new Error(`Instance not found: ${parsed.accountId}`);
  if (channel.toLowerCase() !== parsed.channel) {
    throw new Error(`Instance ${parsed.accountId} is on channel ${channel}, not ${parsed.channel}`);
  }
}

/** A JSON object `{"<instance name>": ["host", …]}` with existing instance names and valid hostnames. */
export function validateEgressAllow(value: string, deps: KnowledgeSettingValidatorDeps = {}): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Must be a JSON object such as {"main": ["example.com"]}');
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error('Must be a JSON object such as {"main": ["example.com"]}');
  }
  for (const [instance, hosts] of Object.entries(parsed as Record<string, unknown>)) {
    if ((deps.instanceChannel ?? defaultInstanceChannel)(instance) === null) {
      throw new Error(`Instance not found: ${instance}`);
    }
    if (!Array.isArray(hosts)) throw new Error(`The value for ${instance} must be an array of hostnames`);
    for (const host of hosts) {
      if (typeof host !== "string" || !isValidHostname(host)) {
        throw new Error(`Invalid hostname for ${instance}: ${typeof host === "string" ? host : JSON.stringify(host)}`);
      }
    }
  }
}

export function isValidHostname(value: string): boolean {
  const host = value.trim().toLowerCase().replace(/\.$/, "");
  if (!host || host.length > 253) return false;
  const labels = host.split(".");
  if (labels.length < 2) return false;
  if (!labels.every((label) => HOST_LABEL.test(label))) return false;
  // The top-level label is never all digits (that would be an IP address).
  return !/^\d+$/.test(labels[labels.length - 1] ?? "");
}

export function parseOwnerTarget(value: string): { channel: string; accountId: string; to: string } | null {
  const raw = value.trim();
  const first = raw.indexOf(":");
  const second = first < 0 ? -1 : raw.indexOf(":", first + 1);
  if (first <= 0 || second <= first + 1) return null;
  const channel = raw.slice(0, first).trim().toLowerCase();
  const accountId = raw.slice(first + 1, second).trim();
  const to = raw.slice(second + 1).trim();
  if (!CHANNEL_ID.test(channel) || !accountId || !to || /\s/.test(to)) return null;
  return { channel, accountId, to };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertAgent(id: string, deps: KnowledgeSettingValidatorDeps): void {
  if (!AGENT_ID.test(id)) throw new Error(`Invalid agent id: ${id}`);
  const exists = deps.agentExists ?? ((agentId: string) => Boolean(dbGetAgent(agentId)));
  if (!exists(id)) throw new Error(`Agent not found: ${id}`);
}

function defaultInstanceChannel(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  return dbGetInstance(trimmed)?.channel ?? null;
}

function parseAgentCsv(value: string | null): string[] {
  if (!value) return [];
  return [...new Set(value.split(",").map((id) => id.trim()))].filter(Boolean);
}

function parseEgressAllowLenient(raw: string): Map<string, string[]> | "invalid" {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    const map = new Map<string, string[]>();
    for (const [instance, hosts] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(hosts)) throw new Error("not an array");
      map.set(
        instance.trim(),
        hosts
          .filter((host): host is string => typeof host === "string")
          .map((host) => host.trim().toLowerCase().replace(/\.$/, ""))
          .filter(Boolean),
      );
    }
    return map;
  } catch {
    log.warn("knowledge.egress.allow does not parse; packet replies allow no other host");
    return "invalid";
  }
}

function isValidTimezone(tz: string): boolean {
  if (!tz) return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function systemTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
