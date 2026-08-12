import { describe, expect, test } from "bun:test";
import { watchForLeadershipVacancy } from "./index.js";

describe("leadership vacancy watcher", () => {
  test("cancel stops polling before it can touch NATS or invoke takeover", async () => {
    let takeoverCalls = 0;
    const watcher = watchForLeadershipVacancy("cancelled-test-role", async () => {
      takeoverCalls += 1;
    });

    watcher.cancel();
    await watcher.done;

    expect(watcher.signal.aborted).toBe(true);
    expect(takeoverCalls).toBe(0);
  });

  test("an external abort signal stops polling", async () => {
    const controller = new AbortController();
    const watcher = watchForLeadershipVacancy("externally-cancelled-test-role", async () => undefined, {
      signal: controller.signal,
    });

    controller.abort();
    await watcher.done;

    expect(watcher.signal.aborted).toBe(true);
  });
});
