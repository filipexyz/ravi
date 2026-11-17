/**
 * Atomic session runtime update — one operation for provider/model/effort/
 * thinking with fail-fast validation, a liveness probe, and automatic
 * rollback.
 *
 * Contract (spec sessions/runtime-update):
 * 1. Every requested axis is validated BEFORE anything is written. An invalid
 *    value is refused naming the valid values; no partial write survives.
 * 2. The requested axes are applied together, then a real provider turn (the
 *    probe) runs against the persisted effective runtime.
 * 3. A failed probe restores every touched axis to its prior value, so the
 *    session is never left on a selection that cannot complete a turn.
 *
 * Destructive finalization (clearing provider continuity when the provider
 * changed, rematerializing agent defaults after a clear) is deferred until the
 * probe passed: rollback never has to reconstruct destroyed state.
 *
 * The axis writes land as one SQLite transaction (`applyAtomically`): a write
 * that throws rolls the whole apply back, so a partial configuration is never
 * persisted. A restore that itself fails after a failed probe is reported on
 * the result (`rollbackError`), never swallowed and never in place of the probe
 * verdict.
 *
 * Concurrency: every apply bumps the session's persisted runtime-config
 * revision, and both the rollback and the destructive finalization are
 * conditional on still owning (revision + all four persisted values) what this
 * update wrote. A concurrent update that lands while the probe runs supersedes
 * this one: nothing is restored or destroyed over the newer configuration
 * (lost-update finding on #829).
 */

import {
  applySessionRuntimeConfigAtomically,
  bumpSessionRuntimeProviderConfigRevision,
  clearProviderSessionIfRuntimeConfigOwned,
  resolveSession,
  restoreSessionRuntimeConfigIfOwned,
  sessionRuntimeConfigOwned,
  updateSessionEffortOverride,
  updateSessionModelOverride,
  updateSessionRuntimeProviderOverride,
  updateSessionThinkingLevel,
} from "../router/sessions.js";
import type { AgentConfig, SessionEntry } from "../router/types.js";
import { parseRuntimeEffort, type RuntimeEffort } from "./effort.js";
import { getDefaultModelForProvider } from "./model-catalog.js";
import { validateRuntimeModelSelector } from "./model-validation.js";
import { listRegisteredRuntimeProviderIds } from "./provider-registry.js";
import { rematerializeSessionToAgentRuntime } from "./agent-session-runtime-sync.js";
import { probeRuntimeTurn, type RuntimeProbeRequest, type RuntimeProbeResult } from "./runtime-probe.js";
import { resolveEffectiveSessionRuntime } from "./runtime-selection.js";
import type { RuntimeProviderId, RuntimeThinking } from "./types.js";
import { logger } from "../utils/logger.js";

const log = logger.child("session-runtime-update");

export const SESSION_RUNTIME_THINKING_LEVELS = ["off", "normal", "verbose"] as const;

export interface SessionRuntimeAxisChange<T> {
  /** The value to persist; null clears the override. */
  set: T | null;
}

export interface SessionRuntimeUpdateAxes {
  provider?: SessionRuntimeAxisChange<RuntimeProviderId>;
  model?: SessionRuntimeAxisChange<string>;
  effort?: SessionRuntimeAxisChange<RuntimeEffort>;
  thinking?: SessionRuntimeAxisChange<RuntimeThinking>;
}

export interface SessionRuntimeSnapshot {
  runtimeProviderOverride: string | null;
  modelOverride: string | null;
  effortOverride: string | null;
  thinkingLevel: string | null;
}

export interface SessionRuntimeEffectiveSelection {
  provider: string;
  model: string | null;
  effort: string | null;
  thinking: string | null;
}

