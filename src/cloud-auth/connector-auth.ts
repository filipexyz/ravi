import { rmSync } from "node:fs";

import {
  resolveConnectorExecRoute,
  resolveConnectorTurn,
  type ConnectorExecRoute,
  type ConnectorTurn,
  type ConnectorTurnDeps,
} from "../link/connector-turn.js";
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
  /**
   * An exec: also apply the executing agent's mode for `provider`, so a
   * contact's turn may go to agent exec instead of being refused.
   */
  exec?: { provider: string; useShared?: boolean };
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
 *
 * With `exec`, the agent's mode may send a contact's turn to agent exec
 * (`route.mode` other than `owner`). That call still uses the operator's
 * session as the CLI bearer, but the account is the person's own or the
 * shared one, picked by the Worker.
 */
export function resolveConnectorCloudCredentials(options: ConnectorAuthOptions = {}): {
  turn: ConnectorTurn;
  credentials: CloudCredentials;
  /** Console user the turn was classified against (null for a legacy session without one). */
  activeUserId: string | null;
  /** Where an exec goes (only with `exec`). */
  route?: ConnectorExecRoute;
} {
  const env = options.env ?? process.env;
  const readActive = options.readActive ?? readCloudCredentials;
  const active = readActive(env);
  if (!active) {
    throw new CloudAuthError("AUTH_REQUIRED", "Ravi Cloud login required. Run `ravi login`.");
  }
  const activeUserId =
    options.turn?.activeUserId !== undefined ? options.turn.activeUserId : resolveActiveUserId(env, active);
  const turnDeps: ConnectorTurnDeps = {
    env,
    ...options.turn,
    activeUserId,
    activeOrgId: options.turn?.activeOrgId !== undefined ? options.turn.activeOrgId : (active.organization?.id ?? null),
    ownerName:
      options.turn?.ownerName !== undefined
        ? options.turn.ownerName
        : (active.user?.name ?? active.user?.displayName ?? null),
  };
  const result = options.exec
    ? resolveConnectorExecRoute({ ...turnDeps, ...options.exec })
    : resolveConnectorTurn(turnDeps);
  const actorPrincipal = !result.ok
    ? result.actorPrincipal
    : "route" in result
      ? result.route.turn.actorPrincipal
      : result.turn.actorPrincipal;
  // A contact cannot be told apart from the owner when the stored session
  // does not say whose it is.
  if (!activeUserId && actorPrincipal.startsWith("contact:")) {
    throw new CloudAuthError(
      "AUTH_REQUIRED",
      "The stored Ravi Cloud login does not say which Console user it belongs to. Run `ravi login` again.",
    );
  }
  if (!result.ok) throw result.error;
  if ("route" in result) return { turn: result.route.turn, credentials: active, activeUserId, route: result.route };
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
