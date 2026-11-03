/**
 * High-level Console-side helpers that wrap the HMAC client. Keeps the
 * Next.js route handlers thin: every call forwards the signed-in person's
 * identity to the connectors Worker, which owns all connector state.
 */

import {
  getLinkHmacConfig,
  LinkHmacError,
  linkHmacRequest,
} from "./link-hmac-client";

// ---------------------------------------------------------------------------
// Shared response types (the Worker returns them, the Console consumes them)
// ---------------------------------------------------------------------------

export type ToolPolicy = "always_allow" | "needs_approval" | "blocked";
export type ConnectorAccessMode = "full" | "read_only";
export type ConnectorScopeKind = "user" | "organization";
export type ConnectorUseMode = "owner" | "person_asking" | "shared";
export type ConnectOrigin = "cli" | "ui";

export type UsageRow = {
  installationId: string | null;
  installationName: string | null;
  agentId: string | null;
  routineKey: string | null;
  mode: ConnectorUseMode;
  conversation: string;
  lastUsedAt: string;
  useCount: number;
  legacyCli: boolean;
};

export type ConnectionSummary = {
  id: string;
  provider: string;
  scopeKind: ConnectorScopeKind;
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
  /** Up to 5, newest first. */
  usedBy: UsageRow[];
  /** Organization rows only. */
  managedBy?: { userId: string; email: string | null } | null;
};

export type ToolRow = {
  capability: string;
  label: string;
  class: "read" | "write" | "destructive";
  policy: ToolPolicy;
  userPolicy: ToolPolicy | null;
  ceiling: ToolPolicy | null;
  /** The scope the tool needs was granted. */
  available: boolean;
};

export type ActivityRow = {
  action: string;
  capability: string | null;
  at: string;
  agentId: string | null;
  conversation: string | null;
  outcome: "ok" | "denied" | "failed";
  /**
   * A refused action's code (`connector_approval_required`, ...), when the
   * Worker sends it. Beyond section 7: without it a write that waited for the
   * owner can't be told from a real refusal.
   */
  code?: string | null;
};

export type AgentGrantRow = {
  id: string;
  mode: "person_asking" | "shared";
  provider: string;
  agentId: string;
  installationId: string;
  installationName: string | null;
  operator: { userId: string; email: string | null } | null;
  connectionId: string | null;
  email: string | null;
  conversations: string[];
  createdAt: string;
};

export type ConnectionDetail = ConnectionSummary & {
  tools: ToolRow[];
  usage: UsageRow[];
  activity: ActivityRow[];
  grants: AgentGrantRow[];
};

export type ConnectResolveView =
  | {
      state: "pending";
      provider: string;
      accessMode: ConnectorAccessMode;
      origin: ConnectOrigin;
      installationName: string | null;
      expiresAt: string;
      reconnect: { connectionId: string; email: string | null } | null;
      scopeKind: ConnectorScopeKind;
    }
  | { state: "expired" | "used" | "user_mismatch" | "invalid" | "disabled_by_org" };

export type ConnectFinishResult =
  | {
      state: "connected";
      connectionId: string;
      provider: string;
      email: string | null;
      created: boolean;
      reconnected: boolean;
      accountChanged: boolean;
      origin: ConnectOrigin;
      /** `organization` for an organization account; a Worker from before them leaves it out. */
      scopeKind?: ConnectorScopeKind;
    }
  | { state: "rejected"; reason: string }
  | { state: "expired" | "invalid" };

export type ApprovalSummary = {
  id: string;
  connectionId: string;
  email: string | null;
  capability: string;
  label: string;
  reason: "policy" | "write_after_read";
  requestedAt: string;
  expiresAt: string;
  installationName: string | null;
  agentId: string | null;
  conversation: string | null;
};

export type ApprovalDetail = ApprovalSummary & {
  status: string;
  preview: Record<string, unknown> | null;
  sessionName: string | null;
  speakerKind: string | null;
  routine: { kind: string; id?: string } | null;
};