export interface SessionRuntimeUpdateResult {
  sessionKey: string;
  sessionName: string | null;
  changed: { provider: boolean; model: boolean; effort: boolean; thinking: boolean };
  before: SessionRuntimeSnapshot;
  after: SessionRuntimeSnapshot;
  effective: SessionRuntimeEffectiveSelection;
  probe: RuntimeProbeResult | null;
  rolledBack: boolean;
  /**
   * The probe failed and the restore itself threw, so the unproven
   * configuration is still persisted. Carries the restore error; null whenever
   * the restore ran (it either restored, or found a newer update and left it
   * alone).
   */
  rollbackError: string | null;
  /**
   * A concurrent update replaced this configuration while the probe ran. The
   * newer configuration was left untouched: no rollback, no destructive
   * finalization, and the caller must not announce this update as current.
   */
  superseded: boolean;
  clearedProviderSession: boolean;
  rematerializedToAgentRuntime: boolean;
}

export type SessionRuntimeUpdateErrorCode =
  | "NOTHING_TO_UPDATE"
  | "UNKNOWN_PROVIDER"
  | "INVALID_MODEL"
  | "INVALID_EFFORT"
  | "INVALID_THINKING";

export class SessionRuntimeUpdateError extends Error {
  readonly code: SessionRuntimeUpdateErrorCode;

  constructor(code: SessionRuntimeUpdateErrorCode, message: string) {
    super(message);
    this.name = "SessionRuntimeUpdateError";
    this.code = code;
  }
}

export interface SessionRuntimeUpdateDeps {
  /** Runs the synchronous axis writes as one transaction: all land or none does. */
  applyAtomically: typeof applySessionRuntimeConfigAtomically;
  updateProviderOverride: typeof updateSessionRuntimeProviderOverride;
  updateModelOverride: typeof updateSessionModelOverride;
  updateEffortOverride: typeof updateSessionEffortOverride;
  updateThinkingLevel: typeof updateSessionThinkingLevel;
  bumpConfigRevision: typeof bumpSessionRuntimeProviderConfigRevision;
  restoreIfOwned: typeof restoreSessionRuntimeConfigIfOwned;
  configOwned: typeof sessionRuntimeConfigOwned;
  clearProviderSessionIfOwned: typeof clearProviderSessionIfRuntimeConfigOwned;
  rematerializeSessionToAgentRuntime: typeof rematerializeSessionToAgentRuntime;
  readSession: (sessionKey: string) => SessionEntry | null;
  probe: (request: RuntimeProbeRequest) => Promise<RuntimeProbeResult>;
  listProviderIds: () => RuntimeProviderId[];
}

function defaultDeps(): SessionRuntimeUpdateDeps {
  return {
    applyAtomically: applySessionRuntimeConfigAtomically,
    updateProviderOverride: updateSessionRuntimeProviderOverride,
    updateModelOverride: updateSessionModelOverride,
    updateEffortOverride: updateSessionEffortOverride,
    updateThinkingLevel: updateSessionThinkingLevel,
    bumpConfigRevision: bumpSessionRuntimeProviderConfigRevision,
    restoreIfOwned: restoreSessionRuntimeConfigIfOwned,
    configOwned: sessionRuntimeConfigOwned,
    clearProviderSessionIfOwned: clearProviderSessionIfRuntimeConfigOwned,
    rematerializeSessionToAgentRuntime,
    readSession: resolveSession,
    probe: probeRuntimeTurn,
    listProviderIds: listRegisteredRuntimeProviderIds,
  };
}

export interface SessionRuntimeUpdateOptions {
  session: SessionEntry;
  agent: AgentConfig | null;
  axes: SessionRuntimeUpdateAxes;
  /** Run the liveness probe after applying (default true). */
  probe?: boolean;
  probeTimeoutMs?: number;
  deps?: Partial<SessionRuntimeUpdateDeps>;
}

function snapshotOf(
  session: Pick<SessionEntry, "runtimeProviderOverride" | "modelOverride" | "effortOverride" | "thinkingLevel">,
): SessionRuntimeSnapshot {
  return {
    runtimeProviderOverride: session.runtimeProviderOverride ?? null,
    modelOverride: session.modelOverride ?? null,
    effortOverride: session.effortOverride ?? null,
    thinkingLevel: session.thinkingLevel ?? null,
  };
}

/**
 * Parse CLI-shaped axis inputs ("clear" clears; absent means untouched) into
 * typed axis changes, refusing invalid values and naming the valid ones.
 */
