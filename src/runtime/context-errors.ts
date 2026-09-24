/**
 * Expected context-registry failures with a public contract code.
 *
 * These are policy/usage denials, not unexpected crashes. The CLI/gateway
 * contract mapper preserves `message` and `suggestedAction`. Do not put
 * context keys (`rctx_*`) or other secrets in these fields.
 */
export type RuntimeContextErrorCode = "PERMISSION_DENIED" | "USAGE_ERROR";

export const IDENTITY_DELEGATION_REQUIRES_ADMIN =
  "Identity delegation requires admin:system:* on the parent context";
export const IDENTITY_DELEGATION_REQUIRES_ADMIN_ACTION =
  "Re-run from a parent context that has admin:system:*, or omit --as-agent / --as-session-key / --as-session-name";

export const DELEGATED_SESSION_BINDINGS_MUST_BE_PAIRED =
  "Delegated sessionKey and sessionName must be provided together";
export const DELEGATED_SESSION_BINDINGS_MUST_BE_PAIRED_ACTION =
  "Pass both --as-session-key and --as-session-name, or omit both";

export const DELEGATED_AGENT_ID_REQUIRED = "Delegated agentId is required";
export const DELEGATED_AGENT_ID_REQUIRED_ACTION =
  "Pass --as-agent when using --as-session-key or --as-session-name";

export class RuntimeContextError extends Error {
  readonly code: RuntimeContextErrorCode;
  readonly exitCode: number;
  readonly suggestedAction: string;
  readonly details: Record<string, unknown>;

  constructor(
    code: RuntimeContextErrorCode,
    message: string,
    suggestedAction: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "RuntimeContextError";
    this.code = code;
    this.exitCode = code === "USAGE_ERROR" ? 2 : 1;
    this.suggestedAction = suggestedAction;
    this.details = details;
  }
}

export function isRuntimeContextError(error: unknown): error is RuntimeContextError {
  return error instanceof RuntimeContextError;
}

export function identityDelegationRequiresAdminError(): RuntimeContextError {
  return new RuntimeContextError(
    "PERMISSION_DENIED",
    IDENTITY_DELEGATION_REQUIRES_ADMIN,
    IDENTITY_DELEGATION_REQUIRES_ADMIN_ACTION,
    { requiredCapability: "admin:system:*" },
  );
}

export function delegatedSessionBindingsMustBePairedError(): RuntimeContextError {
  return new RuntimeContextError(
    "USAGE_ERROR",
    DELEGATED_SESSION_BINDINGS_MUST_BE_PAIRED,
    DELEGATED_SESSION_BINDINGS_MUST_BE_PAIRED_ACTION,
  );
}

export function delegatedAgentIdRequiredError(): RuntimeContextError {
  return new RuntimeContextError("USAGE_ERROR", DELEGATED_AGENT_ID_REQUIRED, DELEGATED_AGENT_ID_REQUIRED_ACTION);
}

export function capabilityNotGrantedByParentError(capability: {
  permission: string;
  objectType: string;
  objectId: string;
}): RuntimeContextError {
  const granted = `${capability.permission}:${capability.objectType}:${capability.objectId}`;
  return new RuntimeContextError(
    "PERMISSION_DENIED",
    `Capability not granted by parent context: ${granted}`,
    "Request the missing capability on the parent context or omit it from --allow",
    { requiredCapability: granted },
  );
}
