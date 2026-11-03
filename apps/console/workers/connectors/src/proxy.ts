/**
 * Connector proxy executor (`POST /cli/exec/:id`, and the shared
 * pipeline of `POST /cli/agent-exec`, see `agent-exec.ts`).
 *
 * Runs the checks of a capability invocation in a fixed order, then the
 * call itself:
 *    1. (router) the CLI bearer, on an active installation, and the
 *       `X-Ravi-Exec-Context` of the turn;
 *    2. the connection: in the caller's organization, and (3) the
 *       caller's own personal connection (organization connections only
 *       run through agent exec), checked first so that someone else's
 *       connection answers like an unknown one; then live, not waiting
 *       for a reconnect, of the capability's provider;
 *    4. who is asking and where (groups, other agents, triggers, other
 *       people);
 *    5. the organization's policy for the provider;
 *    6. the effective tool policy (organization ceiling, writes allowed,
 *       the owner's choice or the class default); for the person asking,
 *       a write always needs that person's approval;
 *    7. write-after-read: a write in a turn that already read is never
 *       run without approval;
 *    8. access mode, provider scopes, input validation;
 *    9. the owner's approval when the policy needs one (checked here,
 *       used up right before the provider call);
 *   10. step-up, token refresh, the provider call, output projection and
 *       audit;
 *   11. usage and `last_used_at`.
 * Agent exec resolves the connection and who decides its approvals
 * itself (the person asking, or an organization account's manager) and
 * enters at step 5 with its mode; usage then records that mode.
 * Every refusal is audited (`connector.action.denied` with its error
 * code; on the caller when the connection is not theirs). Waiting for the
 * owner's approval is no refusal: it is audited as the approval's
 * request. Plaintext provider tokens are scoped to this function call and
 * never exposed to the caller.
 */

import { z, ZodError } from "zod";

import { AdapterProviderError, type ConnectorAdapter, type ProviderTokenBundle } from "./adapters/adapter";
import {
  approvalParamsHash,
  checkApproval,
  consumeApproval,
  requestApproval,
  type ApprovalReason,
  type ApprovalRedeemInput,
} from "./approvals";
import {
  decryptPayload,
  encryptPayload,
  type ConnectorEncryptionAad,
} from "./crypto";
import type { ConnectorsDb } from "./db";
import {
  findConnectorToolPolicy,
  findCredentialsByConnection,
  findOrgConnectorPolicy,
  findProviderConnectionById,
  hasRecentTurnRead,
  insertAuditEvent,
  markConnectionRequiresReauth,
  recordConnectorUsage,
  recordTurnRead,
  touchConnectionLastUsed,
  upsertCredential,
  type ProviderConnectionRecord,
} from "./db";
import { getCapability, type CapabilityDefinition } from "./capabilities/registry";
import {
  execAuditMetadata,
  personalUseDenial,
  routineKey,
  type ParsedExecContext,
} from "./exec-context";
import { missingRequiredProviderScopes, storedAccessMode } from "./scopes";
import {
  issueChallenge,
  StepUpRuntimeError,
  verifyAndConsumeToken,
  type StepUpRuntimeDeps,
} from "./stepup-runtime";
import { sha256Hex } from "./tokens";
import {
  effectiveToolPolicy,
  isToolPolicy,
  sharedDefaultToolPolicy,
  strictestToolPolicy,
} from "./tool-policy";

export { missingRequiredProviderScopes } from "./scopes";

const SCHEMA_VERSION = 1;
const REFRESH_BEFORE_EXPIRY_SECONDS = 60;

export interface ProxyDeps {
  db: ConnectorsDb;
  rootWrapKey: CryptoKey;
  dekKeyVersion: number;
  adapters: Map<string, ConnectorAdapter>;
  stepUp: StepUpRuntimeDeps;
  /** Base of the Console approval page links. */
  consoleBaseUrl: string;
}

export interface ProxyInvocation {
  organizationId: string;
  userId: string;
  providerConnectionId: string;
  capability: string;
  parameters: unknown;
  requestId: string;
  actorType: "user" | "cli" | "agent";
  stepUpToken?: string;
  /** The turn's `X-Ravi-Exec-Context` (the terminal for an older CLI without it). */
  execContext: ParsedExecContext;
  /** The CLI session's installation and the session itself. */
  localInstallationId: string | null;
  cliSessionId: string | null;
  /** `X-Ravi-Approval`: the owner's approval of exactly this action. */
  approvalId?: string | null;
}

