import { ApiError, describeError } from "@/lib/api/client";
import { CONNECTION_NAME_MAX_LENGTH } from "@/shared/integrations/connection-limits";
import { listProviderDefinitions } from "@/shared/integrations/provider-registry";
import { connectableProviders } from "@/shared/integrations/connectable-providers";
import type {
  ActivityRow,
  AdminConnectionRow,
  AgentGrantRow,
  ApprovalDetail,
  ApprovalSummary,
  ConnectFinishResult,
  ConnectionDetail,
  ConnectionSummary,
  ConnectorAccessMode,
  ConnectorUseMode,
  ConsentView,
  OrgPolicy,
  SharedConversation,
  ToolCeilingChange,
  ToolPolicy,
  ToolRow,
  UsageRow,
} from "@/server/connectors/console-client";
import type { InstallationRow, OrganizationInstallationRow } from "@/server/connectors/installations";
import type { Tone } from "@/ui/badge";

/**
 * A connection as `/api/internal/connectors/list` returns it: one account of
 * the signed-in person. The worker lists, runs and revokes by person; no
 * project is involved.
 */
export type Connection = ConnectionSummary;

export type ConnectionsResponse = { status: "ok"; connections: Connection[] };
export type ConnectStartResponse = { status: "ok"; authorizationUrl: string; pendingGrantId: string; expiresAt: string };
export type ConnectContinueResponse = { status: "ok"; authorizationUrl: string };
export type ConnectFinishResponse = { status: "ok" } & ConnectFinishResult;
export type InstallationsResponse = { status: "ok"; installations: InstallationRow[] };

export const CONNECTIONS_ENDPOINT = "/api/internal/connectors/list";
export const CONNECT_START_ENDPOINT = "/api/internal/connectors/connect/start";
export const CONNECT_CONTINUE_ENDPOINT = "/api/internal/connectors/connect/continue";
export const CONNECT_FINISH_ENDPOINT = "/api/internal/connectors/connect/finish";
export const INSTALLATIONS_ENDPOINT = "/api/internal/connectors/installations";
export const revokeEndpoint = (id: string) => `/api/internal/connectors/revoke/${encodeURIComponent(id)}`;
export const revokeInstallationEndpoint = (id: string) =>
  `/api/internal/connectors/installations/${encodeURIComponent(id)}/revoke`;
export const renameEndpoint = (id: string) => `/api/internal/connectors/${encodeURIComponent(id)}/rename`;
export const defaultEndpoint = (id: string) => `/api/internal/connectors/${encodeURIComponent(id)}/default`;
export const detailEndpoint = (id: string) => `/api/internal/connectors/${encodeURIComponent(id)}/detail`;
export const toolsEndpoint = (id: string) => `/api/internal/connectors/${encodeURIComponent(id)}/tools`;
export const APPROVALS_ENDPOINT = "/api/internal/connectors/approvals/list";
export const decideEndpoint = (id: string) => `/api/internal/connectors/approvals/${encodeURIComponent(id)}/decide`;
/** The page an approval link opens. */
export const approvalHref = (id: string) => `/connectors/approvals/${encodeURIComponent(id)}`;
export const ADMIN_POLICY_ENDPOINT = "/api/internal/connectors/admin/policy";
export const ADMIN_POLICY_SET_ENDPOINT = "/api/internal/connectors/admin/policy/set";
export const ADMIN_CONNECTIONS_ENDPOINT = "/api/internal/connectors/admin/connections";
export const adminRevokeEndpoint = (id: string) =>
  `/api/internal/connectors/admin/connections/${encodeURIComponent(id)}/revoke`;

export const CONSENT_DECIDE_ENDPOINT = "/api/internal/connectors/consent/decide";
export const CONSENT_LIST_ENDPOINT = "/api/internal/connectors/consent/list";
export const consentRevokeEndpoint = (id: string) => `/api/internal/connectors/consent/${encodeURIComponent(id)}/revoke`;
export const ORG_CONNECTIONS_ENDPOINT = "/api/internal/connectors/org/connections";
export const orgOwnerEndpoint = (id: string) => `/api/internal/connectors/org/connections/${encodeURIComponent(id)}/owner`;
export const ORG_SHARED_ENDPOINT = "/api/internal/connectors/org/shared";
export const ORG_SHARED_LIST_ENDPOINT = "/api/internal/connectors/org/shared/list";
export const orgSharedRevokeEndpoint = (id: string) =>
  `/api/internal/connectors/org/shared/${encodeURIComponent(id)}/revoke`;
export const ORG_INSTALLATIONS_ENDPOINT = "/api/internal/connectors/org/installations";

export type ConnectionDetailResponse = { status: "ok"; connection: ConnectionDetail };
export type ApprovalsResponse = { status: "ok"; approvals: ApprovalSummary[] };
export type ApprovalDecideResponse = { status: "ok"; approvalStatus: string };
export type OrgPolicyResponse = { status: "ok"; policy: OrgPolicy };
export type AdminConnectionsResponse = { status: "ok"; connections: AdminConnectionRow[] };
export type AgentGrantsResponse = { status: "ok"; grants: AgentGrantRow[] };
export type ConsentDecideResponse = { status: "ok"; consentStatus: string; grantId: string | null };
export type OrgConnectionsResponse = { status: "ok"; connections: Connection[] };
export type OrgInstallationsResponse = { status: "ok"; installations: OrganizationInstallationRow[] };
export type SharedGrantResponse = { status: "ok"; grantId: string };

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------


export type ConnectableProvider = {
  id: string;
  name: string;
  /** What connecting lets agents do, in one sentence. */
  pitch: string;
  /** What full access allows, as the permissions people will grant. */
  permissions: string[];
  /** What read-only access allows: the same without any write. */
  readOnlyPermissions: string[];
};

const PROVIDER_PITCH: Record<string, string> = {
  google: "Read and send email and see your calendar, from your agents and the ravi CLI.",
};

export function providerName(providerId: string) {
  const known = listProviderDefinitions().find((provider) => provider.connectionProviderId === providerId);
  if (known) return known.displayName;
  return providerId ? `${providerId.charAt(0).toUpperCase()}${providerId.slice(1)}` : "Account";
}

// ---------------------------------------------------------------------------
// Scopes in words
// ---------------------------------------------------------------------------

const GOOGLE_SCOPE_PREFIX = "https://www.googleapis.com/auth/";

/** Ordered: the order here is the order permissions are listed in. */
const SCOPE_LABELS: Array<[scope: string, label: string]> = [
  ["https://mail.google.com/", "Full access to email"],
  [`${GOOGLE_SCOPE_PREFIX}gmail.modify`, "Manage email"],
  [`${GOOGLE_SCOPE_PREFIX}gmail.readonly`, "Read email"],
  [`${GOOGLE_SCOPE_PREFIX}gmail.compose`, "Write drafts"],
  [`${GOOGLE_SCOPE_PREFIX}gmail.send`, "Send email"],
  [`${GOOGLE_SCOPE_PREFIX}calendar`, "Manage calendar"],
  [`${GOOGLE_SCOPE_PREFIX}calendar.events`, "Edit calendar events"],
  [`${GOOGLE_SCOPE_PREFIX}calendar.readonly`, "See calendar"],
  [`${GOOGLE_SCOPE_PREFIX}drive`, "Manage Drive files"],
  [`${GOOGLE_SCOPE_PREFIX}drive.readonly`, "See Drive files"],
  [`${GOOGLE_SCOPE_PREFIX}drive.file`, "Files you choose in Drive"],
];
const SCOPE_ORDER = new Map(SCOPE_LABELS.map(([scope], index) => [scope, index]));
const SCOPE_TEXT = new Map(SCOPE_LABELS);

