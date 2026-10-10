/**
 * High-level connectors operations against `link.ravi.so` and the Console.
 *
 * Connections belong to a person, not to a project. Every helper first
 * classifies the current turn (`connector-turn.ts`): only the operator's own
 * turns reach the operator's Console session, and nothing here ever falls
 * back to it for somebody else's turn. Then each helper does one Link or
 * Console call, so command-layer code stays focused on UX and exits with
 * consistent errors when the bearer is missing or expired.
 *
 * An exec also applies the executing agent's mode (`connector-mode.ts`): a
 * contact's turn of an agent in `person_asking` or `shared` mode goes to
 * `POST /cli/agent-exec`, where the Worker picks the person's own account or
 * the shared one. The operator's own turns keep `POST /cli/exec/:id`.
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
import { sanitizePublicValue } from "../cli/redaction.js";

import { APPROVAL_ID_PATTERN, CONSENT_REF_PATTERN, LinkApiClient, LinkStepUpRequiredError } from "./client.js";
import type { ConnectorUseMode } from "./connector-mode.js";
import {
  buildAgentExecContext,
  buildExecContext,
  encodeExecContextHeader,
  EXEC_CONTEXT_HEADER,
  type ConnectorExecRoute,
  type ConnectorTurn,
  type ConnectorTurnDeps,
} from "./connector-turn.js";

export const CONSOLE_CONNECT_START_PATH = "/api/cli/connectors/connect/start";
export const AGENT_EXEC_PATH = "/cli/agent-exec";

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
  /**
   * Legacy, ignored: connections belong to a person. Until 2027-01-01 the
   * Worker sends the row's project, else the stored legacy project id, else
   * "" (older answers sent null).
   */
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
  /** Where an exec goes (exec only). */
  route?: ConnectorExecRoute;
  consoleUrl: string;
  userEmail: string | null;
  ownerName: string | null;
}

async function authenticate(
  deps: ConnectorHelperDeps,
  exec?: { provider: string; useShared?: boolean },
): Promise<AuthenticatedLinkContext> {
  const read = deps.readCredentials ?? readCloudCredentials;
  const write = deps.writeCredentials ?? writeCloudCredentials;
  const remove = deps.deleteCredentials ? () => deps.deleteCredentials?.() : () => deleteConnectorSession();
  const { turn, route, credentials, activeUserId } = resolveConnectorCloudCredentials({
    readActive: read,
    turn: deps.turn,
    ...(exec ? { exec } : {}),
  });
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
    ...(route ? { route } : {}),
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
  /** The operator's own connection; required when the turn uses the owner's account. */
  connectorId?: string;
  capability: string;
  parameters: unknown;
  stepUpToken?: string;
  /** The account owner's approval of this exact action, from an earlier approval answer. */
  approvalId?: string;
  /** The owner asks for the agent's shared account on their own turn (`--shared`). */
  useShared?: boolean;
  /**
   * The mode the caller planned for (`resolveConnectorExecPlan`). When the
   * turn resolves to another one now, nothing is sent.
   */
  expectedMode?: ConnectorUseMode;
}

/**
 * Where an exec of `provider` would go for the current turn, without any
 * remote call: `owner` (the operator's own connection, which the caller
 * picks), or `person_asking` / `shared` (agent exec, where the Worker picks
 * the connection). A turn that may not use any account throws here (exit 3).
 */
export function resolveConnectorExecPlan(
  options: { provider: string; useShared?: boolean },
  deps: ConnectorHelperDeps = {},
): { mode: ConnectorUseMode; agentId: string | null } {
  const { route } = resolveConnectorCloudCredentials({
    readActive: deps.readCredentials ?? readCloudCredentials,
    turn: deps.turn,
    exec: options,
  });
  return { mode: route?.mode ?? "owner", agentId: route?.turn.agentId ?? null };
}