/**
 * How a connection is used on this call: by its owner (`/cli/exec`), or by
 * an agent for the person asking or as a shared organization account.
 */
export interface ConnectionUse {
  mode: "owner" | "person_asking" | "shared";
  /** Who decides approvals; `null` when nobody can (an action needing one is refused). */
  approverUserId: string | null;
  /**
   * `person_asking`: the person the agent acts for (the account's owner).
   * The audit's actor stays the CLI session user, who asked; this person
   * is named in the metadata, which is how their Recent activity finds it.
   */
  actingForUserId?: string;
  /** The agent grant the call runs under. */
  grantId?: string;
}

export interface ProxyResult {
  result: unknown;
  capability: string;
  refreshed: boolean;
}

export interface StepUpRequiredDetails {
  challengeId: string;
  verificationUrl: string;
  expiresAt: string;
}

export class ProxyError extends Error {
  constructor(
    public readonly code: ProxyErrorCode,
    message: string,
    public readonly details?: Record<string, unknown> | StepUpRequiredDetails,
  ) {
    super(message);
    this.name = "ProxyError";
  }
}

export type ProxyErrorCode =
  | "connector_unavailable"
  | "connector_permission_required"
  | "connector_capability_unsupported"
  | "connector_provider_error"
  | "connector_reauth_required"
  | "connector_stepup_required"
  | "connector_stepup_rejected"
  | "connector_forbidden"
  | "connector_group_blocked"
  | "connector_speaker_not_owner"
  | "connector_disabled_by_org"
  | "connector_tool_blocked"
  | "connector_approval_required"
  | "connector_approval_pending"
  | "connector_approval_denied"
  | "connector_approval_invalid"
  | "payload_invalid"
  | "internal_error";

/** HTTP status of each proxy error. */
export const PROXY_ERROR_STATUS: Record<ProxyErrorCode, number> = {
  connector_unavailable: 503,
  connector_permission_required: 403,
  connector_capability_unsupported: 400,
  connector_provider_error: 502,
  connector_reauth_required: 503,
  connector_stepup_required: 409,
  connector_stepup_rejected: 401,
  connector_forbidden: 403,
  connector_group_blocked: 403,
  connector_speaker_not_owner: 403,
  connector_disabled_by_org: 403,
  connector_tool_blocked: 403,
  connector_approval_required: 409,
  connector_approval_pending: 409,
  connector_approval_denied: 403,
  connector_approval_invalid: 400,
  payload_invalid: 400,
  internal_error: 503,
};

/** Proxy errors whose details reach the caller. */
export const PROXY_ERROR_PUBLIC_DETAILS: ReadonlySet<ProxyErrorCode> = new Set<ProxyErrorCode>([
  "connector_disabled_by_org",
  "connector_stepup_required",
  "connector_permission_required",
  "connector_approval_required",
  "connector_approval_pending",
]);

export async function executeCapability(
  deps: ProxyDeps,
  invocation: ProxyInvocation,
): Promise<ProxyResult> {
  const capability = safeGetCapability(invocation.capability);
  const { context } = invocation.execContext;

  // 2–3. The connection: in the caller's organization and the caller's own
  // personal connection (organization connections only run through agent
  // exec). Someone else's connection is refused before its state is looked
  // at, like an unknown id, and the refusal is audited on the caller: the
  // owner's Recent activity never shows what another person sent.
  const connection = await findProviderConnectionById(
    deps.db,
    invocation.providerConnectionId,
    invocation.organizationId,
  );
  if (!connection || connection.provider === "github") {
    throw new ProxyError("connector_unavailable", "Connection not found");
  }
  if (connection.scopeKind === "organization") {
    await auditForeignDenied(deps, invocation, connection.id, "organization_connection", "connector_forbidden");
    throw new ProxyError("connector_forbidden", "Organization connections run through agent exec");
  }
  if (!connection.userId || connection.userId !== invocation.userId) {
    await auditForeignDenied(deps, invocation, connection.id, "actor_user_mismatch", "connector_unavailable");
    throw new ProxyError("connector_unavailable", "Connection not found");
  }
  const use: ConnectionUse = { mode: "owner", approverUserId: connection.userId };
  await requireUsableConnection(deps, invocation, connection, capability, use);

  // 4. Who is asking, and where.
  const useDenial = personalUseDenial(context, connection.userId);
  if (useDenial) {
    await auditDenied(deps, invocation, connection, use, useDenial === "connector_group_blocked" ? "group_conversation" : "speaker_not_owner", useDenial);
    throw new ProxyError(useDenial, "This connection serves only its owner's own requests");
  }

  return runCapability(deps, invocation, connection, capability, use);
}

