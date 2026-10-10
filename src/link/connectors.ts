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
import { CloudAuthError, isRetryableCloudAuthError } from "../cloud-auth/errors.js";
import { deleteCloudCredentials, readCloudCredentials, writeCloudCredentials } from "../cloud-auth/storage.js";
import { DEFAULT_CONSOLE_URL, type CloudCredentials } from "../cloud-auth/types.js";

import { APPROVAL_ID_PATTERN, LinkApiClient, LinkStepUpRequiredError } from "./client.js";
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
  let payload: unknown;
  try {
    payload = await ctx.consoleClient.requestJson<unknown>(
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
  } catch (error) {
    if (error instanceof CloudAuthError && error.code === "CONNECTOR_DISABLED_BY_ORG") {
      throw connectorDisabledByOrgError({ ownerName: ctx.ownerName, service: "Google account", status: error.status });
    }
    throw error;
  }
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

export interface ExecCapabilityOptions {
  connectorId: string;
  capability: string;
  parameters: unknown;
  stepUpToken?: string;
  /** The owner's approval of this exact action, from an earlier approval answer. */
  approvalId?: string;
}

export async function execCapability(
  options: ExecCapabilityOptions,
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
    throw connectorAnswerError(error, {
      consoleUrl: ctx.consoleUrl,
      ownerName: ctx.ownerName,
      service: serviceForCapability(options.capability),
      approvalId: options.approvalId,
    });
  }
}

