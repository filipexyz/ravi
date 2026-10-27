/**
 * Stable, non-secret failure codes for the credential broker. Callers such as
 * the native channel runner map these to health reasons and logs; the message
 * may name the connection but never carries secret material.
 */
export type CredentialBrokerErrorCode =
  | "connection_not_found"
  | "connection_disabled"
  | "backend_unavailable"
  | "secret_unavailable";

export class CredentialBrokerError extends Error {
  constructor(
    readonly code: CredentialBrokerErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "CredentialBrokerError";
  }
}

export function isCredentialBrokerError(error: unknown): error is CredentialBrokerError {
  return error instanceof CredentialBrokerError;
}