/**
 * Agent exec (`/cli/agent-exec`): the connection and who decides for it
 * were resolved from the agent's grant; the rest of the pipeline is the
 * same as an owner's exec.
 */
export async function executeCapabilityForAgent(
  deps: ProxyDeps,
  invocation: ProxyInvocation,
  connection: ProviderConnectionRecord,
  use: ConnectionUse,
): Promise<ProxyResult> {
  const capability = safeGetCapability(invocation.capability);
  await requireUsableConnection(deps, invocation, connection, capability, use);
  return runCapability(deps, invocation, connection, capability, use);
}

/**
 * Live, usable without a reconnect, of the capability's provider. A row
 * whose refresh token Google refused is not asked to approve anything:
 * the action could not run.
 */
async function requireUsableConnection(
  deps: ProxyDeps,
  invocation: ProxyInvocation,
  connection: ProviderConnectionRecord,
  capability: CapabilityDefinition,
  use: ConnectionUse,
): Promise<void> {
  const deny = async (code: ProxyErrorCode, reason: string, message: string): Promise<never> => {
    await auditDenied(deps, invocation, connection, use, reason, code);
    throw new ProxyError(code, message);
  };
  if (connection.status !== "active") {
    await deny(
      connection.requiresReauth ? "connector_reauth_required" : "connector_unavailable",
      "connector_status_inactive",
      `Connection status ${connection.status}`,
    );
  }
  if (connection.requiresReauth) {
    await deny("connector_reauth_required", "connector_requires_reauth", "Connection needs reconnecting");
  }
  if (capability.providerId !== connection.provider) {
    await deny("connector_capability_unsupported", "capability_provider_mismatch", "Capability does not match provider");
  }
}

