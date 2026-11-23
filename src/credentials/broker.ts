import { getContext } from "../cli/context.js";
import { actorHoldsCredentialAction, authorizeCredentialUse, type CredentialBrokerAuthority } from "./authorization.js";
export type { CredentialBrokerAuthority } from "./authorization.js";
import { readSecret, redactSecretRef } from "./backends.js";
import { CredentialBrokerError } from "./errors.js";
import { getCredentialConnection, recordCredentialAuditEvent, type CredentialStoreOptions } from "./store.js";
import type { CredentialConnectionRecord, CredentialPolicyExplanation, PublicCredentialConnection } from "./types.js";

export function explainCredentialPolicy(input: {
  provider: string;
  connection: string;
  action: string;
}): CredentialPolicyExplanation {
  return {
    provider: input.provider,
    connection: input.connection,
    action: input.action,
    requiredCapabilities: [
      `use:credential:${input.provider}:${input.connection}`,
      `execute:${input.provider}:${input.action}`,
    ],
    approval: {
      required: isSensitiveAction(input.action, input.provider),
      reason: isSensitiveAction(input.action, input.provider)
        ? "write_or_destructive_provider_action"
        : "read_only_provider_action",
    },
  };
}

export async function resolveCredentialSecret(input: {
  provider: string;
  connection: string;
  action: string;
  /**
   * The caller knows this call removes content even though the provider
   * method's name does not say so (for example a `canvases.edit` whose
   * change is `delete`). It always asks for approval, like `*.delete`.
   */
  destructive?: boolean;
  authority?: CredentialBrokerAuthority;
  /** Host-only additional guard, after approval and immediately before backend access. */
  beforeResolve?: () => Promise<void>;
  options?: CredentialStoreOptions;
}): Promise<{ connection: CredentialConnectionRecord; secret: string; policy: CredentialPolicyExplanation }> {
  let connection = requireActiveConnection(input);
  const policy = explainCredentialPolicy(input);
  let decision = "deny";
  let approvalStatus: string | null = null;
  let actorContextId = getContext({ localOnly: true })?.context?.contextId;
  let agentId: string | undefined;
  const audit = (resultStatus: string, errorCode?: string) =>
    recordCredentialAuditEvent(
      {
        provider: connection.provider,
        connection: connection.connection,
        action: input.action,
        decision,
        approvalRequired: policy.approval.required || approvalStatus === "pending",
        approvalStatus,
        resultStatus,
        errorCode,
        actorContextId,
        agentId,
      },
      input.options,
    );
  try {
    let authorization = authorizeCredentialUse({
      ...input,
      onCallerResolved: (caller) => {
        actorContextId = caller.actorContextId;
        agentId = caller.agentId;
      },
    });
    actorContextId = authorization.actorContextId;
    agentId = authorization.agentId;
    decision = "allow";
    if (
      policy.approval.required &&
      authorization.context &&
      input.destructive !== true &&
      !isDestructiveAction(input.action) &&
      actorHoldsCredentialAction(authorization.context, input)
    ) {
      // The card would ask the turn's author to approve their own request.
      approvalStatus = "actor_authorized";
    } else if (policy.approval.required && authorization.context) {
      decision = "needs_approval";
      approvalStatus = "pending";
      audit("approval_pending");
      const { isFixedApprovalRefusalReason, requestCascadingApproval } = await import("../approval/service.js");
      const context = authorization.context;
      const result = await requestCascadingApproval({
        resolvedSource: context.source,
        type: "permission",
        sessionName: context.sessionName ?? context.contextId,
        agentId: context.agentId!,
        text: `Approve credential action ${connection.provider}:${connection.connection} / ${input.action}?`,
        autoApproveWithoutSource: false,
        eventData: {
          contextId: context.contextId,
          permission: "execute",
          objectType: connection.provider,
          objectId: input.action,
        },
      });
      if (!result.approved) {
        approvalStatus = "denied";
        // Keep only fixed text the approval service wrote: an exception
        // message or a rejecting human's words never leave as `detail`.
        const fixedReason =
          result.reason &&
          isFixedApprovalRefusalReason(result.reason, "permission", {
            permission: "execute",
            objectType: connection.provider,
            objectId: input.action,
          })
            ? result.reason
            : undefined;
        throw new CredentialBrokerError("approval_denied", "Credential action approval was not granted.", {
          ...(fixedReason ? { detail: fixedReason } : {}),
        });
      }
      approvalStatus = "approved";
      // Approval cannot revive a revoked context, bypass a changed provider or
      // authorize a connection that was disabled/replaced while we waited.
      const current = requireActiveConnection(input);
      if (current.secretRef !== connection.secretRef || current.updatedAt !== connection.updatedAt) {
        throw new CredentialBrokerError("authorization_denied", "Credential connection changed during approval.");
      }
      connection = current;
      authorization = authorizeCredentialUse(input);
      if (authorization.actorContextId !== actorContextId || authorization.agentId !== agentId) {
        throw new CredentialBrokerError("caller_invalid", "Credential caller changed during approval.");
      }
      decision = "allow";
    } else if (policy.approval.required) {
      approvalStatus = "operator_control";
    }
    if (input.beforeResolve) {
      await input.beforeResolve();
      const current = requireActiveConnection(input);
      if (current.secretRef !== connection.secretRef || current.updatedAt !== connection.updatedAt)
        throw new CredentialBrokerError("authorization_denied", "Credential connection changed during host guard.");
      const currentCaller = authorizeCredentialUse(input);
      if (currentCaller.actorContextId !== actorContextId || currentCaller.agentId !== agentId)
        throw new CredentialBrokerError("caller_invalid", "Credential caller changed during host guard.");
    }
    const secret = await readSecret(connection.secretRef);
    audit("secret_resolved");
    return { connection, secret, policy };
  } catch (error) {
    const code = error instanceof CredentialBrokerError ? error.code : "secret_unavailable";
    if (code === "approval_required") {
      decision = "needs_approval";
      approvalStatus = "pending";
    } else if (["caller_invalid", "authorization_denied", "approval_denied", "connection_disabled"].includes(code)) {
      decision = "deny";
    }
    audit("failed", code);
    // Backend/parser causes can contain the plaintext. Do not retain them on
    // an error that CLI diagnostics or a runner may serialize.
    // An approval refusal keeps its reason only when it is fixed text the
    // approval service wrote (checked where it was thrown), so the caller can
    // show the way out without echoing an exception or a person's words.
    const detail = error instanceof CredentialBrokerError && code === "approval_denied" ? error.detail : undefined;
    throw new CredentialBrokerError(
      code,
      `Credential operation failed (${code}): ${input.provider}:${input.connection}`,
      {
        ...(detail ? { detail } : {}),
      },
    );
  }
}

