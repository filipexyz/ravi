import { rmSync } from "node:fs";

import { resolveConnectorTurn, type ConnectorTurn, type ConnectorTurnDeps } from "../link/connector-turn.js";
import { CloudAuthError } from "./errors.js";
import {
  deleteCloudCredentials,
  getActiveCloudAuthPointerPath,
  readActiveCloudAuthUserId,
  readCloudCredentials,
} from "./storage.js";
import { LEGACY_CLOUD_AUTH_USER_ID, type CloudCredentials } from "./types.js";

export interface ConnectorAuthOptions {
  env?: NodeJS.ProcessEnv;
  readActive?: typeof readCloudCredentials;
  /** Turn classification inputs (tests). */
  turn?: ConnectorTurnDeps;
}

/**
 * Resolve the Console session for a connector call.
 *
 * Personal connections serve only the operator's own turns, so the only
 * session a connector call may use is the active `ravi login` session, and
 * only after the turn was classified as the operator's (terminal, the
 * operator's own direct chat, or a routine the operator owns). A turn of
 * anyone else is blocked (exit 3) before any Console or Link call. A contact
 * linked to a different Console user is refused, never switched to that
 * user's stored session.
 *
 * Without an active session there is nothing to protect, so the answer is
 * AUTH_REQUIRED for every turn: the owner writing from their own chat while
 * logged out must not be told they are someone else.
 */
export function resolveConnectorCloudCredentials(options: ConnectorAuthOptions = {}): {
  turn: ConnectorTurn;
  credentials: CloudCredentials;
  /** Console user the turn was classified against (null for a legacy session without one). */
  activeUserId: string | null;
} {
  const env = options.env ?? process.env;
  const readActive = options.readActive ?? readCloudCredentials;
  const active = readActive(env);
  if (!active) {
    throw new CloudAuthError("AUTH_REQUIRED", "Ravi Cloud login required. Run `ravi login`.");
  }
  const activeUserId =
    options.turn?.activeUserId !== undefined ? options.turn.activeUserId : resolveActiveUserId(env, active);
  const result = resolveConnectorTurn({
    env,
    ...options.turn,
    activeUserId,
    activeOrgId: options.turn?.activeOrgId !== undefined ? options.turn.activeOrgId : (active.organization?.id ?? null),
    ownerName:
      options.turn?.ownerName !== undefined
        ? options.turn.ownerName
        : (active.user?.name ?? active.user?.displayName ?? null),
  });
  if (!result.ok) {
    // A contact cannot be told apart from the owner when the stored session
    // does not say whose it is.
    if (!activeUserId && result.actorPrincipal.startsWith("contact:")) {
      throw new CloudAuthError(
        "AUTH_REQUIRED",
        "The stored Ravi Cloud login does not say which Console user it belongs to. Run `ravi login` again.",
      );
    }
    throw result.error;
  }
  return { turn: result.turn, credentials: active, activeUserId };
}

/**
 * Forget the active session after its refresh failed, without handing its
 * place to another stored user. `deleteCloudCredentials` promotes the next
 * stored session; a connector call never starts running as that person, so
 * the active pointer is dropped instead and the next call asks for
 * `ravi login`.
 */
export function deleteConnectorSession(
  env: NodeJS.ProcessEnv = process.env,
  remove: (env: NodeJS.ProcessEnv) => void = deleteCloudCredentials,
): void {
  const before = safeActiveUserId(env);
  remove(env);
  const after = safeActiveUserId(env);
  if (after && after !== before) rmSync(getActiveCloudAuthPointerPath(env), { force: true });
}

/**
 * The Console's own answer about whose session this is must match the user the
 * turn was classified against; otherwise the stored session is not the one it
 * claims to be.
 */
export function assertConnectorSessionUser(expectedUserId: string | null, verifiedUserId: unknown): void {
  const verified = stringValue(verifiedUserId);
  if (!expectedUserId || expectedUserId === LEGACY_CLOUD_AUTH_USER_ID || !verified) return;
  if (verified !== expectedUserId) {
    throw new CloudAuthError(
      "AUTH_REQUIRED",
      "The stored Ravi Cloud session belongs to a different Console user than the active login. Run `ravi login`.",
    );
  }
}

function resolveActiveUserId(env: NodeJS.ProcessEnv, active: CloudCredentials | null): string | null {
  const pointer = safeActiveUserId(env);
  if (pointer && pointer !== LEGACY_CLOUD_AUTH_USER_ID) return pointer;
  return stringValue(active?.user?.id);
}

function safeActiveUserId(env: NodeJS.ProcessEnv): string | null {
  try {
    return readActiveCloudAuthUserId(env);
  } catch {
    return null;
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
