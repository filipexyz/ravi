/**
 * High-level connectors operations against `link.ravi.so` and the Console.
 *
 * Connections belong to a person, not to a project. Every helper first
 * classifies the current turn (`connector-turn.ts`): only the operator's own
 * turns reach the operator's Console session, and nothing here ever falls
 * back to it for somebody else's turn. Then each helper does one Link or
 * Console call, so command-layer code stays focused on UX and exits with
 * consistent errors when the bearer is missing or expired.
 */

import { ConsoleApiClient, getMeWithAutoRefresh } from "../cloud-auth/client.js";
import {
  assertConnectorSessionUser,
  deleteConnectorSession,
  resolveConnectorCloudCredentials,
} from "../cloud-auth/connector-auth.js";
import { CloudAuthError } from "../cloud-auth/errors.js";
import { deleteCloudCredentials, readCloudCredentials, writeCloudCredentials } from "../cloud-auth/storage.js";
import { DEFAULT_CONSOLE_URL, type CloudCredentials } from "../cloud-auth/types.js";

import { APPROVAL_ID_PATTERN, LinkApiClient } from "./client.js";
import {
  buildExecContext,
  encodeExecContextHeader,
  EXEC_CONTEXT_HEADER,
  type ConnectorTurn,
  type ConnectorTurnDeps,
} from "./connector-turn.js";

export const CONSOLE_CONNECT_START_PATH = "/api/cli/connectors/connect/start";

/** Header naming the owner's approval when an action is run again after it. */
export const APPROVAL_HEADER = "X-Ravi-Approval";

/** Statuses of a row that still holds, or may hold, credentials. */
export const LIVE_CONNECTION_STATUSES: ReadonlySet<string> = new Set([
  "active",
  "degraded",
  "suspended",
  "revoke_pending",
]);

export interface ConnectorHelperDeps {
  link?: LinkApiClient;
  consoleClient?: ConsoleApiClient;
  readCredentials?: typeof readCloudCredentials;
  writeCredentials?: typeof writeCloudCredentials;
  deleteCredentials?: typeof deleteCloudCredentials;
  /** Turn classification inputs (tests). */
  turn?: ConnectorTurnDeps;
}

export interface ConnectorListItem {
  id: string;
  /** Always null since connections belong to a person (kept until 2027-01-01). */
  projectId: string | null;
  provider: string;
  displayName: string;
  status: string;
  requiresReauth: boolean;
  scopes: string[];
  createdAt: string;
  /** The account email. */
  externalAccountLogin?: string | null;
  isDefault?: boolean;
  accessMode?: "full" | "read_only";
  scopeKind?: "user" | "organization";
}

export interface ConnectorDetail extends ConnectorListItem {
  capabilities: string[];
  externalAccountLogin: string | null;
  grantedAt: string;
  lastReauthAt: string | null;
  lastUsedAt?: string | null;
  revokedAt?: string | null;
}

export interface ConnectStartResult {
  connectUrl: string;
  pendingGrantId: string;
  expiresAt: string;
}

export interface ConnectStartOutcome extends ConnectStartResult {
  /** Email of the Console user who must open the link. */
  userEmail: string | null;
}

export interface ConnectStatusResult {
  status: "pending" | "consumed" | "expired" | "rejected";
  provider: string;
  connectorId: string | null;
  expiresAt: string;
}

export interface ExecResult {
  result: unknown;
  capability: string;
  refreshed: boolean;
}

export interface AuthenticatedLinkContext {
  link: LinkApiClient;
  consoleClient: ConsoleApiClient;
  accessToken: string;
  turn: ConnectorTurn;
  consoleUrl: string;
  userEmail: string | null;
  ownerName: string | null;
}

