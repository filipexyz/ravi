/**
 * `POST /cli/agent-exec`: an agent uses a connection that is not the
 * operator's own.
 *
 *   person_asking  The speaker uses their own account. Who the speaker is
 *                  comes only from the installation's `ravi link` binding
 *                  of the contact (never from the exec context's
 *                  `consoleUserId`, which the daemon could make up). That
 *                  person must be an active member, must have allowed this
 *                  agent on this installation (else a consent link), and
 *                  must have an account connected (else the Connectors
 *                  page). The call runs as them: their tool rules, and
 *                  their approval for writes. Never in a group.
 *   shared         The organization account the agent was given, only in
 *                  the conversations named and while the organization
 *                  allows sharing; never for another agent, a trigger or
 *                  an automation other than a cron job or heartbeat. A
 *                  routine reaches it only through the chat it posts into
 *                  (`dm` or `group`): the CLI refuses `--shared` for one
 *                  that posts nowhere, since a grant lists only chats, and
 *                  `automation` reaches only `/cli/exec`. Reads are blocked except free/busy
 *                  unless the manager allowed them; writes wait for the
 *                  manager (every owner and admin when nobody manages it).
 *
 * The CLI session user (the operator whose daemon runs the agent) is the
 * requester of every approval and the actor of every audit row; the
 * person asking is named in the metadata (`actingForUserId`). Once the connection and who decides for it
 * are known, the call goes through the same pipeline as an owner's exec
 * (`proxy.ts`), and usage records the mode.
 */

import { requestConsent } from "./consent";
import {
  findActiveActorBinding,
  findActiveAgentGrant,
  findDefaultOrNewestUserConnection,
  findFirstOrganizationOwner,
  findProviderConnectionById,
  insertAuditEvent,
  isActiveOrganizationMember,
  isLiveConnectionStatus,
  type ProviderConnectionRecord,
} from "./db";
import { ConnectorHttpError, type ConnectorPublicErrorCode } from "./errors";
import { execAuditMetadata, relayOrAutomationDenial, type ParsedExecContext } from "./exec-context";
import {
  executeCapabilityForAgent,
  safeGetCapability,
  type ProxyDeps,
  type ProxyInvocation,
  type ProxyResult,
} from "./proxy";

export type AgentExecMode = "person_asking" | "shared";

export interface AgentExecInput {
  organizationId: string;
  /** The CLI session user: the operator, requester of approvals. */
  userId: string;
  localInstallationId: string;
  cliSessionId: string;
  provider: string;
  capability: string;
  parameters: unknown;
  mode: AgentExecMode;
  execContext: ParsedExecContext;
  approvalId: string | null;
  stepUpToken?: string;
  requestId: string;
}

export function parseAgentExecMode(value: unknown): AgentExecMode | null {
  return value === "person_asking" || value === "shared" ? value : null;
}

export async function executeAgentCapability(deps: ProxyDeps, input: AgentExecInput): Promise<ProxyResult> {
  const capability = safeGetCapability(input.capability);
  if (capability.providerId !== input.provider) {
    throw new ConnectorHttpError(400, "connector_capability_unsupported", "Capability does not match provider");
  }
  const { context } = input.execContext;
  if (input.execContext.legacyCli) {
    throw new ConnectorHttpError(400, "connector_exec_context_invalid", "X-Ravi-Exec-Context is required", {
      reason: "missing",
    });
  }
  if (!context.agentId) {
    throw new ConnectorHttpError(400, "connector_exec_context_invalid", "agentId is required", {
      reason: "agent_required",
    });
  }
  const invocation: ProxyInvocation = {
    organizationId: input.organizationId,
    userId: input.userId,
    providerConnectionId: "",
    capability: input.capability,
    parameters: input.parameters,
    requestId: input.requestId,
    actorType: "agent",
    stepUpToken: input.stepUpToken,
    execContext: input.execContext,
    localInstallationId: input.localInstallationId,
    cliSessionId: input.cliSessionId,
    approvalId: input.approvalId,
  };
  return input.mode === "person_asking"
    ? personAsking(deps, input, invocation, context.agentId)
    : shared(deps, input, invocation, context.agentId);
}