export function parseSessionRuntimeUpdateAxes(input: {
  provider?: string;
  model?: string;
  effort?: string;
  thinking?: string;
  listProviderIds?: () => RuntimeProviderId[];
}): SessionRuntimeUpdateAxes {
  const axes: SessionRuntimeUpdateAxes = {};
  const listProviderIds = input.listProviderIds ?? listRegisteredRuntimeProviderIds;

  if (input.provider !== undefined) {
    const normalized = input.provider.trim().toLowerCase();
    if (!normalized) {
      throw new SessionRuntimeUpdateError(
        "UNKNOWN_PROVIDER",
        `Invalid provider: '${input.provider}'. Valid providers: ${listProviderIds().join(", ")}, clear.`,
      );
    }
    if (normalized === "clear") {
      axes.provider = { set: null };
    } else {
      if (!listProviderIds().includes(normalized)) {
        throw new SessionRuntimeUpdateError(
          "UNKNOWN_PROVIDER",
          `Unknown runtime provider: '${normalized}'. Valid providers: ${listProviderIds().join(", ")}.`,
        );
      }
      axes.provider = { set: normalized };
    }
  }

  if (input.model !== undefined) {
    const trimmed = input.model.trim();
    if (!trimmed) {
      throw new SessionRuntimeUpdateError("INVALID_MODEL", "Invalid model: value cannot be empty.");
    }
    axes.model = trimmed === "clear" ? { set: null } : { set: trimmed };
  }

  if (input.effort !== undefined) {
    const normalized = input.effort.trim().toLowerCase();
    if (normalized === "clear") {
      axes.effort = { set: null };
    } else {
      let parsed: RuntimeEffort | undefined;
      try {
        parsed = parseRuntimeEffort(normalized);
      } catch (error) {
        throw new SessionRuntimeUpdateError("INVALID_EFFORT", error instanceof Error ? error.message : String(error));
      }
      if (!parsed) {
        throw new SessionRuntimeUpdateError("INVALID_EFFORT", `Invalid runtime effort: '${input.effort}'.`);
      }
      axes.effort = { set: parsed };
    }
  }

  if (input.thinking !== undefined) {
    const normalized = input.thinking.trim().toLowerCase();
    if (normalized === "clear") {
      axes.thinking = { set: null };
    } else if ((SESSION_RUNTIME_THINKING_LEVELS as readonly string[]).includes(normalized)) {
      axes.thinking = { set: normalized as RuntimeThinking };
    } else {
      throw new SessionRuntimeUpdateError(
        "INVALID_THINKING",
        `Invalid thinking level: '${input.thinking}'. Valid values: ${SESSION_RUNTIME_THINKING_LEVELS.join(", ")}, clear.`,
      );
    }
  }

  return axes;
}