export async function execCapability(
  options: ExecCapabilityOptions,
  deps: ConnectorHelperDeps = {},
): Promise<ExecResult> {
  const provider = providerForCapability(options.capability);
  const ctx = await authenticate(deps, { provider, ...(options.useShared ? { useShared: true } : {}) });
  const mode = ctx.route?.mode ?? "owner";
  if (options.expectedMode && options.expectedMode !== mode) {
    throw new CloudAuthError(
      "CONFLICT",
      "The agent's connector mode changed while this command ran. Run the same command again.",
    );
  }
  const answer = {
    consoleUrl: ctx.consoleUrl,
    ownerName: ctx.ownerName,
    service: serviceForCapability(options.capability),
    approvalId: options.approvalId,
  };
  const extraHeaders: Record<string, string> = {
    ...(options.stepUpToken ? { "X-Ravi-Step-Up": options.stepUpToken } : {}),
    ...(options.approvalId ? { [APPROVAL_HEADER]: options.approvalId } : {}),
  };
  if (mode !== "owner") {
    const turn = ctx.route?.turn ?? ctx.turn;
    try {
      return await ctx.link.request<ExecResult>(
        "POST",
        AGENT_EXEC_PATH,
        ctx.accessToken,
        { provider, capability: options.capability, parameters: options.parameters, mode },
        {
          headers: {
            [EXEC_CONTEXT_HEADER]: encodeExecContextHeader(buildAgentExecContext(turn), { keepAgentId: true }),
            ...extraHeaders,
          },
        },
      );
    } catch (error) {
      throw connectorAnswerError(error, { ...answer, audience: mode, agentId: turn.agentId ?? null });
    }
  }
  const connectorId = options.connectorId?.trim();
  if (!connectorId) {
    throw new CloudAuthError("PAYLOAD_INVALID", "--connector is required to use your own connection here.");
  }
  try {
    return await ctx.link.request<ExecResult>(
      "POST",
      `/cli/exec/${encodeURIComponent(connectorId)}`,
      ctx.accessToken,
      {
        capability: options.capability,
        parameters: options.parameters,
      },
      { headers: { [EXEC_CONTEXT_HEADER]: encodeExecContextHeader(buildExecContext(ctx.turn)), ...extraHeaders } },
    );
  } catch (error) {
    throw connectorAnswerError(error, answer);
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
 *
 * `audience` is whose account the call ran on: the operator's own (`owner`,
 * the default), the person asking's (`person_asking`: lines go to them in
 * their own direct chat), or a shared one (`shared`: the person in the chat
 * cannot fix the account, so lines only say what happened).
 */
export function connectorAnswerError(error: unknown, input: ConnectorAnswerInput = {}): unknown {
  if (!(error instanceof CloudAuthError)) return error;
  const audience = input.audience ?? "owner";
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
    case "CONNECTOR_CONSENT_REQUIRED":
      return audience === "person_asking" ? connectorConsentError(error, input) : error;
    case "CONNECTOR_NOT_LINKED":
      return audience === "person_asking"
        ? connectorNotLinkedError({ ...input, status: error.status, reason: stringValue(error.details?.reason) })
        : error;
    case "CONNECTOR_CONNECTION_REQUIRED":
      return audience === "person_asking"
        ? connectorConnectionRequiredError({ ...input, status: error.status })
        : error;
    case "CONNECTOR_FORBIDDEN":
      return audience === "shared" ? connectorSharedUnavailableError({ ...input, status: error.status }) : error;
    case "CONNECTOR_GROUP_BLOCKED":
      return audience === "owner" ? error : connectorAgentGroupBlockedError({ ...input, status: error.status });
    case "SERVER_UNAVAILABLE":
      // Not an outage: the shared account was revoked or paused, and every
      // retry would get the same answer until an admin fixes it.
      return audience === "shared" && error.details?.reason === "shared_connection_unavailable"
        ? connectorSharedConnectionUnavailableError({ ...input, status: error.status })
        : error;
    default:
      return error;
  }
}

/** Whose account an answer is about, and what the lines say. */
export interface ConnectorAnswerInput {
  consoleUrl?: string | null;
  ownerName?: string | null;
  service?: string;
  approvalId?: string;
  audience?: ConnectorUseMode;
  /** The executing agent (agent exec). */
  agentId?: string | null;
}

/** Who holds the account, and where lines about it go. */
function accountHolder(input: Pick<ConnectorAnswerInput, "ownerName" | "audience">): {
  /** "Luis", "the account owner", "the person asking". */
  label: string;
  /** Instruction for where the line goes, with a colon. */
  tell: string;
  replyTo: "owner_privately" | "same_chat";
} {
  if (input.audience === "person_asking") {
    return {
      label: "the person asking",
      tell: "Tell them in this direct chat, never in a group:",
      replyTo: "same_chat",
    };
  }
  if (input.audience === "shared") {
    return { label: "the manager of the shared account", tell: "Reply:", replyTo: "same_chat" };
  }
  const label = stringValue(input.ownerName) ?? "the account owner";
  return { label, tell: `Tell ${label} privately, never in a group:`, replyTo: "owner_privately" };
}

