import { getRuntimeContextFromEnv } from "../runtime/context-registry.js";
import { CloudAuthError } from "./errors.js";
import { readCloudCredentials, readCloudCredentialsForUser } from "./storage.js";
import type { CloudCredentials } from "./types.js";

export interface ConnectorAuthOptions {
  /**
   * User-scoped connector tools MUST set this. There is no operator JWT
   * fallback: if the turn has no bound Console user, fail closed.
   */
  requireBoundUser?: boolean;
  env?: NodeJS.ProcessEnv;
  readActive?: typeof readCloudCredentials;
  readForUser?: typeof readCloudCredentialsForUser;
}

/**
 * Resolve Console session credentials for Link/Console calls.
 *
 * Default (operator/installation tools): the active `ravi login` session.
 * User-scoped connector tools: the bound `consoleUserId` from turn metadata.
 * Operator JWT is never a fallback for user-scoped connector tools.
 */
export function resolveConnectorCloudCredentials(options: ConnectorAuthOptions = {}): CloudCredentials {
  const env = options.env ?? process.env;
  const readActive = options.readActive ?? readCloudCredentials;
  const readForUser = options.readForUser ?? readCloudCredentialsForUser;
  const context = getRuntimeContextFromEnv(env);
  const consoleUserId = stringField(context?.metadata, "consoleUserId");

  if (consoleUserId) {
    const bound = readForUser(consoleUserId, env);
    if (bound) return bound;
    if (options.requireBoundUser) {
      throw new CloudAuthError(
        "AUTH_REQUIRED",
        `No Console session is stored for bound user ${consoleUserId}. That user must run \`ravi login\`. Operator JWT is not a fallback.`,
      );
    }
  }

  if (options.requireBoundUser) {
    throw new CloudAuthError(
      "AUTH_REQUIRED",
      "This connector tool needs a linked Console user. Run `ravi link` from the contact's turn. Operator JWT is not a fallback.",
    );
  }

  const active = readActive(env);
  if (!active) {
    throw new CloudAuthError("AUTH_REQUIRED", "Ravi Cloud login required. Run `ravi login`.");
  }
  return active;
}

function stringField(metadata: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