async function authenticate(deps: ConnectorHelperDeps): Promise<AuthenticatedLinkContext> {
  const read = deps.readCredentials ?? readCloudCredentials;
  const write = deps.writeCredentials ?? writeCloudCredentials;
  const remove = deps.deleteCredentials ? () => deps.deleteCredentials?.() : () => deleteConnectorSession();
  const { turn, credentials, activeUserId } = resolveConnectorCloudCredentials({ readActive: read, turn: deps.turn });
  const consoleClient = deps.consoleClient ?? new ConsoleApiClient({ consoleUrl: credentials.consoleUrl });
  const { me, credentials: fresh } = await getMeWithAutoRefresh({
    client: consoleClient,
    credentials,
    write: (c: CloudCredentials) => write(c),
    // A dead session is forgotten without promoting another stored user.
    delete: remove,
  });
  assertConnectorSessionUser(activeUserId, me?.user?.id);
  const link = deps.link ?? new LinkApiClient();
  return {
    link,
    consoleClient,
    accessToken: fresh.accessToken,
    turn,
    consoleUrl: fresh.consoleUrl,
    userEmail: stringValue(me?.user?.email) ?? stringValue(fresh.user?.email),
    ownerName:
      stringValue(fresh.user?.name) ?? stringValue(fresh.user?.displayName) ?? stringValue(me?.user?.name) ?? null,
  };
}

/**
 * Start a connection through the Console, which applies the "who can
 * connect" rule. The answer is the Console page `/connect/<token>`, which
 * only the Console user who started it can continue.
 */
export async function startConnect(
  options: {
    provider: string;
    accessMode?: "full" | "read_only";
    reconnectConnectionId?: string;
    displayName?: string;
  },
  deps: ConnectorHelperDeps = {},
): Promise<ConnectStartOutcome> {
  const ctx = await authenticate(deps);
  const payload = await ctx.consoleClient.requestJson<unknown>(
    "POST",
    CONSOLE_CONNECT_START_PATH,
    {
      provider: options.provider,
      ...(options.accessMode ? { accessMode: options.accessMode } : {}),
      ...(options.reconnectConnectionId ? { reconnectConnectionId: options.reconnectConnectionId } : {}),
      ...(options.displayName ? { displayName: options.displayName } : {}),
    },
    ctx.accessToken,
  );
  const root = objectValue(payload);
  const connectUrl = stringValue(root?.connectUrl);
  const pendingGrantId = stringValue(root?.pendingGrantId);
  const expiresAt = stringValue(root?.expiresAt);
  if (!connectUrl || !pendingGrantId || !expiresAt) {
    throw new CloudAuthError("SERVER_UNAVAILABLE", "Console returned an incomplete connect answer.", {
      retryable: true,
    });
  }
  return { connectUrl, pendingGrantId, expiresAt, userEmail: ctx.userEmail };
}

export async function getConnectStatus(
  pendingId: string,
  deps: ConnectorHelperDeps = {},
): Promise<ConnectStatusResult> {
  const ctx = await authenticate(deps);
  return ctx.link.request<ConnectStatusResult>(
    "GET",
    `/cli/connect/status/${encodeURIComponent(pendingId)}`,
    ctx.accessToken,
  );
}

export async function listConnectors(
  options: { provider?: string } = {},
  deps: ConnectorHelperDeps = {},
): Promise<ConnectorListItem[]> {
  const ctx = await authenticate(deps);
  const params = new URLSearchParams();
  if (options.provider) params.set("provider", options.provider);
  const query = params.toString();
  const path = query ? `/cli/connect/list?${query}` : "/cli/connect/list";
  const result = await ctx.link.request<{ connections: ConnectorListItem[] }>("GET", path, ctx.accessToken);
  return result.connections;
}

export async function showConnector(id: string, deps: ConnectorHelperDeps = {}): Promise<ConnectorDetail> {
  const ctx = await authenticate(deps);
  const result = await ctx.link.request<{ connection: ConnectorDetail }>(
    "GET",
    `/cli/connect/show/${encodeURIComponent(id)}`,
    ctx.accessToken,
  );
  return result.connection;
}