export type OrgPolicy = {
  provider: string;
  enabled: boolean;
  writesAllowed: boolean;
  sharedAllowed: boolean;
  toolCeilings: Record<string, ToolPolicy>;
  tools: { capability: string; label: string; class: string }[];
};

export type AdminConnectionRow = {
  id: string;
  provider: string;
  scopeKind: string;
  email: string | null;
  status: string;
  requiresReauth: boolean;
  member: { userId: string | null; email: string | null; name: string | null };
  lastUsedAt: string | null;
  createdAt: string;
};

export type ConsentView =
  | {
      state: "pending";
      provider: string;
      agentId: string;
      agentDisplayName: string | null;
      operatorName: string | null;
      operatorEmail: string | null;
      installationName: string | null;
      connections: { id: string; email: string | null; isDefault: boolean }[];
      expiresAt: string;
    }
  | { state: "expired" | "used" | "user_mismatch" | "invalid" };

export type ConsentDecision = "approve" | "deny";

export type ConsentDecisionResult = { status: string; grantId: string | null };

/** Where a shared account may be used: direct messages, groups, or both. */
export type SharedConversation = "dm" | "group";

export type SharedGrantInput = {
  connectionId: string;
  installationId: string;
  agentId: string;
  conversations: SharedConversation[];
};

export interface ConsoleConnectStartResult {
  /** The Console page `/connect/<token>` (CLI origin). */
  connectUrl?: string;
  /** The provider's sign-in, when the start continued at once (Console origin). */
  authorizationUrl?: string;
  pendingGrantId: string;
  expiresAt: string;
}

export interface ConsoleConnectorActorContext {
  userId: string;
  organizationId: string;
}

/**
 * A call that carries the member's role, whatever it is: on organization
 * accounts the Worker serves owners and admins every account and anyone
 * else only the accounts they manage, deciding from its membership row too.
 */
export interface ConsoleConnectorMemberContext extends ConsoleConnectorActorContext {
  role: string;
}

/** An admin call also carries the member's role; the Worker requires `owner` or `admin`. */
export type ConsoleConnectorAdminContext = ConsoleConnectorMemberContext;

export type ApprovalDecision = "approve" | "deny";

export type OrgPolicyUpdate = {
  provider: string;
  enabled?: boolean;
  writesAllowed?: boolean;
  sharedAllowed?: boolean;
  /** The whole map: a capability left out has no ceiling. */
  toolCeilings?: Record<string, ToolPolicy>;
};

/** One tool's ceiling change; `null` is "No limit". */
export type ToolCeilingChange = { capability: string; ceiling: "needs_approval" | "blocked" | null };

/**
 * The whole ceilings map after one tool's change, built from `policy` as the
 * Worker just answered it (the Worker stores the map as sent). Keeps only the
 * tools the policy lists, so a capability that left the catalog doesn't make
 * the Worker refuse the map. `null` when the policy doesn't list the tool.
 */
export function withToolCeiling(
  policy: Pick<OrgPolicy, "toolCeilings" | "tools">,
  change: ToolCeilingChange,
): Record<string, ToolPolicy> | null {
  const known = new Set(policy.tools.map((tool) => tool.capability));
  if (!known.has(change.capability)) return null;
  const next: Record<string, ToolPolicy> = {};
  for (const [capability, ceiling] of Object.entries(policy.toolCeilings)) {
    if (capability === change.capability || !known.has(capability)) continue;
    if (ceiling === "needs_approval" || ceiling === "blocked") next[capability] = ceiling;
  }
  if (change.ceiling) next[change.capability] = change.ceiling;
  return next;
}

export class ConsoleConnectorClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    /**
     * The Worker's `reason` detail, when it sends one: it tells apart
     * refusals that share a code (`connector_disabled_by_org` with
     * `shared_not_allowed` is shared accounts being off, not the connector).
     */
    public readonly reason: string | null = null,
  ) {
    super(message);
    this.name = "ConsoleConnectorClientError";
  }
}