function capitalize(value: string): string {
  return value ? `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}` : value;
}

function statusOption(status: number | undefined): { status?: number } {
  return status !== undefined ? { status } : {};
}

/**
 * "The account owner must approve this action first": the approval page goes
 * to them privately, and the same command runs again with `--approval <id>`.
 * The page is rebuilt from the Console this CLI is logged in to. Without an
 * approval id the Link answer keeps its catalog copy. On a shared account the
 * manager approves in the Console, so the person in the chat only hears that
 * it waits for an approval.
 */
export function connectorApprovalError(error: CloudAuthError, input: ConnectorAnswerInput = {}): CloudAuthError {
  const approvalId = stringValue(error.details?.approvalId);
  if (!approvalId || !APPROVAL_ID_PATTERN.test(approvalId)) return error;
  const service = input.service ?? "Gmail";
  const consoleUrl = consoleBase(input.consoleUrl);
  const approvalLink = `${consoleUrl}/connectors/approvals/${approvalId}`;
  const retryWith = `--approval ${approvalId}`;
  const expiresAt = stringValue(error.details?.expiresAt);
  const pending = error.code === "CONNECTOR_APPROVAL_PENDING";
  const holder = accountHolder(input);
  let chatLine = `Please approve this ${service} action: ${approvalLink}`;
  let chatLinePt = `Aprove esta ação do ${service}: ${approvalLink}`;
  const quotedLine = `Please approve this ${service} action: ${withoutScheme(approvalLink)}`;
  let message: string;
  if (input.audience === "shared") {
    chatLine = "This needs approval from the manager of the shared account first. I'll do it once it's approved.";
    chatLinePt =
      "Isso precisa ser aprovado antes por quem gerencia a conta compartilhada. Faço assim que for aprovado.";
    message = pending
      ? `The approval for this ${service} action is still waiting for the manager of the shared account (Ravi Console, Connectors, Waiting for you). Once it is approved, run the same command again with ${retryWith}.`
      : `The manager of the shared ${service} account must approve this action first; they see it in Ravi Console under Connectors, Waiting for you. Reply: "${chatLine}" Once it is approved, run the same command again with ${retryWith}.`;
  } else if (input.audience === "person_asking") {
    message = pending
      ? `The approval for this ${service} action is still waiting for the person asking. Once they approve, run the same command again with ${retryWith}. If they have not seen it, send them the link again in this direct chat: "${quotedLine}"`
      : `The person asking must approve this ${service} action first, because it runs on their own account. Send them the link in this direct chat, never in a group: "${quotedLine}", then run the same command again with ${retryWith} once they approve.`;
  } else {
    const ownerName = stringValue(input.ownerName);
    message = pending
      ? `The approval for this ${service} action is still waiting for ${ownerName ?? "the account owner"}. Once they approve, run the same command again with ${retryWith}. If they have not seen it, send them the link again privately, never in a group: "${quotedLine}"`
      : `${ownerName ?? "The account owner"} must approve this ${service} action first. Send them the link privately, never in a group: "${quotedLine}", then run the same command again with ${retryWith} once they approve.`;
  }
  return new CloudAuthError(error.code, message, {
    exitCode: 3,
    ...statusOption(error.status),
    details: {
      source: "connector-turn",
      chatLine,
      chatLinePt,
      replyTo: holder.replyTo,
      approvalId,
      approvalLink,
      retryWith,
      ...(expiresAt ? { expiresAt } : {}),
    },
  });
}

/** The account holder declined the action: it is not done, and the approval is not retried. */
export function connectorApprovalDeniedError(
  input: ConnectorAnswerInput & { status?: number; atTerminal?: boolean } = {},
): CloudAuthError {
  const service = input.service ?? "Gmail";
  const holder = accountHolder(input);
  const options = { exitCode: 3, ...statusOption(input.status) };
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
    `${capitalize(holder.label)} declined this ${service} action in Ravi Console, so it was not done. Do not run it again with this approval. Reply: "${chatLine}"`,
    { ...options, details: { source: "connector-turn", chatLine, chatLinePt, replyTo: "same_chat" } },
  );
}