export async function applySessionRuntimeUpdate(
  options: SessionRuntimeUpdateOptions,
): Promise<SessionRuntimeUpdateResult> {
  const deps: SessionRuntimeUpdateDeps = { ...defaultDeps(), ...(options.deps ?? {}) };
  const { session, agent, axes } = options;
  const probeEnabled = options.probe !== false;

  const touched = {
    provider: axes.provider !== undefined,
    model: axes.model !== undefined,
    effort: axes.effort !== undefined,
    thinking: axes.thinking !== undefined,
  };
  if (!touched.provider && !touched.model && !touched.effort && !touched.thinking) {
    throw new SessionRuntimeUpdateError(
      "NOTHING_TO_UPDATE",
      "Nothing to update: pass at least one of --provider, --model, --effort, --thinking.",
    );
  }

  const before = snapshotOf(session);

  // Fail fast: resolve the runtime this update would produce and validate it
  // against the installed catalog before any write happens.
  const hypothetical = {
    agentId: session.agentId,
    runtimeProviderOverride: (touched.provider ? (axes.provider?.set ?? undefined) : session.runtimeProviderOverride) as
      | SessionEntry["runtimeProviderOverride"]
      | undefined,
    // A touched provider axis must not let the stale last-used provider win
    // the hypothetical resolution (set: override wins; clear: agent default
    // rematerializes).
    runtimeProvider: touched.provider ? undefined : session.runtimeProvider,
    modelOverride: touched.model ? (axes.model?.set ?? undefined) : session.modelOverride,
    effortOverride: (touched.effort ? (axes.effort?.set ?? undefined) : session.effortOverride) as
      | SessionEntry["effortOverride"]
      | undefined,
    thinkingLevel: (touched.thinking ? (axes.thinking?.set ?? undefined) : session.thinkingLevel) as
      | SessionEntry["thinkingLevel"]
      | undefined,
  };
  const nextRuntime = resolveEffectiveSessionRuntime({ session: hypothetical, agent });
  if (nextRuntime.model.error) {
    throw new SessionRuntimeUpdateError("INVALID_MODEL", nextRuntime.model.error);
  }
  if (nextRuntime.model.value && nextRuntime.model.source !== "runtime_default") {
    const validation = validateRuntimeModelSelector(nextRuntime.provider.value, nextRuntime.model.value);
    if (!validation.ok) {
      throw new SessionRuntimeUpdateError(
        "INVALID_MODEL",
        validation.error ?? `Invalid model: ${nextRuntime.model.value}`,
      );
    }
  }

  // Apply every requested axis together, and make the apply observable: the
  // provider setter bumps the persisted runtime-config revision on its own;
  // every other combination bumps it explicitly, so one atomic update is
  // exactly one revision step and concurrent updates always see each other.
  //
  // The axis writes, the revision bump and the read that captures ownership
  // run as ONE transaction: a setter that throws midway rolls back the writes
  // before it, so no partial, unproven configuration is ever persisted, and no
  // other writer can land between two of the statements. The original error
  // reaches the caller unchanged. Nothing here has to guess, from persisted
  // values, whether a half-applied state is this update's to undo.
  const { persistedSession, written, ownedRevision } = deps.applyAtomically(() => {
    if (touched.provider)
      deps.updateProviderOverride(session.sessionKey, toProviderOverride(axes.provider?.set ?? null));
    if (touched.model) deps.updateModelOverride(session.sessionKey, axes.model?.set ?? null);
    if (touched.effort) deps.updateEffortOverride(session.sessionKey, toEffortOverride(axes.effort?.set ?? null));
    if (touched.thinking) deps.updateThinkingLevel(session.sessionKey, axes.thinking?.set ?? null);
    if (!touched.provider) deps.bumpConfigRevision(session.sessionKey);

    const persisted = deps.readSession(session.sessionKey);
    const persistedEntry = persisted ?? ({ ...session, ...hypothetical } as SessionEntry);
    return {
      persistedSession: persistedEntry,
      // Ownership of this update: the persisted revision right after the apply,
      // plus the four persisted values it wrote. Rollback and destructive
      // finalization only act while both still hold.
      written: snapshotOf(persistedEntry),
      ownedRevision: persistedEntry.runtimeProviderConfigRevision ?? 0,
    };
  });

  let effective: SessionRuntimeEffectiveSelection;
  let probeResult: RuntimeProbeResult | null = null;
  try {
    const effectiveSelection = resolveEffectiveSessionRuntime({
      session: {
        agentId: persistedSession.agentId,
        runtimeProviderOverride: persistedSession.runtimeProviderOverride,
        // The probe must prove the runtime the next turn will launch with: when
        // the provider changed, the stale last-used provider no longer wins.
        runtimeProvider: touched.provider ? undefined : persistedSession.runtimeProvider,
        modelOverride: persistedSession.modelOverride,
        effortOverride: persistedSession.effortOverride,
        thinkingLevel: persistedSession.thinkingLevel,
      },
      agent,
    });
    effective = {
      provider: effectiveSelection.provider.value,
      model: effectiveSelection.model.value,
      effort: effectiveSelection.effort.value ?? null,
      thinking: effectiveSelection.thinking.value ?? null,
    };

    if (probeEnabled) {
      const probeModel = effective.model ?? getDefaultModelForProvider(effective.provider as RuntimeProviderId);
      probeResult = await deps.probe({
        provider: effective.provider as RuntimeProviderId,
        model: probeModel,
        ...(effective.effort ? { effort: effective.effort as RuntimeEffort } : {}),
        ...(effective.thinking ? { thinking: effective.thinking as RuntimeThinking } : {}),
        agentId: session.agentId,
        sessionKey: session.sessionKey,
        sessionName: session.name ?? undefined,
        ...(options.probeTimeoutMs ? { timeoutMs: options.probeTimeoutMs } : {}),
      });
    }
  } catch (error) {
    // The probe (or the resolution feeding it) threw instead of returning a
    // verdict: the written configuration is unproven. Same conditional restore
    // as a failed probe; a concurrent update that landed meanwhile is kept.
    try {
      deps.restoreIfOwned(session.sessionKey, ownedRevision, written, before);
    } catch (restoreError) {
      log.warn("Could not restore the runtime configuration after the probe threw", {
        sessionKey: session.sessionKey,
        error: restoreError instanceof Error ? restoreError.message : String(restoreError),
      });
    }
    throw error;
  }

  if (probeResult) {
    if (!probeResult.ok) {
      // Conditional rollback: restore only while this update still owns the
      // persisted configuration. A concurrent update that landed during the
      // probe wins; overwriting it with this update's past would lose it.
      //
      // The restore can itself throw (disk I/O, lock). That must not replace
      // the probe verdict: the caller still gets the probe's failure, plus the
      // fact that the unproven configuration is STILL persisted.
      let restored = false;
      let rollbackError: string | null = null;
      try {
        restored = deps.restoreIfOwned(session.sessionKey, ownedRevision, written, before);
      } catch (restoreError) {
        rollbackError = restoreError instanceof Error ? restoreError.message : String(restoreError);
        log.warn("Could not restore the runtime configuration after the probe failed", {
          sessionKey: session.sessionKey,
          error: rollbackError,
        });
      }
      // After a failed restore the store is not trusted for another read: the
      // unproven configuration this update wrote is what stays persisted.
      const after = rollbackError === null ? deps.readSession(session.sessionKey) : null;
      return {
        sessionKey: session.sessionKey,
        sessionName: session.name ?? null,
        changed: touched,
        before,
        after: after ? snapshotOf(after) : restored ? before : written,
        effective,
        probe: probeResult,
        rolledBack: restored,
        rollbackError,
        superseded: rollbackError === null && !restored,
        clearedProviderSession: false,
        rematerializedToAgentRuntime: false,
      };
    }
  }

  // Destructive finalization only after the selection proved alive — and only
  // while this update still owns the persisted configuration. A superseded
  // update must not clear the continuity of, or rematerialize over, the
  // configuration that replaced it.
  let superseded = !deps.configOwned(session.sessionKey, ownedRevision, written);
  let clearedProviderSession = false;
  const newProvider = axes.provider?.set ?? null;
  if (
    !superseded &&
    touched.provider &&
    newProvider &&
    session.providerSessionId &&
    session.runtimeProvider &&
    session.runtimeProvider !== newProvider
  ) {
    clearedProviderSession = deps.clearProviderSessionIfOwned(session.sessionKey, ownedRevision, written);
    superseded = !clearedProviderSession;
  }

  let rematerializedToAgentRuntime = false;
  if (!superseded && touched.provider && newProvider === null && agent) {
    const cleared = deps.readSession(session.sessionKey);
    if (cleared) {
      rematerializedToAgentRuntime = Boolean(deps.rematerializeSessionToAgentRuntime(cleared, agent));
    }
  }

  const after = deps.readSession(session.sessionKey);
  return {
    sessionKey: session.sessionKey,
    sessionName: session.name ?? null,
    changed: touched,
    before,
    after: after ? snapshotOf(after) : snapshotOf({ ...session, ...hypothetical } as SessionEntry),
    effective,
    probe: probeResult,
    rolledBack: false,
    rollbackError: null,
    superseded,
    clearedProviderSession,
    rematerializedToAgentRuntime,
  };
}

function toProviderOverride(value: string | null): SessionEntry["runtimeProviderOverride"] | null {
  return (value ?? null) as SessionEntry["runtimeProviderOverride"] | null;
}

function toEffortOverride(value: string | null): SessionEntry["effortOverride"] | null {
  return (value ?? null) as SessionEntry["effortOverride"] | null;
}
