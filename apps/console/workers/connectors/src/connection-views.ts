/**
 * Wire shapes of connections for the CLI and the Console.
 *
 * Connections belong to a person, not to a project, and GitHub
 * installations never reach these views. The Console views carry no
 * project; CLI items still carry a string `projectId` for CLIs from
 * before personal connections (see `legacyCliProjectId`).
 */

import {
  capabilityLabel,
  listProviderCapabilities,
  type CapabilityClass,
  type CapabilityDefinition,
} from "./capabilities/registry";
import type {
  AgentGrantViewRecord,
  ConnectionActivityRecord,
  ConnectorOrgPolicyRecord,
  ConnectorUsageRecord,
  OrganizationAccountRecord,
  OrganizationConnectionRecord,
  ProviderConnectionRecord,
} from "./db";
import {
  connectionAccessMode,
  missingRequiredProviderScopes,
  storedAccessMode,
  type ConnectorAccessMode,
} from "./scopes";
import {
  effectiveToolPolicy,
  isToolPolicy,
  sharedDefaultToolPolicy,
  toolPolicyCeiling,
  type ToolPolicy,
} from "./tool-policy";

const USED_BY_LIMIT = 5;

export interface CliConnectionItem {
  id: string;
  provider: string;
  displayName: string;
  status: string;
  requiresReauth: boolean;
  scopes: string[];
  /** Only for older CLIs, whose return schema requires a string, until 2027-01-01. */
  projectId: string;
  createdAt: string;
  externalAccountLogin: string | null;
  isDefault: boolean;
  accessMode: ConnectorAccessMode;
  scopeKind: "user" | "organization";
  /** Up to 5 uses, newest first. */
  usedBy: UsageRow[];
}