/**
 * The approval does not cover this action any more (it expired, was used, or
 * the command changed). A new run without `--approval` asks again.
 */
export function connectorApprovalInvalidError(
  input: ConnectorAnswerInput & {
    status?: number;
    reason?: "expired" | "used" | "invalid" | "mismatch";
    atTerminal?: boolean;
  } = {},
): CloudAuthError {
  const service = input.service ?? "Gmail";
  const holder = accountHolder(input);
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
    : `Run the same command again without --approval to ask ${holder.label} for a new approval.`;
  return new CloudAuthError(
    "CONNECTOR_APPROVAL_INVALID",
    `${approval} ${why}, so this ${service} action was not done. ${next}`,
    {
      exitCode: 1,
      ...statusOption(input.status),
      details: { source: "connector-turn" },
    },
  );
}

/** The account holder or the organization blocked this tool in the Console. */
export function connectorToolBlockedError(input: ConnectorAnswerInput & { status?: number } = {}): CloudAuthError {
  const service = input.service ?? "Gmail";
  const options = { exitCode: 3, ...statusOption(input.status) };
  if (input.audience === "shared") {
    const chatLine = "I can't do that with the shared account: this action is blocked in Ravi Console.";
    const chatLinePt = "Não posso fazer isso com a conta compartilhada: esta ação está bloqueada no Ravi Console.";
    return new CloudAuthError(
      "CONNECTOR_TOOL_BLOCKED",
      `This ${service} action is blocked for the shared account in Ravi Console, by its manager or by the organization, so it was not run. Do not retry it with another flag. Reply: "${chatLine}"`,
      { ...options, details: { source: "connector-turn", chatLine, chatLinePt, replyTo: "same_chat" } },
    );
  }
  const link = `${consoleBase(input.consoleUrl)}/connectors`;
  const holder = accountHolder(input);
  const chatLine = `I can't do that: this ${service} action is blocked in your Ravi Console settings. You can review it under Connectors: ${link}`;
  const chatLinePt = `Não posso fazer isso: esta ação do ${service} está bloqueada nas suas configurações do Ravi Console. Você pode revisar em Connectors: ${link}`;
  return new CloudAuthError(
    "CONNECTOR_TOOL_BLOCKED",
    `This ${service} action is blocked in Ravi Console, by ${holder.label} or by the organization, so it was not run. Do not retry it with another flag or connection. ${holder.tell} "${chatLine.replace(link, withoutScheme(link))}"`,
    {
      ...options,
      details: { source: "connector-turn", chatLine, chatLinePt, replyTo: holder.replyTo, reconnectLink: link },
    },
  );
}

/** The organization turned the provider off: only an organization owner or admin can turn it back on. */
export function connectorDisabledByOrgError(input: ConnectorAnswerInput & { status?: number } = {}): CloudAuthError {
  const service = input.service ?? "Gmail";
  const options = { exitCode: 3, ...statusOption(input.status) };
  if (input.audience === "shared") {
    const chatLine = "I can't use the shared Google account right now.";
    const chatLinePt = "Não consigo usar a conta compartilhada do Google agora.";
    return new CloudAuthError(
      "CONNECTOR_DISABLED_BY_ORG",
      `The organization turned off Google connections in Ravi Console, so the shared ${service} account cannot be used. Do not retry. Reply: "${chatLine}"`,
      { ...options, details: { source: "connector-turn", chatLine, chatLinePt, replyTo: "same_chat" } },
    );
  }
  const holder = accountHolder(input);
  const chatLine =
    "Your organization turned off Google connections in Ravi Console. An organization owner or admin can turn them back on.";
  const chatLinePt =
    "Sua organização desligou as conexões do Google no Ravi Console. Um dono ou admin da organização pode religar.";
  const whose = input.audience === "person_asking" ? "the person asking's" : `${holder.label}'s`;
  return new CloudAuthError(
    "CONNECTOR_DISABLED_BY_ORG",
    `The organization turned off Google connections in Ravi Console, so ${whose} ${service} cannot be used. Do not retry. ${holder.tell} "${chatLine}"`,
    { ...options, details: { source: "connector-turn", chatLine, chatLinePt, replyTo: holder.replyTo } },
  );
}