function requireConfig() {
  const config = getLinkHmacConfig();
  if (!config) {
    throw new ConsoleConnectorClientError(
      503,
      "server_not_configured",
      "RAVI_CONNECTORS HMAC keys are not configured.",
    );
  }
  return config;
}

async function call<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const config = requireConfig();
  try {
    return await linkHmacRequest<T>(config, { method: "POST", path, body });
  } catch (error) {
    throw normalizeError(error);
  }
}

function actorBody(actor: ConsoleConnectorActorContext) {
  return { userId: actor.userId, organizationId: actor.organizationId };
}

function roleBody(member: ConsoleConnectorMemberContext) {
  return { ...actorBody(member), role: member.role };
}

// ---------------------------------------------------------------------------
// Connect flow
// ---------------------------------------------------------------------------

export async function startConnect(
  actor: ConsoleConnectorActorContext,
  input: {
    provider: string;
    accessMode?: ConnectorAccessMode;
    reconnectConnectionId?: string;
    displayName?: string;
    /** Start and continue in one step, so the browser goes straight to the provider. */
    continueNow?: boolean;
    origin?: ConnectOrigin;
    cliSessionId?: string;
    localInstallationId?: string;
    /** `organization`: an account the organization's agents share, managed by the person starting it. */
    scopeKind?: ConnectorScopeKind;
    /** The member's role, sent with an organization start so the Worker checks it too. */
    role?: string;
  },
): Promise<ConsoleConnectStartResult> {
  return call<ConsoleConnectStartResult>("/ui/connect/start", {
    ...actorBody(actor),
    ...(input.role ? { role: input.role } : {}),
    provider: input.provider,
    scopeKind: input.scopeKind,
    accessMode: input.accessMode,
    reconnectConnectionId: input.reconnectConnectionId,
    displayName: input.displayName,
    continueNow: input.continueNow,
    origin: input.origin ?? "ui",
    cliSessionId: input.cliSessionId,
    localInstallationId: input.localInstallationId,
  });
}

export async function resolveConnect(
  actor: ConsoleConnectorActorContext,
  connectToken: string,
): Promise<ConnectResolveView> {
  return call<ConnectResolveView>("/ui/connect/resolve", { ...actorBody(actor), connectToken });
}

export async function continueConnect(
  actor: ConsoleConnectorActorContext,
  connectToken: string,
): Promise<{ authorizationUrl: string }> {
  return call<{ authorizationUrl: string }>("/ui/connect/continue", { ...actorBody(actor), connectToken });
}

