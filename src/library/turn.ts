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
import { resolveConnectorTurn, type ConnectorTurnDeps, type ConnectorTurnResult } from "../link/connector-turn.js";

export interface LibraryTurnDeps {
  turn?: ConnectorTurnDeps;
  readCredentials?: typeof readCloudCredentials;
  /** Overrides the classification (tests). */
  operatorOwnTurn?: boolean;
}

export function isOperatorOwnTurn(deps: LibraryTurnDeps = {}): boolean {
  if (deps.operatorOwnTurn !== undefined) return deps.operatorOwnTurn;
  try {
    return resolveOperatorTurnClassification(deps).ok;
  } catch {
    // no-cause: fail closed, a turn that cannot be classified is not the operator's own.
    return false;
  }
}

/**
 * The full classification behind `isOperatorOwnTurn`, with the operator's
 * active login as the owner. Callers that need to know who is speaking (not
 * only whether it is the operator) read `turn.speaker`, or `candidate` on a
 * refusal. Throws only when the classifier itself fails.
 */
export function resolveOperatorTurnClassification(
  deps: Omit<LibraryTurnDeps, "operatorOwnTurn"> = {},
): ConnectorTurnResult {
  const env = deps.turn?.env ?? process.env;
  let active: ReturnType<typeof readCloudCredentials> = null;
  try {
    active = (deps.readCredentials ?? readCloudCredentials)(env);
  } catch {
    // no-cause: unreadable credentials name no owner, so no turn classifies as the operator's own.
    active = null;
  }
  const activeUserId =
    deps.turn?.activeUserId !== undefined ? deps.turn.activeUserId : activeCloudUserId(env, active?.user?.id);
  return resolveConnectorTurn({
    ...deps.turn,
    env,
    activeUserId,
    activeOrgId: deps.turn?.activeOrgId !== undefined ? deps.turn.activeOrgId : (active?.organization?.id ?? null),
  });
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