export async function revokeConnector(id: string, deps: ConnectorHelperDeps = {}): Promise<void> {
  const ctx = await authenticate(deps);
  await ctx.link.request<{ revoked: boolean }>(
    "POST",
    `/cli/connect/revoke/${encodeURIComponent(id)}`,
    ctx.accessToken,
  );
}

export async function execCapability(
  options: {
    connectorId: string;
    capability: string;
    parameters: unknown;
    stepUpToken?: string;
    /** The owner's approval of this exact action, from an earlier approval answer. */
    approvalId?: string;
  },
  deps: ConnectorHelperDeps = {},
): Promise<ExecResult> {
  const ctx = await authenticate(deps);
  const headers: Record<string, string> = {
    [EXEC_CONTEXT_HEADER]: encodeExecContextHeader(buildExecContext(ctx.turn)),
    ...(options.stepUpToken ? { "X-Ravi-Step-Up": options.stepUpToken } : {}),
    ...(options.approvalId ? { [APPROVAL_HEADER]: options.approvalId } : {}),
  };
  try {
    return await ctx.link.request<ExecResult>(
      "POST",
      `/cli/exec/${encodeURIComponent(options.connectorId)}`,
      ctx.accessToken,
      {
        capability: options.capability,
        parameters: options.parameters,
      },
      { headers },
    );
  } catch (error) {
    if (error instanceof CloudAuthError && error.code === "CONNECTOR_REAUTH_REQUIRED") {
      throw connectorReconnectError({ consoleUrl: ctx.consoleUrl, ownerName: ctx.ownerName, status: error.status });
    }
    if (error instanceof CloudAuthError && isApprovalAnswer(error)) {
      throw connectorApprovalError(error, { consoleUrl: ctx.consoleUrl, ownerName: ctx.ownerName });
    }
    throw error;
  }
}

function isApprovalAnswer(error: CloudAuthError): boolean {
  return error.code === "CONNECTOR_APPROVAL_REQUIRED" || error.code === "CONNECTOR_APPROVAL_PENDING";
}

/**
 * "The owner must approve this action first": the approval page goes to the
 * owner privately, and the same command runs again with `--approval <id>`.
 * The page is rebuilt from the Console this CLI is logged in to. Without an
 * approval id the Link answer keeps its catalog copy.
 */
export function connectorApprovalError(
  error: CloudAuthError,
  input: { consoleUrl?: string | null; ownerName?: string | null; service?: string } = {},
): CloudAuthError {
  const approvalId = stringValue(error.details?.approvalId);
  if (!approvalId || !APPROVAL_ID_PATTERN.test(approvalId)) return error;
  const service = input.service ?? "Gmail";
  const consoleUrl = (input.consoleUrl ?? readActiveConsoleUrl()).replace(/\/+$/, "");
  const approvalLink = `${consoleUrl}/connectors/approvals/${approvalId}`;
  const ownerName = stringValue(input.ownerName);
  const retryWith = `--approval ${approvalId}`;
  const chatLine = `Please approve this ${service} action: ${approvalLink}`;
  const chatLinePt = `Aprove esta ação do ${service}: ${approvalLink}`;
  const quotedLine = `Please approve this ${service} action: ${approvalLink.replace(/^[a-z]+:\/\//i, "")}`;
  const expiresAt = stringValue(error.details?.expiresAt);
  const message =
    error.code === "CONNECTOR_APPROVAL_PENDING"
      ? `The approval for this ${service} action is still waiting for ${ownerName ?? "the account owner"}. Once they approve, run the same command again with ${retryWith}.`
      : `${ownerName ?? "The account owner"} must approve this ${service} action first. Tell them privately, never in a group: "${quotedLine}", then run the same command again with ${retryWith} once they approve.`;
  return new CloudAuthError(error.code, message, {
    exitCode: 3,
    ...(error.status !== undefined ? { status: error.status } : {}),
    details: {
      source: "connector-turn",
      chatLine,
      chatLinePt,
      replyTo: "owner_privately",
      approvalId,
      approvalLink,
      retryWith,
      ...(expiresAt ? { expiresAt } : {}),
    },
  });
}

