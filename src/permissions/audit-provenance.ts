import type { ContextCapability, ContextRecord, ContextSource } from "../router/router-db.js";

export interface AuditProvenanceInput {
  contextId?: string | null;
  kind?: string | null;
  agentId?: string | null;
  sessionKey?: string | null;
  sessionName?: string | null;
  source?: ContextSource | null;
  capabilities?: ContextCapability[] | null;
  metadata?: Record<string, unknown> | null;
  context?: ContextRecord | null;
}

export interface AuditContextProvenance {
  contextId?: string;
  kind?: string;
  agentId?: string;
  sessionKey?: string;
  sessionName?: string;
  authorityMode?: string;
  authorityResolver?: string;
  actorPrincipal?: string;
  actorResolution?: string;
  actorDisplayName?: string;
  surfacePrincipal?: string;
  surfaceDisplayName?: string;
  executorAgentId?: string;
  actorCapabilityCount?: number;
  surfaceCapabilityCount?: number;
  actorOverrideCapabilityCount?: number;
  surfaceOverrideCapabilityCount?: number;
  delegationOverridePrincipals?: string[];
  turnCapabilityCount?: number;
  turnCapabilities?: ContextCapability[];
  effectiveCapabilityCount?: number;
  capabilitiesCount?: number;
  source?: {
    channel?: string;
    accountId?: string;
    chatId?: string;
    threadId?: string;
  };
}

const STRING_METADATA_KEYS = [
  "authorityMode",
  "authorityResolver",
  "actorPrincipal",
  "actorResolution",
  "actorDisplayName",
  "surfacePrincipal",
  "surfaceDisplayName",
  "executorAgentId",
] as const;

const NUMBER_METADATA_KEYS = [
  "actorCapabilityCount",
  "surfaceCapabilityCount",
  "actorOverrideCapabilityCount",
  "surfaceOverrideCapabilityCount",
  "turnCapabilityCount",
  "effectiveCapabilityCount",
] as const;

export function buildAuditContextProvenance(input?: AuditProvenanceInput | null): AuditContextProvenance | undefined {
  if (!input) return undefined;

  const record = input.context ?? null;
  const metadata = record?.metadata ?? input.metadata ?? null;
  const capabilities = record?.capabilities ?? input.capabilities ?? null;
  const source = record?.source ?? input.source ?? null;

  const context: AuditContextProvenance = {};
  assignString(context, "contextId", record?.contextId ?? input.contextId);
  assignString(context, "kind", record?.kind ?? input.kind);
  assignString(context, "agentId", record?.agentId ?? input.agentId);
  assignString(context, "sessionKey", record?.sessionKey ?? input.sessionKey);
  assignString(context, "sessionName", record?.sessionName ?? input.sessionName);

  for (const key of STRING_METADATA_KEYS) {
    assignString(context, key, metadata?.[key]);
  }
  for (const key of NUMBER_METADATA_KEYS) {
    assignNumber(context, key, metadata?.[key]);
  }
  assignStringArray(context, "delegationOverridePrincipals", metadata?.delegationOverridePrincipals);
  assignCapabilityArray(context, "turnCapabilities", metadata?.turnCapabilities);

  if (Array.isArray(capabilities)) {
    context.capabilitiesCount = capabilities.length;
  }

  const safeSource = buildSafeSource(source);
  if (safeSource) context.source = safeSource;

  return Object.keys(context).length > 0 ? context : undefined;
}

function assignString(target: object, key: string, value: unknown): void {
  if (typeof value === "string" && value.length > 0) {
    (target as Record<string, unknown>)[key] = value;
  }
}

function assignNumber(target: object, key: string, value: unknown): void {
  if (typeof value === "number" && Number.isFinite(value)) {
    (target as Record<string, unknown>)[key] = value;
  }
}

function assignStringArray(target: object, key: string, value: unknown): void {
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry): entry is string => typeof entry === "string" && entry.length > 0)
  ) {
    (target as Record<string, unknown>)[key] = value;
  }
}

function assignCapabilityArray(target: object, key: string, value: unknown): void {
  if (!Array.isArray(value) || value.length === 0) return;
  const capabilities: ContextCapability[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const permission = stringField(record.permission);
    const objectType = stringField(record.objectType);
    const objectId = stringField(record.objectId);
    if (!permission || !objectType || !objectId) continue;
    const source = stringField(record.source);
    capabilities.push({
      permission,
      objectType,
      objectId,
      ...(source ? { source } : {}),
    });
  }
  if (capabilities.length > 0) {
    (target as Record<string, unknown>)[key] = capabilities;
  }
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function buildSafeSource(source?: ContextSource | null): AuditContextProvenance["source"] | undefined {
  if (!source) return undefined;
  const safe: NonNullable<AuditContextProvenance["source"]> = {};
  assignString(safe, "channel", source.channel);
  assignString(safe, "accountId", source.accountId);
  assignString(safe, "chatId", source.chatId);
  assignString(safe, "threadId", source.threadId);
  return Object.keys(safe).length > 0 ? safe : undefined;
}
