import { logger } from "../utils/logger.js";
import { cleanupKimiCodeSessionState } from "./kimi-code-state.js";
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
