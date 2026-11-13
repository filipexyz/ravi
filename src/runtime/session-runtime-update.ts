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
 */

import {
  clearProviderSession,
  resolveSession,
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
  updateProviderOverride: typeof updateSessionRuntimeProviderOverride;
  updateModelOverride: typeof updateSessionModelOverride;
  updateEffortOverride: typeof updateSessionEffortOverride;
  updateThinkingLevel: typeof updateSessionThinkingLevel;
  clearProviderSession: typeof clearProviderSession;
  rematerializeSessionToAgentRuntime: typeof rematerializeSessionToAgentRuntime;
  readSession: (sessionKey: string) => SessionEntry | null;
  probe: (request: RuntimeProbeRequest) => Promise<RuntimeProbeResult>;
  listProviderIds: () => RuntimeProviderId[];
}

function defaultDeps(): SessionRuntimeUpdateDeps {
  return {
    updateProviderOverride: updateSessionRuntimeProviderOverride,
    updateModelOverride: updateSessionModelOverride,
    updateEffortOverride: updateSessionEffortOverride,
    updateThinkingLevel: updateSessionThinkingLevel,
    clearProviderSession,
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

  const restore = (): void => {
    if (touched.provider)
      deps.updateProviderOverride(session.sessionKey, toProviderOverride(before.runtimeProviderOverride));
    if (touched.model) deps.updateModelOverride(session.sessionKey, before.modelOverride);
    if (touched.effort) deps.updateEffortOverride(session.sessionKey, toEffortOverride(before.effortOverride));
    if (touched.thinking) deps.updateThinkingLevel(session.sessionKey, before.thinkingLevel);
  };

  // Apply every requested axis together.
  if (touched.provider) deps.updateProviderOverride(session.sessionKey, toProviderOverride(axes.provider?.set ?? null));
  if (touched.model) deps.updateModelOverride(session.sessionKey, axes.model?.set ?? null);
  if (touched.effort) deps.updateEffortOverride(session.sessionKey, toEffortOverride(axes.effort?.set ?? null));
  if (touched.thinking) deps.updateThinkingLevel(session.sessionKey, axes.thinking?.set ?? null);

  const persisted = deps.readSession(session.sessionKey);
  const persistedSession: SessionEntry = persisted ?? ({ ...session, ...hypothetical } as SessionEntry);
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
  const effective: SessionRuntimeEffectiveSelection = {
    provider: effectiveSelection.provider.value,
    model: effectiveSelection.model.value,
    effort: effectiveSelection.effort.value ?? null,
    thinking: effectiveSelection.thinking.value ?? null,
  };

  let probeResult: RuntimeProbeResult | null = null;
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

    if (!probeResult.ok) {
      restore();
      const after = deps.readSession(session.sessionKey);
      return {
        sessionKey: session.sessionKey,
        sessionName: session.name ?? null,
        changed: touched,
        before,
        after: after ? snapshotOf(after) : before,
        effective,
        probe: probeResult,
        rolledBack: true,
        clearedProviderSession: false,
        rematerializedToAgentRuntime: false,
      };
    }
  }

  // Destructive finalization only after the selection proved alive.
  let clearedProviderSession = false;
  const newProvider = axes.provider?.set ?? null;
  if (
    touched.provider &&
    newProvider &&
    session.providerSessionId &&
    session.runtimeProvider &&
    session.runtimeProvider !== newProvider
  ) {
    deps.clearProviderSession(session.sessionKey);
    clearedProviderSession = true;
  }

  let rematerializedToAgentRuntime = false;
  if (touched.provider && newProvider === null && agent) {
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