/** Identity scopes every sign-in includes; they say nothing about what agents can do. */
const HIDDEN_SCOPES = new Set([
  "openid",
  "email",
  "profile",
  `${GOOGLE_SCOPE_PREFIX}userinfo.email`,
  `${GOOGLE_SCOPE_PREFIX}userinfo.profile`,
]);

function normalizeScope(scope: string) {
  const value = scope.trim();
  if (!value) return value;
  if (value.includes("://") || HIDDEN_SCOPES.has(value)) return value;
  if (/^[a-z]+(\.[a-z_]+)*$/.test(value)) return `${GOOGLE_SCOPE_PREFIX}${value}`;
  return value;
}

/** Permission labels in a stable order, plus how many scopes have no plain-words label. */
export function describeScopes(scopes: readonly string[]) {
  const labels: string[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();
  const normalized = [...new Set(scopes.map(normalizeScope).filter(Boolean))]
    .filter((scope) => !HIDDEN_SCOPES.has(scope))
    .sort((a, b) => (SCOPE_ORDER.get(a) ?? 999) - (SCOPE_ORDER.get(b) ?? 999));
  for (const scope of normalized) {
    const label = SCOPE_TEXT.get(scope);
    if (!label) {
      unknown.push(scope);
      continue;
    }
    if (seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
  }
  return { labels, unknown };
}

export function permissionsSentence(scopes: readonly string[]) {
  const { labels, unknown } = describeScopes(scopes);
  const parts = [...labels];
  if (unknown.length) parts.push(unknown.length === 1 ? "1 more permission" : `${unknown.length} more permissions`);
  return parts.length ? parts.join(" · ") : "Basic profile only";
}

/** Implemented OAuth providers from the shared registry that the worker can actually connect. */
export const CONNECTABLE_PROVIDERS: ConnectableProvider[] = connectableProviders()
  .map((provider) => {
    const actions = provider.actions.filter((action) => action.status === "implemented");
    return {
      id: provider.connectionProviderId,
      name: provider.displayName,
      permissions: describeScopes(actions.flatMap((action) => action.requiredProviderScopes)).labels,
      pitch: PROVIDER_PITCH[provider.connectionProviderId] ?? `Your agents can use your ${provider.displayName} account.`,
      readOnlyPermissions: describeScopes(
        actions.filter((action) => action.class === "read").flatMap((action) => action.requiredProviderScopes),
      ).labels,
    };
  });

export function connectableProvider(providerId: string) {
  return CONNECTABLE_PROVIDERS.find((provider) => provider.id === providerId) ?? null;
}

// ---------------------------------------------------------------------------
// Names, status, grouping
// ---------------------------------------------------------------------------

/** People know their accounts by email, so the email is the name. */
export function connectionName(connection: Pick<Connection, "email" | "displayName" | "provider">) {
  if (connection.email) return connection.email;
  return connectionLabel(connection) ?? `${providerName(connection.provider)} account`;
}

/**
 * The label the person gave the connection, when it says something the email
 * doesn't. The worker names every connection after its provider by default.
 */
export function connectionLabel(connection: Pick<Connection, "email" | "displayName" | "provider">) {
  const label = connection.displayName?.trim();
  if (!label) return null;
  const lower = label.toLowerCase();
  if (lower === connection.provider.toLowerCase() || lower === providerName(connection.provider).toLowerCase()) return null;
  if (connection.email && lower === connection.email.toLowerCase()) return null;
  return label;
}

const PLATFORM_NAMES: Record<string, string> = { darwin: "macOS", linux: "Linux", win32: "Windows" };

/** "macOS · ana-mbp": what tells one computer from another, besides its name. */
export function installationDetails(installation: Pick<InstallationRow, "name" | "hostname" | "platform">) {
  const platform = installation.platform ? (PLATFORM_NAMES[installation.platform] ?? installation.platform) : null;
  const hostname = installation.hostname && installation.hostname !== installation.name ? installation.hostname : null;
  return [platform, hostname].filter(Boolean).join(" · ");
}

export function accessLabel(connection: Pick<Connection, "accessMode">) {
  return connection.accessMode === "read_only" ? "Read only" : "Full access";
}

export type StatusView = {
  label: string;
  tone: Tone;
  /** The next step, said in one sentence. */
  hint?: string;
  next?: "reconnect" | "retry-disconnect";
};

/** Statuses of rows that hold no credentials anymore. */
const HISTORY_STATUSES = new Set(["revoked_by_user", "revoked_by_operator", "revoked_by_provider", "tampered"]);

/** Statuses of rows that still hold, or may hold, credentials. */
const LIVE_STATUSES = new Set(["active", "degraded", "suspended", "revoke_pending"]);

export function isHistory(connection: Pick<Connection, "status">) {
  return HISTORY_STATUSES.has(connection.status);
}

export function connectionStatus(connection: Pick<Connection, "status" | "requiresReauth" | "provider">): StatusView {
  const provider = providerName(connection.provider);
  if (isHistory(connection)) return { label: "Disconnected", tone: "neutral" };
  if (connection.status === "revoke_pending") {
    return {
      hint: `${provider} hasn't confirmed the disconnect yet. Agents can't use it meanwhile; try again to finish it.`,
      label: "Disconnecting…",
      next: "retry-disconnect",
      tone: "warn",
    };
  }
  if (connection.requiresReauth && connection.status !== "suspended") {
    return {
      hint: `${provider} stopped accepting this connection. Reconnect so your agents keep working.`,
      label: "Needs reconnecting",
      next: "reconnect",
      tone: "warn",
    };
  }
  if (connection.status === "suspended" || connection.status === "degraded") {
    return {
      hint: "Ravi paused this connection, so agents can't use it. Contact the Ravi team if you didn't expect this.",
      label: "Paused by Ravi",
      tone: "neutral",
    };
  }
  if (connection.status === "active") return { label: "Connected", tone: "ok" };
  const text = connection.status.replace(/[_-]+/g, " ").trim();
  return { label: text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : "Unknown", tone: "neutral" };
}

/** Why a history row has no access anymore. */
export function historyReason(connection: Pick<Connection, "status" | "provider">) {
  switch (connection.status) {
    case "revoked_by_operator":
      return "Disconnected by Ravi";
    case "revoked_by_provider":
      return `${providerName(connection.provider)} ended access`;
    case "tampered":
      return "Disconnected by Ravi to protect the account";
    default:
      return "You disconnected it";
  }
}

export function isUsable(connection: Pick<Connection, "status" | "requiresReauth">) {
  return connection.status === "active" && !connection.requiresReauth;
}

/** GitHub rows belong to the project's GitHub App, not to the person, and never show here. */
export function isPersonalConnection(connection: Pick<Connection, "provider">) {
  return connection.provider !== "github";
}

function createdTime(connection: Pick<Connection, "createdAt" | "grantedAt">) {
  const time = Date.parse(connection.createdAt || connection.grantedAt);
  return Number.isNaN(time) ? 0 : time;
}

export function newestFirst<T extends Pick<Connection, "createdAt" | "grantedAt">>(items: T[]) {
  return [...items].sort((a, b) => createdTime(b) - createdTime(a));
}

/**
 * The connection commands like `ravi gmail` use without `--connector`, by the
 * CLI's own rule: the live row marked default, even when it needs
 * reconnecting (its status says so), else the newest one that works.
 */
export function defaultConnectionId(connections: Connection[], provider: string) {
  const candidates = newestFirst(connections.filter((connection) => connection.provider === provider));
  const marked = candidates.find((connection) => connection.isDefault && LIVE_STATUSES.has(connection.status));
  return marked?.id ?? candidates.find(isUsable)?.id ?? null;
}

/** Live rows (default first, then newest) and history rows (newest first). */
export function splitConnections(connections: Connection[]) {
  const personal = newestFirst(connections.filter(isPersonalConnection));
  return {
    current: personal
      .filter((connection) => !isHistory(connection))
      .sort((a, b) => Number(b.isDefault) - Number(a.isDefault)),
    history: personal.filter(isHistory),
  };
}

export function groupByProvider(connections: Connection[]) {
  const groups = new Map<string, Connection[]>();
  for (const connection of connections) {
    const list = groups.get(connection.provider) ?? [];
    list.push(connection);
    groups.set(connection.provider, list);
  }
  return [...groups.entries()].map(([provider, items]) => ({ items, name: providerName(provider), provider }));
}

export function connectedDate(connection: Pick<Connection, "createdAt" | "grantedAt">) {
  return connection.grantedAt || connection.createdAt;
}

/** What each row action needs from the connect start route. `organization` starts an organization account. */
export function connectStartBody(
  provider: string,
  options: {
    accessMode?: ConnectorAccessMode;
    reconnect?: Pick<Connection, "id" | "accessMode">;
    scopeKind?: "organization";
  } = {},
) {
  return {
    accessMode: options.accessMode ?? options.reconnect?.accessMode ?? "full",
    provider,
    ...(options.reconnect ? { reconnectConnectionId: options.reconnect.id } : {}),
    ...(options.scopeKind === "organization" ? { scopeKind: "organization" as const } : {}),
  };
}

// ---------------------------------------------------------------------------
// The connect pages
// ---------------------------------------------------------------------------

export type Copy = { title: string; description: string };

/** Fixed copy for a connect link that can't be continued. Never echoes ids or other people. */
export function connectLinkCopy(state: string): Copy {
  switch (state) {
    case "expired":
      return {
        description:
          "Connect links last 10 minutes. Start again from the terminal with `ravi connectors connect google`, or from Connectors.",
        title: "This link has expired",
      };
    case "used":
      return {
        description: "Each link works once. Your connected accounts are listed in Connectors.",
        title: "This link was already used",
      };
    case "user_mismatch":
      return {
        description: "This link was made for another Ravi account. Sign in as that person or ask them for a new link.",
        title: "This link is for someone else",
      };
    case "disabled_by_org":
      return {
        description: "An owner or admin turned this connector off for the organization. Ask them if you need it.",
        title: "This connector is turned off",
      };
    case "not_member":
      return {
        description: "You aren't an active member of the organization this link belongs to. Ask an owner to add you back.",
        title: "No access to this organization",
      };
    case "impersonation":
      return {
        description: "You're signed in as someone else, so you can't connect accounts for them. They need to open this link themselves.",
        title: "Connecting needs the person's own session",
      };
    case "feature_unavailable":
      return {
        description: "Connecting outside accounts isn't available in this organization yet.",
        title: "Connectors aren't enabled here",
      };
    case "feature_forbidden":
      return {
        description: "Your role in this organization doesn't include connectors. Ask an owner or admin.",
        title: "You can't connect accounts here",
      };
    case "unavailable":
      return {
        description: "Ravi couldn't check this link right now. Nothing changed. Try again in a moment.",
        title: "We couldn't open this link",
      };
    default:
      return {
        description: "Check that you opened the whole link, or start again from the terminal or from Connectors.",
        title: "This link isn't valid",
      };
  }
}

/** Why a finished sign-in didn't connect anything. */
export function finishRejectedCopy(reason: string, provider = "Google"): Copy {
  switch (reason) {
    case "provider_denied":
      return {
        description: `You didn't allow access in ${provider}, so nothing was connected. Start again if you want to connect it.`,
        title: "Nothing was connected",
      };
    case "user_mismatch":
      return {
        description: "This sign-in was started by another Ravi account, so nothing was connected. Ask that person to finish it.",
        title: "This sign-in is for someone else",
      };
    case "account_mismatch_org":
      return {
        description: "That account can't be connected in this organization. Sign in with another account and start again.",
        title: "That account can't be used here",
      };
    case "disabled_by_org":
      return {
        description: "An owner or admin turned this connector off for the organization, so nothing was connected.",
        title: "This connector is turned off",
      };
    case "exchange_failed":
      return {
        description: `${provider} didn't finish the sign-in, so nothing was connected. Start again in a moment.`,
        title: "The sign-in didn't finish",
      };
    case "identity_missing":
      return {
        description: `${provider} didn't say which account you signed in with, so nothing was connected. Start again and allow Ravi to see your email address.`,
        title: "We couldn't tell which account it was",
      };
    case "not_member":
      return {
        description: "You're no longer a member of this organization, so nothing was connected.",
        title: "Nothing was connected",
      };
    case "account_changed":
      return {
        description: `You signed in with a different ${provider} account than the organization account you were reconnecting, so nothing changed. Reconnect and sign in with that same account.`,
        title: "That's a different account",
      };
    case "forbidden":
      return {
        description:
          "Only owners, admins and the member who manages an organization account can connect it, so nothing was connected. Ask an owner or admin.",
        title: "You can't connect this organization account",
      };
    default:
      return {
        description: "Nothing was connected. Start again from the terminal or from Connectors.",
        title: "Nothing was connected",
      };
  }
}

/** The sign-in came back to a browser that didn't start it. */
export const FINISH_OTHER_BROWSER_COPY: Copy = {
  description:
    "A sign-in can only finish in the browser where you clicked Connect or Continue, so nothing was connected. Start again from Connectors or the terminal.",
  title: "Start again in this browser",
};

export type FinishConnectedView = {
  title: string;
  /** Shown in bold before `sentence`; null when the account's email isn't known. */
  account: string | null;
  sentence: string;
  /** Where the account is listed now. */
  href: "/connectors" | "/org/connectors";
  linkLabel: string;
  /** Where both accounts are listed after a reconnect that signed in as another one. */
  listedIn: string;
};

/**
 * What `/connect/finish` says once the account is stored. An organization
 * account isn't the person's own and is listed in Organization accounts,
 * not in their connections. Only a new one is managed by whoever connected
 * it; a reconnect keeps its manager.
 */
export function finishConnectedView(
  result: Pick<Extract<ConnectFinishResult, { state: "connected" }>, "provider" | "email" | "created" | "reconnected" | "accountChanged" | "scopeKind">,
): FinishConnectedView {
  const provider = providerName(result.provider);
  const reconnected = result.reconnected && !result.accountChanged;
  if (result.scopeKind === "organization") {
    const sentence = reconnected
      ? "works again for the agents that share it."
      : result.created
        ? "is now an account of the organization, and you manage it: its approvals come to you. Agents use it only where an owner or admin shares it."
        : "is connected as an account of the organization. Agents use it only where an owner or admin shares it.";
    return {
      account: result.email,
      href: "/org/connectors",
      linkLabel: "View organization accounts",
      listedIn: "Organization accounts",
      sentence: result.email ? sentence : `The organization's ${provider} account ${sentence}`,
      title: reconnected ? `Organization ${provider} account reconnected` : `Organization ${provider} account connected`,
    };
  }
  const sentence = "is connected to your Ravi account. Agents use it only as you allow.";
  return {
    account: result.email,
    href: "/connectors",
    linkLabel: "View your connections",
    listedIn: "Connectors",
    sentence: result.email ? sentence : `Your ${provider} account ${sentence}`,
    title: reconnected ? `${provider} reconnected` : `${provider} connected`,
  };
}

export function finishStateCopy(state: "expired" | "invalid"): Copy {
  return state === "expired"
    ? {
        description: "Sign-ins last 10 minutes, so nothing was connected. Start again from the terminal or from Connectors.",
        title: "This sign-in expired",
      }
    : {
        description: "This page opens after you sign in with a provider, and this one has nothing to finish. Your connected accounts are listed in Connectors.",
        title: "Nothing to finish here",
      };
}

// ---------------------------------------------------------------------------
// Tools and their rules
// ---------------------------------------------------------------------------

export const TOOL_POLICIES: ToolPolicy[] = ["always_allow", "needs_approval", "blocked"];

export const TOOL_POLICY_LABELS: Record<ToolPolicy, string> = {
  always_allow: "Always allow",
  blocked: "Blocked",
  needs_approval: "Needs approval",
};

const STRICTNESS: Record<ToolPolicy, number> = { always_allow: 0, blocked: 2, needs_approval: 1 };

/** The stricter of two rules: Blocked, then Needs approval, then Always allow. */
export function stricterPolicy(a: ToolPolicy, b: ToolPolicy | null | undefined): ToolPolicy {
  if (!b) return a;
  return STRICTNESS[b] > STRICTNESS[a] ? b : a;
}

export type ToolGroup<T> = { key: "read" | "write"; title: string; tools: T[] };

/** Read and Write, in that order, without empty groups. Destructive tools are writes. */
export function groupTools<T extends { class: string }>(tools: T[]): ToolGroup<T>[] {
  const read = tools.filter((tool) => tool.class === "read");
  const write = tools.filter((tool) => tool.class !== "read");
  return [
    { key: "read" as const, title: "Read", tools: read },
    { key: "write" as const, title: "Write", tools: write },
  ].filter((group) => group.tools.length > 0);
}

/** What the select shows: the rule in force, never looser than the ceiling. */
export function toolPolicyValue(tool: Pick<ToolRow, "policy" | "ceiling">): ToolPolicy {
  return stricterPolicy(tool.policy, tool.ceiling);
}

export type PolicyOption = { value: ToolPolicy; label: string; disabled: boolean };

/** The three rules; the ones looser than the organization's ceiling can't be picked. */
export function toolPolicyOptions(tool: Pick<ToolRow, "ceiling">): PolicyOption[] {
  return TOOL_POLICIES.map((value) => ({
    disabled: Boolean(tool.ceiling && STRICTNESS[value] < STRICTNESS[tool.ceiling]),
    label: TOOL_POLICY_LABELS[value],
    value,
  }));
}

/** One short line under a tool's select, when something limits it. */
export function toolPolicyHint(tool: Pick<ToolRow, "available" | "ceiling" | "class">): string | null {
  if (!tool.available) {
    return tool.class === "read"
      ? "Not allowed when you connected this account. Reconnect to add it."
      : "This account is read only. Allow writing to use it.";
  }
  if (tool.ceiling === "blocked") return "Your organization blocked this tool.";
  if (tool.ceiling === "needs_approval") return "Your organization requires approval, so Always allow is off.";
  return null;
}

// ---------------------------------------------------------------------------
// Used by and recent activity
// ---------------------------------------------------------------------------

const USE_MODE_LABELS: Record<ConnectorUseMode, string> = {
  owner: "Only when you ask",
  person_asking: "The person asking",
  shared: "Shared account",
};

export function connectorModeLabel(mode: ConnectorUseMode) {
  return USE_MODE_LABELS[mode] ?? USE_MODE_LABELS.owner;
}

/** "cron:daily-brief" in words. Unknown keys are shown as they are. */
export function routineLabel(routineKey: string | null | undefined) {
  const key = routineKey?.trim();
  if (!key) return null;
  const [kind, ...rest] = key.split(":");
  const id = rest.join(":").trim();
  switch (kind) {
    case "cron":
      return id ? `Cron job ${id}` : "A cron job";
    case "heartbeat":
      return "Heartbeat";
    case "trigger":
      return id ? `Trigger ${id}` : "A trigger";
    default:
      return key;
  }
}

const CONVERSATION_LABELS: Record<string, string> = {
  automation: "Routine",
  dm: "Direct message",
  group: "Group chat",
  terminal: "Terminal",
};

export function conversationLabel(conversation: string | null | undefined) {
  if (!conversation || conversation === "legacy_cli") return null;
  return CONVERSATION_LABELS[conversation] ?? conversation;
}

/** Who used the account, and where: "Agent main on ana-mbp". */
export function usageTitle(row: Pick<UsageRow, "agentId" | "installationName" | "legacyCli" | "conversation">) {
  const where = row.installationName ? ` on ${row.installationName}` : "";
  if (row.legacyCli) return `An older Ravi version${where}`;
  if (row.agentId) return `Agent ${row.agentId}${where}`;
  return row.installationName ? `The terminal on ${row.installationName}` : "The terminal";
}

/** The routine, the conversation and the mode, as one gray line. */
export function usageDetails(row: Pick<UsageRow, "routineKey" | "conversation" | "mode" | "legacyCli">) {
  if (row.legacyCli) return "Says nothing about the agent or routine. Update ravi on that computer to see them.";
  const conversation = row.conversation === "terminal" ? null : conversationLabel(row.conversation);
  return [routineLabel(row.routineKey), conversation, connectorModeLabel(row.mode)].filter(Boolean).join(" · ");
}

function usageShortName(row: Pick<UsageRow, "agentId" | "installationName" | "legacyCli">) {
  if (row.legacyCli) return row.installationName ? `an older Ravi version on ${row.installationName}` : "an older Ravi version";
  if (row.agentId) return row.installationName ? `${row.agentId} on ${row.installationName}` : row.agentId;
  return row.installationName ?? "the terminal";
}

/** "Used by: main on ana-mbp, the terminal +1 more" for a row; null when nothing used it yet. */
export function usedBySentence(usedBy: UsageRow[], shown = 2) {
  if (!usedBy.length) return null;
  const names = [...new Set(usedBy.map(usageShortName))];
  const head = names.slice(0, shown).join(", ");
  const more = names.length - shown;
  return `Used by: ${head}${more > 0 ? ` +${more} more` : ""}`;
}

/**
 * A refused action in words, by the Worker's refusal code. A write that waits
 * for the owner is audited as refused too, and isn't a refusal to the person.
 */
const REFUSAL_TEXT: Record<string, string> = {
  connector_approval_denied: "You denied it",
  connector_approval_pending: "Waiting for your approval",
  connector_approval_required: "Asked for your approval",
};

export type ActivityView = { text: string; badge: { label: string; tone: Tone } | null };

/**
 * One activity row in words. The Worker lists only actions (ran, refused,
 * failed); content never reaches these rows. A refusal without its code says
 * only that it didn't run: it may have waited for an approval.
 */
export function activityView(row: Pick<ActivityRow, "action" | "outcome"> & { code?: string | null }): ActivityView {
  switch (row.action) {
    case "connector.action.executed":
      return { badge: null, text: "Ran" };
    case "connector.action.failed":
      return { badge: null, text: "Failed" };
    case "connector.action.denied":
      if (!row.code) return { badge: null, text: "Didn't run" };
      return { badge: null, text: REFUSAL_TEXT[row.code] ?? "Refused" };
  }
  const last = row.action.split(".").slice(1).join(" ").replace(/[_-]+/g, " ").trim();
  const text = last ? `${last.charAt(0).toUpperCase()}${last.slice(1)}` : "Activity";
  if (row.outcome === "denied") return { badge: { label: "Refused", tone: "warn" }, text };
  if (row.outcome === "failed") return { badge: { label: "Failed", tone: "err" }, text };
  return { badge: null, text };
}

const CAPABILITY_LABELS: Record<string, string> = {
  "gcal.event.list": "Read your calendar",
  "gcal.freebusy.query": "See when you're free or busy",
  "gmail.message.list": "Search your email",
  "gmail.message.read": "Read your email",
  "gmail.message.send": "Send email",
};

/** "Send email" for a capability the connection's tools name; the id otherwise. */
export function capabilityLabel(capability: string | null | undefined, tools: Pick<ToolRow, "capability" | "label">[] = []) {
  if (!capability) return null;
  return tools.find((tool) => tool.capability === capability)?.label ?? CAPABILITY_LABELS[capability] ?? capability;
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

/** The provider a capability belongs to, from its prefix: `gmail.*` and `gcal.*` are Google. */
export function capabilityProvider(capability: string) {
  const prefix = capability.split(".")[0];
  return prefix === "gmail" || prefix === "gcal" ? "google" : null;
}

/** Why a write is waiting for its owner. */
export function approvalReasonText(reason: ApprovalSummary["reason"]) {
  return reason === "write_after_read"
    ? "This agent read your email or calendar in the same task, so writing needs your OK"
    : "Your rules ask for approval";
}

export type ApprovalView = "pending" | "approved" | "consumed" | "denied" | "expired";

/** Where an approval stands now; a pending one past its expiry is expired. */
export function approvalView(approval: Pick<ApprovalDetail, "status" | "expiresAt">, now = Date.now()): ApprovalView {
  switch (approval.status) {
    case "approved":
    case "consumed":
    case "denied":
    case "expired":
      return approval.status;
    default: {
      const expires = Date.parse(approval.expiresAt);
      return Number.isFinite(expires) && expires <= now ? "expired" : "pending";
    }
  }
}

/** What happens next, after the owner decided here. */
export function decisionCopy(status: string): Copy {
  if (status === "denied") return { description: "The agent was told no.", title: "Denied" };
  if (status === "expired") return approvalStateCopy("expired");
  return { description: "The agent can continue now.", title: "Approved" };
}

/** An approval that can't be decided anymore, or couldn't be opened. Never echoes other people. */
export function approvalStateCopy(state: string): Copy {
  switch (state) {
    case "expired":
      return {
        description: "Requests wait 15 minutes. Nothing was sent. If you still want it, ask the agent again.",
        title: "This request expired",
      };
    case "approved":
      return { description: "You approved this request. The agent can continue now.", title: "Already approved" };
    case "consumed":
      return { description: "You approved this request and the agent ran it once.", title: "This request already ran" };
    case "denied":
      return { description: "You denied this request. The agent was told no.", title: "Already denied" };
    case "impersonation":
      return {
        description: "You're signed in as someone else, so you can't see or decide their requests. They need to open this link themselves.",
        title: "Deciding needs the person's own session",
      };
    case "not_member":
      return {
        description: "You aren't an active member of the organization this request belongs to.",
        title: "No access to this organization",
      };
    case "feature_unavailable":
      return { description: "Connectors aren't enabled for this organization.", title: "Connectors aren't enabled here" };
    case "feature_forbidden":
      return { description: "Your role in this organization doesn't include connectors.", title: "You can't decide this here" };
    case "unavailable":
      return {
        description: "Ravi couldn't load this request right now. Nothing was approved. Try again in a moment.",
        title: "We couldn't open this request",
      };
    default:
      return {
        description: "It may be for another Ravi account, or the link is incomplete. Requests waiting for you are listed in Connectors.",
        title: "We couldn't find this request",
      };
  }
}

/** "Agent main on ana-mbp · expires in 12 minutes" style facts about who asked. */
export function approvalAskedBy(
  approval: Pick<ApprovalDetail, "installationName" | "agentId" | "sessionName" | "routine" | "conversation">,
) {
  const routine = approval.routine
    ? routineLabel(approval.routine.id ? `${approval.routine.kind}:${approval.routine.id}` : approval.routine.kind)
    : null;
  return [
    { label: "Computer", value: approval.installationName },
    { label: "Agent", value: approval.agentId },
    { label: "Session", value: approval.sessionName },
    { label: "Routine", value: routine },
    { label: "Conversation", value: conversationLabel(approval.conversation) },
  ].filter((item): item is { label: string; value: string } => Boolean(item.value));
}

/** One line for "Waiting for you": who asked, from where. */
export function approvalSummaryLine(approval: Pick<ApprovalSummary, "agentId" | "installationName" | "email">) {
  const who = approval.agentId ? `Agent ${approval.agentId}` : "The terminal";
  const where = approval.installationName ? ` on ${approval.installationName}` : "";
  return [approval.email, `${who}${where}`].filter(Boolean).join(" · ");
}

/**
 * Parts of a request the page can't show. The Worker's preview holds the
 * email's text body and its HTML part (the markup, as text) up to 4,000
 * characters each; other requests are cut at 4 KB. A Worker from before the
 * HTML part was previewed only flags that the email has one.
 */
export type PreviewGap = "html_body" | "html_cut" | "body_cut" | "parameters_cut";

export type ApprovalPreview = {
  /** Nothing could be shown (the preview is missing or couldn't be read). */
  missing: boolean;
  fields: Array<{ label: string; value: string }>;
  /** The text body; "" when the request has an empty one. */
  body: string | null;
  /** The HTML part's markup, to show as plain text and never render; null when the email has none or it isn't sent. */
  html: string | null;
  /** Anything else the request carries: formatted JSON, or the cut text of a long request. */
  other: string | null;
  gaps: PreviewGap[];
};

const PREVIEW_FIELDS: Array<[key: string, label: string]> = [
  ["to", "To"],
  ["cc", "Cc"],
  ["bcc", "Bcc"],
  ["subject", "Subject"],
  // A reply: the message it answers and the thread it joins.
  ["inReplyTo", "Reply to message"],
  ["threadId", "Thread"],
  ["references", "References"],
];
const PREVIEW_BODY_KEYS = ["body", "bodyExcerpt", "text"];

function previewText(value: unknown) {
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) {
    const items = value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
    return items.length ? items.join(", ") : null;
  }
  return null;
}

/**
 * The preview as the page shows it: the email's envelope, its text body,
 * its HTML part, the rest, and what can't be shown. Always rendered as text,
 * never as HTML.
 */
export function approvalPreview(preview: Record<string, unknown> | null): ApprovalPreview {
  if (!preview) return { body: null, fields: [], gaps: [], html: null, missing: true, other: null };
  const keys = Object.keys(preview);
  // A request over 4 KB arrives as the start of its JSON, cut.
  if (keys.length === 2 && preview.truncated === true && typeof preview.parameters === "string") {
    return { body: null, fields: [], gaps: ["parameters_cut"], html: null, missing: false, other: preview.parameters };
  }
  const used = new Set<string>();
  const fields: ApprovalPreview["fields"] = [];
  for (const [key, label] of PREVIEW_FIELDS) {
    const value = previewText(preview[key]);
    used.add(key);
    if (value) fields.push({ label, value });
  }
  let body: string | null = null;
  for (const key of PREVIEW_BODY_KEYS) {
    used.add(key);
    if (body === null && typeof preview[key] === "string") body = preview[key] as string;
  }
  const html = typeof preview.bodyHtml === "string" ? preview.bodyHtml : null;
  if (html !== null) used.add("bodyHtml");
  const gaps: PreviewGap[] = [];
  if (preview.hasHtmlBody === true) {
    used.add("hasHtmlBody");
    if (html === null) gaps.push("html_body");
  }
  if (preview.bodyTruncated === true) {
    used.add("bodyTruncated");
    gaps.push("body_cut");
  }
  if (preview.bodyHtmlTruncated === true) {
    used.add("bodyHtmlTruncated");
    gaps.push("html_cut");
  }
  const rest = Object.fromEntries(Object.entries(preview).filter(([key]) => !used.has(key)));
  return {
    body,
    fields,
    gaps,
    html,
    missing: false,
    other: Object.keys(rest).length ? JSON.stringify(rest, null, 2) : null,
  };
}

const PREVIEW_GAP_TEXT: Record<PreviewGap, string> = {
  body_cut: "The message is longer than what's shown. Only its first 4,000 characters are here.",
  html_body:
    "This email also has a formatted (HTML) version that isn't shown here. Most mail apps show recipients that version, and it can say something different from the text above.",
  html_cut: "The HTML part is longer than what's shown. Only its first 4,000 characters are here, and the rest can say something else.",
  parameters_cut: "This request is too long to show in full. Only its start is shown.",
};

export function previewGapText(gap: PreviewGap) {
  return PREVIEW_GAP_TEXT[gap];
}

/**
 * Approve is offered only for what the owner can see: never when nothing could
 * be shown, and only after an explicit OK when part of it isn't shown.
 */
export function approveGate(preview: Pick<ApprovalPreview, "missing" | "gaps">): "allowed" | "confirm" | "unavailable" {
  if (preview.missing) return "unavailable";
  return preview.gaps.length ? "confirm" : "allowed";
}

// ---------------------------------------------------------------------------
// Organization rules (/org/connectors)
// ---------------------------------------------------------------------------

export type CeilingValue = "none" | "needs_approval" | "blocked";

export const CEILING_OPTIONS: Array<{ value: CeilingValue; label: string }> = [
  { label: "No limit", value: "none" },
  { label: "Needs approval", value: "needs_approval" },
  { label: "Blocked", value: "blocked" },
];

export function ceilingValue(ceilings: OrgPolicy["toolCeilings"], capability: string): CeilingValue {
  const ceiling = ceilings[capability];
  return ceiling === "needs_approval" || ceiling === "blocked" ? ceiling : "none";
}

/**
 * One tool's change, as the set route takes it: the route applies it to the
 * policy as it is now, so a page loaded earlier can't undo another change.
 */
export function ceilingChange(capability: string, value: CeilingValue): ToolCeilingChange {
  return { capability, ceiling: value === "none" ? null : value };
}

/** What a tool's select shows: the change being saved, else the stored ceiling. */
export function shownCeiling(
  ceilings: OrgPolicy["toolCeilings"],
  capability: string,
  pending: ToolCeilingChange | null | undefined,
): CeilingValue {
  if (pending?.capability === capability) return pending.ceiling ?? "none";
  return ceilingValue(ceilings, capability);
}

/** Why a ceiling select can't be changed right now. */
export function ceilingHint(tool: { class: string }, policy: Pick<OrgPolicy, "writesAllowed">) {
  if (tool.class !== "read" && !policy.writesAllowed) return "Writing tools are off, so this is blocked.";
  return null;
}

/** The member a connection belongs to, by name, else email. */
export function memberName(row: Pick<AdminConnectionRow, "member">) {
  return row.member.name ?? row.member.email ?? "A former member";
}

// ---------------------------------------------------------------------------
// Agents that use your account when you ask (consent)
// ---------------------------------------------------------------------------

type PendingConsent = Extract<ConsentView, { state: "pending" }>;

/** The agent's own name when it has one, else its id. */
export function consentAgentName(view: Pick<PendingConsent, "agentDisplayName" | "agentId">) {
  return view.agentDisplayName?.trim() || view.agentId;
}

/** "main on ana-mbp wants to use your Google account when you ask it something". */
export function consentTitle(view: Pick<PendingConsent, "agentDisplayName" | "agentId" | "installationName" | "provider">) {
  const where = view.installationName ? ` on ${view.installationName}` : "";
  return `${consentAgentName(view)}${where} wants to use your ${providerName(view.provider)} account when you ask it something`;
}

/** Who runs the agent, as the request names them: "Ana Souza (ana@example.com)". */
export function consentOperator(view: Pick<PendingConsent, "operatorName" | "operatorEmail">) {
  const name = view.operatorName?.trim() || null;
  const email = view.operatorEmail?.trim() || null;
  if (name && email && name.toLowerCase() !== email.toLowerCase()) return `${name} (${email})`;
  return name ?? email;
}

/** The account preselected: the default one, else the first listed. */
export function defaultConsentConnectionId(connections: PendingConsent["connections"]) {
  return connections.find((connection) => connection.isDefault)?.id ?? connections[0]?.id ?? null;
}

/**
 * The account the page has chosen: the one picked while it is still listed
 * (the list is read again after a failed answer), else the preselected one.
 */
export function consentChoice(connections: PendingConsent["connections"], picked: string | null) {
  return picked && connections.some((connection) => connection.id === picked) ? picked : defaultConsentConnectionId(connections);
}

/**
 * What Approve or Deny sends. Choosing the default account sends no account,
 * so the agent follows the person's default when they change it (and keeps
 * working when they disconnect the old one); any other account is pinned.
 */
export function consentDecideBody(input: {
  token: string;
  decision: "approve" | "deny";
  chosen: string | null;
  connections: PendingConsent["connections"];
}) {
  const base = { decision: input.decision, token: input.token };
  if (input.decision !== "approve") return base;
  const account = input.connections.find((connection) => connection.id === input.chosen);
  return account && !account.isDefault ? { ...base, connectionId: account.id } : base;
}

/**
 * What writes do when the agent acts for the person: they always ask first,
 * even ones the person set to Always allow for their own use. The computer
 * that runs the agent is what says who is asking, so Ravi never writes on
 * that claim alone.
 */
export const CONSENT_WRITES_LINE =
  "Writes, like sending email, always ask you first in the Console, even ones you set to Always allow for yourself.";

/**
 * Who the person trusts by approving. The operator's computer tells Ravi who
 * is asking, so Ravi can't promise more than that computer does.
 */
export function consentTrustLine(view: Pick<PendingConsent, "operatorName" | "operatorEmail" | "installationName">) {
  const operator = view.operatorName?.trim() || view.operatorEmail?.trim() || null;
  const computer = view.installationName
    ? `${operator ? `${operator}'s computer` : "The computer"} ${view.installationName}`
    : operator
      ? `${operator}'s computer`
      : "The computer that runs the agent";
  return `${computer} tells Ravi who is asking. Approve only if you trust ${operator ?? "whoever runs it"} with your account.`;
}

/** Where a consent request stands now; a pending one past its expiry is expired. */
export function consentView(view: Pick<PendingConsent, "expiresAt">, now = Date.now()): "pending" | "expired" {
  const expires = Date.parse(view.expiresAt);
  return Number.isFinite(expires) && expires <= now ? "expired" : "pending";
}

/** A consent link that can't be answered, or couldn't be opened. Never echoes other people. */
export function consentStateCopy(state: string): Copy {
  switch (state) {
    case "expired":
      return {
        description: "Requests last 24 hours. Nothing was allowed. Ask the agent again and it sends you a new link.",
        title: "This request expired",
      };
    case "used":
      return {
        description: "Each request is answered once. Agents you allowed are listed in Connectors, where you can revoke them.",
        title: "This request was already answered",
      };
    case "user_mismatch":
      return {
        description: "Only the person it was sent to can answer it. Sign in as them, or ask the agent to send them the link.",
        title: "This request is for another Ravi account.",
      };
    case "impersonation":
      return {
        description: "You're signed in as someone else, so you can't allow agents to use their accounts. They need to open this link themselves.",
        title: "Allowing needs the person's own session",
      };
    case "not_member":
      return {
        description: "You aren't an active member of the organization this request belongs to.",
        title: "No access to this organization",
      };
    case "feature_unavailable":
      return { description: "Connectors aren't enabled for this organization.", title: "Connectors aren't enabled here" };
    case "feature_forbidden":
      return {
        description: "Your role in this organization doesn't include connectors. Ask an owner or admin.",
        title: "You can't allow this here",
      };
    case "unavailable":
      return {
        description: "Ravi couldn't load this request right now. Nothing was allowed. Try again in a moment.",
        title: "We couldn't open this request",
      };
    default:
      return {
        description: "Check that you opened the whole link. Agents you allowed are listed in Connectors.",
        title: "This link isn't valid",
      };
  }
}

/** What happens next, after the person answered. `followsDefault`: the agent uses whichever account is the default. */
export function consentDecisionCopy(
  status: string,
  input: { agent: string; email: string | null; provider: string; followsDefault?: boolean },
): Copy {
  if (status === "denied") {
    return {
      description: `${input.agent} won't use your ${input.provider} account. If it asks again, you get a new link.`,
      title: "Denied",
    };
  }
  if (status === "expired") return consentStateCopy("expired");
  const account = input.followsDefault
    ? `your default ${input.provider} account${input.email ? ` (${input.email} now)` : ""}`
    : (input.email ?? `your ${input.provider} account`);
  return {
    description: `${input.agent} can now use ${account} when you ask it something, under your rules. Go back to the conversation and ask again. You can revoke it any time in Connectors.`,
    title: "Allowed",
  };
}

/** "Agent main on ana-mbp". */
export function grantTitle(grant: Pick<AgentGrantRow, "agentId" | "installationName">) {
  const agent = grant.agentId ? `Agent ${grant.agentId}` : "An agent";
  return grant.installationName ? `${agent} on ${grant.installationName}` : agent;
}

/** The account the grant uses; one without its own uses the person's default. */
export function grantAccount(grant: Pick<AgentGrantRow, "email" | "connectionId" | "provider">) {
  if (grant.email) return grant.email;
  return grant.connectionId ? `${providerName(grant.provider)} account` : `Your default ${providerName(grant.provider)} account`;
}

/** "Run by ana@example.com", when the Worker names who runs the agent. */
export function grantOperator(grant: Pick<AgentGrantRow, "operator">) {
  return grant.operator?.email ? `Run by ${grant.operator.email}` : null;
}

export function newestGrantsFirst<T extends Pick<AgentGrantRow, "createdAt">>(grants: T[]) {
  const time = (grant: T) => {
    const value = Date.parse(grant.createdAt);
    return Number.isNaN(value) ? 0 : value;
  };
  return [...grants].sort((a, b) => time(b) - time(a));
}

// ---------------------------------------------------------------------------
// Organization accounts and shared grants (/org/connectors)
// ---------------------------------------------------------------------------

export const SHARED_CONVERSATION_OPTIONS: Array<{ value: SharedConversation; label: string }> = [
  { label: "Direct messages", value: "dm" },
  { label: "Groups", value: "group" },
];

/** "Direct messages · Groups", in that order; unknown kinds are shown as they are. */
export function sharedConversationsText(conversations: readonly string[]) {
  const known = SHARED_CONVERSATION_OPTIONS.filter((option) => conversations.includes(option.value)).map((option) => option.label);
  const other = conversations.filter((item) => !SHARED_CONVERSATION_OPTIONS.some((option) => option.value === item));
  const parts = [...known, ...other];
  return parts.length ? parts.join(" · ") : "No conversations";
}

/** Each organization account's shared grants, newest first. Grants of other accounts are left out. */
export function grantsByConnection(grants: AgentGrantRow[]) {
  const byConnection = new Map<string, AgentGrantRow[]>();
  for (const grant of newestGrantsFirst(grants)) {
    if (grant.mode !== "shared" || !grant.connectionId) continue;
    const list = byConnection.get(grant.connectionId) ?? [];
    list.push(grant);
    byConnection.set(grant.connectionId, list);
  }
  return byConnection;
}

export type SharedGrantDraft = { installationId: string; agentId: string; conversations: SharedConversation[] };

const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** What's missing before a shared grant can be added; null when it can. */
export function sharedGrantDraftError(draft: SharedGrantDraft): { field: "installation" | "agent" | "conversations"; message: string } | null {
  if (!draft.installationId) return { field: "installation", message: "Choose the computer the agent runs on." };
  const agent = draft.agentId.trim();
  if (!agent) return { field: "agent", message: "Enter the agent's id." };
  if (agent.length > 120 || !AGENT_ID_RE.test(agent)) {
    return { field: "agent", message: "Use the id ravi agents list shows: letters, numbers, dots, dashes and underscores." };
  }
  if (!draft.conversations.length) return { field: "conversations", message: "Choose at least one kind of conversation." };
  return null;
}

export type SharedGrantConflict = {
  /** `move`: the agent uses another organization account now and adding it here moves it. `update`: it already uses this one. */
  kind: "move" | "update";
  grant: AgentGrantRow;
};

/**
 * An agent on a computer uses at most one shared account per provider:
 * adding it to one account takes it off any other (the Worker revokes or
 * moves that grant). Finds the grant an Add would replace, so the dialog can
 * say so first.
 */
export function sharedGrantConflict(
  grants: readonly AgentGrantRow[],
  target: { connectionId: string; provider: string; installationId: string; agentId: string },
): SharedGrantConflict | null {
  const agentId = target.agentId.trim();
  if (!agentId || !target.installationId) return null;
  const same = grants.filter(
    (grant) =>
      grant.mode === "shared" &&
      grant.installationId === target.installationId &&
      grant.agentId === agentId &&
      grant.provider === target.provider,
  );
  const elsewhere = same.find((grant) => grant.connectionId !== target.connectionId);
  if (elsewhere) return { grant: elsewhere, kind: "move" };
  return same[0] ? { grant: same[0], kind: "update" } : null;
}

/** The line the Add dialog shows for a conflict, before anything changes. */
export function sharedGrantConflictText(
  conflict: SharedGrantConflict,
  target: { agentId: string; installationName: string | null; accountName: string },
) {
  const agent = target.installationName ? `${target.agentId.trim()} on ${target.installationName}` : target.agentId.trim();
  if (conflict.kind === "update") {
    return `${agent} already uses ${target.accountName}. Adding it again replaces its conversations with the ones you choose here.`;
  }
  const other = conflict.grant.email ?? "another organization account";
  return `${agent} uses ${other} now. An agent uses one shared ${providerName(conflict.grant.provider)} account at a time, so adding it here moves it: it stops using ${other}.`;
}

/** The notice on an organization account nobody manages: who answers its approvals until someone does. */
export function noManagerText() {
  return "Until you pick a member, its approvals go to the organization's owners and admins, and any of them can answer. Pick a manager so one person sees them.";
}

/** The member who manages an organization account, by name when the members list has them. */
export function managerName(
  connection: Pick<Connection, "managedBy">,
  members: ReadonlyArray<{ id: string; name: string; email: string }> = [],
) {
  const manager = connection.managedBy;
  if (!manager) return null;
  const member = members.find((item) => item.id === manager.userId);
  return member?.name || member?.email || manager.email || "A former member";
}

/** "ana-mbp · Ana Souza": which computer, and whose. */
export function organizationInstallationLabel(installation: Pick<OrganizationInstallationRow, "name" | "owner">) {
  const owner = installation.owner.name ?? installation.owner.email;
  return owner ? `${installation.name} · ${owner}` : installation.name;
}

// ---------------------------------------------------------------------------
// Errors in plain words
// ---------------------------------------------------------------------------

const SHARED_ACCOUNTS_OFF_TEXT = "Shared accounts are off for this organization. Turn on Allow shared accounts first.";
const SHARED_ACCOUNTS_OFF_MANAGER_TEXT = "Shared accounts are off for this organization. An owner or admin can turn them on.";

/**
 * The Worker refused to share an account with an agent that uses another
 * organization account its manager can't change (only that account's
 * manager, an owner or an admin can take the agent off it).
 */
export function isAgentOnOtherAccount(error: unknown) {
  return error instanceof ApiError && error.code === "connector_forbidden" && error.extra.reason === "agent_uses_other_account";
}

/**
 * The Worker refused an organization account because the organization
 * doesn't allow shared accounts (the connector itself may still be on).
 */
export function isSharedAccountsOff(error: unknown) {
  return error instanceof ApiError && error.code === "connector_disabled_by_org" && error.extra.reason === "shared_not_allowed";
}

export function isNotConfigured(error: unknown) {
  return error instanceof ApiError && error.code === "server_not_configured";
}

/**
 * The connectors service doesn't have this route yet (it is deployed after
 * the Console). It answers an unknown route with `not_found`; a missing or
 * foreign connection is `connector_unavailable`, and a missing approval is
 * only ever asked for by its own page.
 */
export function isMissingRoute(error: unknown) {
  return error instanceof ApiError && error.status === 404 && error.code === "not_found";
}

/** Retry only failures that can pass on their own; a missing service or a refusal won't. */
export function retryConnectorQuery(failureCount: number, error: unknown) {
  if (error instanceof ApiError && (error.code === "server_not_configured" || (error.status > 0 && error.status < 500))) {
    return false;
  }
  return failureCount < 2;
}

/** `manage`: what a manager who isn't an owner or admin does with an organization account they manage. */
export type ConnectorAction =
  | "load"
  | "connect"
  | "disconnect"
  | "rename"
  | "default"
  | "policy"
  | "decide"
  | "admin"
  | "manage"
  | "consent";

export function connectorErrorText(error: unknown, action: ConnectorAction = "load") {
  const code = error instanceof ApiError ? error.code : null;
  switch (code) {
    case "connector_policy_above_ceiling":
      return "Your organization doesn't allow a looser rule for this tool. Pick a stricter one.";
    case "connector_forbidden":
      if (isAgentOnOtherAccount(error)) {
        return "This agent uses another organization account. Its manager or an owner or admin must take it off that one first.";
      }
      // Admin routes refuse non-admins; the rest refuse someone who isn't an active member.
      if (action === "manage") return "Only this account's manager, owners and admins can change this.";
      return action === "admin"
        ? "Only owners and admins can change this."
        : "You aren't an active member of this organization.";
    case "connector_approval_invalid":
      return "This request can't be decided anymore. Reload the page to see where it stands.";
    case "payload_invalid":
      return action === "rename"
        ? `Use a name of 1 to ${CONNECTION_NAME_MAX_LENGTH} characters.`
        : "The request wasn't accepted. Reload the page and try again.";
    case "server_not_configured":
      return "Connections aren't set up on this Console.";
    case "connector_service_unavailable":
      return "Ravi couldn't reach the service that keeps connected accounts. Nothing changed. Try again in a moment.";
    case "impersonation":
      if (action === "consent") return consentStateCopy("impersonation").description;
      return action === "decide"
        ? approvalStateCopy("impersonation").description
        : "You're signed in as someone else, so you can't change their connections.";
    case "connect_other_browser":
      return FINISH_OTHER_BROWSER_COPY.description;
    case "feature_unavailable":
      return "Connectors aren't enabled for this organization.";
    case "feature_forbidden":
      return "Your role doesn't include connectors.";
    case "connector_disabled_by_org":
      if (isSharedAccountsOff(error)) return action === "manage" ? SHARED_ACCOUNTS_OFF_MANAGER_TEXT : SHARED_ACCOUNTS_OFF_TEXT;
      return "An owner or admin turned this connector off for the organization.";
    case "disabled_by_org":
      return "An owner or admin turned this connector off for the organization.";
    case "connector_connection_required":
      return "Connect an account first, then allow the agent to use it.";
    case "consent_invalid":
      return consentStateCopy("invalid").description;
    case "connector_unavailable":
    case "not_found":
      if (action === "decide") return approvalStateCopy("not_found").description;
      if (action === "consent") return "This account or permission no longer exists. Reload the page.";
      if (action === "admin") return "This connection no longer exists. Reload the list.";
      if (action === "manage") return "This account no longer exists, or you don't manage it anymore. Reload the page.";
      return action === "connect"
        ? "This provider can't be connected right now."
        : "This connection no longer exists, or it isn't yours. Reload the list.";
    case "connector_provider_error":
      return action === "disconnect"
        ? "Google didn't confirm the disconnect. Try again in a moment."
        : "Google didn't respond. Try again in a moment.";
    case "connector_connect_unavailable":
    case "connect_invalid":
      return "This link can't be used anymore. Start again from the terminal or from Connectors.";
    case "user_mismatch":
      if (action === "consent") return consentStateCopy("user_mismatch").title;
      return "This link was made for another Ravi account. Sign in as that person or ask them for a new link.";
    case "forbidden":
      return "The Console refused this request. Reload the page and try again.";
    case "unauthorized":
      return "Your session ended. Sign in again.";
    default:
      return describeError(error);
  }
}