export interface CliConnectionDetail extends CliConnectionItem {
  /** The tools the granted scopes and the access mode allow, in registry order. */
  capabilities: string[];
  grantedAt: string;
  lastReauthAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export type UsageMode = "owner" | "person_asking" | "shared";

export interface UsageRow {
  installationId: string | null;
  installationName: string | null;
  agentId: string | null;
  routineKey: string | null;
  mode: UsageMode;
  conversation: string;
  lastUsedAt: string;
  useCount: number;
  legacyCli: boolean;
}

export interface ConnectionSummary {
  id: string;
  provider: string;
  scopeKind: "user" | "organization";
  displayName: string;
  email: string | null;
  status: string;
  requiresReauth: boolean;
  scopes: string[];
  accessMode: ConnectorAccessMode;
  isDefault: boolean;
  grantedAt: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  usedBy: UsageRow[];
  managedBy?: { userId: string; email: string | null } | null;
}

export interface ToolRow {
  capability: string;
  label: string;
  class: CapabilityClass;
  /** What exec applies (before write-after-read). */
  policy: ToolPolicy;
  /** The owner's choice; `null` = the class default. */
  userPolicy: ToolPolicy | null;
  /** The organization's ceiling; `null` = none. */
  ceiling: ToolPolicy | null;
  /** The connection holds what the tool needs (scopes, access mode). */
  available: boolean;
}

export interface ActivityRow {
  action: string;
  capability: string | null;
  at: string;
  agentId: string | null;
  conversation: string | null;
  outcome: "ok" | "denied" | "failed";
  /** The connector error code of a refusal, so the Console can say why. */
  code: string | null;
}

/**
 * An agent on one installation allowed to use an account: for the person
 * asking (the person who gave it), or as a shared organization account.
 */
export interface AgentGrantRow {
  id: string;
  mode: "person_asking" | "shared";
  provider: string;
  agentId: string;
  installationId: string;
  installationName: string | null;
  /** The member signed in on that installation, who runs the agent. */
  operator: { userId: string; email: string | null } | null;
  /** `null`: the person's default account at the time of use. */
  connectionId: string | null;
  email: string | null;
  conversations: string[];
  createdAt: string;
}

export interface ConnectionDetail extends ConnectionSummary {
  tools: ToolRow[];
  usage: UsageRow[];
  activity: ActivityRow[];
  /** Agents that use the account: person-asking grants on it, shared grants of an organization account. */
  grants: AgentGrantRow[];
}

export interface OrgPolicyView {
  provider: string;
  enabled: boolean;
  writesAllowed: boolean;
  sharedAllowed: boolean;
  toolCeilings: Record<string, ToolPolicy>;
  tools: { capability: string; label: string; class: CapabilityClass }[];
}

export interface AdminConnectionRow {
  id: string;
  provider: string;
  scopeKind: "user" | "organization";
  email: string | null;
  status: string;
  requiresReauth: boolean;
  member: { userId: string | null; email: string | null; name: string | null };
  lastUsedAt: string | null;
  createdAt: string;
}

export function toCliConnectionItem(
  row: ProviderConnectionRecord,
  writeScopes: readonly string[],
  usage: readonly ConnectorUsageRecord[] = [],
): CliConnectionItem {
  return {
    id: row.id,
    provider: row.provider,
    displayName: row.displayName,
    status: row.status,
    requiresReauth: row.requiresReauth,
    scopes: row.scopesJson,
    projectId: legacyCliProjectId(row),
    createdAt: row.createdAt.toISOString(),
    externalAccountLogin: row.externalAccountLogin,
    isDefault: row.isDefault,
    accessMode: connectionAccessMode(row, writeScopes),
    scopeKind: publicScopeKind(row.scopeKind),
    usedBy: usedBy(row.id, usage),
  };
}

export function toCliConnectionDetail(
  row: ProviderConnectionRecord,
  writeScopes: readonly string[],
  usage: readonly ConnectorUsageRecord[] = [],
): CliConnectionDetail {
  return {
    ...toCliConnectionItem(row, writeScopes, usage),
    // From the registry, as the Console's tool rows: `capabilities_json`
    // is not kept up to date (the connect flow stores it empty).
    capabilities: listProviderCapabilities(row.provider)
      .filter((capability) => isCapabilityAvailable(row, capability))
      .map((capability) => capability.id),
    grantedAt: row.grantedAt.toISOString(),
    lastReauthAt: row.lastReauthAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

export function toConnectionSummary(
  row: ProviderConnectionRecord,
  writeScopes: readonly string[],
  usage: readonly ConnectorUsageRecord[],
): ConnectionSummary {
  return {
    id: row.id,
    provider: row.provider,
    scopeKind: publicScopeKind(row.scopeKind),
    displayName: row.displayName,
    email: row.externalAccountLogin,
    status: row.status,
    requiresReauth: row.requiresReauth,
    scopes: row.scopesJson,
    accessMode: connectionAccessMode(row, writeScopes),
    isDefault: row.isDefault,
    grantedAt: row.grantedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    usedBy: usedBy(row.id, usage),
  };
}

function usedBy(connectionId: string, usage: readonly ConnectorUsageRecord[]): UsageRow[] {
  return usage
    .filter((entry) => entry.providerConnectionId === connectionId)
    .sort((a, b) => b.lastUsedAt.getTime() - a.lastUsedAt.getTime())
    .slice(0, USED_BY_LIMIT)
    .map(toUsageRow);
}

/** An organization account with the member who manages it. */
export function toOrgConnectionSummary(
  row: OrganizationAccountRecord,
  writeScopes: readonly string[],
  usage: readonly ConnectorUsageRecord[],
): ConnectionSummary {
  return {
    ...toConnectionSummary(row, writeScopes, usage),
    managedBy: row.managedByUserId ? { userId: row.managedByUserId, email: row.managerEmail } : null,
  };
}

export function toAgentGrantRow(row: AgentGrantViewRecord): AgentGrantRow {
  return {
    id: row.id,
    mode: row.mode,
    provider: row.provider,
    agentId: row.agentId,
    installationId: row.localInstallationId,
    installationName: row.installationName,
    operator: row.operatorUserId ? { userId: row.operatorUserId, email: row.operatorEmail } : null,
    connectionId: row.providerConnectionId,
    email: row.connectionEmail,
    conversations: Array.isArray(row.conversationsJson)
      ? row.conversationsJson.filter((item): item is string => typeof item === "string")
      : [],
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * One row per capability of the connection's provider. An organization
 * account starts from the shared defaults (reads blocked except free/busy).
 */
export function toToolRows(
  row: ProviderConnectionRecord,
  input: {
    capabilities: readonly CapabilityDefinition[];
    orgPolicy: ConnectorOrgPolicyRecord;
    userPolicies: readonly { capability: string; policy: string }[];
  },
): ToolRow[] {
  const shared = row.scopeKind === "organization";
  return input.capabilities.map((capability) => {
    const chosen = input.userPolicies.find((entry) => entry.capability === capability.id)?.policy;
    const userPolicy = isToolPolicy(chosen) ? chosen : null;
    const ceilingInput = {
      capabilityClass: capability.class,
      ceiling: input.orgPolicy.toolCeilingsJson?.[capability.id],
      writesAllowed: input.orgPolicy.writesAllowed,
    };
    return {
      capability: capability.id,
      label: capabilityLabel(capability.id),
      class: capability.class,
      policy: effectiveToolPolicy({
        ...ceilingInput,
        userPolicy,
        ...(shared ? { defaultPolicy: sharedDefaultToolPolicy(capability) } : {}),
      }),
      userPolicy,
      ceiling: toolPolicyCeiling(ceilingInput),
      available: isCapabilityAvailable(row, capability),
    };
  });
}

/** A write needs a connection that was not connected read only; every tool needs its provider scopes. */
function isCapabilityAvailable(row: ProviderConnectionRecord, capability: CapabilityDefinition): boolean {
  if (capability.class !== "read" && storedAccessMode(row.metadataJson) === "read_only") return false;
  return missingRequiredProviderScopes(capability.requiredProviderScopes, row.scopesJson).length === 0;
}

export function toActivityRow(entry: ConnectionActivityRecord): ActivityRow {
  const metadata = entry.metadata ?? {};
  return {
    action: entry.action,
    capability: stringOrNull(metadata.capability),
    at: entry.createdAt.toISOString(),
    agentId: stringOrNull(metadata.agentId),
    conversation: stringOrNull(metadata.conversation),
    outcome: activityOutcome(entry.action),
    code: stringOrNull(metadata.code),
  };
}

function activityOutcome(action: string): ActivityRow["outcome"] {
  if (action === "connector.action.denied" || action === "connector.approval.denied") return "denied";
  if (action === "connector.action.failed" || action === "connector.reauth_required") return "failed";
  return "ok";
}

export function toOrgPolicyView(
  policy: ConnectorOrgPolicyRecord,
  capabilities: readonly CapabilityDefinition[],
): OrgPolicyView {
  const toolCeilings: Record<string, ToolPolicy> = {};
  for (const [capability, value] of Object.entries(policy.toolCeilingsJson ?? {})) {
    // A stored value that is not a policy blocks the tool on exec; show it so.
    toolCeilings[capability] = isToolPolicy(value) ? value : "blocked";
  }
  return {
    provider: policy.provider,
    enabled: policy.enabled,
    writesAllowed: policy.writesAllowed,
    sharedAllowed: policy.sharedAllowed,
    toolCeilings,
    tools: capabilities.map((capability) => ({
      capability: capability.id,
      label: capabilityLabel(capability.id),
      class: capability.class,
    })),
  };
}

export function toAdminConnectionRow(row: OrganizationConnectionRecord): AdminConnectionRow {
  return {
    id: row.id,
    provider: row.provider,
    scopeKind: publicScopeKind(row.scopeKind),
    email: row.externalAccountLogin,
    status: row.status,
    requiresReauth: row.requiresReauth,
    member: { userId: row.memberUserId, email: row.memberEmail, name: row.memberName },
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/**
 * A CLI from before personal connections checks `projectId: z.string()` on
 * `connectors list` and `show` and fails the whole answer on `null`; newer
 * ones accept a string or `null` and ignore it. Until the 2027-01-01
 * deprecation date the item keeps a string: the row's project, else the
 * one it was filed under before it became personal, else "".
 */
function legacyCliProjectId(row: ProviderConnectionRecord): string {
  return row.projectId ?? stringOrNull(row.metadataJson?.legacyProjectId) ?? "";
}

export function toUsageRow(entry: ConnectorUsageRecord): UsageRow {
  return {
    installationId: entry.localInstallationId,
    installationName: entry.installationName,
    agentId: entry.agentId || null,
    routineKey: entry.routineKey || null,
    mode: entry.mode === "person_asking" || entry.mode === "shared" ? entry.mode : "owner",
    conversation: entry.conversation,
    lastUsedAt: entry.lastUsedAt.toISOString(),
    useCount: entry.useCount,
    // Exec calls without `X-Ravi-Exec-Context` (an old CLI) are recorded
    // with conversation `legacy_cli`.
    legacyCli: entry.conversation === "legacy_cli",
  };
}

/** Legacy `project` rows are personal rows waiting to be reclassified. */
function publicScopeKind(scopeKind: ProviderConnectionRecord["scopeKind"]): "user" | "organization" {
  return scopeKind === "organization" ? "organization" : "user";
}
