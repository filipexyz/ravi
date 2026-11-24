import { describe, expect, it, spyOn } from "bun:test";
import { StateNotPreparedError } from "../../db/state-boundary.js";
import { decideStateReady, runSetup, runStateStep, waitForStateReady } from "./setup.js";

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
        daemon: async () => {
          order.push("daemon");
          return true;
        },
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
        daemon: async () => true,
        agent: async () => {
          order.push("agent");
          throw new StateNotPreparedError("STATE_SCHEMA_NOT_READY: ravi.db does not exist. Run `ravi daemon start`.");
        },
        settings: async () => void order.push("settings"),
      });
      expect(complete).toBe(false);
    } finally {
      log.mockRestore();
    }
    expect(order).toEqual(["agent"]);
    expect(output).toContain("ravi.db does not exist. Run `ravi daemon start`.");
    expect(output).not.toContain("Configuração completa!");
  });

  it("passes on the refusal's own fix, such as a restart after an update", async () => {
    const log = quiet();
    let output = "";
    log.mockImplementation((...args: unknown[]) => void (output += `${args.join(" ")}\n`));
    try {
      const ran = await runStateStep(async () => {
        throw new StateNotPreparedError(
          'STATE_SCHEMA_NOT_READY: router is not prepared for this release. Run `ravi daemon restart -m "prepare state"`.',
        );
      });
      expect(ran).toBe(false);
    } finally {
      log.mockRestore();
    }
    expect(output).toContain('ravi daemon restart -m "prepare state"');
  });

  it("is not complete when the daemon never became ready, even if state steps would succeed", async () => {
    const log = quiet();
    const order: string[] = [];
    try {
      const complete = await runSetup({
        omni: async () => {},
        environment: async () => {},
        daemon: async () => false,
        agent: async () => void order.push("agent"),
        settings: async () => void order.push("settings"),
      });
      expect(complete).toBe(false);
    } finally {
      log.mockRestore();
    }
    expect(order).toEqual([]);
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

describe("decideStateReady", () => {
  const notReady = () => {
    throw new StateNotPreparedError("STATE_SCHEMA_NOT_READY");
  };
  const fine = () => {};

  it("is not ready without an online daemon", () => {
    expect(decideStateReady({ online: false, phase: null, probe: fine })).toBe(false);
  });

  it("follows the daemon's schema phase when it reports one", () => {
    expect(decideStateReady({ online: true, phase: "ready", probe: notReady })).toBe(true);
    expect(decideStateReady({ online: true, phase: "owned", probe: fine })).toBe(false);
    expect(decideStateReady({ online: true, phase: "waiting", probe: fine })).toBe(false);
  });

  it("probes the database when there is no phase receipt", () => {
    expect(decideStateReady({ online: true, phase: null, probe: fine })).toBe(true);
    expect(decideStateReady({ online: true, phase: null, probe: notReady })).toBe(false);
  });

  it("rethrows a probe error that is not state readiness", () => {
    expect(() =>
      decideStateReady({
        online: true,
        phase: null,
        probe: () => {
          throw new Error("disk");
        },
      }),
    ).toThrow("disk");
  });
});
