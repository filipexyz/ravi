/**
 * Keep agent defaults and materialized session runtime aligned.
 *
 * `sessions.runtime_provider` is last-used, and last-used wins over agent
 * defaults on the next turn. When an agent provider/model/modelPreset changes,
 * no-override sessions must rematerialize so they follow the agent instead of
 * staying pinned to a stale last-used provider.
 */

import type { AgentConfig, SessionEntry } from "../router/types.js";
import {
  clearProviderSession,
  getSessionsByAgent,
  updateRuntimeProviderState,
  updateSessionModelOverride,
  updateSessionRuntimeProviderOverride,
} from "../router/sessions.js";
import { resolveRequestedRuntimeProvider } from "./runtime-selection.js";
import type { RuntimeEffort } from "./effort.js";
import type { RuntimeProviderId } from "./types.js";

export const SESSION_RUNTIME_OVERRIDE_REASONS = [
  "provider_override",
  "model_override",
  "effort_override",
  "thinking_override",
] as const;

export type SessionRuntimeOverrideReason = (typeof SESSION_RUNTIME_OVERRIDE_REASONS)[number];

export const SESSION_RUNTIME_DRIFT_REASONS = ["stale_runtime_provider"] as const;

export type SessionRuntimeDriftReason = (typeof SESSION_RUNTIME_DRIFT_REASONS)[number];

export interface AgentSessionOverrideReport {
  sessionName: string;
  reasons: SessionRuntimeOverrideReason[];
  provider?: string;
  model?: string;
  effort?: RuntimeEffort;
  thinking?: NonNullable<SessionEntry["thinkingLevel"]>;
}

export interface AgentSessionRematerializeReport {
  sessionName: string;
  sessionKey: string;
  reasons: SessionRuntimeDriftReason[];
  previousRuntimeProvider: string | null;
  runtimeProvider: string | null;
  clearedProviderSession: boolean;
}

export interface AgentSessionRuntimeSyncResult {
  sessionOverrides: AgentSessionOverrideReport[];
  rematerializedSessions: AgentSessionRematerializeReport[];
  forcedClearedOverrides: AgentSessionOverrideReport[];
}

export interface SyncAgentSessionsToAgentRuntimeInput {
  agent: Pick<AgentConfig, "id" | "provider" | "model" | "modelPresetId">;
  sessions?: SessionEntry[];
  rematerialize?: boolean;
  force?: boolean;
  clearProviderOverrides?: boolean;
  clearModelOverrides?: boolean;
}

export function sessionRuntimeDisplayName(session: Pick<SessionEntry, "name">): string {
  return session.name?.trim() || "(canonical name unavailable)";
}

export function resolveAgentRuntimeDefaultProvider(
  agent: Pick<AgentConfig, "provider" | "model" | "modelPresetId">,
): RuntimeProviderId {
  return resolveRequestedRuntimeProvider({ agent }).value;
}

export function hasExplicitSessionProviderOverride(session: Pick<SessionEntry, "runtimeProviderOverride">): boolean {
  return Boolean(session.runtimeProviderOverride?.trim());
}

export function hasExplicitSessionModelOverride(session: Pick<SessionEntry, "modelOverride">): boolean {
  return Boolean(session.modelOverride?.trim());
}

export function sessionHasStaleRuntimeProvider(
  session: Pick<SessionEntry, "runtimeProvider" | "runtimeProviderOverride">,
  agentProvider: string,
): boolean {
  if (hasExplicitSessionProviderOverride(session)) {
    return false;
  }
  const lastUsed = session.runtimeProvider?.trim();
  return Boolean(lastUsed && lastUsed !== agentProvider);
}