/** The connection is read only, or misses a permission the action needs. */
export function connectorPermissionError(
  input: ConnectorAnswerInput & { status?: number; readOnly?: boolean } = {},
): CloudAuthError {
  const service = input.service ?? "Gmail";
  const why = input.readOnly ? "is read only" : "is missing a permission this action needs";
  if (input.audience === "shared") {
    const chatLine = `The shared ${service} account doesn't allow that.`;
    const chatLinePt = `A conta compartilhada do ${service} não permite isso.`;
    return new CloudAuthError(
      "CONNECTOR_PERMISSION_REQUIRED",
      `The shared ${service} account ${why}, so it was not run; its manager can change that in Ravi Console. Do not retry as is. Reply: "${chatLine}"`,
      {
        ...statusOption(input.status),
        details: { source: "connector-turn", chatLine, chatLinePt, replyTo: "same_chat" },
      },
    );
  }
  const link = `${consoleBase(input.consoleUrl)}/connectors`;
  const holder = accountHolder(input);
  const chatLine = input.readOnly
    ? `Your ${service} connection is read only, so I can't do that. To allow it, choose Allow writing in Ravi Console: ${link}`
    : `Your ${service} connection is missing a permission this needs. Reconnect it in Ravi Console: ${link}`;
  const chatLinePt = input.readOnly
    ? `Sua conexão do ${service} é só leitura, então não posso fazer isso. Para permitir, escolha Allow writing no Ravi Console: ${link}`
    : `Falta uma permissão na sua conexão do ${service} para isso. Reconecte no Ravi Console: ${link}`;
  const whose =
    input.audience === "person_asking"
      ? "The person asking's"
      : holder.label === "the account owner"
        ? "The"
        : `${holder.label}'s`;
  return new CloudAuthError(
    "CONNECTOR_PERMISSION_REQUIRED",
    `${whose} ${service} connection ${why}, so it was not run. Do not retry as is. ${holder.tell} "${chatLine.replace(link, withoutScheme(link))}"`,
    {
      ...statusOption(input.status),
      details: { source: "connector-turn", chatLine, chatLinePt, replyTo: holder.replyTo, reconnectLink: link },
    },
  );
}

/**
 * "The person asking" must allow this agent once (agent exec, Link
 * `connector_consent_required`). The consent page is rebuilt from the
 * Console of the active login with the token of the page Link named; it goes
 * only to that person, in their own direct chat, and carries their consent
 * link, so the message refers to the chat line instead of quoting it.
 */
export function connectorConsentError(error: CloudAuthError, input: ConnectorAnswerInput = {}): CloudAuthError {
  const service = input.service ?? "Gmail";
  const agent = stringValue(input.agentId);
  const who = agent ? `agent ${agent}` : "this agent";
  const ref = stringValue(error.details?.consentRef);
  const consentLink =
    ref && CONSENT_REF_PATTERN.test(ref) ? `${consoleBase(input.consoleUrl)}/connectors/consent/${ref}` : null;
  const chatLine = consentLink ? `To use your ${service} here, approve it once: ${consentLink}` : null;
  const options = { exitCode: 3, ...statusOption(error.status) };
  // A link the public sanitizer would change cannot be sent; asking again
  // issues a new one.
  if (!consentLink || !chatLine || sanitizePublicValue(chatLine, "chatLine") !== chatLine) {
    return new CloudAuthError(
      "CONNECTOR_CONSENT_REQUIRED",
      `The person asking must allow ${who} to use their ${service} first, but no usable consent link came back. Run the same command again to get a new one.`,
      { ...options, details: { source: "connector-turn" } },
    );
  }
  const chatLinePt = `Para eu usar o seu ${service} aqui, aprove uma vez: ${consentLink}`;
  const expiresAt = stringValue(error.details?.expiresAt);
  return new CloudAuthError(
    "CONNECTOR_CONSENT_REQUIRED",
    `The person asking has not allowed ${who} to use their own ${service} yet. Send them the chat line (it carries their consent link) in this direct chat only, never in a group or to anyone else, then run the same command again after they approve. They approve once for this agent.`,
    {
      ...options,
      details: {
        source: "connector-turn",
        chatLine,
        chatLinePt,
        replyTo: "same_chat",
        consentLink,
        ...(expiresAt ? { expiresAt } : {}),
      },
    },
  );
}