/** Steps 5–11, shared by an owner's exec and an agent's. */
async function runCapability(
  deps: ProxyDeps,
  invocation: ProxyInvocation,
  owned: ProviderConnectionRecord,
  capability: CapabilityDefinition,
  use: ConnectionUse,
): Promise<ProxyResult> {
  const { context } = invocation.execContext;
  const deny = async (
    code: ProxyErrorCode,
    reason: string,
    message: string,
    details?: Record<string, unknown>,
  ): Promise<never> => {
    await auditDenied(deps, invocation, owned, use, reason, code);
    throw new ProxyError(code, message, details);
  };

  // 5. The organization's policy for the provider (and, for a shared
  // account, whether the organization allows sharing at all).
  const orgPolicy = await findOrgConnectorPolicy(deps.db, {
    organizationId: owned.organizationId,
    provider: owned.provider,
  });
  if (!orgPolicy.enabled) {
    await deny("connector_disabled_by_org", "disabled_by_org", "Connector disabled by the organization");
  }
  if (use.mode === "shared" && !orgPolicy.sharedAllowed) {
    await deny("connector_disabled_by_org", "shared_not_allowed", "Shared accounts are off for the organization", {
      reason: "shared_not_allowed",
    });
  }

  // 6. Effective tool policy. A shared account starts from its own
  // defaults (reads blocked except free/busy); the manager's rule may
  // loosen them within the organization's ceilings.
  const userPolicy = await findConnectorToolPolicy(deps.db, {
    providerConnectionId: owned.id,
    capability: capability.id,
  });
  let policy = effectiveToolPolicy({
    capabilityClass: capability.class,
    ceiling: orgPolicy.toolCeilingsJson?.[capability.id],
    writesAllowed: orgPolicy.writesAllowed,
    userPolicy: isToolPolicy(userPolicy) ? userPolicy : null,
    ...(use.mode === "shared" ? { defaultPolicy: sharedDefaultToolPolicy(capability) } : {}),
  });
  if (policy === "blocked") {
    await deny("connector_tool_blocked", "tool_blocked", "Tool blocked by policy");
  }
  // For the person asking, a write always waits for that person: their
  // "Always allow" was chosen for their own requests, and who is asking is
  // only what the operator's daemon says. Reads follow the rules above.
  if (use.mode === "person_asking" && capability.class !== "read") {
    policy = strictestToolPolicy(policy, "needs_approval");
  }

  // 7. Write-after-read: what a turn read may have steered what it writes.
  let approvalReason: ApprovalReason = "policy";
  const turnKeyHash = context.turnKey ? await sha256Hex(context.turnKey) : null;
  if (capability.class !== "read" && turnKeyHash && invocation.localInstallationId) {
    const readThisTurn = await hasRecentTurnRead(deps.db, {
      localInstallationId: invocation.localInstallationId,
      turnKeyHash,
    });
    if (readThisTurn) {
      policy = strictestToolPolicy(policy, "needs_approval");
      approvalReason = "write_after_read";
    }
  }

  // 8. Access mode, provider scopes, input.
  // Connected read only: no write, whatever scopes the row holds.
  if (capability.class !== "read" && storedAccessMode(owned.metadataJson) === "read_only") {
    await deny("connector_permission_required", "connection_read_only", "Connection is read only", {
      accessMode: "read_only",
    });
  }
  const missingScopes = missingRequiredProviderScopes(
    capability.requiredProviderScopes,
    owned.scopesJson,
  );
  if (missingScopes.length > 0) {
    await deny(
      "connector_permission_required",
      "provider_scope_missing",
      "Connection missing required provider scope",
      { missingScopes },
    );
  }

  let parameters: unknown;
  try {
    parameters = capability.input.parse(invocation.parameters);
  } catch (error) {
    if (error instanceof ZodError) {
      await deny("payload_invalid", "payload_invalid", "Capability input did not validate", {
        issues: error.issues.map((issue) => ({ path: issue.path, code: issue.code })),
      });
    }
    throw error;
  }

  const adapter = deps.adapters.get(owned.provider);
  if (!adapter) {
    await deny("connector_unavailable", "adapter_missing", "Provider adapter not registered");
  }

  // 9. The approval of the owner (or the organization account's manager).
  // Waiting for them is no refusal: the request is audited as
  // `connector.approval.created`, never as a denial. An approval that
  // covers this action is only checked here; it is used up right before
  // the provider call (below), so a refusal on the way there leaves it for
  // the retry.
  const approvalDeps = {
    db: deps.db,
    rootWrapKey: deps.rootWrapKey,
    dekKeyVersion: deps.dekKeyVersion,
    consoleBaseUrl: deps.consoleBaseUrl,
  };
  let approval: ApprovalRedeemInput | null = null;
  if (policy === "needs_approval") {
    // A CLI from before approvals (no exec context) can neither wait for
    // one nor send it back: asking the owner would leave them an approval
    // that nothing ever runs, so it is told to update instead.
    if (invocation.execContext.legacyCli) {
      await deny("connector_permission_required", "cli_upgrade_required", "Update Ravi to run actions that need approval", {
        reason: "cli_upgrade_required",
      });
    }
    if (!use.approverUserId) {
      await deny("connector_forbidden", "no_approver", "Nobody can approve actions on this account");
    }
    const ownerUserId = use.approverUserId!;
    const paramsHash = await approvalParamsHash(parameters);
    const auditActorType = use.mode === "owner" ? "cli" : "agent";
    const auditMetadata = connectionUseMetadata(invocation, use);
    if (!invocation.approvalId) {
      const details = await requestApproval(approvalDeps, {
        connection: owned,
        ownerUserId,
        capability,
        parameters,
        paramsHash,
        reason: approvalReason,
        requestedByUserId: invocation.userId,
        auditActorType,
        auditMetadata,
        localInstallationId: invocation.localInstallationId,
        cliSessionId: invocation.cliSessionId,
        execContext: invocation.execContext,
        requestId: invocation.requestId,
      });
      throw new ProxyError("connector_approval_required", "The owner must approve this action", { ...details });
    }
    approval = {
      approvalId: invocation.approvalId,
      connection: owned,
      ownerUserId,
      capability,
      paramsHash,
      requestedByUserId: invocation.userId,
      cliSessionId: invocation.cliSessionId,
      auditActorType,
      auditMetadata,
      requestId: invocation.requestId,
    };
    const outcome = await checkApproval(approvalDeps, approval);
    if (outcome.kind === "pending") {
      throw new ProxyError("connector_approval_pending", "The approval is still pending", { ...outcome.details });
    }
    if (outcome.kind === "denied") {
      await deny("connector_approval_denied", "approval_denied", "The owner denied this action");
    }
    if (outcome.kind === "invalid") {
      await deny("connector_approval_invalid", "approval_invalid", "The approval does not cover this action");
    }
  }

  // 10. Step-up enforcement for destructive capabilities. Issue a fresh
  // challenge on the first attempt; verify+consume on the retry that
  // carries the user-supplied step-up token.
  if (capability.requiresStepUp) {
    // A step-up proves the CLI session user is present; for an agent
    // acting as someone else it would prove nothing about them.
    if (use.mode !== "owner") {
      await deny("connector_forbidden", "stepup_not_for_agents", "This tool needs the owner at their own terminal");
    }
    if (!invocation.stepUpToken) {
      const issued = await issueChallenge(deps.stepUp, {
        providerConnectionId: owned.id,
        organizationId: owned.organizationId,
        userId: invocation.userId,
        capability: capability.id,
        capabilityClass: capability.class,
        requestId: invocation.requestId,
      });
      throw new ProxyError("connector_stepup_required", "Step-up auth required", {
        challengeId: issued.challengeId,
        verificationUrl: issued.verificationUrl,
        expiresAt: issued.expiresAt.toISOString(),
      } satisfies StepUpRequiredDetails);
    }
    try {
      await verifyAndConsumeToken(deps.stepUp, {
        token: invocation.stepUpToken,
        userId: invocation.userId,
        organizationId: invocation.organizationId,
        providerConnectionId: owned.id,
        capability: capability.id,
        capabilityClass: capability.class,
        requestId: invocation.requestId,
      });
    } catch (error) {
      if (error instanceof StepUpRuntimeError) {
        await deny("connector_stepup_rejected", `stepup_${error.code}`, `Step-up token rejected: ${error.code}`);
      }
      throw error;
    }
  }

  const credentials = await findCredentialsByConnection(deps.db, owned.id);
  const accessRow = credentials.find((row) => row.payloadKind === "access_token");
  const refreshRow = credentials.find((row) => row.payloadKind === "refresh_token");
  if (!accessRow) {
    await deny("connector_reauth_required", "credentials_missing", "No access token stored");
  }

  let accessToken: string;
  let refreshed = false;

  if (shouldRefresh(accessRow!.expiresAt) && refreshRow) {
    try {
      const refreshedBundle = await refreshAccessToken({
        adapter: adapter!,
        refreshAccessRow: refreshRow,
        connection: owned,
        rootWrapKey: deps.rootWrapKey,
        dekKeyVersion: deps.dekKeyVersion,
      });
      await persistRefreshedBundle(deps, owned, refreshRow, accessRow!, refreshedBundle);
      accessToken = refreshedBundle.accessToken;
      refreshed = true;
    } catch (error) {
      if (isInvalidGrant(error)) {
        // The provider no longer honors the refresh token (revoked by the
        // account owner, password change, expiry): the connection needs a
        // reconnect until a successful finish clears the flag.
        await markConnectionRequiresReauth(deps.db, owned.id);
        await insertAuditEvent(deps.db, {
          organizationId: owned.organizationId,
          actorType: "system",
          actorId: owned.userId ?? invocation.userId,
          targetType: "provider_connection",
          targetId: owned.id,
          action: "connector.reauth_required",
          requestId: invocation.requestId,
          metadata: { reason: "invalid_grant", capability: invocation.capability },
        });
      }
      await auditProviderError(deps, invocation, owned, use, "refresh_failed");
      throw new ProxyError("connector_reauth_required", "Token refresh failed");
    }
  } else {
    accessToken = await decryptCredential(deps, owned, accessRow!);
  }

  // The approval is used up now, once: of two retries carrying it, only
  // one reaches the provider.
  if (approval && !(await consumeApproval(approvalDeps, approval))) {
    await deny("connector_approval_invalid", "approval_used", "The approval does not cover this action");
  }

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), capability.timeoutMs);
  let providerResponse: unknown;
  try {
    providerResponse = await adapter!.executeCapability({
      capability: capability.id,
      parameters,
      accessToken,
      abortSignal: abortController.signal,
    });
  } catch (error) {
    console.error("provider exec failed", {
      requestId: invocation.requestId,
      capability: capability.id,
      providerId: owned.provider,
      name: error instanceof Error ? error.name : "unknown",
      message: error instanceof Error ? error.message : String(error),
      ...((error as { status?: number; providerCode?: string | null })?.status !== undefined
        ? {
            status: (error as { status?: number }).status,
            providerCode: (error as { providerCode?: string | null }).providerCode,
          }
        : {}),
    });
    await auditProviderError(deps, invocation, owned, use, "provider_call_failed");
    throw new ProxyError("connector_provider_error", "Provider call failed", {
      cause: error instanceof Error ? error.message : "unknown",
    });
  } finally {
    clearTimeout(timeout);
  }

  let projected: unknown;
  try {
    projected = capability.output.parse(providerResponse);
  } catch {
    await auditProviderError(deps, invocation, owned, use, "provider_response_invalid");
    throw new ProxyError("connector_provider_error", "Provider response did not match schema");
  }

  // A read in this turn: writes later in the same turn need approval.
  // Recorded before answering, so a read is never returned unrecorded.
  if (capability.class === "read" && turnKeyHash && invocation.localInstallationId) {
    await recordTurnRead(deps.db, {
      localInstallationId: invocation.localInstallationId,
      organizationId: owned.organizationId,
      turnKeyHash,
    });
  }

  // 10–11. Audit and usage. The provider call already happened (an email
  // may be sent): a bookkeeping failure is logged, never turned into an
  // error that invites a retry.
  try {
    await insertAuditEvent(deps.db, {
      organizationId: owned.organizationId,
      actorType: invocation.actorType,
      actorId: invocation.userId,
      targetType: "provider_connection",
      targetId: owned.id,
      action: "connector.action.executed",
      requestId: invocation.requestId,
      metadata: {
        capability: capability.id,
        class: capability.class,
        refreshed,
        ...(approval ? { approvalId: approval.approvalId } : {}),
        ...execAuditMetadata(invocation.execContext, invocation.localInstallationId),
        ...connectionUseMetadata(invocation, use),
      },
    });
    if (invocation.localInstallationId) {
      await recordConnectorUsage(deps.db, {
        providerConnectionId: owned.id,
        organizationId: owned.organizationId,
        localInstallationId: invocation.localInstallationId,
        agentId: context.agentId ?? "",
        routineKey: routineKey(context),
        mode: use.mode,
        conversation: invocation.execContext.legacyCli ? "legacy_cli" : context.conversation,
        capability: capability.id,
      });
    }
    await touchConnectionLastUsed(deps.db, owned.id);
  } catch (error) {
    console.error("ravi-connectors exec bookkeeping failed", {
      requestId: invocation.requestId,
      name: error instanceof Error ? error.name : "unknown",
      code: (error as { code?: unknown })?.code ?? null,
    });
  }

  return { result: projected, capability: capability.id, refreshed };
}

