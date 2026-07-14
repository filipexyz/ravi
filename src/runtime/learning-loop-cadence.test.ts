import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { saveMessage } from "../db.js";
import { getOrCreateSession, getSession } from "../router/sessions.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  advanceLearningLoopCadenceState,
  noteTerminalTurnForLearningLoop,
  preserveLearningLoopCadenceState,
  readLearningLoopCadenceState,
} from "./learning-loop-cadence.js";
import { isLearningLoopSessionExcluded } from "./learning-loop-sessions.js";

describe("durable learning-loop cadence", () => {
  let stateDir: string | null = null;
  const previousMemoryInterval = process.env.RAVI_MEMORY_NUDGE_INTERVAL;
  const previousSkillInterval = process.env.RAVI_SKILL_NUDGE_INTERVAL;

  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-learning-loop-");
    process.env.RAVI_MEMORY_NUDGE_INTERVAL = "1000";
    process.env.RAVI_SKILL_NUDGE_INTERVAL = "1000";
  });

  afterEach(async () => {
    if (previousMemoryInterval === undefined) delete process.env.RAVI_MEMORY_NUDGE_INTERVAL;
    else process.env.RAVI_MEMORY_NUDGE_INTERVAL = previousMemoryInterval;
    if (previousSkillInterval === undefined) delete process.env.RAVI_SKILL_NUDGE_INTERVAL;
    else process.env.RAVI_SKILL_NUDGE_INTERVAL = previousSkillInterval;
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("fires both loops exactly at the 10th terminal and preserves restart phase", () => {
    const ninth = {
      terminalTurnCount: 9,
      memoryLastDispatchTurn: 0,
      skillLastDispatchTurn: 0,
    };
    const decision = advanceLearningLoopCadenceState({
      current: ninth,
      terminalTurnsBeforeCurrent: 9,
      memoryInterval: 10,
      skillInterval: 10,
    });
    expect(decision).toEqual({
      next: {
        terminalTurnCount: 10,
        memoryLastDispatchTurn: 10,
        skillLastDispatchTurn: 10,
      },
      memoryDue: true,
      skillDue: true,
    });

    const afterRestart = advanceLearningLoopCadenceState({
      current: decision.next,
      terminalTurnsBeforeCurrent: 10,
      memoryInterval: 10,
      skillInterval: 10,
    });
    expect(afterRestart.next.terminalTurnCount).toBe(11);
    expect(afterRestart.memoryDue).toBe(false);
    expect(afterRestart.skillDue).toBe(false);
  });

  it("reconstructs a missing phase from the durable terminal ledger without replaying intervals", () => {
    const first = advanceLearningLoopCadenceState({
      terminalTurnsBeforeCurrent: 27,
      memoryInterval: 10,
      skillInterval: 10,
    });
    expect(first.next.terminalTurnCount).toBe(28);
    expect(first.memoryDue).toBe(false);
    expect(first.skillDue).toBe(false);

    const second = advanceLearningLoopCadenceState({
      current: { ...first.next, terminalTurnCount: 29 },
      terminalTurnsBeforeCurrent: 29,
      memoryInterval: 10,
      skillInterval: 10,
    });
    expect(second.next.terminalTurnCount).toBe(30);
    expect(second.memoryDue).toBe(true);
    expect(second.skillDue).toBe(true);
  });

  it("cold-start seeds both watermarks at the current cursor instead of replaying history", () => {
    const sessionKey = "test:learning-loop:bootstrap";
    const sessionName = "learning-loop-bootstrap";
    getOrCreateSession(sessionKey, "ravi-dev", "/tmp/ravi-dev");
    saveMessage(sessionName, "user", "historic user message");
    saveMessage(sessionName, "assistant", "historic assistant message");

    const decision = noteTerminalTurnForLearningLoop({
      sessionKey,
      sessionName,
      agentId: "ravi-dev",
      agentCwd: "/tmp/ravi-dev",
    });
    expect(decision?.next.terminalTurnCount).toBe(1);

    const params = getSession(sessionKey)?.runtimeSessionParams as Record<string, any>;
    expect(params.memoryCuration.lastCuratedMessageId).toBe(2);
    expect(params.skillCuration.lastCuratedMessageId).toBe(2);
    expect(readLearningLoopCadenceState(params)?.terminalTurnCount).toBe(1);
  });

  it("preserves cadence alongside provider params and excludes curator/report sessions", () => {
    const cadence = {
      terminalTurnCount: 19,
      memoryLastDispatchTurn: 10,
      skillLastDispatchTurn: 10,
    };
    expect(preserveLearningLoopCadenceState({ learningLoopCadence: cadence }, { sessionId: "provider-1" })).toEqual({
      sessionId: "provider-1",
      learningLoopCadence: cadence,
    });
    expect(isLearningLoopSessionExcluded("task-123-curator")).toBe(true);
    expect(isLearningLoopSessionExcluded("memory-log")).toBe(true);
    expect(isLearningLoopSessionExcluded("skill-log")).toBe(true);
    expect(isLearningLoopSessionExcluded("main-dm-615153")).toBe(false);
  });
});