export async function finishConnect(
  actor: ConsoleConnectorActorContext,
  input: { pendingId: string; resultToken: string },
): Promise<ConnectFinishResult> {
  return call<ConnectFinishResult>("/ui/connect/finish", {
    ...actorBody(actor),
    pendingId: input.pendingId,
    resultToken: input.resultToken,
  });
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

export async function listConnectors(
  actor: ConsoleConnectorActorContext,
  filter: { provider?: string; includeHistory?: boolean } = {},
): Promise<ConnectionSummary[]> {
  const result = await call<{ connections?: unknown[] }>("/ui/connect/list", {
    ...actorBody(actor),
    provider: filter.provider,
    includeHistory: filter.includeHistory,
  });
  return (Array.isArray(result?.connections) ? result.connections : [])
    .map(normalizeConnectionSummary)
    .filter((connection): connection is ConnectionSummary => connection !== null);
}

export async function renameConnector(
  actor: ConsoleConnectorActorContext,
  connectorId: string,
  displayName: string,
): Promise<void> {
  await call<{ ok: boolean }>(`/ui/connect/rename/${encodeURIComponent(connectorId)}`, {
    ...actorBody(actor),
    displayName,
  });
}

export async function makeDefaultConnector(
  actor: ConsoleConnectorActorContext,
  connectorId: string,
): Promise<void> {
  await call<{ ok: boolean }>(`/ui/connect/default/${encodeURIComponent(connectorId)}`, actorBody(actor));
}

export async function revokeConnector(
  actor: ConsoleConnectorActorContext,
  connectorId: string,
): Promise<void> {
  await call<{ revoked: boolean }>(`/ui/connect/revoke/${encodeURIComponent(connectorId)}`, actorBody(actor));
}

/** One connection with its tools, who uses it, and its recent activity. Owner only. */
export async function getConnectionDetail(
  actor: ConsoleConnectorActorContext,
  connectorId: string,
): Promise<ConnectionDetail> {
  const result = await call<unknown>(`/ui/connect/detail/${encodeURIComponent(connectorId)}`, actorBody(actor));
  const detail = normalizeConnectionDetail(result);
  if (!detail) throw new ConsoleConnectorClientError(502, "connector_service_unavailable", "Unexpected connection detail");
  return detail;
}

/** The person's own policy for one tool. Looser than the admin ceiling fails with `connector_policy_above_ceiling`. */
export async function setToolPolicy(
  actor: ConsoleConnectorActorContext,
  connectorId: string,
  input: { capability: string; policy: ToolPolicy },
): Promise<void> {
  await call<{ ok: boolean }>(`/ui/connect/tools/${encodeURIComponent(connectorId)}`, {
    ...actorBody(actor),
    capability: input.capability,
    policy: input.policy,
  });
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

/** Pending approvals the person must decide. */
export async function listApprovals(actor: ConsoleConnectorActorContext): Promise<ApprovalSummary[]> {
  const result = await call<{ approvals?: unknown[] }>("/ui/approvals/list", actorBody(actor));
  return (Array.isArray(result?.approvals) ? result.approvals : [])
    .map(normalizeApprovalSummary)
    .filter((approval): approval is ApprovalSummary => approval !== null);
}

/** One approval with its decrypted preview. The Worker answers only its owner. */
export async function getApproval(actor: ConsoleConnectorActorContext, approvalId: string): Promise<ApprovalDetail> {
  const result = await call<unknown>(`/ui/approvals/get/${encodeURIComponent(approvalId)}`, actorBody(actor));
  const approval = normalizeApprovalDetail(result);
  if (!approval) throw new ConsoleConnectorClientError(502, "connector_service_unavailable", "Unexpected approval");
  return approval;
}

export async function decideApproval(
  actor: ConsoleConnectorActorContext,
  approvalId: string,
  decision: ApprovalDecision,
): Promise<{ status: string }> {
  const result = await call<{ status?: unknown }>(`/ui/approvals/decide/${encodeURIComponent(approvalId)}`, {
    ...actorBody(actor),
    decision,
  });
  return { status: stringOrNull(result?.status) ?? (decision === "approve" ? "approved" : "denied") };
}

// ---------------------------------------------------------------------------
// Organization admin (owners and admins; the Worker checks the role)
// ---------------------------------------------------------------------------

export async function getOrgPolicy(admin: ConsoleConnectorAdminContext, provider: string): Promise<OrgPolicy> {
  const result = await call<unknown>("/ui/admin/policy/get", { ...roleBody(admin), provider });
  return normalizeOrgPolicy(result, provider);
}

export async function setOrgPolicy(admin: ConsoleConnectorAdminContext, input: OrgPolicyUpdate): Promise<OrgPolicy> {
  const result = await call<unknown>("/ui/admin/policy/set", {
    ...roleBody(admin),
    enabled: input.enabled,
    provider: input.provider,
    sharedAllowed: input.sharedAllowed,
    toolCeilings: input.toolCeilings,
    writesAllowed: input.writesAllowed,
  });
  return normalizeOrgPolicy(result, input.provider);
}

/** Every member's connections in the organization. Metadata only: never tokens or content. */
export async function listAdminConnections(
  admin: ConsoleConnectorAdminContext,
  filter: { provider?: string } = {},
): Promise<AdminConnectionRow[]> {
  const result = await call<{ connections?: unknown[] }>("/ui/admin/connections/list", {
    ...roleBody(admin),
    provider: filter.provider,
  });
  return (Array.isArray(result?.connections) ? result.connections : [])
    .map(normalizeAdminConnection)
    .filter((connection): connection is AdminConnectionRow => connection !== null);
}

export async function revokeAdminConnection(admin: ConsoleConnectorAdminContext, connectorId: string): Promise<void> {
  await call<{ revoked: boolean }>(
    `/ui/admin/connections/revoke/${encodeURIComponent(connectorId)}`,
    roleBody(admin),
  );
}

// ---------------------------------------------------------------------------
// Agents that use the person's account when they ask (consent)
// ---------------------------------------------------------------------------

/** What a consent link asks, for the person it was sent to. Inert. */
export async function resolveConsent(actor: ConsoleConnectorActorContext, token: string): Promise<ConsentView> {
  return normalizeConsentView(await call<unknown>("/ui/consent/resolve", { ...actorBody(actor), token }));
}

/** "Approve" (with the account the agent will use) or "Deny". */
export async function decideConsent(
  actor: ConsoleConnectorActorContext,
  input: { token: string; decision: ConsentDecision; connectionId?: string },
): Promise<ConsentDecisionResult> {
  const result = await call<{ status?: unknown; grantId?: unknown }>("/ui/consent/decide", {
    ...actorBody(actor),
    connectionId: input.connectionId,
    decision: input.decision,
    token: input.token,
  });
  return {
    grantId: stringOrNull(result?.grantId),
    status: stringOrNull(result?.status) ?? (input.decision === "approve" ? "approved" : "denied"),
  };
}

/** The agents the person allowed to use their accounts when they ask. */
export async function listConsentGrants(actor: ConsoleConnectorActorContext): Promise<AgentGrantRow[]> {
  const result = await call<{ grants?: unknown[] }>("/ui/consent/list", actorBody(actor));
  return grantRows(result?.grants);
}

export async function revokeConsentGrant(actor: ConsoleConnectorActorContext, grantId: string): Promise<void> {
  await call<{ ok: boolean }>(`/ui/consent/revoke/${encodeURIComponent(grantId)}`, actorBody(actor));
}

// ---------------------------------------------------------------------------
// Organization accounts and where agents share them (owners and admins, and
// for the accounts they manage, their manager; the Worker decides)
// ---------------------------------------------------------------------------

/**
 * The organization's own accounts, with the member who manages each: every
 * one for an owner or admin, only the ones they manage for anyone else.
 */
export async function listOrgConnections(member: ConsoleConnectorMemberContext): Promise<ConnectionSummary[]> {
  const result = await call<{ connections?: unknown[] }>("/ui/org/connections/list", roleBody(member));
  return (Array.isArray(result?.connections) ? result.connections : [])
    .map(normalizeConnectionSummary)
    .filter((connection): connection is ConnectionSummary => connection !== null)
    .map((connection) => ({ ...connection, managedBy: connection.managedBy ?? null, scopeKind: "organization" as const }));
}

/** Who manages an organization account: approvals for it go to them. Owners and admins only. */
export async function setOrgConnectionOwner(
  admin: ConsoleConnectorAdminContext,
  connectorId: string,
  managedByUserId: string,
): Promise<void> {
  await call<{ ok: boolean }>(`/ui/org/connections/owner/${encodeURIComponent(connectorId)}`, {
    ...roleBody(admin),
    managedByUserId,
  });
}

/** Lets one agent on one computer use an organization account in the conversations named. */
export async function grantSharedUse(
  member: ConsoleConnectorMemberContext,
  input: SharedGrantInput,
): Promise<{ grantId: string }> {
  const result = await call<{ grantId?: unknown }>("/ui/org/shared/grant", {
    ...roleBody(member),
    agentId: input.agentId,
    connectionId: input.connectionId,
    conversations: input.conversations,
    installationId: input.installationId,
  });
  const grantId = stringOrNull(result?.grantId);
  if (!grantId) throw new ConsoleConnectorClientError(502, "connector_service_unavailable", "Unexpected grant");
  return { grantId };
}

export async function revokeSharedGrant(member: ConsoleConnectorMemberContext, grantId: string): Promise<void> {
  await call<{ ok: boolean }>(`/ui/org/shared/revoke/${encodeURIComponent(grantId)}`, roleBody(member));
}

/**
 * Shared grants of the organization's accounts (for a manager, of the
 * accounts they manage); one account's with `connectionId`.
 */
export async function listSharedGrants(
  member: ConsoleConnectorMemberContext,
  filter: { connectionId?: string } = {},
): Promise<AgentGrantRow[]> {
  const result = await call<{ grants?: unknown[] }>("/ui/org/shared/list", {
    ...roleBody(member),
    connectionId: filter.connectionId,
  });
  return grantRows(result?.grants);
}

// ---------------------------------------------------------------------------
// Normalizers: the screens read one shape even when a field is missing
// ---------------------------------------------------------------------------

const TOOL_POLICIES = new Set<ToolPolicy>(["always_allow", "needs_approval", "blocked"]);

function toolPolicyOrNull(value: unknown): ToolPolicy | null {
  return typeof value === "string" && TOOL_POLICIES.has(value as ToolPolicy) ? (value as ToolPolicy) : null;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    : [];
}

function normalizeUsageRow(raw: Record<string, unknown>): UsageRow {
  const mode = raw.mode === "person_asking" || raw.mode === "shared" ? raw.mode : "owner";
  return {
    agentId: stringOrNull(raw.agentId),
    conversation: stringOrNull(raw.conversation) ?? "terminal",
    installationId: stringOrNull(raw.installationId),
    installationName: stringOrNull(raw.installationName),
    lastUsedAt: stringOrNull(raw.lastUsedAt) ?? "",
    legacyCli: raw.legacyCli === true,
    mode,
    routineKey: stringOrNull(raw.routineKey),
    useCount: typeof raw.useCount === "number" ? raw.useCount : 0,
  };
}

function normalizeToolRow(raw: Record<string, unknown>): ToolRow | null {
  const capability = stringOrNull(raw.capability);
  if (!capability) return null;
  const toolClass = raw.class === "write" || raw.class === "destructive" ? raw.class : "read";
  return {
    available: raw.available !== false,
    capability,
    ceiling: toolPolicyOrNull(raw.ceiling),
    class: toolClass,
    label: stringOrNull(raw.label) ?? capability,
    policy: toolPolicyOrNull(raw.policy) ?? (toolClass === "read" ? "always_allow" : "needs_approval"),
    userPolicy: toolPolicyOrNull(raw.userPolicy),
  };
}

function normalizeActivityRow(raw: Record<string, unknown>): ActivityRow | null {
  const action = stringOrNull(raw.action);
  const at = stringOrNull(raw.at);
  if (!action || !at) return null;
  return {
    action,
    agentId: stringOrNull(raw.agentId),
    at,
    capability: stringOrNull(raw.capability),
    code: stringOrNull(raw.code),
    conversation: stringOrNull(raw.conversation),
    outcome: raw.outcome === "denied" || raw.outcome === "failed" ? raw.outcome : "ok",
  };
}

/** `{ userId, email }`, or null when the Worker names nobody. */
function personRef(value: unknown): { userId: string; email: string | null } | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const userId = stringOrNull(raw.userId);
  return userId ? { email: stringOrNull(raw.email), userId } : null;
}

export function normalizeGrantRow(value: unknown): AgentGrantRow | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const id = stringOrNull(raw.id);
  if (!id) return null;
  return {
    agentId: stringOrNull(raw.agentId) ?? "",
    connectionId: stringOrNull(raw.connectionId),
    conversations: Array.isArray(raw.conversations)
      ? raw.conversations.filter((item): item is string => typeof item === "string")
      : [],
    createdAt: stringOrNull(raw.createdAt) ?? "",
    email: stringOrNull(raw.email),
    id,
    installationId: stringOrNull(raw.installationId) ?? "",
    installationName: stringOrNull(raw.installationName),
    mode: raw.mode === "shared" ? "shared" : "person_asking",
    operator: personRef(raw.operator),
    provider: stringOrNull(raw.provider) ?? "",
  };
}

