import { getLatestMessageId } from "../db.js";
import { markCurationMessageProcessed } from "../memory/curation-state.js";
import { dispatchMemoryCuratorForCadence } from "../memory/curation-runtime.js";
import { getSession, updateRuntimeProviderState } from "../router/index.js";
import { countSessionTerminalTurns } from "../session-trace/session-trace-db.js";
import { markSkillMessageProcessed } from "../skills/skill-curation-state.js";
import { dispatchSkillCuratorForCadence } from "../skills/skill-curation-runtime.js";
import { logger } from "../utils/logger.js";
import { isLearningLoopSessionExcluded } from "./learning-loop-sessions.js";

const log = logger.child("learning-loop:cadence");
const STATE_KEY = "learningLoopCadence";
const DEFAULT_INTERVAL = 10;
const MAX_SANE_TURN_COUNT = 100_000_000;

export interface LearningLoopCadenceState {
  terminalTurnCount: number;
  memoryLastDispatchTurn: number;
  skillLastDispatchTurn: number;
}

export interface LearningLoopCadenceDecision {
  next: LearningLoopCadenceState;
  memoryDue: boolean;
  skillDue: boolean;
}

export interface LearningLoopTerminalTurnInput {
  sessionKey: string;
  sessionName: string;
  agentId: string;
  agentCwd?: string;
  skillsInPlay?: string[];
}

export function readLearningLoopCadenceState(
  params: Record<string, unknown> | undefined,
): LearningLoopCadenceState | undefined {
  const raw = params?.[STATE_KEY];
  if (!isRecord(raw)) return undefined;
  return {
    terminalTurnCount: toSaneCount(raw.terminalTurnCount),
    memoryLastDispatchTurn: toSaneCount(raw.memoryLastDispatchTurn),
    skillLastDispatchTurn: toSaneCount(raw.skillLastDispatchTurn),
  };
}

export function writeLearningLoopCadenceState(
  params: Record<string, unknown> | undefined,
  state: LearningLoopCadenceState,
): Record<string, unknown> {
  return { ...(params ?? {}), [STATE_KEY]: { ...state } };
}

export function preserveLearningLoopCadenceState(
  existingParams: Record<string, unknown> | undefined | null,
  incoming: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const cadence = existingParams?.[STATE_KEY];
  return cadence === undefined || cadence === null ? incoming : { ...(incoming ?? {}), [STATE_KEY]: cadence };
}

/** Pure transition: reconstruct from the ledger, then advance the in-flight terminal exactly once. */
export function advanceLearningLoopCadenceState(input: {
  current?: LearningLoopCadenceState;
  terminalTurnsBeforeCurrent: number;
  memoryInterval: number;
  skillInterval: number;
}): LearningLoopCadenceDecision {
  const current = input.current ?? {
    terminalTurnCount: 0,
    memoryLastDispatchTurn: 0,
    skillLastDispatchTurn: 0,
  };
  const reconstructed = Math.max(0, Math.floor(input.terminalTurnsBeforeCurrent)) + 1;
  const terminalTurnCount = Math.max(current.terminalTurnCount + 1, reconstructed);
  const memoryInterval = normalizeInterval(input.memoryInterval);
  const skillInterval = normalizeInterval(input.skillInterval);
  const memoryDue = terminalTurnCount % memoryInterval === 0 && terminalTurnCount > current.memoryLastDispatchTurn;
  const skillDue = terminalTurnCount % skillInterval === 0 && terminalTurnCount > current.skillLastDispatchTurn;

  return {
    next: {
      terminalTurnCount,
      memoryLastDispatchTurn: memoryDue ? terminalTurnCount : current.memoryLastDispatchTurn,
      skillLastDispatchTurn: skillDue ? terminalTurnCount : current.skillLastDispatchTurn,
    },
    memoryDue,
    skillDue,
  };
}

/**
 * Persist one terminal and asynchronously dispatch due curators. This function
 * is best-effort by contract: curation must never break the primary turn.
 */
export function noteTerminalTurnForLearningLoop(
  input: LearningLoopTerminalTurnInput,
): LearningLoopCadenceDecision | undefined {
  try {
    if (!input.agentId || isLearningLoopSessionExcluded(input.sessionName)) return undefined;
    const session = getSession(input.sessionKey);
    if (!session) return undefined;

    const existingParams = session.runtimeSessionParams as Record<string, unknown> | undefined;
    const current = readLearningLoopCadenceState(existingParams);
    const decision = advanceLearningLoopCadenceState({
      current,
      terminalTurnsBeforeCurrent: countSessionTerminalTurns(input.sessionKey),
      memoryInterval: resolveInterval("RAVI_MEMORY_NUDGE_INTERVAL"),
      skillInterval: resolveInterval("RAVI_SKILL_NUDGE_INTERVAL"),
    });

    let nextParams = existingParams;
    if (!isRecord(existingParams?.memoryCuration)) {
      nextParams = markCurationMessageProcessed(
        { runtimeSessionParams: nextParams },
        resolveInterval("RAVI_MEMORY_NUDGE_INTERVAL"),
        getLatestMessageId(input.sessionName),
      );
    }
    if (!isRecord(existingParams?.skillCuration)) {
      nextParams = markSkillMessageProcessed(
        { runtimeSessionParams: nextParams },
        getLatestMessageId(input.sessionName),
      );
    }
    nextParams = writeLearningLoopCadenceState(nextParams, decision.next);
    updateRuntimeProviderState(input.sessionKey, session.runtimeProvider, {
      runtimeSessionParams: nextParams,
      ...(session.providerSessionId ? { providerSessionId: session.providerSessionId } : {}),
      ...(session.runtimeSessionDisplayId ? { runtimeSessionDisplayId: session.runtimeSessionDisplayId } : {}),
    });

    log.info("learning loop terminal tick", {
      sessionName: input.sessionName,
      agentId: input.agentId,
      terminalTurnCount: decision.next.terminalTurnCount,
      memoryDue: decision.memoryDue,
      skillDue: decision.skillDue,
    });

    if (decision.memoryDue) {
      void dispatchMemoryCuratorForCadence(input, decision.next.terminalTurnCount).catch((error) => {
        log.warn("memory curator dispatch failed (best-effort)", { agentId: input.agentId, error });
      });
    }
    if (decision.skillDue) {
      void dispatchSkillCuratorForCadence(input, decision.next.terminalTurnCount).catch((error) => {
        log.warn("skill curator dispatch failed (best-effort)", { agentId: input.agentId, error });
      });
    }
    return decision;
  } catch (error) {
    log.warn("learning loop terminal tick failed (best-effort)", {
      sessionName: input.sessionName,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

function resolveInterval(name: "RAVI_MEMORY_NUDGE_INTERVAL" | "RAVI_SKILL_NUDGE_INTERVAL"): number {
  const raw = process.env[name];
  return normalizeInterval(raw ? Number.parseInt(raw, 10) : DEFAULT_INTERVAL);
}

function normalizeInterval(value: number): number {
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : DEFAULT_INTERVAL;
}

function toSaneCount(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : 0;
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_SANE_TURN_COUNT) return 0;
  return Math.floor(parsed);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
