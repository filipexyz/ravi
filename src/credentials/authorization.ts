import { getContext, hasRuntimeInvocationContext } from "../cli/context.js";
import { getContactById } from "../contacts.js";
import { authorizePermission, materializeSubjectCapabilities } from "../permissions/provider-runtime.js";
import { canWithCapabilities } from "../permissions/capability-snapshot.js";
import type { PermissionProviderRequest } from "../permissions/provider-types.js";
import { dbGetAgent, dbGetContext, dbGetContextByKey, type ContextRecord } from "../router/router-db.js";
import { resolveRuntimeContext, resolveRuntimeContextById } from "../runtime/context-registry.js";
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
      !resolveRuntimeContextById(context.contextId) ||
      !context.agentId ||
      !dbGetAgent(context.agentId) ||
      (claimed &&
        // The claimed key must be the one stored for this context (only its hash is stored).
        (dbGetContextByKey(claimed.contextKey)?.contextId !== context.contextId ||
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

/**
 * The person who wrote this turn may already hold what the action needs.
 *
 * A write through a provider credential asks a human to approve it on a card
 * in the chat the turn came from. When the turn's own author is a resolved,
 * active contact whose own capabilities allow both the credential and the
 * provider action, that card asks the author to approve their own request:
 * the answer is already known, so the broker records it as
 * `actor_authorized` instead of asking.
 *
 * Only a direct turn counts. A turn without a resolved human author (an
 * agent relay, a trigger, a cron, an unknown speaker) or one whose author was
 * projected from another session (a thread acting for its parent) keeps the
 * card, and so does an author who could not grant the action themselves.
 * The broker never asks this for a destructive action (archive, kick,
 * delete): those keep the card even on the author's own turn.
 */
export function actorHoldsCredentialAction(
  context: ContextRecord,
  input: { provider: string; connection: string; action: string },
): boolean {
  // Only Slack's actions are classified (read set, destructive verbs, the
  // caller's destructive mark); any other provider keeps the card.
  if (input.provider !== "slack") return false;
  const metadata = context.metadata ?? {};
  if (metadata.actorResolution !== "resolved" || metadata.actorProjection) return false;
  // A cron, a trigger or an observer may carry its owner as the actor; only a
  // message a person sent counts as that person asking.
  const provenance = metadata.turnProvenance as { origin?: unknown } | undefined;
  if (provenance?.origin !== "human") return false;
  const principal = metadata.actorPrincipal;
  if (typeof principal !== "string" || !principal.startsWith("contact:")) return false;
  const contactId = principal.slice("contact:".length).trim();
  if (!contactId) return false;
  const contact = getContactById(contactId);
  if (!contact || contact.status === "blocked" || contact.opt_out) return false;
  // Subject grants only: a chat-scoped grant keeps the card (known limitation
  // in .ravi/specs/credentials/broker/SPEC.md, Consumption Authority).
  const capabilities = materializeSubjectCapabilities("contact", contact.id);
  return (
    canWithCapabilities(capabilities, "use", "credential", `${input.provider}:${input.connection}`) &&
    canWithCapabilities(capabilities, "execute", input.provider, input.action)
  );
}