export function inspectAgentSessionOverrides(session: SessionEntry): AgentSessionOverrideReport | null {
  const reasons: SessionRuntimeOverrideReason[] = [];
  const report: AgentSessionOverrideReport = {
    sessionName: sessionRuntimeDisplayName(session),
    reasons,
  };

  if (hasExplicitSessionProviderOverride(session)) {
    reasons.push("provider_override");
    report.provider = session.runtimeProviderOverride;
  }
  if (hasExplicitSessionModelOverride(session)) {
    reasons.push("model_override");
    report.model = session.modelOverride;
  }
  if (session.effortOverride !== null && session.effortOverride !== undefined) {
    reasons.push("effort_override");
    report.effort = session.effortOverride;
  }
  if (session.thinkingLevel !== null && session.thinkingLevel !== undefined) {
    reasons.push("thinking_override");
    report.thinking = session.thinkingLevel;
  }

  return reasons.length > 0 ? report : null;
}

function sortBySessionName<T extends { sessionName: string }>(items: T[]): T[] {
  return [...items].sort((left, right) => left.sessionName.localeCompare(right.sessionName));
}

function sessionHasStoredProviderId(session: Pick<SessionEntry, "providerSessionId" | "sdkSessionId">): boolean {
  return Boolean(session.providerSessionId?.trim() || session.sdkSessionId?.trim());
}

function rematerializeSessionRuntimeProvider(
  session: SessionEntry,
  agentProvider: RuntimeProviderId,
): AgentSessionRematerializeReport {
  const previousRuntimeProvider = session.runtimeProvider?.trim() || null;
  const shouldClearStoredSession =
    sessionHasStoredProviderId(session) &&
    Boolean(previousRuntimeProvider && previousRuntimeProvider !== agentProvider);

  if (shouldClearStoredSession) {
    clearProviderSession(session.sessionKey);
  }
  updateRuntimeProviderState(session.sessionKey, agentProvider);

  const report: AgentSessionRematerializeReport = {
    sessionName: sessionRuntimeDisplayName(session),
    sessionKey: session.sessionKey,
    reasons: ["stale_runtime_provider"],
    previousRuntimeProvider,
    runtimeProvider: agentProvider,
    clearedProviderSession: shouldClearStoredSession,
  };
  return report;
}

/**
 * Align an agent's sessions with the agent's current runtime defaults.
 *
 * No-override sessions whose last-used provider drifted are rematerialized.
 * Explicit provider/model overrides stay unless `--force` (or the matching
 * clear* flag) removes them first.
 */
export function syncAgentSessionsToAgentRuntime(
  input: SyncAgentSessionsToAgentRuntimeInput,
): AgentSessionRuntimeSyncResult {
  const agentProvider = resolveAgentRuntimeDefaultProvider(input.agent);
  const sessions = input.sessions ?? getSessionsByAgent(input.agent.id);
  const rematerialize = input.rematerialize === true;
  const clearProviderOverrides = input.force === true || input.clearProviderOverrides === true;
  const clearModelOverrides = input.force === true || input.clearModelOverrides === true;

  const rematerializedSessions: AgentSessionRematerializeReport[] = [];
  const forcedClearedOverrides: AgentSessionOverrideReport[] = [];
  const nextSessions: SessionEntry[] = [];

  for (const session of sessions) {
    const beforeClear = inspectAgentSessionOverrides(session);
    let current = session;
    let clearedProvider = false;
    let clearedModel = false;

    if (clearProviderOverrides && hasExplicitSessionProviderOverride(current)) {
      updateSessionRuntimeProviderOverride(current.sessionKey, null);
      current = { ...current, runtimeProviderOverride: undefined };
      clearedProvider = true;
    }
    if (clearModelOverrides && hasExplicitSessionModelOverride(current)) {
      updateSessionModelOverride(current.sessionKey, null);
      current = { ...current, modelOverride: undefined };
      clearedModel = true;
    }

    if ((clearedProvider || clearedModel) && beforeClear) {
      const clearedReasons = beforeClear.reasons.filter((reason) => {
        if (reason === "provider_override") return clearedProvider;
        if (reason === "model_override") return clearedModel;
        return false;
      });
      if (clearedReasons.length > 0) {
        forcedClearedOverrides.push({
          sessionName: beforeClear.sessionName,
          reasons: clearedReasons,
          ...(clearedProvider && beforeClear.provider ? { provider: beforeClear.provider } : {}),
          ...(clearedModel && beforeClear.model ? { model: beforeClear.model } : {}),
        });
      }
    }

    if (rematerialize && sessionHasStaleRuntimeProvider(current, agentProvider)) {
      rematerializedSessions.push(rematerializeSessionRuntimeProvider(current, agentProvider));
      const previousRuntimeProvider = current.runtimeProvider;
      current = {
        ...current,
        runtimeProvider: agentProvider,
        ...(sessionHasStoredProviderId(current) && previousRuntimeProvider && previousRuntimeProvider !== agentProvider
          ? { providerSessionId: undefined, sdkSessionId: undefined }
          : {}),
      };
    }

    nextSessions.push(current);
  }

  const sessionOverrides = sortBySessionName(
    nextSessions.flatMap((session) => {
      const report = inspectAgentSessionOverrides(session);
      return report ? [report] : [];
    }),
  );

  return {
    sessionOverrides,
    rematerializedSessions: sortBySessionName(rematerializedSessions),
    forcedClearedOverrides: sortBySessionName(forcedClearedOverrides),
  };
}

