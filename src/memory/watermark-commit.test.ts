import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteSession, getOrCreateSession, getSession } from "../router/sessions.js";
import { advanceWatermarkForCompletedCuratorTask, commitCurationWatermark } from "./watermark-commit.js";

/**
 * P1 collapse-regression guard (spec: memory/deterministic-loop).
 *
 * The watermark must advance when the `curador-memoria` task COMPLETES (done),
 * driven by the runtime — NOT only when the curator's LLM report says it wrote
 * something. The failure mode this locks down: a cycle that reads a non-empty
 * delta and judges nothing worth saving (`proposto=0`, so no guard write, so no
 * `--processed-through-message-id` flag) must STILL advance, otherwise the delta
 * re-grows every session until something is finally saved (slow collapse).
 */
describe("watermark-commit — P1 runtime-owned watermark advance", () => {
  const tmpDirs: string[] = [];
  const sessionKeys: string[] = [];

  afterEach(() => {
    while (sessionKeys.length > 0) {
      const key = sessionKeys.pop();
      if (key) deleteSession(key);
    }
    while (tmpDirs.length > 0) {
      const dir = tmpDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  function ephemeralSession(initialWatermark = 0): string {
    const sessionKey = `wm-commit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    sessionKeys.push(sessionKey);
    const agentCwd = mkdtempSync(join(tmpdir(), "ravi-wm-commit-"));
    tmpDirs.push(agentCwd);
    getOrCreateSession(sessionKey, "ravi-dev", agentCwd, {
      runtimeSessionParams: {
        memoryCuration: {
          turnCount: 10,
          lastCuratedTurn: 10,
          cadenceTurns: 10,
          lastCuratedMessageId: initialWatermark,
        },
      },
    });
    return sessionKey;
  }

  function watermarkOf(sessionKey: string): number {
    const session = getSession(sessionKey);
    const memoryCuration = (session?.runtimeSessionParams?.memoryCuration ?? {}) as {
      lastCuratedMessageId?: number;
    };
    return memoryCuration.lastCuratedMessageId ?? 0;
  }

  it("COLLAPSE GUARD: a curador-memoria `done` task advances the watermark even when nothing was written (proposto=0)", () => {
    const sessionKey = ephemeralSession(0);
    // proposto=0: the curator read the delta up to id 137 but wrote nothing.
    // No `--processed-through-message-id` flag would ever fire here — only the
    // runtime completion path advances it.
    const advanced = advanceWatermarkForCompletedCuratorTask({
      profileId: "curador-memoria",
      profileInput: {
        originator_session: sessionKey,
        highest_message_id: "137",
        cadence_turn: "10",
      },
    });
    expect(advanced).toBe(true);
    expect(watermarkOf(sessionKey)).toBe(137);
  });

  it("is monotonic — never regresses when highest_message_id is below the current watermark", () => {
    const sessionKey = ephemeralSession(200);
    const advanced = advanceWatermarkForCompletedCuratorTask({
      profileId: "curador-memoria",
      profileInput: {
        originator_session: sessionKey,
        highest_message_id: "50",
        cadence_turn: "10",
      },
    });
    expect(advanced).toBe(true);
    expect(watermarkOf(sessionKey)).toBe(200);
  });

  it("no-ops for a non-curator profile (never touches unrelated task completions)", () => {
    const sessionKey = ephemeralSession(10);
    const advanced = advanceWatermarkForCompletedCuratorTask({
      profileId: "default",
      profileInput: {
        originator_session: sessionKey,
        highest_message_id: "999",
        cadence_turn: "10",
      },
    });
    expect(advanced).toBe(false);
    expect(watermarkOf(sessionKey)).toBe(10);
  });

  it("no-ops when highest_message_id is missing from profileInput", () => {
    const sessionKey = ephemeralSession(10);
    const advanced = advanceWatermarkForCompletedCuratorTask({
      profileId: "curador-memoria",
      profileInput: {
        originator_session: sessionKey,
        cadence_turn: "10",
      },
    });
    expect(advanced).toBe(false);
    expect(watermarkOf(sessionKey)).toBe(10);
  });

  it("no-ops when originator_session is missing from profileInput", () => {
    const advanced = advanceWatermarkForCompletedCuratorTask({
      profileId: "curador-memoria",
      profileInput: {
        highest_message_id: "137",
        cadence_turn: "10",
      },
    });
    expect(advanced).toBe(false);
  });

  it("no-ops when profileInput is entirely absent", () => {
    const advanced = advanceWatermarkForCompletedCuratorTask({
      profileId: "curador-memoria",
      profileInput: undefined,
    });
    expect(advanced).toBe(false);
  });

  it("defaults cadence to 1 when cadence_turn is unparseable, still advancing the watermark", () => {
    const sessionKey = ephemeralSession(0);
    const advanced = advanceWatermarkForCompletedCuratorTask({
      profileId: "curador-memoria",
      profileInput: {
        originator_session: sessionKey,
        highest_message_id: "42",
        cadence_turn: "not-a-number",
      },
    });
    expect(advanced).toBe(true);
    expect(watermarkOf(sessionKey)).toBe(42);
  });
});

describe("commitCurationWatermark — direct guard fallback path", () => {
  const tmpDirs: string[] = [];
  const sessionKeys: string[] = [];

  afterEach(() => {
    while (sessionKeys.length > 0) {
      const key = sessionKeys.pop();
      if (key) deleteSession(key);
    }
    while (tmpDirs.length > 0) {
      const dir = tmpDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  function ephemeralSession(initialWatermark = 0): string {
    const sessionKey = `wm-direct-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    sessionKeys.push(sessionKey);
    const agentCwd = mkdtempSync(join(tmpdir(), "ravi-wm-direct-"));
    tmpDirs.push(agentCwd);
    getOrCreateSession(sessionKey, "ravi-dev", agentCwd, {
      runtimeSessionParams: {
        memoryCuration: {
          turnCount: 10,
          lastCuratedTurn: 10,
          cadenceTurns: 10,
          lastCuratedMessageId: initialWatermark,
        },
      },
    });
    return sessionKey;
  }

  function watermarkOf(sessionKey: string): number {
    const session = getSession(sessionKey);
    const memoryCuration = (session?.runtimeSessionParams?.memoryCuration ?? {}) as {
      lastCuratedMessageId?: number;
    };
    return memoryCuration.lastCuratedMessageId ?? 0;
  }

  it("advances the watermark for an existing session", () => {
    const sessionKey = ephemeralSession(0);
    expect(commitCurationWatermark(sessionKey, 10, 88)).toBe(true);
    expect(watermarkOf(sessionKey)).toBe(88);
  });

  it("returns false for an empty session key", () => {
    expect(commitCurationWatermark("   ", 10, 88)).toBe(false);
    expect(commitCurationWatermark(undefined, 10, 88)).toBe(false);
  });

  it("returns false for a session that does not exist", () => {
    expect(commitCurationWatermark("nonexistent-session-xyz", 10, 88)).toBe(false);
  });

  it("returns false for a negative or non-finite message id", () => {
    const sessionKey = ephemeralSession(10);
    expect(commitCurationWatermark(sessionKey, 10, -1)).toBe(false);
    expect(commitCurationWatermark(sessionKey, 10, Number.NaN)).toBe(false);
    expect(watermarkOf(sessionKey)).toBe(10);
  });
});
