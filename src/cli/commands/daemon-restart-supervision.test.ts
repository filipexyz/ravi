import { describe, expect, it } from "bun:test";
import {
  performSupervisedDaemonRestart,
  shouldHandoffDaemonRestart,
  type ManagedDaemonProcess,
} from "../daemon-restart-supervision.js";

function clock() {
  let time = 0;
  return {
    now: () => time,
    wait: async (ms: number) => {
      time += ms;
    },
  };
}

function harness(input: {
  processes: ManagedDaemonProcess[];
  startStatus?: number;
  saveStatus?: number;
  deleteStatus?: number;
  dropSuccessorOnDelete?: boolean;
  killSuccessorAfterHits?: number;
  pidAlive?: (pid: number) => boolean;
  mustBeDetached?: boolean;
  insideTree?: boolean;
  schemaPhase?: (
    process: ManagedDaemonProcess,
    processes: ManagedDaemonProcess[],
    calls: string[],
  ) => "waiting" | "owned" | "ready" | null;
  onWait?: (processes: ManagedDaemonProcess[], calls: string[]) => void;
}) {
  const calls: string[] = [];
  const processes = input.processes.map((process) => ({ ...process }));
  let hitsOnSuccessor = 0;
  const time = clock();
  return {
    calls,
    processes,
    run: () =>
      performSupervisedDaemonRestart({
        list: () => processes.map((process) => ({ ...process })),
        start: ({ force }) => {
          calls.push(`start force=${force}`);
          if ((input.startStatus ?? 0) !== 0) return input.startStatus ?? 1;
          if (force && !processes.some((process) => process.pmId === 5)) {
            processes.push({ name: "ravi", pmId: 5, pid: 200, status: "online" });
          }
          if (!force && processes.length === 0) {
            processes.push({ name: "ravi", pmId: 6, pid: 300, status: "online" });
          }
          return 0;
        },
        deletePmId: (pmId) => {
          calls.push(`delete ${pmId}`);
          if ((input.deleteStatus ?? 0) !== 0) return input.deleteStatus ?? 1;
          const removeIds = input.dropSuccessorOnDelete ? processes.map((process) => process.pmId) : [pmId];
          for (const id of removeIds) {
            const index = processes.findIndex((process) => process.pmId === id);
            if (index >= 0) processes.splice(index, 1);
          }
          return 0;
        },
        save: () => {
          calls.push("save");
          return input.saveStatus ?? 0;
        },
        pidAlive:
          input.pidAlive ??
          ((pid) => {
            if (pid === 200) {
              hitsOnSuccessor += 1;
              if (input.killSuccessorAfterHits !== undefined && hitsOnSuccessor > input.killSuccessorAfterHits) {
                return false;
              }
            }
            return pid > 0;
          }),
        schemaPhase: (process) =>
          input.schemaPhase?.(process, processes, calls) ?? (input.schemaPhase ? null : "ready"),
        now: time.now,
        wait: async (ms) => {
          await time.wait(ms);
          input.onWait?.(processes, calls);
        },
        readyTimeoutMs: 1_000,
        detachTimeoutMs: 400,
        pollMs: 200,
        confirmations: 2,
        mustBeDetached: input.mustBeDetached,
        isInsidePredecessorTree: () => input.insideTree === true,
      }),
  };
}

const predecessor: ManagedDaemonProcess = { name: "ravi", pmId: 4, pid: 100, status: "online" };

describe("shouldHandoffDaemonRestart", () => {
  it("reparents a marked handoff before it can cut over inside the predecessor tree", () => {
    expect(
      shouldHandoffDaemonRestart({
        handoffEnv: "1",
        runtimeInvocation: true,
        insideDaemonTree: true,
      }),
    ).toBe("reparent");
  });

  it("cuts over once the worker is marked, even when runtime session env is still present", () => {
    expect(
      shouldHandoffDaemonRestart({
        handoffEnv: "1",
        workerEnv: "1",
        runtimeInvocation: true,
        insideDaemonTree: false,
      }),
    ).toBe("cutover");
  });

  it("hands off a runtime caller that has not been detached yet", () => {
    expect(
      shouldHandoffDaemonRestart({
        runtimeInvocation: true,
        insideDaemonTree: false,
      }),
    ).toBe("handoff");
  });

  it("cuts over a direct operator restart", () => {
    expect(
      shouldHandoffDaemonRestart({
        runtimeInvocation: false,
        insideDaemonTree: false,
      }),
    ).toBe("cutover");
  });
});

