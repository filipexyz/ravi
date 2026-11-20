import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  clearTriggersRefreshPending,
  markTriggersRefreshPending,
  readTriggersRefreshPending,
  triggersRefreshPending,
} from "./refresh-intent.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-triggers-refresh-intent-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
});

describe("triggers refresh intent", () => {
  it("reports nothing pending until an intent is saved", () => {
    expect(readTriggersRefreshPending()).toBeNull();
    expect(triggersRefreshPending()).toBe(false);
  });

  it("gives every intent its own token, even within the same millisecond", () => {
    const first = markTriggersRefreshPending(1000);
    const second = markTriggersRefreshPending(1000);
    expect(second).not.toBe(first);
    // The newest intent is the one that is stored.
    expect(readTriggersRefreshPending()).toBe(second);
  });

  it("clears the intent it covered and nothing else", () => {
    const covered = markTriggersRefreshPending(1000);
    expect(clearTriggersRefreshPending(covered)).toBe(true);
    expect(triggersRefreshPending()).toBe(false);
    // Clearing again, or clearing something that was never stored, changes nothing.
    expect(clearTriggersRefreshPending(covered)).toBe(false);
  });

  it("leaves a newer intent alone when an older one is cleared", () => {
    const older = markTriggersRefreshPending(1000);
    const newer = markTriggersRefreshPending(1000);

    // The publisher read `older` before publishing; `newer` was saved while that publish was in flight.
    expect(clearTriggersRefreshPending(older)).toBe(false);
    expect(readTriggersRefreshPending()).toBe(newer);
    expect(clearTriggersRefreshPending(newer)).toBe(true);
    expect(triggersRefreshPending()).toBe(false);
  });
});
