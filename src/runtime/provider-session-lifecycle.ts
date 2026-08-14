import { logger } from "../utils/logger.js";
import { resolveRuntimeProviderSessionLifecycle } from "./provider-registry.js";
import { mutateSessionAndEnqueueProviderStateCleanup } from "./provider-state-cleanup-store.js";
import type { RuntimeSessionState } from "./types.js";

export { adoptPublishedProviderState } from "./provider-state-lifecycle.js";

const log = logger.child("runtime:provider-session-lifecycle");

export interface ProviderSessionLifecycleMutationInput {
  /** The state observed before the synchronous database mutation. */
  session: RuntimeSessionState | null | undefined;
  /** Must perform an exact/CAS mutation and report whether it changed the row. */
  mutate: () => boolean;
  /** Test hook. Production callers omit it and enqueue durable cleanup. */
  cleanupProviderState?: (session: RuntimeSessionState) => Promise<void>;
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
  retireProviderState?: (
    previousSession: RuntimeSessionState,
    nextSession: RuntimeSessionState,
    env?: NodeJS.ProcessEnv,
  ) => Promise<void>;
  env?: NodeJS.ProcessEnv;
}

export interface StartedProviderSessionLifecycleMutation {
  changed: boolean;
  cleanup: Promise<void>;
}

export async function runProviderSessionPersistenceMutation(
  input: ProviderSessionPersistenceMutationInput,
): Promise<void> {
  const previousSession = snapshotRuntimeSessionState(input.previousSession);
  const nextSession = snapshotRuntimeSessionState(input.nextSession);
  input.persist();
  if (!previousSession || !nextSession) return;
  const lifecycle = resolveRuntimeProviderSessionLifecycle(previousSession);
  if (!lifecycle?.shouldRetirePersistedState?.(previousSession, nextSession)) return;
  const retireProviderState = input.retireProviderState ?? lifecycle.retirePersistedState;
  if (!retireProviderState) return;

  try {
    await retireProviderState(previousSession, nextSession, input.env);
  } catch (error) {
    log.warn("Failed to retire superseded provider session state after host persistence", { error });
  }
}

/**
 * Couples provider-owned cleanup to a successful host-session mutation without
 * allowing cleanup failure to alter that mutation's outcome.
 */
export async function runProviderSessionLifecycleMutation(
  input: ProviderSessionLifecycleMutationInput,
): Promise<boolean> {
  const started = startProviderSessionLifecycleMutation(input);
  await started.cleanup;
  return started.changed;
}

/** Runs the exact database mutation synchronously and exposes test cleanup separately. */
export function startProviderSessionLifecycleMutation(
  input: ProviderSessionLifecycleMutationInput,
): StartedProviderSessionLifecycleMutation {
  const snapshot = snapshotRuntimeSessionState(input.session);
  const lifecycle = resolveRuntimeProviderSessionLifecycle(snapshot);
  const cleanupRequest = snapshot ? lifecycle?.createDeleteStateCleanup(snapshot) : null;
  const cleanupProviderState = input.cleanupProviderState;
  if (lifecycle && !cleanupRequest) {
    return { changed: false, cleanup: Promise.resolve() };
  }
  const changed =
    cleanupRequest && !cleanupProviderState
      ? mutateSessionAndEnqueueProviderStateCleanup(
          cleanupRequest,
          () => input.mutate(),
        ).won
      : input.mutate();
  const cleanup = (async () => {
    if (!changed || !snapshot || !cleanupRequest || !cleanupProviderState) return;
    try {
      await cleanupProviderState(snapshot);
    } catch (error) {
      log.warn("Failed to clean provider session state after host lifecycle mutation", { error });
    }
  })();
  return { changed, cleanup };
}

function snapshotRuntimeSessionState(session: RuntimeSessionState | null | undefined): RuntimeSessionState | undefined {
  if (!session) return undefined;
  return {
    ...(session.displayId === undefined ? {} : { displayId: session.displayId }),
    ...(session.params ? { params: { ...session.params } } : {}),
  };
}