function grantRows(value: unknown): AgentGrantRow[] {
  return records(value)
    .map(normalizeGrantRow)
    .filter((row): row is AgentGrantRow => row !== null);
}

const CONSENT_END_STATES = new Set(["expired", "used", "user_mismatch", "invalid"]);

/** A consent request as the page reads it; anything unexpected is `invalid`. */
export function normalizeConsentView(value: unknown): ConsentView {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const state = stringOrNull(raw.state);
  if (state === "pending") {
    const provider = stringOrNull(raw.provider);
    const agentId = stringOrNull(raw.agentId);
    if (provider && agentId) {
      return {
        agentDisplayName: stringOrNull(raw.agentDisplayName),
        agentId,
        connections: records(raw.connections)
          .map((item) => {
            const id = stringOrNull(item.id);
            return id ? { email: stringOrNull(item.email), id, isDefault: item.isDefault === true } : null;
          })
          .filter((item): item is { id: string; email: string | null; isDefault: boolean } => item !== null),
        expiresAt: stringOrNull(raw.expiresAt) ?? "",
        installationName: stringOrNull(raw.installationName),
        operatorEmail: stringOrNull(raw.operatorEmail),
        operatorName: stringOrNull(raw.operatorName),
        provider,
        state: "pending",
      };
    }
  }
  if (state && CONSENT_END_STATES.has(state)) {
    return { state: state as "expired" | "used" | "user_mismatch" | "invalid" };
  }
  return { state: "invalid" };
}