export class ConnectionReauthRequiredError extends Error {
  constructor(public readonly reason: "credentials_missing" | "invalid_grant" | "refresh_failed") {
    super(`Connection needs a reconnect: ${reason}`);
    this.name = "ConnectionReauthRequiredError";
  }
}

/**
 * A usable access token for a background job of the Worker (calendar sync),
 * refreshed and stored the way an exec refreshes it. The token never leaves
 * the Worker. A refresh the provider refuses marks the connection for
 * reconnect, as an exec does.
 */
export async function resolveConnectionAccessToken(
  deps: Pick<ProxyDeps, "db" | "rootWrapKey" | "dekKeyVersion" | "adapters">,
  connection: ProviderConnectionRecord,
): Promise<{ accessToken: string; refreshed: boolean }> {
  const credentials = await findCredentialsByConnection(deps.db, connection.id);
  const accessRow = credentials.find((row) => row.payloadKind === "access_token");
  const refreshRow = credentials.find((row) => row.payloadKind === "refresh_token");
  const adapter = deps.adapters.get(connection.provider);
  if (!accessRow || !adapter) throw new ConnectionReauthRequiredError("credentials_missing");
  if (!shouldRefresh(accessRow.expiresAt) || !refreshRow) {
    return { accessToken: await decryptCredential(deps, connection, accessRow), refreshed: false };
  }
  try {
    const bundle = await refreshAccessToken({
      adapter,
      refreshAccessRow: refreshRow,
      connection,
      rootWrapKey: deps.rootWrapKey,
      dekKeyVersion: deps.dekKeyVersion,
    });
    await persistRefreshedBundle(deps, connection, refreshRow, accessRow, bundle);
    return { accessToken: bundle.accessToken, refreshed: true };
  } catch (error) {
    if (!isInvalidGrant(error)) throw new ConnectionReauthRequiredError("refresh_failed");
    await markConnectionRequiresReauth(deps.db, connection.id);
    await insertAuditEvent(deps.db, {
      organizationId: connection.organizationId,
      actorType: "system",
      actorId: connection.userId,
      targetType: "provider_connection",
      targetId: connection.id,
      action: "connector.reauth_required",
      requestId: null,
      metadata: { reason: "invalid_grant", job: "calendar_sync" },
    });
    throw new ConnectionReauthRequiredError("invalid_grant");
  }
}

