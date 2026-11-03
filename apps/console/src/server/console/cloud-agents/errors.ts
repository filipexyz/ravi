// Cloud agents errors share the CLI failure envelope; the codes are the
// lowercase ones of the cloud agents HTTP API.

import { CliApiError, type CliErrorCode } from "@/server/cli/errors";

export type CloudAgentsErrorCode = Extract<
  CliErrorCode,
  | "cloud_agents_unconfigured"
  | "cloud_agents_not_enabled"
  | "cloud_credential_missing"
  | "cloud_credential_invalid"
  | "cloud_agent_definition_invalid"
  | "cloud_agent_provider_unsupported"
  | "cloud_agent_repository_unavailable"
  | "cloud_run_not_active"
  | "forbidden"
  | "not_found"
  | "validation_failed"
  | "idempotency_conflict"
  | "provider_error"
>;

const STATUS: Record<CloudAgentsErrorCode, number> = {
  cloud_agents_unconfigured: 503,
  cloud_agents_not_enabled: 403,
  cloud_credential_missing: 409,
  cloud_credential_invalid: 409,
  cloud_agent_definition_invalid: 400,
  cloud_agent_provider_unsupported: 400,
  cloud_agent_repository_unavailable: 400,
  cloud_run_not_active: 409,
  forbidden: 403,
  not_found: 404,
  validation_failed: 400,
  idempotency_conflict: 409,
  provider_error: 502,
};

export class CloudAgentsError extends CliApiError {
  declare readonly code: CloudAgentsErrorCode;

  constructor(code: CloudAgentsErrorCode, message: string, details?: Record<string, unknown>, status = STATUS[code]) {
    super(status, code, message, details);
    this.name = "CloudAgentsError";
  }
}

export function cloudError(code: CloudAgentsErrorCode, message: string, details?: Record<string, unknown>) {
  return new CloudAgentsError(code, message, details);
}

export function isCloudAgentsError(error: unknown, code?: CloudAgentsErrorCode): error is CloudAgentsError {
  return error instanceof CloudAgentsError && (code === undefined || error.code === code);
}

/** A run or agent keeps a code and a short message, never a stack or a raw payload. */
export function errorSummary(error: unknown): { code: CloudAgentsErrorCode; message: string } {
  if (error instanceof CloudAgentsError) return { code: error.code, message: error.message.slice(0, 500) };
  const message = error instanceof Error ? error.message : "Unknown error.";
  return { code: "provider_error", message: message.slice(0, 500) };
}