export function normalizeConnectionDetail(value: unknown): ConnectionDetail | null {
  const summary = normalizeConnectionSummary(value);
  if (!summary) return null;
  const raw = value as Record<string, unknown>;
  const usage = records(raw.usage).map(normalizeUsageRow);
  return {
    ...summary,
    activity: records(raw.activity)
      .map(normalizeActivityRow)
      .filter((row): row is ActivityRow => row !== null),
    grants: grantRows(raw.grants),
    tools: records(raw.tools)
      .map(normalizeToolRow)
      .filter((row): row is ToolRow => row !== null),
    usage: usage.length ? usage : summary.usedBy,
  };
}

export function normalizeApprovalSummary(value: unknown): ApprovalSummary | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const id = stringOrNull(raw.id);
  const capability = stringOrNull(raw.capability);
  if (!id || !capability) return null;
  return {
    agentId: stringOrNull(raw.agentId),
    capability,
    connectionId: stringOrNull(raw.connectionId) ?? "",
    conversation: stringOrNull(raw.conversation),
    email: stringOrNull(raw.email),
    expiresAt: stringOrNull(raw.expiresAt) ?? "",
    id,
    installationName: stringOrNull(raw.installationName),
    label: stringOrNull(raw.label) ?? capability,
    reason: raw.reason === "write_after_read" ? "write_after_read" : "policy",
    requestedAt: stringOrNull(raw.requestedAt) ?? "",
  };
}

