import { readSecret, redactSecretRef } from "./backends.js";
import { getContext } from "../cli/context.js";
import { authorizePermission } from "../permissions/provider-runtime.js";
import { getCredentialConnection, recordCredentialAuditEvent, type CredentialStoreOptions } from "./store.js";
import type {
  CredentialAuthorizationInput,
  CredentialCallerContext,
  CredentialConnectionRecord,
  CredentialPolicyExplanation,
  PublicCredentialConnection,
} from "./types.js";

export interface CredentialBrokerDependencies {
  readSecret?: typeof readSecret;
  getCallerContext?: () => CredentialCallerContext | null | undefined;
}

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
      required: isSensitiveAction(input.action),
      reason: isSensitiveAction(input.action) ? "write_or_destructive_provider_action" : "read_only_provider_action",
    },
  };
}

export async function resolveCredentialSecret(
  input: {
    provider: string;
    connection: string;
    action: string;
    authorization?: CredentialAuthorizationInput;
    options?: CredentialStoreOptions;
  },
  dependencies: CredentialBrokerDependencies = {},
): Promise<{
  connection: CredentialConnectionRecord;
  secret: string;
  policy: CredentialPolicyExplanation;
}> {
  const requestedPolicy = explainCredentialPolicy({
    provider: input.provider,
    connection: input.connection,
    action: input.action,
  });
  let context: Readonly<CredentialCallerContext>;
  try {
    context = resolveCallerContext(dependencies.getCallerContext);
  } catch (error) {
    if (error instanceof CredentialAuthorizationError) {
      recordCredentialAuditEvent(
        {
          provider: input.provider,
          connection: input.connection,
          action: input.action,
          decision: "deny",
          approvalRequired: requestedPolicy.approval.required,
          approvalStatus: requestedPolicy.approval.required ? "not_requested" : null,
          resultStatus: "authorization_denied",
          errorCode: error.code,
        },
        input.options,
      );
    }
    throw error;
  }
  const connection = getCredentialConnection(input.provider, input.connection, input.options);
  if (!connection) {
    throw new Error(`Connection not found: ${input.provider}:${input.connection}`);
  }
  if (connection.status !== "active") {
    throw new Error(`Connection disabled: ${input.provider}:${input.connection}`);
  }
  const policy = explainCredentialPolicy({
    provider: connection.provider,
    connection: connection.connection,
    action: input.action,
  });
  authorizeCredentialRequest({
    connection,
    action: input.action,
    policy,
    context,
    tenant: input.authorization?.tenant ?? null,
    approvalStatus: input.authorization?.approvalStatus ?? null,
    options: input.options,
  });
  const approvalStatus = credentialApprovalStatus({
    policy,
    context,
    provider: connection.provider,
    action: input.action,
    requestedStatus: input.authorization?.approvalStatus ?? null,
  });
  try {
    const secret = await (dependencies.readSecret ?? readSecret)(connection.secretRef);
    recordCredentialAuditEvent(
      {
        provider: connection.provider,
        connection: connection.connection,
        action: input.action,
        decision: "allow",
        approvalRequired: policy.approval.required,
        approvalStatus,
        resultStatus: "secret_resolved",
        actorContextId: context.contextId,
        agentId: context.agentId ?? null,
      },
      input.options,
    );
    return { connection, secret, policy };
  } catch (error) {
    recordCredentialAuditEvent(
      {
        provider: connection.provider,
        connection: connection.connection,
        action: input.action,
        decision: "allow",
        approvalRequired: policy.approval.required,
        approvalStatus,
        resultStatus: "failed",
        errorCode: error instanceof Error ? error.message.slice(0, 120) : "unknown_error",
        actorContextId: context.contextId,
        agentId: context.agentId ?? null,
      },
      input.options,
    );
    throw error;
  }
}

function resolveCallerContext(
  getCallerContext: CredentialBrokerDependencies["getCallerContext"],
): Readonly<CredentialCallerContext> {
  const runtimeContext = getContext()?.context;
  const candidate = getCallerContext ? getCallerContext() : runtimeContext;
  if (!candidate?.contextId) {
    throw new CredentialAuthorizationError("missing_caller_context");
  }
  if (!candidate.agentId?.trim()) {
    throw new CredentialAuthorizationError("missing_caller_identity");
  }
  const capabilities = (candidate.capabilities ?? []).map((capability) => Object.freeze({ ...capability }));
  Object.freeze(capabilities);
  return Object.freeze({
    contextId: candidate.contextId,
    agentId: candidate.agentId ?? null,
    kind: candidate.kind ?? null,
    capabilities,
  });
}