export function safeGetCapability(id: string): CapabilityDefinition {
  try {
    return getCapability(id);
  } catch {
    throw new ProxyError("connector_capability_unsupported", `Unknown capability: ${id}`);
  }
}

function shouldRefresh(expiresAt: Date | null): boolean {
  if (!expiresAt) return false;
  const remaining = expiresAt.getTime() - Date.now();
  return remaining < REFRESH_BEFORE_EXPIRY_SECONDS * 1000;
}

async function refreshAccessToken(input: {
  adapter: ConnectorAdapter;
  refreshAccessRow: { ciphertext: string; nonce: string; aadHash: string; wrappedDek: string; payloadKeyVersion: number; dekKeyVersion: number };
  connection: ProviderConnectionRecord;
  rootWrapKey: CryptoKey;
  dekKeyVersion: number;
}): Promise<ProviderTokenBundle> {
  const refreshToken = await decryptPayload({
    ciphertextBase64: input.refreshAccessRow.ciphertext,
    nonceBase64: input.refreshAccessRow.nonce,
    aadHash: input.refreshAccessRow.aadHash,
    wrappedDekBase64: input.refreshAccessRow.wrappedDek,
    aad: {
      organizationId: input.connection.organizationId,
      userId: input.connection.userId,
      providerConnectionId: input.connection.id,
      payloadKind: "refresh_token",
      dekKeyVersion: input.refreshAccessRow.dekKeyVersion,
      payloadKeyVersion: input.refreshAccessRow.payloadKeyVersion,
      schemaVersion: SCHEMA_VERSION,
    },
    rootWrapKey: input.rootWrapKey,
  });
  return input.adapter.refresh({ refreshToken });
}