describe("performSupervisedDaemonRestart", () => {
  it("does not stop the predecessor when no successor stays supervised", async () => {
    const test = harness({ processes: [predecessor] });
    const time = clock();
    test.run = () =>
      performSupervisedDaemonRestart({
        list: () => [predecessor],
        start: () => {
          test.calls.push("start");
          return 0;
        },
        deletePmId: (pmId) => {
          test.calls.push(`delete ${pmId}`);
          return 0;
        },
        save: () => {
          test.calls.push("save");
          return 0;
        },
        pidAlive: () => true,
        schemaPhase: () => "ready",
        now: time.now,
        wait: time.wait,
        readyTimeoutMs: 1_000,
        pollMs: 200,
        confirmations: 2,
      });

    const result = await test.run();

    expect(result.ok).toBe(false);
    expect(result.code).toBe("successor_not_supervised");
    expect(result.predecessorPreserved).toBe(true);
    expect(result.changed).toBe(false);
    expect(test.calls).toEqual(["start"]);
    expect(result.message).toContain("running daemon was not stopped");
  });

  it("deletes only the new process when the successor dies before it is confirmed", async () => {
    const test = harness({ processes: [{ ...predecessor }], killSuccessorAfterHits: 1 });

    const result = await test.run();

    expect(result.ok).toBe(false);
    expect(result.code).toBe("successor_not_supervised");
    expect(result.predecessorPreserved).toBe(true);
    expect(test.calls).toContain("start force=true");
    expect(test.calls).toContain("delete 5");
    expect(test.calls).not.toContain("delete 4");
    expect(test.processes.map((process) => process.pmId)).toEqual([4]);
  });

  it("saves the successor and then deletes only the predecessor pm id", async () => {
    const test = harness({ processes: [{ ...predecessor }] });

    const result = await test.run();

    expect(result).toMatchObject({
      ok: true,
      changed: true,
      code: "restarted",
      successorPmId: 5,
      predecessorPreserved: false,
      deletedPmIds: [4],
    });
    expect(test.calls).toEqual(["start force=true", "save", "delete 4", "save"]);
    expect(test.processes.map((process) => process.pmId)).toEqual([5]);
  });

  it("does not report success when the successor disappears with the predecessor", async () => {
    const test = harness({ processes: [{ ...predecessor }], dropSuccessorOnDelete: true });

    const result = await test.run();

    expect(result.ok).toBe(false);
    expect(result.code).toBe("successor_lost");
    expect(result.predecessorPreserved).toBe(false);
    expect(test.calls[0]).toBe("start force=true");
    expect(test.calls).toContain("delete 4");
    expect(test.calls).toContain("start force=false");
    expect(result.message).toContain("did not complete cleanly");
  });

  it("leaves the predecessor running when the successor fails to start", async () => {
    const test = harness({ processes: [{ ...predecessor }], startStatus: 1 });

    const result = await test.run();

    expect(result.code).toBe("start_failed");
    expect(result.predecessorPreserved).toBe(true);
    expect(test.calls).toEqual(["start force=true"]);
  });

  it("does not start or stop while the orchestrator is still inside the predecessor tree", async () => {
    const test = harness({ processes: [{ ...predecessor }], mustBeDetached: true, insideTree: true });

    const result = await test.run();

    expect(result.code).toBe("orchestrator_attached");
    expect(result.predecessorPreserved).toBe(true);
    expect(test.calls).toEqual([]);
    expect(result.message).toContain("only supervised daemon");
  });

  it("drops the successor and keeps the predecessor when the process list cannot be saved", async () => {
    const test = harness({ processes: [{ ...predecessor }], saveStatus: 1 });

    const result = await test.run();

    expect(result.code).toBe("save_failed");
    expect(result.predecessorPreserved).toBe(true);
    expect(test.calls).toEqual(["start force=true", "save", "delete 5"]);
    expect(test.processes.map((process) => process.pmId)).toEqual([4]);
  });

  it("preserves the predecessor when PM2 is online but the successor has no schema phase", async () => {
    const test = harness({ processes: [predecessor], schemaPhase: () => null });
    const result = await test.run();

    expect(result.code).toBe("successor_not_supervised");
    expect(result.predecessorPreserved).toBe(true);
    expect(test.calls).toEqual(["start force=true", "delete 5"]);
  });

  it("cuts over from supervised standby and confirms readiness only after predecessor stop", async () => {
    const test = harness({
      processes: [predecessor],
      schemaPhase: (_process, processes, calls) => {
        const phase = processes.some((process) => process.pmId === predecessor.pmId) ? "waiting" : "ready";
        calls.push(`phase ${phase}`);
        return phase;
      },
    });
    const result = await test.run();

    expect(result.ok).toBe(true);
    const stopIndex = test.calls.indexOf("delete 4");
    expect(test.calls.slice(0, stopIndex)).toContain("phase waiting");
    expect(test.calls.slice(0, stopIndex)).not.toContain("phase ready");
    expect(test.calls.slice(stopIndex).filter((call) => call === "phase ready").length).toBeGreaterThanOrEqual(2);
    expect(test.calls.indexOf("save")).toBeLessThan(stopIndex);
    expect(test.calls.lastIndexOf("save")).toBeGreaterThan(stopIndex);
  });

  it("fails after cutover when ownership never becomes ready", async () => {
    const test = harness({ processes: [predecessor], schemaPhase: () => "owned" });
    const result = await test.run();

    expect(result).toMatchObject({ ok: false, code: "successor_not_ready", predecessorPreserved: false });
    expect(test.calls).toEqual(["start force=true", "save", "delete 4"]);
  });

  it("requires readiness on cold start as well", async () => {
    const test = harness({ processes: [], schemaPhase: () => "waiting" });
    const result = await test.run();

    expect(result).toMatchObject({ ok: false, code: "successor_not_ready", predecessorPreserved: false });
    expect(test.calls).toEqual(["start force=false"]);
  });

  it("refuses a replaced PID carrying only the previous process's phase before cutover", async () => {
    const test = harness({
      processes: [predecessor],
      schemaPhase: (process) => (process.pid === 200 ? "ready" : null),
      onWait: (processes) => {
        const successor = processes.find((process) => process.pmId === 5);
        if (successor) successor.pid = 201;
      },
    });
    const result = await test.run();

    expect(result.ok).toBe(false);
    expect(result.predecessorPreserved).toBe(true);
    expect(test.calls).not.toContain("delete 4");
  });

  it("does not complete a restart when PM2 reuses the successor id for another PID", async () => {
    const test = harness({
      processes: [predecessor],
      onWait: (processes, calls) => {
        if (!calls.includes("delete 4")) return;
        const successor = processes.find((process) => process.pmId === 5);
        if (successor) successor.pid = 201;
      },
    });
    const result = await test.run();

    expect(result).toMatchObject({ ok: false, code: "successor_lost", predecessorPreserved: false });
    expect(test.calls).toContain("start force=false");
  });

  it("rejects a changed process start time even if the PM2 id and PID match", async () => {
    const test = harness({
      processes: [predecessor],
      onWait: (processes, calls) => {
        if (!calls.includes("delete 4")) return;
        const successor = processes.find((process) => process.pmId === 5);
        if (successor) successor.startedAt = 123;
      },
    });
    const result = await test.run();

    expect(result).toMatchObject({ ok: false, code: "successor_lost", predecessorPreserved: false });
  });

  it("does not describe a replacement as recovered until it reaches readiness", async () => {
    const test = harness({
      processes: [predecessor],
      dropSuccessorOnDelete: true,
      schemaPhase: (process) => (process.pid === 300 ? "owned" : "ready"),
    });
    const result = await test.run();

    expect(result).toMatchObject({
      ok: false,
      code: "successor_lost",
      changed: false,
      successorPmId: null,
      predecessorPreserved: false,
    });
    expect(result.message).toContain("replacement did not reach readiness");
    expect(test.calls.filter((call) => call === "save")).toHaveLength(1);
  });
});