export function normalizeApprovalDetail(value: unknown): ApprovalDetail | null {
  const summary = normalizeApprovalSummary(value);
  if (!summary) return null;
  const raw = value as Record<string, unknown>;
  const routine = raw.routine && typeof raw.routine === "object" ? (raw.routine as Record<string, unknown>) : null;
  const routineKind = routine ? stringOrNull(routine.kind) : null;
  const routineId = routine ? stringOrNull(routine.id) : null;
  return {
    ...summary,
    preview:
      raw.preview && typeof raw.preview === "object" && !Array.isArray(raw.preview)
        ? (raw.preview as Record<string, unknown>)
        : null,
    routine: routineKind ? { kind: routineKind, ...(routineId ? { id: routineId } : {}) } : null,
    sessionName: stringOrNull(raw.sessionName),
    speakerKind: stringOrNull(raw.speakerKind),
    status: stringOrNull(raw.status) ?? "pending",
  };
}

export function normalizeOrgPolicy(value: unknown, provider: string): OrgPolicy {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const ceilings: Record<string, ToolPolicy> = {};
  if (raw.toolCeilings && typeof raw.toolCeilings === "object") {
    for (const [capability, policy] of Object.entries(raw.toolCeilings as Record<string, unknown>)) {
      const parsed = toolPolicyOrNull(policy);
      if (parsed) ceilings[capability] = parsed;
    }
  }
  return {
    // No policy row means the defaults: enabled, writes allowed, no ceilings, shared off.
    enabled: raw.enabled !== false,
    provider: stringOrNull(raw.provider) ?? provider,
    sharedAllowed: raw.sharedAllowed === true,
    toolCeilings: ceilings,
    tools: records(raw.tools)
      .map((tool) => {
        const capability = stringOrNull(tool.capability);
        if (!capability) return null;
        return { capability, class: stringOrNull(tool.class) ?? "read", label: stringOrNull(tool.label) ?? capability };
      })
      .filter((tool): tool is OrgPolicy["tools"][number] => tool !== null),
    writesAllowed: raw.writesAllowed !== false,
  };
}