/**
 * The person asking has not linked this chat to a Console user (or that user
 * is not a member of the organization), so their own account cannot be used.
 */
export function connectorNotLinkedError(
  input: ConnectorAnswerInput & { status?: number; reason?: string | null } = {},
): CloudAuthError {
  const service = input.service ?? "Gmail";
  const options = { exitCode: 3, ...statusOption(input.status) };
  if (input.reason === "speaker_not_member") {
    const chatLine = `I can't use your ${service} here: your Ravi account is not part of this organization.`;
    const chatLinePt = `Não posso usar o seu ${service} aqui: sua conta Ravi não faz parte desta organização.`;
    return new CloudAuthError(
      "CONNECTOR_NOT_LINKED",
      `The person asking is linked to a Console user who is not an active member of this organization, so their own ${service} cannot be used here. Do not retry. Reply: "${chatLine}"`,
      { ...options, details: { source: "connector-turn", chatLine, chatLinePt, replyTo: "same_chat" } },
    );
  }
  const chatLine = `To use your ${service} here, first link this chat to your Ravi account. Want me to send you a private link to do it?`;
  const chatLinePt = `Para eu usar o seu ${service} aqui, primeiro vincule este chat à sua conta Ravi. Quer que eu te mande um link privado para isso?`;
  return new CloudAuthError(
    "CONNECTOR_NOT_LINKED",
    `The person asking has not linked this chat to a Ravi Console account, so their own ${service} cannot be used yet. Reply: "${chatLine}" If they say yes, run \`ravi link\` in their turn (it sends them the private link); once they approve, run the same command again.`,
    { ...options, details: { source: "connector-turn", chatLine, chatLinePt, replyTo: "same_chat" } },
  );
}

/** The person asking allowed the agent but has no account connected: they connect one in their own Console. */
export function connectorConnectionRequiredError(
  input: ConnectorAnswerInput & { status?: number } = {},
): CloudAuthError {
  const service = input.service ?? "Gmail";
  const link = `${consoleBase(input.consoleUrl)}/connectors`;
  const chatLine = `To use your ${service} here, connect it in Ravi Console first: ${link}`;
  const chatLinePt = `Para eu usar o seu ${service} aqui, conecte ele no Ravi Console primeiro: ${link}`;
  return new CloudAuthError(
    "CONNECTOR_CONNECTION_REQUIRED",
    `The person asking has no ${service} account connected in Ravi Console. Ask them to connect one, in this direct chat: "${chatLine.replace(link, withoutScheme(link))}", then run the same command again.`,
    {
      exitCode: 3,
      ...statusOption(input.status),
      details: { source: "connector-turn", chatLine, chatLinePt, replyTo: "same_chat", reconnectLink: link },
    },
  );
}

/** Shared mode, but no shared account serves this agent in this conversation. */
export function connectorSharedUnavailableError(
  input: ConnectorAnswerInput & { status?: number } = {},
): CloudAuthError {
  const service = input.service ?? "Gmail";
  const agent = stringValue(input.agentId);
  const chatLine = `I can't use a shared ${service} account in this conversation.`;
  const chatLinePt = `Não posso usar uma conta compartilhada do ${service} nesta conversa.`;
  return new CloudAuthError(
    "CONNECTOR_FORBIDDEN",
    `${agent ? `Agent ${agent}` : "This agent"} is set to use a shared Google account, but none is shared with it for this conversation: an organization owner or admin shares one, and chooses its conversations, in Ravi Console. Do not retry. Reply: "${chatLine}"`,
    {
      exitCode: 3,
      ...statusOption(input.status),
      details: { source: "connector-turn", chatLine, chatLinePt, replyTo: "same_chat" },
    },
  );
}

/**
 * Shared mode, and a grant exists, but the organization account it names was
 * disconnected or paused (Link 503 `connector_unavailable`). Only an
 * organization owner or admin can fix it, so the agent does not retry.
 */
