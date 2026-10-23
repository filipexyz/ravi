import { describe, expect, it } from "bun:test";
import { parseDurationMs } from "../../cron/schedule.js";
import {
  DEBOUNCE_MAX_EVENTS,
  DEBOUNCE_MAX_WAIT_FACTOR,
  type DebounceClock,
  parseOptionalDurationMs,
  type TriggerBatch,
  TriggerDebouncer,
} from "../debounce.js";

/** Manual clock: timers run only when the test advances time. */
function fakeClock(): DebounceClock & { advance(ms: number): void } {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = ++nextId;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
    advance(ms) {
      const until = now + ms;
      while (true) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = until;
    },
  };
}

const event = (n: number) => ({ topic: "ravi.voice.message", data: { n } });

describe("TriggerDebouncer", () => {
  it("fires a burst once, after the quiet window, with every event", () => {
    const clock = fakeClock();
    const fired: TriggerBatch[] = [];
    const debouncer = new TriggerDebouncer((batch) => fired.push(batch), clock);

    debouncer.add("t1", "t1", 1000, event(1));
    clock.advance(400);
    debouncer.add("t1", "t1", 1000, event(2));
    clock.advance(400);
    debouncer.add("t1", "t1", 1000, event(3));
    clock.advance(999);
    expect(fired).toHaveLength(0);

    clock.advance(1);
    expect(fired).toHaveLength(1);
    expect(fired[0].events.map((e) => (e.data as { n: number }).n)).toEqual([1, 2, 3]);
    expect(fired[0].omitted).toBe(0);
    expect(debouncer.pendingKeys).toBe(0);
  });

  it("keeps separate bursts per key", () => {
    const clock = fakeClock();
    const fired: TriggerBatch[] = [];
    const debouncer = new TriggerDebouncer((batch) => fired.push(batch), clock);

    debouncer.add("t1:a", "t1", 500, event(1));
    debouncer.add("t1:b", "t1", 500, event(2));
    clock.advance(500);
    expect(fired.map((b) => b.key).sort()).toEqual(["t1:a", "t1:b"]);
  });

  it("does not let a constant stream hold the fire forever", () => {
    const clock = fakeClock();
    const fired: TriggerBatch[] = [];
    const debouncer = new TriggerDebouncer((batch) => fired.push(batch), clock);
    const window = 100;

    for (let i = 0; i < DEBOUNCE_MAX_WAIT_FACTOR * 3; i++) {
      debouncer.add("t1", "t1", window, event(i));
      clock.advance(window / 2);
    }
    expect(fired.length).toBeGreaterThanOrEqual(1);
    // Events every window/2 starting at 0; the cap fires at FACTOR × window after the first.
    expect(fired[0].events.length).toBe(DEBOUNCE_MAX_WAIT_FACTOR * 2);
  });

  it("caps a burst and reports what was dropped from the front", () => {
    const clock = fakeClock();
    const fired: TriggerBatch[] = [];
    const debouncer = new TriggerDebouncer((batch) => fired.push(batch), clock);

    for (let i = 0; i < DEBOUNCE_MAX_EVENTS + 5; i++) debouncer.add("t1", "t1", 1000, event(i));
    clock.advance(1000);
    expect(fired[0].events).toHaveLength(DEBOUNCE_MAX_EVENTS);
    expect(fired[0].omitted).toBe(5);
    expect((fired[0].events[0].data as { n: number }).n).toBe(5);
  });

  it("requeues a batch (cooldown) and merges events that arrive meanwhile", () => {
    const clock = fakeClock();
    const fired: TriggerBatch[] = [];
    let held = false;
    const debouncer = new TriggerDebouncer((batch) => {
      if (!held) {
        held = true;
        debouncer.requeue(batch, 3000);
        return;
      }
      fired.push(batch);
    }, clock);

    debouncer.add("t1", "t1", 1000, event(1));
    clock.advance(1000); // due, but "cooling down": requeued for 3s
    debouncer.add("t1", "t1", 1000, event(2));
    clock.advance(1000); // the new event's window wins the merged bucket
    expect(fired).toHaveLength(1);
    expect(fired[0].events.map((e) => (e.data as { n: number }).n)).toEqual([1, 2]);
  });

  it("clear drops pending bursts and reports how many events were waiting", () => {
    const clock = fakeClock();
    const fired: TriggerBatch[] = [];
    const debouncer = new TriggerDebouncer((batch) => fired.push(batch), clock);
    debouncer.add("t1", "t1", 1000, event(1));
    debouncer.add("t2", "t2", 1000, event(2));
    expect(debouncer.clear()).toBe(2);
    clock.advance(5000);
    expect(fired).toHaveLength(0);
  });
});

describe("parseOptionalDurationMs", () => {
  it("treats off/none/0 as disabled and parses positive durations", () => {
    for (const value of ["off", "none", "0", "0s", "OFF"]) {
      expect(parseOptionalDurationMs(value, parseDurationMs)).toBe(0);
    }
    expect(parseOptionalDurationMs("2s", parseDurationMs)).toBe(2000);
    expect(() => parseOptionalDurationMs("soon", parseDurationMs)).toThrow();
  });
});
