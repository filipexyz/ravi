import { logger } from "../utils/logger.js";
import { cleanupKimiCodeSessionState, retireSupersededKimiCodeSessionState } from "./kimi-code-state.js";
import type { RuntimeSessionState } from "./types.js";

const log = logger.child("runtime:provider-session-lifecycle");

export interface ProviderSessionLifecycleMutationInput {
  /** The state observed before the synchronous database mutation. */
  session: RuntimeSessionState | null | undefined;
  /** Must perform an exact/CAS mutation and report whether it changed the row. */
  mutate: () => boolean;
  /** Injectable only to keep the mutation/cleanup ordering independently testable. */
  cleanupKimi?: (session: RuntimeSessionState) => Promise<void>;
  env?: NodeJS.ProcessEnv;
}

export interface ProviderSessionPersistenceMutationInput {
  /** The locator owned by the host before the durable persistence callback. */
  previousSession: RuntimeSessionState | null | undefined;
  /** The locator returned by the provider for the completed turn. */
  nextSession: RuntimeSessionState | null | undefined;
  /** Must synchronously durably store nextSession or throw. */
  persist: () => void;
  /** Injectable only to keep persistence/retirement ordering independently testable. */
  retireKimi?: (
    previousSession: RuntimeSessionState,
    nextSession: RuntimeSessionState,
    env?: NodeJS.ProcessEnv,
  ) => Promise<void>;
  env?: NodeJS.ProcessEnv;
}

export async function runProviderSessionPersistenceMutation(
  input: ProviderSessionPersistenceMutationInput,
): Promise<void> {
  const previousSession = snapshotRuntimeSessionState(input.previousSession);
  const nextSession = snapshotRuntimeSessionState(input.nextSession);
  input.persist();
  if (!isKimiCodeSession(previousSession) || !isKimiCodeSession(nextSession)) return;
  if (
    previousSession.params?.sessionId !== nextSession.params?.sessionId ||
    Number(nextSession.params?.revision) <= Number(previousSession.params?.revision)
  ) {
    return;
  }

  try {
    await (input.retireKimi ?? retireSupersededKimiCodeSessionState)(previousSession, nextSession, input.env);
  } catch (error) {
    log.warn("Failed to retire superseded Kimi Code session state after host persistence", { error });
  }
}

/**
 * Couples provider-owned cleanup to a successful host-session mutation without
 * allowing cleanup failure to alter that mutation's outcome.
 */
export async function runProviderSessionLifecycleMutation(
  input: ProviderSessionLifecycleMutationInput,
): Promise<boolean> {
  const snapshot = snapshotRuntimeSessionState(input.session);
  const changed = input.mutate();
  if (!changed || !isKimiCodeSession(snapshot)) return changed;

  try {
    await (input.cleanupKimi ?? ((session) => cleanupKimiCodeSessionState(session, input.env)))(snapshot);
  } catch (error) {
    log.warn("Failed to clean Kimi Code session state after host lifecycle mutation", { error });
  }
  return changed;
}

function isKimiCodeSession(session: RuntimeSessionState | undefined): session is RuntimeSessionState {
  const params = session?.params;
  return (
    params?.provider === "kimi-code" &&
    params.schemaVersion === 1 &&
    typeof params.model === "string" &&
    typeof params.sessionId === "string" &&
    Number.isSafeInteger(params.revision) &&
    typeof params.cwd === "string" &&
    typeof params.workspaceIdentity === "object" &&
    params.workspaceIdentity !== null &&
    typeof params.sessionFile === "string" &&
    typeof params.lastCommittedTurnId === "string"
  );
}

function snapshotRuntimeSessionState(session: RuntimeSessionState | null | undefined): RuntimeSessionState | undefined {
  if (!session) return undefined;
  return {
    ...(session.displayId === undefined ? {} : { displayId: session.displayId }),
    ...(session.params ? { params: { ...session.params } } : {}),
  };
}
