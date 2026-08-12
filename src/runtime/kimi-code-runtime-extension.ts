import { isKimiCodeSessionStartEnabled } from "./kimi-code-availability.js";
import { retireSupersededKimiCodeSessionState } from "./kimi-code-state.js";
import type { RuntimeProviderRegistrationOptions } from "./provider-registry.js";
import type { RuntimeSessionState } from "./types.js";

function isKimiCodeSessionState(session: RuntimeSessionState | undefined): session is RuntimeSessionState {
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

export const kimiCodeRuntimeExtensions = {
  availability(env) {
    return isKimiCodeSessionStartEnabled(env)
      ? { available: true as const }
      : { available: false as const, reason: "Kimi Code session start is disabled" };
  },
  sessionLifecycle: {
    createDeleteStateCleanup(session) {
      return isKimiCodeSessionState(session)
        ? { operation: "delete_state" as const, locator: session.params }
        : null;
    },
    shouldRetirePersistedState(previousSession, nextSession) {
      return (
        isKimiCodeSessionState(previousSession) &&
        isKimiCodeSessionState(nextSession) &&
        previousSession.params?.sessionId === nextSession.params?.sessionId &&
        Number(nextSession.params?.revision) > Number(previousSession.params?.revision)
      );
    },
    retirePersistedState: retireSupersededKimiCodeSessionState,
  },
} satisfies RuntimeProviderRegistrationOptions;