export type ConnectorApprovalOutcome = "approved" | "denied" | "expired" | "timeout";

/**
 * Wait at the operator's terminal for the owner to decide on an approval:
 * poll `GET /cli/approvals/:id` every 2 s, up to 10 minutes.
 */
export async function waitForConnectorApproval(
  approvalId: string,
  deps: ConnectorHelperDeps = {},
  options: { intervalMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<ConnectorApprovalOutcome> {
  if (!APPROVAL_ID_PATTERN.test(approvalId)) return "expired";
  const intervalMs = options.intervalMs ?? 2_000;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (options.timeoutMs ?? 10 * 60_000);
  const ctx = await authenticate(deps);
  for (;;) {
    const answer = await ctx.link.request<{ status?: unknown }>(
      "GET",
      `/cli/approvals/${encodeURIComponent(approvalId)}`,
      ctx.accessToken,
    );
    const status = objectValue(answer)?.status;
    if (status === "approved") return "approved";
    if (status === "denied") return "denied";
    if (status !== "pending") return "expired";
    if (now() + intervalMs > deadline) return "timeout";
    await sleep(intervalMs);
  }
}

/**
 * The connection `gmail` and friends use without `--connector`: the row
 * marked default while it is active, else the newest active row of the
 * provider. A default row that is degraded, suspended or waiting for its
 * revoke is skipped, because Link runs capabilities only on active rows.
 * `needsReconnect` is set when the only candidates need reconnecting.
 */
export function pickDefaultConnector(
  connections: ConnectorListItem[],
  provider = "google",
): { connector: ConnectorListItem | null; needsReconnect: boolean } {
  const mine = connections.filter((conn) => conn.provider === provider);
  const marked = mine.find((conn) => conn.isDefault === true && conn.status === "active");
  if (marked) return { connector: marked, needsReconnect: false };
  const active = mine
    .filter((conn) => conn.status === "active" && !conn.requiresReauth)
    .sort((a, b) => timestamp(b.createdAt) - timestamp(a.createdAt));
  if (active[0]) return { connector: active[0], needsReconnect: false };
  const needsReconnect = mine.some((conn) => LIVE_CONNECTION_STATUSES.has(conn.status) && conn.requiresReauth);
  return { connector: null, needsReconnect };
}

/**
 * "Your Gmail connection expired": a line for the owner only, sent privately.
 * The whole link travels in `chatLine`/`chatLinePt` and `reconnectLink`.
 * Public messages lose the path of any `scheme://` URL, so the line quoted in
 * the message names the page without its scheme.
 */
export function connectorReconnectError(
  input: { consoleUrl?: string | null; ownerName?: string | null; status?: number; service?: string } = {},
): CloudAuthError {
  const service = input.service ?? "Gmail";
  const consoleUrl = (input.consoleUrl ?? readActiveConsoleUrl()).replace(/\/+$/, "");
  const reconnectLink = `${consoleUrl}/connectors`;
  const owner = stringValue(input.ownerName) ?? "the account owner";
  const chatLine = `Your ${service} connection expired. Reconnect: ${reconnectLink}`;
  const chatLinePt = `Sua conexão do ${service} expirou. Reconecte: ${reconnectLink}`;
  const quotedLine = `Your ${service} connection expired. Reconnect: ${reconnectLink.replace(/^[a-z]+:\/\//i, "")}`;
  return new CloudAuthError(
    "CONNECTOR_REAUTH_REQUIRED",
    `The ${service} connection expired. Tell ${owner} privately, never in a group: "${quotedLine}"`,
    {
      ...(input.status !== undefined ? { status: input.status } : {}),
      details: { source: "connector-turn", chatLine, chatLinePt, replyTo: "owner_privately", reconnectLink },
    },
  );
}

function readActiveConsoleUrl(): string {
  try {
    return readCloudCredentials()?.consoleUrl ?? DEFAULT_CONSOLE_URL;
  } catch {
    return DEFAULT_CONSOLE_URL;
  }
}

function timestamp(value: string | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