export function isInvalidGrant(error: unknown): boolean {
  return error instanceof AdapterProviderError && error.providerCode === "invalid_grant";
}

/**
 * Store a refreshed bundle. Each payload kind is re-encrypted with its own
 * key version + 1, and that exact version is what `upsertCredential`
 * stores, so the AAD rebuilt from the row on decrypt always matches.
 */
async function persistRefreshedBundle(
  deps: Pick<ProxyDeps, "db" | "rootWrapKey">,
  connection: ProviderConnectionRecord,
  refreshRow: { wrappedDek: string; payloadKeyVersion: number },
  accessRow: { wrappedDek: string; dekKeyVersion: number; payloadKeyVersion: number },
  bundle: ProviderTokenBundle,
): Promise<void> {
  // Reuse the existing wrapped DEK so we don't churn the vault on every
  // refresh. AES-KW unwrap → AES-GCM encrypt with the same DEK is safe.
  const { unwrapDek } = await import("./crypto");
  const dek = await unwrapDek(accessRow.wrappedDek, deps.rootWrapKey);
  const accessKeyVersion = accessRow.payloadKeyVersion + 1;
  const aad: ConnectorEncryptionAad = {
    organizationId: connection.organizationId,
    userId: connection.userId,
    providerConnectionId: connection.id,
    payloadKind: "access_token",
    dekKeyVersion: accessRow.dekKeyVersion,
    payloadKeyVersion: accessKeyVersion,
    schemaVersion: SCHEMA_VERSION,
  };
  const enc = await encryptPayload({ plaintext: bundle.accessToken, aad, dek });
  const expiresAt = bundle.expiresInSeconds
    ? new Date(Date.now() + bundle.expiresInSeconds * 1000)
    : null;
  await upsertCredential(deps.db, {
    providerConnectionId: connection.id,
    organizationId: connection.organizationId,
    userId: connection.userId,
    payloadKind: "access_token",
    ciphertext: enc.ciphertextBase64,
    nonce: enc.nonceBase64,
    aadHash: enc.aadHash,
    wrappedDek: accessRow.wrappedDek,
    dekKeyVersion: accessRow.dekKeyVersion,
    payloadKeyVersion: accessKeyVersion,
    expiresAt,
    refreshSupported: Boolean(refreshRow),
  });

  if (bundle.refreshToken) {
    const refreshKeyVersion = refreshRow.payloadKeyVersion + 1;
    const refreshEnc = await encryptPayload({
      plaintext: bundle.refreshToken,
      aad: { ...aad, payloadKind: "refresh_token", payloadKeyVersion: refreshKeyVersion },
      dek,
    });
    await upsertCredential(deps.db, {
      providerConnectionId: connection.id,
      organizationId: connection.organizationId,
      userId: connection.userId,
      payloadKind: "refresh_token",
      ciphertext: refreshEnc.ciphertextBase64,
      nonce: refreshEnc.nonceBase64,
      aadHash: refreshEnc.aadHash,
      wrappedDek: accessRow.wrappedDek,
      dekKeyVersion: accessRow.dekKeyVersion,
      payloadKeyVersion: refreshKeyVersion,
      expiresAt: null,
      refreshSupported: true,
    });
  }

  await insertAuditEvent(deps.db, {
    organizationId: connection.organizationId,
    actorType: "system",
    actorId: connection.userId,
    targetType: "provider_connection",
    targetId: connection.id,
    action: "connector.token.refreshed",
    requestId: null,
    metadata: { expiresInSeconds: bundle.expiresInSeconds ?? null },
  });
}