export interface ApprovalWaitOptions {
  intervalMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** The operator's own terminal, where an approval can be waited for. */
export interface TerminalApprovalOptions extends ApprovalWaitOptions {
  /** Opens a page in the operator's browser (best effort). */
  openExternal?: (url: string) => Promise<void> | void;
  /** Progress lines for the operator; stderr by default. */
  log?: (line: string) => void;
}

/**
 * Answers a step-up challenge with the code from the browser, or null to
 * cancel. Without one, the challenge is thrown as it came.
 */
export type StepUpHandler = (challenge: LinkStepUpRequiredError["details"]) => Promise<string | null>;

/**
 * Run a capability; when the owner must approve it first and `terminal` is
 * given (the operator's own terminal), print the approval page, open it,
 * wait for the decision and run the same action once more with the
 * approval. Without `terminal` the approval answer is thrown (exit 3) with
 * the link to send the owner and the `--approval <id>` to re-run with.
 * A step-up challenge on the way is answered through `stepUp`, and the
 * retry keeps the approval: the Worker asks for the step-up before it
 * consumes the approval.
 */
export async function execCapabilityWithApproval(
  options: ExecCapabilityOptions,
  deps: ConnectorHelperDeps = {},
  terminal: TerminalApprovalOptions | null = null,
  stepUp: StepUpHandler | null = null,
): Promise<ExecResult> {
  try {
    return await execCapabilityWithStepUp(options, deps, stepUp);
  } catch (error) {
    if (!terminal || !(error instanceof CloudAuthError) || !isApprovalAnswer(error)) throw error;
    const approvalId = stringValue(error.details?.approvalId);
    const approvalLink = stringValue(error.details?.approvalLink);
    if (!approvalId || !approvalLink) throw error;
    const log = terminal.log ?? ((line: string) => console.error(line));
    const service = serviceForCapability(options.capability);
    log(`This ${service} action needs your approval in Ravi Console.`);
    log(`Open: ${approvalLink}`);
    log("Waiting for your decision (up to 10 minutes)...");
    try {
      await terminal.openExternal?.(approvalLink);
    } catch {
      // Best-effort browser open: the link is printed above.
    }
    const outcome = await waitForConnectorApproval(approvalId, deps, terminal);
    switch (outcome) {
      case "approved":
        log("Approved. Running it now.");
        return execCapabilityWithStepUp({ ...options, approvalId }, deps, stepUp);
      case "denied":
        throw connectorApprovalDeniedError({ service, atTerminal: true });
      case "expired":
      case "used":
      case "invalid":
        throw connectorApprovalInvalidError({ approvalId, service, reason: outcome, atTerminal: true });
      case "timeout":
        log("No decision after 10 minutes.");
        throw error;
    }
  }
}

async function execCapabilityWithStepUp(
  options: ExecCapabilityOptions,
  deps: ConnectorHelperDeps,
  stepUp: StepUpHandler | null,
): Promise<ExecResult> {
  try {
    return await execCapability(options, deps);
  } catch (error) {
    if (!stepUp || !(error instanceof LinkStepUpRequiredError)) throw error;
    const token = await stepUp(error.details);
    if (!token) throw new Error("Step-up cancelled.");
    return execCapability({ ...options, stepUpToken: token }, deps);
  }
}

function isApprovalAnswer(error: CloudAuthError): boolean {
  return error.code === "CONNECTOR_APPROVAL_REQUIRED" || error.code === "CONNECTOR_APPROVAL_PENDING";
}

/**
 * A Link or Console answer that tells the agent what to say: the connector
 * codes the person can act on get local copy (`source: "connector-turn"`)
 * with the line to send. Anything else is returned as it came.
 */
export function connectorAnswerError(
  error: unknown,
  input: { consoleUrl?: string | null; ownerName?: string | null; service?: string; approvalId?: string } = {},
): unknown {
  if (!(error instanceof CloudAuthError)) return error;
  switch (error.code) {
    case "CONNECTOR_REAUTH_REQUIRED":
      return connectorReconnectError({ ...input, status: error.status });
    case "CONNECTOR_APPROVAL_REQUIRED":
    case "CONNECTOR_APPROVAL_PENDING":
      return connectorApprovalError(error, input);
    case "CONNECTOR_APPROVAL_DENIED":
      return connectorApprovalDeniedError({ ...input, status: error.status });
    case "CONNECTOR_APPROVAL_INVALID":
      return connectorApprovalInvalidError({ ...input, reason: "mismatch", status: error.status });
    case "CONNECTOR_TOOL_BLOCKED":
      return connectorToolBlockedError({ ...input, status: error.status });
    case "CONNECTOR_DISABLED_BY_ORG":
      return connectorDisabledByOrgError({ ...input, status: error.status });
    case "CONNECTOR_PERMISSION_REQUIRED":
      return connectorPermissionError({
        ...input,
        status: error.status,
        readOnly: error.details?.accessMode === "read_only",
      });
    default:
      return error;
  }
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
  const consoleUrl = consoleBase(input.consoleUrl);
  const approvalLink = `${consoleUrl}/connectors/approvals/${approvalId}`;
  const ownerName = stringValue(input.ownerName);
  const retryWith = `--approval ${approvalId}`;
  const chatLine = `Please approve this ${service} action: ${approvalLink}`;
  const chatLinePt = `Aprove esta ação do ${service}: ${approvalLink}`;
  const quotedLine = `Please approve this ${service} action: ${withoutScheme(approvalLink)}`;
  const expiresAt = stringValue(error.details?.expiresAt);
  const message =
    error.code === "CONNECTOR_APPROVAL_PENDING"
      ? `The approval for this ${service} action is still waiting for ${ownerName ?? "the account owner"}. Once they approve, run the same command again with ${retryWith}. If they have not seen it, send them the link again privately, never in a group: "${quotedLine}"`
      : `${ownerName ?? "The account owner"} must approve this ${service} action first. Send them the link privately, never in a group: "${quotedLine}", then run the same command again with ${retryWith} once they approve.`;
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

/** The owner declined the action: it is not done, and the approval is not retried. */
export function connectorApprovalDeniedError(
  input: { ownerName?: string | null; service?: string; status?: number; atTerminal?: boolean } = {},
): CloudAuthError {
  const service = input.service ?? "Gmail";
  const owner = stringValue(input.ownerName) ?? "The account owner";
  const options = { exitCode: 3, ...(input.status !== undefined ? { status: input.status } : {}) };
  if (input.atTerminal) {
    return new CloudAuthError(
      "CONNECTOR_APPROVAL_DENIED",
      `The approval was declined in Ravi Console, so this ${service} action was not done.`,
      { ...options, details: { source: "connector-turn" } },
    );
  }
  const chatLine = "Okay, I didn't do it: the approval was declined.";
  const chatLinePt = "Certo, não fiz: a aprovação foi recusada.";
  return new CloudAuthError(
    "CONNECTOR_APPROVAL_DENIED",
    `${owner} declined this ${service} action in Ravi Console, so it was not done. Do not run it again with this approval. Reply: "${chatLine}"`,
    { ...options, details: { source: "connector-turn", chatLine, chatLinePt, replyTo: "same_chat" } },
  );
}

/**
 * The approval does not cover this action any more (it expired, was used, or
 * the command changed). A new run without `--approval` asks again.
 */
export function connectorApprovalInvalidError(
  input: {
    approvalId?: string;
    ownerName?: string | null;
    service?: string;
    status?: number;
    reason?: "expired" | "used" | "invalid" | "mismatch";
    atTerminal?: boolean;
  } = {},
): CloudAuthError {
  const service = input.service ?? "Gmail";
  const owner = stringValue(input.ownerName) ?? "the account owner";
  const approval =
    input.approvalId && APPROVAL_ID_PATTERN.test(input.approvalId)
      ? `The approval ${input.approvalId}`
      : "The approval";
  const why =
    input.reason === "expired"
      ? `expired before it was decided`
      : input.reason === "used"
        ? "was already used"
        : "does not cover this action: it expired, was already used, or the command changed";
  const next = input.atTerminal
    ? "Run the same command again to ask for a new approval."
    : `Run the same command again without --approval to ask ${owner} for a new approval.`;
  return new CloudAuthError(
    "CONNECTOR_APPROVAL_INVALID",
    `${approval} ${why}, so this ${service} action was not done. ${next}`,
    {
      exitCode: 1,
      ...(input.status !== undefined ? { status: input.status } : {}),
      details: { source: "connector-turn" },
    },
  );
}

/** The owner or the organization blocked this tool in the Console. */
export function connectorToolBlockedError(
  input: { consoleUrl?: string | null; ownerName?: string | null; service?: string; status?: number } = {},
): CloudAuthError {
  const service = input.service ?? "Gmail";
  const link = `${consoleBase(input.consoleUrl)}/connectors`;
  const owner = stringValue(input.ownerName) ?? "the account owner";
  const chatLine = `I can't do that: this ${service} action is blocked in your Ravi Console settings. You can review it under Connectors: ${link}`;
  const chatLinePt = `Não posso fazer isso: esta ação do ${service} está bloqueada nas suas configurações do Ravi Console. Você pode revisar em Connectors: ${link}`;
  return new CloudAuthError(
    "CONNECTOR_TOOL_BLOCKED",
    `This ${service} action is blocked in Ravi Console, by ${owner} or by the organization, so it was not run. Do not retry it with another flag or connection. Tell ${owner} privately: "${chatLine.replace(link, withoutScheme(link))}"`,
    {
      exitCode: 3,
      ...(input.status !== undefined ? { status: input.status } : {}),
      details: { source: "connector-turn", chatLine, chatLinePt, replyTo: "owner_privately", reconnectLink: link },
    },
  );
}

/** The organization turned the provider off: only an organization owner or admin can turn it back on. */
export function connectorDisabledByOrgError(
  input: { ownerName?: string | null; service?: string; status?: number } = {},
): CloudAuthError {
  const owner = stringValue(input.ownerName) ?? "the account owner";
  const service = input.service ?? "Gmail";
  const chatLine =
    "Your organization turned off Google connections in Ravi Console. An organization owner or admin can turn them back on.";
  const chatLinePt =
    "Sua organização desligou as conexões do Google no Ravi Console. Um dono ou admin da organização pode religar.";
  return new CloudAuthError(
    "CONNECTOR_DISABLED_BY_ORG",
    `The organization turned off Google connections in Ravi Console, so ${owner}'s ${service} cannot be used. Do not retry. Tell ${owner} privately: "${chatLine}"`,
    {
      exitCode: 3,
      ...(input.status !== undefined ? { status: input.status } : {}),
      details: { source: "connector-turn", chatLine, chatLinePt, replyTo: "owner_privately" },
    },
  );
}

/** The connection is read only, or misses a permission the action needs. */
export function connectorPermissionError(
  input: {
    consoleUrl?: string | null;
    ownerName?: string | null;
    service?: string;
    status?: number;
    readOnly?: boolean;
  } = {},
): CloudAuthError {
  const service = input.service ?? "Gmail";
  const link = `${consoleBase(input.consoleUrl)}/connectors`;
  const owner = stringValue(input.ownerName) ?? "the account owner";
  const chatLine = input.readOnly
    ? `Your ${service} connection is read only, so I can't do that. To allow it, choose Allow writing in Ravi Console: ${link}`
    : `Your ${service} connection is missing a permission this needs. Reconnect it in Ravi Console: ${link}`;
  const chatLinePt = input.readOnly
    ? `Sua conexão do ${service} é só leitura, então não posso fazer isso. Para permitir, escolha Allow writing no Ravi Console: ${link}`
    : `Falta uma permissão na sua conexão do ${service} para isso. Reconecte no Ravi Console: ${link}`;
  const why = input.readOnly ? "is read only" : "is missing a permission this action needs";
  return new CloudAuthError(
    "CONNECTOR_PERMISSION_REQUIRED",
    `${owner === "the account owner" ? "The" : `${owner}'s`} ${service} connection ${why}, so it was not run. Do not retry as is. Tell ${owner} privately: "${chatLine.replace(link, withoutScheme(link))}"`,
    {
      ...(input.status !== undefined ? { status: input.status } : {}),
      details: { source: "connector-turn", chatLine, chatLinePt, replyTo: "owner_privately", reconnectLink: link },
    },
  );
}

export type ConnectorApprovalOutcome = "approved" | "denied" | "expired" | "used" | "invalid" | "timeout";

/**
 * Wait at the operator's terminal for the owner to decide on an approval:
 * poll `GET /cli/approvals/:id` every 2 s, up to 10 minutes. A passing outage
 * keeps waiting; an approval Link does not know for this user is `invalid`.
 */
export async function waitForConnectorApproval(
  approvalId: string,
  deps: ConnectorHelperDeps = {},
  options: ApprovalWaitOptions = {},
): Promise<ConnectorApprovalOutcome> {
  if (!APPROVAL_ID_PATTERN.test(approvalId)) return "invalid";
  const intervalMs = options.intervalMs ?? 2_000;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (options.timeoutMs ?? 10 * 60_000);
  let ctx = await authenticate(deps);
  let refreshed = false;
  for (;;) {
    let status: unknown = "pending";
    try {
      const answer = await ctx.link.request<{ status?: unknown }>(
        "GET",
        `/cli/approvals/${encodeURIComponent(approvalId)}`,
        ctx.accessToken,
      );
      status = objectValue(answer)?.status;
      refreshed = false;
    } catch (error) {
      if (!(error instanceof CloudAuthError)) throw error;
      if (error.code === "NOT_FOUND") return "invalid";
      if (error.code === "AUTH_EXPIRED" && !refreshed) {
        // The bearer expired during a long wait: refresh it once and go on.
        ctx = await authenticate(deps);
        refreshed = true;
        continue;
      }
      if (!isRetryableCloudAuthError(error)) throw error;
    }
    if (status === "approved") return "approved";
    if (status === "denied") return "denied";
    if (status === "expired") return "expired";
    if (status === "consumed") return "used";
    if (status !== "pending") return "invalid";
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
  const reconnectLink = `${consoleBase(input.consoleUrl)}/connectors`;
  const owner = stringValue(input.ownerName) ?? "the account owner";
  const chatLine = `Your ${service} connection expired. Reconnect: ${reconnectLink}`;
  const chatLinePt = `Sua conexão do ${service} expirou. Reconecte: ${reconnectLink}`;
  const quotedLine = `Your ${service} connection expired. Reconnect: ${withoutScheme(reconnectLink)}`;
  return new CloudAuthError(
    "CONNECTOR_REAUTH_REQUIRED",
    `The ${service} connection expired. Tell ${owner} privately, never in a group: "${quotedLine}"`,
    {
      ...(input.status !== undefined ? { status: input.status } : {}),
      details: { source: "connector-turn", chatLine, chatLinePt, replyTo: "owner_privately", reconnectLink },
    },
  );
}

/** The service a capability acts on, for the lines the agent says. */
export function serviceForCapability(capability: string): string {
  if (capability.startsWith("gmail.")) return "Gmail";
  if (capability.startsWith("gcal.")) return "Google Calendar";
  return "Google";
}

/**
 * The Console of the active login, without a trailing slash. Public messages
 * lose the path of any `scheme://` URL, so lines quoted in a message use
 * `withoutScheme`; `chatLine` and the link details keep the whole link.
 */
function consoleBase(consoleUrl: string | null | undefined): string {
  return (consoleUrl ?? readActiveConsoleUrl()).replace(/\/+$/, "");
}

function withoutScheme(link: string): string {
  return link.replace(/^[a-z]+:\/\//i, "");
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
