import { getContext, hasRuntimeInvocationContext } from "../cli/context.js";
import { getContactById } from "../contacts.js";
import { authorizePermission, materializeSubjectCapabilities } from "../permissions/provider-runtime.js";
import { canWithCapabilities } from "../permissions/capability-snapshot.js";
import type { PermissionProviderRequest } from "../permissions/provider-types.js";
import { dbGetAgent, dbGetContext, type ContextRecord } from "../router/router-db.js";
import { resolveRuntimeContext } from "../runtime/context-registry.js";
import { CredentialBrokerError } from "./errors.js";

/** Host-only intent, never accepted from command arguments or gateway payloads. */
export type CredentialBrokerAuthority =
  | { kind: "local-operator" }
  | {
      kind: "internal-service";
      service: "slack-channel-runtime" | "slack-delivery" | "identity-link" | "approval-delivery";
    };

export interface CredentialAuthorization {
  context?: ContextRecord;
  actorContextId: string;
  agentId?: string;
}

export function authorizeCredentialUse(input: {
  provider: string;
  connection: string;
  action: string;
  authority?: CredentialBrokerAuthority;
  onCallerResolved?: (caller: CredentialAuthorization) => void;
}): CredentialAuthorization {
  const handlerContext = getContext({ localOnly: true });
  const explicitKey = process.env.RAVI_CONTEXT_KEY;
  const key = explicitKey?.trim();
  const keyedContext = key ? resolveRuntimeContext(key, { touch: false }) : null;
  if (explicitKey !== undefined && !keyedContext) {
    throw new CredentialBrokerError("caller_invalid", "Credential caller is missing, invalid, expired or revoked.");
  }
  // The default remains available to ordinary CLI commands, but it is never an
  // explicit credential caller. Runtime markers still require their own valid
  // context; only a context-free host entrypoint can choose operator-control.
  const local = handlerContext?.contextOrigin === "default-credential" ? undefined : handlerContext;
  const hasCaller = Boolean(
    local?.context ||
      local?.contextId ||
      local?.agentId ||
      local?.sessionKey ||
      local?.sessionName ||
      hasRuntimeInvocationContext(),
  );
  // Never consult the default credentials file: an invalid explicit caller must
  // not silently acquire the operator's authority.
  const claimed = local?.context;
  const context = claimed
    ? dbGetContext(claimed.contextId)
    : local?.contextId
      ? dbGetContext(local.contextId)
      : keyedContext;
  let authority: Pick<PermissionProviderRequest, "context" | "subject" | "localOperator">;
  let provenance: CredentialAuthorization;
  if (hasCaller || key) {
    if (
      !context ||
      !resolveRuntimeContext(context.contextKey, { touch: false }) ||
      !context.agentId ||
      !dbGetAgent(context.agentId) ||
      (claimed &&
        (claimed.contextKey !== context.contextKey ||
          claimed.agentId !== context.agentId ||
          claimed.sessionKey !== context.sessionKey)) ||
      (local?.agentId && local.agentId !== context.agentId) ||
      (local?.contextId && local.contextId !== context.contextId) ||
      context.metadata?.actorResolution === "missing_contact"
    ) {
      throw new CredentialBrokerError("caller_invalid", "Credential caller is missing, invalid, expired or revoked.");
    }
    const actor = context.metadata?.actorPrincipal;
    if (typeof actor === "string" && actor.startsWith("contact:")) {
      const contact = getContactById(actor.slice("contact:".length));
      if (!contact || contact.status === "blocked" || contact.opt_out) {
        throw new CredentialBrokerError("caller_invalid", "Credential invocation actor is no longer active.");
      }
    }
    authority = { context, subject: { type: "agent", id: context.agentId } };
    provenance = { context, actorContextId: context.contextId, agentId: context.agentId };
  } else {
    if (!input.authority || !validHostIntent(input)) {
      throw new CredentialBrokerError("caller_invalid", "Credential use requires an explicit caller authority.");
    }
    authority = { localOperator: true };
    provenance = {
      actorContextId:
        input.authority.kind === "internal-service" ? `system:${input.authority.service}` : "operator:local",
    };
  }

  input.onCallerResolved?.(provenance);
  const requirements = [
    { permission: "use", objectType: "credential", objectId: `${input.provider}:${input.connection}` },
    { permission: "execute", objectType: input.provider, objectId: input.action },
  ];
  for (const requirement of requirements) {
    // A provider can replace the snapshot provider. The issued scope and live
    // executor ceiling still bound the caller; neither can widen the other.
    if (
      context &&
      (!canWithCapabilities(
        context.capabilities,
        requirement.permission,
        requirement.objectType,
        requirement.objectId,
      ) ||
        !canWithCapabilities(
          materializeSubjectCapabilities("agent", context.agentId!),
          requirement.permission,
          requirement.objectType,
          requirement.objectId,
        ))
    ) {
      throw new CredentialBrokerError("authorization_denied", "Credential capability denied.");
    }
    const decision = authorizePermission({ ...authority, ...requirement });
    if (decision.decision === "needs_approval") {
      throw new CredentialBrokerError("approval_required", "Credential provider approval is required.");
    }
    if (!decision.allowed || decision.decision !== "allow") {
      throw new CredentialBrokerError("authorization_denied", "Credential provider authorization denied.");
    }
  }
  return provenance;
}

function validHostIntent(input: { provider: string; action: string; authority?: CredentialBrokerAuthority }): boolean {
  if (input.authority?.kind === "local-operator") return true;
  if (input.authority?.kind !== "internal-service" || input.provider !== "slack") return false;
  const actions: Record<Extract<CredentialBrokerAuthority, { kind: "internal-service" }>["service"], string[]> = {
    "slack-channel-runtime": ["socket_mode.connect"],
    "slack-delivery": ["chat.postMessage", "chat.postEphemeral", "chat.update", "files.getUploadURLExternal"],
    "identity-link": ["chat.postMessage", "users.info"],
    "approval-delivery": ["chat.update"],
  };
  return actions[input.authority.service]?.includes(input.action) === true;
}