async function decryptCredential(
  deps: Pick<ProxyDeps, "db" | "rootWrapKey">,
  connection: ProviderConnectionRecord,
  row: { ciphertext: string; nonce: string; aadHash: string; wrappedDek: string; payloadKeyVersion: number; dekKeyVersion: number; payloadKind: "access_token" | "refresh_token" | "id_token" },
): Promise<string> {
  return decryptPayload({
    ciphertextBase64: row.ciphertext,
    nonceBase64: row.nonce,
    aadHash: row.aadHash,
    wrappedDekBase64: row.wrappedDek,
    aad: {
      organizationId: connection.organizationId,
      userId: connection.userId,
      providerConnectionId: connection.id,
      payloadKind: row.payloadKind,
      dekKeyVersion: row.dekKeyVersion,
      payloadKeyVersion: row.payloadKeyVersion,
      schemaVersion: SCHEMA_VERSION,
    },
    rootWrapKey: deps.rootWrapKey,
  });
}

async function auditDenied(
  deps: ProxyDeps,
  invocation: ProxyInvocation,
  connection: ProviderConnectionRecord,
  use: ConnectionUse,
  reason: string,
  code: ProxyErrorCode,
): Promise<void> {
  await insertAuditEvent(deps.db, {
    organizationId: connection.organizationId,
    actorType: invocation.actorType,
    actorId: invocation.userId,
    targetType: "provider_connection",
    targetId: connection.id,
    action: "connector.action.denied",
    requestId: invocation.requestId,
    metadata: {
      capability: invocation.capability,
      reason,
      code,
      ...execAuditMetadata(invocation.execContext, invocation.localInstallationId),
      ...connectionUseMetadata(invocation, use),
    },
  });
}

/**
 * An agent's use: its mode and grant, the CLI session it came through and,
 * for the person asking, the person it acted for (whose Recent activity
 * lists it). The actor is always the CLI session user, who asked.
 */
function connectionUseMetadata(invocation: ProxyInvocation, use: ConnectionUse): Record<string, unknown> {
  if (use.mode === "owner") return {};
  return {
    mode: use.mode,
    ...(use.grantId ? { grantId: use.grantId } : {}),
    ...(use.actingForUserId ? { actingForUserId: use.actingForUserId } : {}),
    cliSessionId: invocation.cliSessionId,
  };
}

/**
 * A refusal on a connection that is not the caller's: audited on the
 * caller, never on the connection, whose Recent activity its owner reads.
 */
async function auditForeignDenied(
  deps: ProxyDeps,
  invocation: ProxyInvocation,
  providerConnectionId: string,
  reason: string,
  code: ProxyErrorCode,
): Promise<void> {
  await insertAuditEvent(deps.db, {
    organizationId: invocation.organizationId,
    actorType: invocation.actorType,
    actorId: invocation.userId,
    targetType: "user",
    targetId: invocation.userId,
    action: "connector.action.denied",
    requestId: invocation.requestId,
    metadata: {
      providerConnectionId,
      capability: invocation.capability,
      reason,
      code,
      ...execAuditMetadata(invocation.execContext, invocation.localInstallationId),
    },
  });
}

async function auditProviderError(
  deps: ProxyDeps,
  invocation: ProxyInvocation,
  connection: ProviderConnectionRecord,
  use: ConnectionUse,
  reason: string,
): Promise<void> {
  await insertAuditEvent(deps.db, {
    organizationId: connection.organizationId,
    actorType: invocation.actorType,
    actorId: invocation.userId,
    targetType: "provider_connection",
    targetId: connection.id,
    action: "connector.action.failed",
    requestId: invocation.requestId,
    metadata: {
      capability: invocation.capability,
      reason,
      ...execAuditMetadata(invocation.execContext, invocation.localInstallationId),
      ...connectionUseMetadata(invocation, use),
    },
  });
}

// Unused helper for now but kept to keep the public type surface stable.
export type CapabilityInvocationSchema = z.ZodTypeAny;