export function rematerializeSessionToAgentRuntime(
  session: SessionEntry,
  agent: Pick<AgentConfig, "id" | "provider" | "model" | "modelPresetId">,
): AgentSessionRematerializeReport | null {
  const agentProvider = resolveAgentRuntimeDefaultProvider(agent);
  if (!sessionHasStaleRuntimeProvider(session, agentProvider)) {
    return null;
  }
  return rematerializeSessionRuntimeProvider(session, agentProvider);
}

export function describeSessionAgentDefaultDiff(input: {
  agentId: string;
  sessionName: string;
  axis: "provider" | "model";
  sessionValue: string | null;
  agent: Pick<AgentConfig, "provider" | "model" | "modelPresetId"> | null | undefined;
}): {
  agentDefaultDiffers: boolean;
  agentDefaultProvider: string | null;
  agentDefaultModel: string | null;
  hint: string | null;
  propagateCommand: string | null;
} {
  const agent = input.agent;
  const agentDefaultProvider = agent ? resolveAgentRuntimeDefaultProvider(agent) : null;
  const agentDefaultModel = agent?.model?.trim() || null;
  const sessionValue = input.sessionValue?.trim() || null;

  if (!sessionValue || !agent) {
    return {
      agentDefaultDiffers: false,
      agentDefaultProvider,
      agentDefaultModel,
      hint: null,
      propagateCommand: null,
    };
  }

  const agentValue = input.axis === "provider" ? agentDefaultProvider : agentDefaultModel;
  const agentDefaultDiffers = Boolean(agentValue && agentValue !== sessionValue);
  if (!agentDefaultDiffers) {
    return {
      agentDefaultDiffers: false,
      agentDefaultProvider,
      agentDefaultModel,
      hint: null,
      propagateCommand: null,
    };
  }

  const propagateCommand =
    input.axis === "provider"
      ? `ravi sessions set-provider ${input.sessionName} ${sessionValue} --propagate`
      : `ravi sessions set-model ${input.sessionName} ${sessionValue} --propagate`;
  const hint =
    input.axis === "provider"
      ? `Agent '${input.agentId}' default provider is ${agentDefaultProvider}. Re-run with --propagate to update the agent and rematerialize sibling sessions without overrides.`
      : `Agent '${input.agentId}' default model is ${agentDefaultModel}. Re-run with --propagate to update the agent and rematerialize sibling sessions without overrides.`;

  return {
    agentDefaultDiffers: true,
    agentDefaultProvider,
    agentDefaultModel,
    hint,
    propagateCommand,
  };
}
