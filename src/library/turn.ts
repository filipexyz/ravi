/**
 * Whether the current turn is the operator's own (terminal, their linked
 * direct chat, their routines). Same classification as `ravi pages read`:
 * every other turn may serve people outside the organization, so Library
 * skills not marked `externalAllowed` stay out of it.
 *
 * spec: skills/library
 */

import { readActiveCloudAuthUserId, readCloudCredentials } from "../cloud-auth/storage.js";
import { LEGACY_CLOUD_AUTH_USER_ID } from "../cloud-auth/types.js";
import { resolveConnectorTurn, type ConnectorTurnDeps } from "../link/connector-turn.js";

export interface LibraryTurnDeps {
  turn?: ConnectorTurnDeps;
  readCredentials?: typeof readCloudCredentials;
  /** Overrides the classification (tests). */
  operatorOwnTurn?: boolean;
}

export function isOperatorOwnTurn(deps: LibraryTurnDeps = {}): boolean {
  if (deps.operatorOwnTurn !== undefined) return deps.operatorOwnTurn;
  const env = deps.turn?.env ?? process.env;
  let active: ReturnType<typeof readCloudCredentials> = null;
  try {
    active = (deps.readCredentials ?? readCloudCredentials)(env);
  } catch {
    active = null;
  }
  const activeUserId =
    deps.turn?.activeUserId !== undefined ? deps.turn.activeUserId : activeCloudUserId(env, active?.user?.id);
  try {
    return resolveConnectorTurn({
      ...deps.turn,
      env,
      activeUserId,
      activeOrgId: deps.turn?.activeOrgId !== undefined ? deps.turn.activeOrgId : (active?.organization?.id ?? null),
    }).ok;
  } catch {
    // Fail closed: a turn that cannot be classified is not the operator's own.
    return false;
  }
}

function activeCloudUserId(env: NodeJS.ProcessEnv, fallback: unknown): string | null {
  try {
    const pointer = readActiveCloudAuthUserId(env);
    if (pointer && pointer !== LEGACY_CLOUD_AUTH_USER_ID) return pointer;
  } catch {
    // An unreadable pointer falls back to the stored session's own user.
  }
  return typeof fallback === "string" && fallback.trim() ? fallback.trim() : null;
}