function requireActiveConnection(input: {
  provider: string;
  connection: string;
  options?: CredentialStoreOptions;
}): CredentialConnectionRecord {
  const connection = getCredentialConnection(input.provider, input.connection, input.options);
  if (!connection) {
    throw new CredentialBrokerError(
      "connection_not_found",
      `Connection not found: ${input.provider}:${input.connection}`,
    );
  }
  if (connection.status !== "active") {
    throw new CredentialBrokerError(
      "connection_disabled",
      `Connection disabled: ${input.provider}:${input.connection}`,
    );
  }
  return connection;
}

export async function execCredentialBroker(input: {
  provider: string;
  connection: string;
  action: string;
  dryRun: boolean;
  authority?: CredentialBrokerAuthority;
  options?: CredentialStoreOptions;
}) {
  const record = getCredentialConnection(input.provider, input.connection, input.options);
  if (!record) {
    throw new CredentialBrokerError(
      "connection_not_found",
      `Connection not found: ${input.provider}:${input.connection}`,
    );
  }
  const policy = explainCredentialPolicy({
    provider: record.provider,
    connection: record.connection,
    action: input.action,
  });

  if (input.dryRun) {
    return {
      status: "planned" as const,
      dryRun: true,
      connection: publicCredentialConnection(record),
      policy,
      secretResolved: false,
      result: null,
    };
  }

  const { secret } = await resolveCredentialSecret({
    provider: record.provider,
    connection: record.connection,
    action: input.action,
    authority: input.authority,
    options: input.options,
  });
  return {
    status: "executed" as const,
    dryRun: false,
    connection: publicCredentialConnection(record),
    policy,
    secretResolved: Boolean(secret),
    result: {
      adapter: "credentials",
      action: input.action,
      note: "Secret was resolved in-process and intentionally not returned.",
    },
  };
}

export function publicCredentialConnection(record: CredentialConnectionRecord): PublicCredentialConnection {
  return {
    id: record.id,
    provider: record.provider,
    connection: record.connection,
    label: record.label,
    backend: record.backend,
    secretRef: redactSecretRef(record.secretRef),
    scopes: record.scopes,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

// Provider reads that change nothing. Anything else is a write and asks a
// human, unless the turn's own author already holds it.
const READ_ONLY_ACTIONS = new Set([
  "auth.check",
  "auth.test",
  "blocks.validate",
  "canvases.sections.lookup",
  "whoami",
  "channels.list",
  "channels.info",
  "conversations.list",
  "conversations.info",
  "conversations.history",
  "conversations.replies",
  "conversations.members",
  "users.list",
  "users.info",
  "users.lookupByEmail",
  "users.conversations",
  "team.info",
]);

// Reads declared by a provider integration that the broker does not know by
// name (a provider's own operation catalogue). Keyed by provider so one
// provider's read can never mark another provider's action as read-only.
const PROVIDER_READ_ONLY_ACTIONS = new Map<string, ReadonlySet<string>>();

/** A provider integration declares its read-only actions once, from its own catalogue. Replaces any earlier set. */
export function registerProviderReadOnlyActions(provider: string, actions: Iterable<string>): void {
  PROVIDER_READ_ONLY_ACTIONS.set(provider, new Set(actions));
}

function isSensitiveAction(action: string, provider: string): boolean {
  if (PROVIDER_READ_ONLY_ACTIONS.get(provider)?.has(action)) return false;
  return !READ_ONLY_ACTIONS.has(action);
}

// Actions that remove something or someone. They ask a human every time,
// even when the turn's own author holds them. A method whose name hides a
// removal (`canvases.edit` with a `delete` change) is marked by its caller
// with `destructive: true` instead.
const DESTRUCTIVE_VERBS = new Set(["archive", "kick", "delete", "remove"]);

export function isDestructiveAction(action: string): boolean {
  const verb = action.split(".").pop() ?? "";
  return DESTRUCTIVE_VERBS.has(verb);
}