export function connectorSharedConnectionUnavailableError(
  input: ConnectorAnswerInput & { status?: number } = {},
): CloudAuthError {
  const service = input.service ?? "Gmail";
  const agent = stringValue(input.agentId);
  const chatLine = `I can't use the shared ${service} account right now.`;
  const chatLinePt = `Não consigo usar a conta compartilhada do ${service} agora.`;
  return new CloudAuthError(
    "CONNECTOR_CONNECTION_REQUIRED",
    `The shared Google account of ${agent ? `agent ${agent}` : "this agent"} was disconnected or paused in Ravi Console; an organization owner or admin must reconnect it or share another one. Do not retry. Reply: "${chatLine}"`,
    {
      exitCode: 3,
      retryable: false,
      ...statusOption(input.status),
      details: { source: "connector-turn", chatLine, chatLinePt, replyTo: "same_chat" },
    },
  );
}

/** Link refused agent exec in a group (a shared account not shared for groups). */
export function connectorAgentGroupBlockedError(
  input: ConnectorAnswerInput & { status?: number } = {},
): CloudAuthError {
  const service = input.service ?? "Gmail";
  const shared = input.audience === "shared";
  const chatLine = shared
    ? "I can't use the shared account in this group."
    : `I can only use your ${service} in a direct chat with me. Ask me there.`;
  const chatLinePt = shared
    ? "Não posso usar a conta compartilhada neste grupo."
    : `Só posso usar o seu ${service} numa conversa direta comigo. Me peça por lá.`;
  return new CloudAuthError(
    "CONNECTOR_GROUP_BLOCKED",
    shared
      ? `The shared ${service} account of this agent is not shared for group chats. Do not retry. Reply in the group: "${chatLine}"`
      : `This agent uses the ${service} of the person asking, but never in a group chat. Reply in the group: "${chatLine}"`,
    {
      exitCode: 3,
      ...statusOption(input.status),
      details: { source: "connector-turn", chatLine, chatLinePt, replyTo: "same_chat" },
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
 * "Your Gmail connection expired": a line for the account holder only, sent
 * privately (the owner, or the person asking in their own direct chat). The
 * whole link travels in `chatLine`/`chatLinePt` and `reconnectLink`. Public
 * messages lose the path of any `scheme://` URL, so the line quoted in the
 * message names the page without its scheme. A shared account is reconnected
 * by its manager, so the person in the chat only hears that it is down.
 */
export function connectorReconnectError(input: ConnectorAnswerInput & { status?: number } = {}): CloudAuthError {
  const service = input.service ?? "Gmail";
  if (input.audience === "shared") {
    const chatLine = `I can't use the shared ${service} account right now: it needs to be reconnected.`;
    const chatLinePt = `Não consigo usar a conta compartilhada do ${service} agora: ela precisa ser reconectada.`;
    return new CloudAuthError(
      "CONNECTOR_REAUTH_REQUIRED",
      `The shared ${service} account of this agent expired; its manager must reconnect it in Ravi Console. Reply: "${chatLine}"`,
      {
        ...statusOption(input.status),
        details: { source: "connector-turn", chatLine, chatLinePt, replyTo: "same_chat" },
      },
    );
  }
  const reconnectLink = `${consoleBase(input.consoleUrl)}/connectors`;
  const holder = accountHolder(input);
  const chatLine = `Your ${service} connection expired. Reconnect: ${reconnectLink}`;
  const chatLinePt = `Sua conexão do ${service} expirou. Reconecte: ${reconnectLink}`;
  const quotedLine = `Your ${service} connection expired. Reconnect: ${withoutScheme(reconnectLink)}`;
  const whose =
    input.audience === "person_asking" ? `${service} connection of the person asking` : `${service} connection`;
  return new CloudAuthError("CONNECTOR_REAUTH_REQUIRED", `The ${whose} expired. ${holder.tell} "${quotedLine}"`, {
    ...statusOption(input.status),
    details: { source: "connector-turn", chatLine, chatLinePt, replyTo: holder.replyTo, reconnectLink },
  });
}

/** The service a capability acts on, for the lines the agent says. */
export function serviceForCapability(capability: string): string {
  if (capability.startsWith("gmail.")) return "Gmail";
  if (capability.startsWith("gcal.")) return "Google Calendar";
  return "Google";
}

/** The provider whose mode and connection a capability uses. */
export function providerForCapability(capability: string): string {
  return capability.startsWith("gmail.") || capability.startsWith("gcal.")
    ? "google"
    : (capability.split(".")[0] ?? "");
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