async function personAsking(
  deps: ProxyDeps,
  input: AgentExecInput,
  invocation: ProxyInvocation,
  agentId: string,
): Promise<ProxyResult> {
  const { context } = input.execContext;
  const contactId = context.speaker.contactId;
  if (!contactId) {
    throw new ConnectorHttpError(400, "connector_exec_context_invalid", "speaker.contactId is required", {
      reason: "contact_required",
    });
  }
  // A personal account never serves a group, whoever asks there.
  if (context.conversation === "group") {
    return refuse(deps, input, 403, "connector_group_blocked", "group_conversation");
  }
  // A person in a conversation; never a relay from another agent, an
  // automation or a trigger acting in someone's name.
  const human = context.speaker.kind === "contact" || context.speaker.kind === "owner";
  if (!human || context.routine) {
    return refuse(deps, input, 403, "connector_speaker_not_owner", "speaker_not_a_person");
  }

  const binding = await findActiveActorBinding(deps.db, {
    installationId: input.localInstallationId,
    organizationId: input.organizationId,
    contactId,
  });
  if (!binding) return refuse(deps, input, 403, "connector_not_linked", "contact_not_linked");
  const speakerUserId = binding.consoleUserId;
  if (!(await isActiveOrganizationMember(deps.db, { organizationId: input.organizationId, userId: speakerUserId }))) {
    return refuse(deps, input, 403, "connector_not_linked", "speaker_not_member");
  }

  const grant = await findActiveAgentGrant(deps.db, {
    organizationId: input.organizationId,
    localInstallationId: input.localInstallationId,
    agentId,
    provider: input.provider,
    mode: "person_asking",
    grantedByUserId: speakerUserId,
  });
  if (!grant) {
    const details = await requestConsent(deps, {
      organizationId: input.organizationId,
      localInstallationId: input.localInstallationId,
      agentId,
      agentDisplayName: context.agentDisplayName ?? null,
      provider: input.provider,
      contactId,
      bindingId: binding.id,
      consoleUserId: speakerUserId,
      requestedByUserId: input.userId,
      requestId: input.requestId,
    });
    throw new ConnectorHttpError(409, "connector_consent_required", "The person must allow this agent first", {
      ...details,
    });
  }

  const connection = await personAskingConnection(deps, input, grant.providerConnectionId, speakerUserId);
  if (!connection) {
    await auditRefusal(deps, input, "connector_connection_required", "no_connection");
    throw new ConnectorHttpError(409, "connector_connection_required", "The person has no account connected", {
      connectorsUrl: `${deps.consoleBaseUrl.replace(/\/+$/, "")}/connectors`,
    });
  }
  return executeCapabilityForAgent(deps, { ...invocation, providerConnectionId: connection.id }, connection, {
    mode: "person_asking",
    approverUserId: speakerUserId,
    actingForUserId: speakerUserId,
    grantId: grant.id,
  });
}

/**
 * The account the grant names while it is live and still the person's;
 * else the person's default; else their newest active one.
 */
async function personAskingConnection(
  deps: ProxyDeps,
  input: AgentExecInput,
  pinnedId: string | null,
  userId: string,
): Promise<ProviderConnectionRecord | null> {
  if (pinnedId) {
    const pinned = await findProviderConnectionById(deps.db, pinnedId, input.organizationId);
    if (
      pinned &&
      pinned.userId === userId &&
      pinned.scopeKind !== "organization" &&
      pinned.provider === input.provider &&
      isLiveConnectionStatus(pinned.status)
    ) {
      return pinned;
    }
  }
  return findDefaultOrNewestUserConnection(deps.db, {
    organizationId: input.organizationId,
    userId,
    provider: input.provider,
  });
}

async function shared(
  deps: ProxyDeps,
  input: AgentExecInput,
  invocation: ProxyInvocation,
  agentId: string,
): Promise<ProxyResult> {
  const { context } = input.execContext;
  // Someone in a conversation, or the operator's own routine; never a
  // relay from another agent, a trigger or another automation.
  if (relayOrAutomationDenial(context)) {
    return refuse(deps, input, 403, "connector_speaker_not_owner", "speaker_not_allowed");
  }
  const grant = await findActiveAgentGrant(deps.db, {
    organizationId: input.organizationId,
    localInstallationId: input.localInstallationId,
    agentId,
    provider: input.provider,
    mode: "shared",
  });
  if (!grant) return refuse(deps, input, 403, "connector_forbidden", "no_shared_grant");
  const connection = grant.providerConnectionId
    ? await findProviderConnectionById(deps.db, grant.providerConnectionId, input.organizationId)
    : null;
  if (!connection || connection.scopeKind !== "organization" || !isLiveConnectionStatus(connection.status)) {
    return refuse(deps, input, 503, "connector_unavailable", "shared_connection_unavailable");
  }
  const conversations = Array.isArray(grant.conversationsJson) ? grant.conversationsJson : [];
  if (!conversations.includes(context.conversation)) {
    return context.conversation === "group"
      ? refuse(deps, input, 403, "connector_group_blocked", "conversation_not_shared")
      : refuse(deps, input, 403, "connector_forbidden", "conversation_not_shared");
  }
  const approverUserId = connection.managedByUserId ?? (await findFirstOrganizationOwner(deps.db, input.organizationId));
  return executeCapabilityForAgent(deps, { ...invocation, providerConnectionId: connection.id }, connection, {
    mode: "shared",
    approverUserId,
    grantId: grant.id,
  });
}

async function refuse(
  deps: ProxyDeps,
  input: AgentExecInput,
  status: number,
  code: ConnectorPublicErrorCode,
  reason: string,
): Promise<never> {
  await auditRefusal(deps, input, code, reason);
  throw new ConnectorHttpError(status, code, reason, { reason });
}

/**
 * A refusal before any connection is in play: audited on the caller,
 * never on someone's connection.
 */
async function auditRefusal(
  deps: ProxyDeps,
  input: AgentExecInput,
  code: ConnectorPublicErrorCode,
  reason: string,
): Promise<void> {
  await insertAuditEvent(deps.db, {
    organizationId: input.organizationId,
    actorType: "agent",
    actorId: input.userId,
    targetType: "user",
    targetId: input.userId,
    action: "connector.action.denied",
    requestId: input.requestId,
    metadata: {
      capability: input.capability,
      provider: input.provider,
      mode: input.mode,
      reason,
      code,
      ...execAuditMetadata(input.execContext, input.localInstallationId),
    },
  });
}