export function normalizeAdminConnection(value: unknown): AdminConnectionRow | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const id = stringOrNull(raw.id);
  const provider = stringOrNull(raw.provider);
  if (!id || !provider || provider === "github") return null;
  const member = raw.member && typeof raw.member === "object" ? (raw.member as Record<string, unknown>) : {};
  return {
    createdAt: stringOrNull(raw.createdAt) ?? "",
    email: stringOrNull(raw.email),
    id,
    lastUsedAt: stringOrNull(raw.lastUsedAt),
    member: { email: stringOrNull(member.email), name: stringOrNull(member.name), userId: stringOrNull(member.userId) },
    provider,
    requiresReauth: raw.requiresReauth === true,
    scopeKind: stringOrNull(raw.scopeKind) ?? "user",
    status: stringOrNull(raw.status) ?? "active",
  };
}

/**
 * Fills the fields a Worker from before personal connections leaves out, so
 * the screens read one shape during the rollout. GitHub rows are project
 * installations and never belong in this list.
 */
export function normalizeConnectionSummary(value: unknown): ConnectionSummary | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const id = stringOrNull(raw.id);
  const provider = stringOrNull(raw.provider);
  if (!id || !provider || provider === "github") return null;
  const createdAt = stringOrNull(raw.createdAt) ?? stringOrNull(raw.grantedAt) ?? "";
  return {
    accessMode: raw.accessMode === "read_only" ? "read_only" : "full",
    createdAt,
    displayName: stringOrNull(raw.displayName) ?? "",
    email: stringOrNull(raw.email) ?? stringOrNull(raw.externalAccountLogin),
    grantedAt: stringOrNull(raw.grantedAt) ?? createdAt,
    id,
    isDefault: raw.isDefault === true,
    lastUsedAt: stringOrNull(raw.lastUsedAt),
    provider,
    requiresReauth: raw.requiresReauth === true,
    revokedAt: stringOrNull(raw.revokedAt),
    scopeKind: raw.scopeKind === "organization" ? "organization" : "user",
    scopes: Array.isArray(raw.scopes) ? raw.scopes.filter((scope): scope is string => typeof scope === "string") : [],
    status: stringOrNull(raw.status) ?? "active",
    usedBy: records(raw.usedBy).map(normalizeUsageRow),
    ...(raw.managedBy !== undefined ? { managedBy: personRef(raw.managedBy) } : {}),
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

const REASON_RE = /^[a-z][a-z0-9_]{0,63}$/;

/** The `reason` detail of a Worker error body, when it is a plain code. */
function errorReason(details: unknown): string | null {
  if (!details || typeof details !== "object") return null;
  const reason = (details as Record<string, unknown>).reason;
  return typeof reason === "string" && REASON_RE.test(reason) ? reason : null;
}

function normalizeError(error: unknown): ConsoleConnectorClientError {
  if (error instanceof ConsoleConnectorClientError) return error;
  if (error instanceof LinkHmacError) {
    return new ConsoleConnectorClientError(error.status, error.code, error.message, errorReason(error.details));
  }
  return new ConsoleConnectorClientError(500, "internal_error", "Unexpected connectors error");
}