function authorizeCredentialRequest(input: {
  connection: CredentialConnectionRecord;
  action: string;
  policy: CredentialPolicyExplanation;
  context: Readonly<CredentialCallerContext>;
  tenant: string | null;
  approvalStatus: CredentialAuthorizationInput["approvalStatus"];
  options?: CredentialStoreOptions;
}): void {
  if (!input.action.trim()) {
    denyCredentialRequest(input, "missing_action");
  }

  const credentialDecision = authorizePermission({
    context: input.context,
    permission: "use",
    objectType: "credential",
    objectId: `${input.connection.provider}:${input.connection.connection}`,
  });
  if (!credentialDecision.allowed) {
    denyCredentialRequest(input, "missing_credential_capability");
  }

  const actionDecision = authorizePermission({
    context: input.context,
    permission: "execute",
    objectType: input.connection.provider,
    objectId: input.action,
  });
  if (!actionDecision.allowed) {
    denyCredentialRequest(input, "missing_action_capability");
  }

  const tenantScopes = input.connection.scopes.filter((scope) => scope.startsWith("tenant:"));
  if (tenantScopes.length > 0 && !input.tenant?.trim()) {
    denyCredentialRequest(input, "missing_tenant");
  }
  if (input.tenant?.trim() && !input.connection.scopes.includes(`tenant:${input.tenant.trim()}`)) {
    denyCredentialRequest(input, "tenant_connection_mismatch");
  }

  if (input.policy.approval.required) {
    if (input.approvalStatus === "denied") {
      denyCredentialRequest(input, "approval_denied", "denied");
    }
    if (!hasApprovalCapability(input.context, input.connection.provider, input.action)) {
      denyCredentialRequest(input, "approval_required", "not_requested");
    }
  }
}

function denyCredentialRequest(
  input: Parameters<typeof authorizeCredentialRequest>[0],
  reasonCode: string,
  approvalStatus = input.policy.approval.required ? (input.approvalStatus ?? "not_requested") : null,
): never {
  recordCredentialAuditEvent(
    {
      provider: input.connection.provider,
      connection: input.connection.connection,
      action: input.action,
      decision: "deny",
      approvalRequired: input.policy.approval.required,
      approvalStatus,
      resultStatus: "authorization_denied",
      errorCode: reasonCode,
      actorContextId: input.context.contextId,
      agentId: input.context.agentId ?? null,
    },
    input.options,
  );
  throw new CredentialAuthorizationError(reasonCode);
}

function credentialApprovalStatus(input: {
  policy: CredentialPolicyExplanation;
  context: Readonly<CredentialCallerContext>;
  provider: string;
  action: string;
  requestedStatus: CredentialAuthorizationInput["approvalStatus"];
}): string | null {
  if (!input.policy.approval.required) return null;
  if (input.requestedStatus === "denied") return "denied";
  if (hasApprovalCapability(input.context, input.provider, input.action)) return "approved";
  return "not_requested";
}

function hasApprovalCapability(context: Readonly<CredentialCallerContext>, provider: string, action: string): boolean {
  return context.capabilities.some(
    (capability) =>
      capability.permission === "execute" &&
      capability.objectType === provider &&
      capability.objectId === action &&
      capability.source === "approval",
  );
}

export class CredentialAuthorizationError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`Credential authorization denied: ${code}`);
    this.name = "CredentialAuthorizationError";
    this.code = code;
  }
}

export async function execCredentialBroker(input: {
  provider: string;
  connection: string;
  action: string;
  dryRun: boolean;
  options?: CredentialStoreOptions;
}) {
  const record = getCredentialConnection(input.provider, input.connection, input.options);
  if (!record) throw new Error(`Connection not found: ${input.provider}:${input.connection}`);
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

function isSensitiveAction(action: string): boolean {
  return !/^(auth\.check|whoami|[a-z0-9_-]+\.(read|list|info|get|show))$/.test(action);
}
