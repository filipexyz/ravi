/**
 * Stable, non-secret failure codes for the credential broker. Callers such as
 * the native channel runner map these to health reasons and logs; the message
 * may name the connection but never carries secret material.
 */
export type CredentialBrokerErrorCode =
  | "caller_invalid"
  | "authorization_denied"
  | "approval_required"
  | "approval_denied"
  | "connection_not_found"
  | "connection_disabled"
  | "backend_unavailable"
  | "secret_unavailable";

export class CredentialBrokerError extends Error {
  /**
   * Non-secret, human-readable reason for a refusal (for example, why an
   * approval could not be granted). Never derived from backend or parser
   * output, so it may be shown to the caller.
   */
  readonly detail?: string;

  constructor(
    readonly code: CredentialBrokerErrorCode,
    message: string,
    options?: { cause?: unknown; detail?: string },
  ) {
    super(message, options);
    this.name = "CredentialBrokerError";
    this.detail = options?.detail;
  }
}

export function isCredentialBrokerError(error: unknown): error is CredentialBrokerError {
  return error instanceof CredentialBrokerError;
}
