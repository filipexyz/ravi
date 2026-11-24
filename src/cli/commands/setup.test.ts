import { describe, expect, it, spyOn } from "bun:test";
import { StateNotPreparedError } from "../../db/state-boundary.js";
import { runSetup, runStateStep, waitForStateReady } from "./setup.js";

function quiet() {
  return spyOn(console, "log").mockImplementation(() => {});
}

describe("ravi setup on a new install", () => {
  it("starts the daemon before any step that needs state", async () => {
    const log = quiet();
    const order: string[] = [];
    try {
      const complete = await runSetup({
        omni: async () => void order.push("omni"),
        environment: async () => void order.push("environment"),
        daemon: async () => void order.push("daemon"),
        agent: async () => void order.push("agent"),
        settings: async () => void order.push("settings"),
      });
      expect(complete).toBe(true);
    } finally {
      log.mockRestore();
    }
    expect(order).toEqual(["omni", "environment", "daemon", "agent", "settings"]);
  });

  it("reports an incomplete setup instead of aborting when state is not ready", async () => {
    const log = quiet();
    const order: string[] = [];
    let output = "";
    log.mockImplementation((...args: unknown[]) => void (output += `${args.join(" ")}\n`));
    try {
      const complete = await runSetup({
        omni: async () => {},
        environment: async () => {},
        daemon: async () => {},
        agent: async () => {
          order.push("agent");
          throw new StateNotPreparedError("STATE_SCHEMA_NOT_READY: ravi.db does not exist");
        },
        settings: async () => void order.push("settings"),
      });
      expect(complete).toBe(false);
    } finally {
      log.mockRestore();
    }
    expect(order).toEqual(["agent"]);
    expect(output).toContain("ravi daemon start");
    expect(output).not.toContain("Configuração completa!");
  });

  it("rethrows errors other than state not ready", async () => {
    const log = quiet();
    try {
      await expect(
        runStateStep(async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
    } finally {
      log.mockRestore();
    }
  });
});

describe("waitForStateReady", () => {
  it("polls until state is ready", async () => {
    let clock = 0;
    let calls = 0;
    const ready = await waitForStateReady({
      isReady: () => ++calls >= 3,
      timeoutMs: 10_000,
      pollMs: 500,
      now: () => clock,
      sleep: async (ms) => void (clock += ms),
    });
    expect(ready).toBe(true);
    expect(calls).toBe(3);
  });

  it("gives up at the deadline", async () => {
    let clock = 0;
    const ready = await waitForStateReady({
      isReady: () => false,
      timeoutMs: 2_000,
      pollMs: 500,
      now: () => clock,
      sleep: async (ms) => void (clock += ms),
    });
    expect(ready).toBe(false);
    expect(clock).toBe(2_000);
  });
});
