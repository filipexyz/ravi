import { describe, expect, it } from "bun:test";
import type { CrashRecoveryStore, RuntimeBootEpochRecord, RuntimeTurnAttemptRecord } from "./crash-recovery-store.js";
import { CrashRecoveryLedgerConflictError } from "./crash-recovery-store.js";
import {
  RuntimeCrashRecoveryCoordinator,
  RuntimeCrashRecoveryOwnershipLostError,
  type RuntimeCrashRecoveryCoordinatorOptions,
  type RuntimeCrashRecoveryCoordinatorStore,
  type RuntimeCrashRecoveryStartTurnAttemptInput,
  type RuntimeCrashRecoveryTimer,
} from "./crash-recovery.js";

type StoreInput<Name extends keyof CrashRecoveryStore> = Parameters<CrashRecoveryStore[Name]>[0];

interface StoreCall {
  operation: string;
  input: unknown;
}

class FakeCrashRecoveryStore implements RuntimeCrashRecoveryCoordinatorStore {
  readonly calls: StoreCall[] = [];
  readonly attempts = new Map<string, RuntimeTurnAttemptRecord>();
  boot: RuntimeBootEpochRecord | null = null;
  heartbeatBootError: unknown = null;
  heartbeatAttemptError: unknown = null;
  createAttemptError: unknown = null;
  markSafetyError: unknown = null;
  terminalAttemptError: unknown = null;
  createAttemptLeaseExpiresAt: number | null = null;
  markSafetyLeaseExpiresAt: number | null = null;
  terminalAttemptLeaseExpiresAt: number | null = null;
  terminalAttemptStatus: RuntimeTurnAttemptRecord["status"] | null = null;
  terminalAttemptCompletedAt: number | null = null;
  invalidResultOperation: string | null = null;
  afterOperation: ((operation: string) => void) | null = null;

  createBootEpoch(input: StoreInput<"createBootEpoch">): RuntimeBootEpochRecord {
    this.calls.push({ operation: "createBoot", input });
    const startedAt = input.startedAt!;
    this.boot = {
      bootEpoch: input.bootEpoch ?? "boot-generated",
      instanceId: input.instanceId,
      pid: input.pid,
      status: "active",
      startedAt,
      lastHeartbeatAt: input.lastHeartbeatAt!,
      leaseExpiresAt: input.leaseExpiresAt,
      gracefulStoppedAt: null,
      abandonedAt: null,
      stopReason: null,
      metadata: input.metadata ?? null,
      createdAt: startedAt,
      updatedAt: startedAt,
    };
    this.afterOperation?.("createBoot");
    return this.resultFor("createBoot", this.boot);
  }

  heartbeatBootEpoch(input: StoreInput<"heartbeatBootEpoch">): RuntimeBootEpochRecord {
    this.calls.push({ operation: "heartbeatBoot", input });
    if (this.heartbeatBootError) throw this.heartbeatBootError;
    const boot = this.requireBoot();
    this.boot = {
      ...boot,
      lastHeartbeatAt: input.heartbeatAt!,
      leaseExpiresAt: input.leaseExpiresAt,
      updatedAt: input.heartbeatAt!,
    };
    this.afterOperation?.("heartbeatBoot");
    return this.resultFor("heartbeatBoot", this.boot);
  }

  markBootEpochGracefulStopped(input: StoreInput<"markBootEpochGracefulStopped">): RuntimeBootEpochRecord {
    this.calls.push({ operation: "gracefulBoot", input });
    const boot = this.requireBoot();
    this.boot = {
      ...boot,
      status: "graceful_stopped",
      gracefulStoppedAt: input.stoppedAt!,
      stopReason: input.reason ?? null,
      updatedAt: input.stoppedAt!,
    };
    this.afterOperation?.("gracefulBoot");
    return this.resultFor("gracefulBoot", this.boot);
  }

  createTurnAttempt(input: StoreInput<"createTurnAttempt">): RuntimeTurnAttemptRecord {
    this.calls.push({ operation: "createAttempt", input });
    if (this.createAttemptError) throw this.createAttemptError;
    const startedAt = input.startedAt!;
    const attempt: RuntimeTurnAttemptRecord = {
      attemptId: input.attemptId ?? `attempt-${this.attempts.size + 1}`,
      turnId: input.turnId,
      recoveredFromAttemptId: input.recoveredFromAttemptId ?? null,
      runId: input.runId,
      sessionKey: input.sessionKey,
      sessionName: input.sessionName ?? null,
      agentId: input.agentId,
      provider: input.provider,
      model: input.model,
      bootEpoch: input.bootEpoch,
      status: "running",
      startedAt,
      leaseExpiresAt: this.createAttemptLeaseExpiresAt ?? input.leaseExpiresAt,
      lastHeartbeatAt: input.lastHeartbeatAt!,
      completedAt: null,
      requestBlobSha256: input.requestBlobSha256 ?? null,
      userPromptSha256: input.userPromptSha256 ?? null,
      systemPromptSha256: input.systemPromptSha256 ?? null,
      checkpoint: input.checkpoint ?? null,
      originKind: input.originKind,
      source: input.source ?? null,
      turnProvenance: input.turnProvenance ?? null,
      taskBarrierTaskId: input.taskBarrierTaskId ?? null,
      deliveryBarrier: input.deliveryBarrier,
      pendingIds: input.pendingIds ?? [],
      startedTool: false,
      materializedOutput: false,
      recoveryClaimId: null,
      recoveryStatus: null,
      recoveryReason: null,
      recoveryRunId: null,
      recoveredAt: null,
      metadata: input.metadata ?? null,
      createdAt: startedAt,
      updatedAt: startedAt,
    };
    this.attempts.set(attempt.attemptId, attempt);
    this.afterOperation?.("createAttempt");
    return this.resultFor("createAttempt", attempt);
  }

  heartbeatTurnAttempt(input: StoreInput<"heartbeatTurnAttempt">): RuntimeTurnAttemptRecord {
    this.calls.push({ operation: "heartbeatAttempt", input });
    if (this.heartbeatAttemptError) throw this.heartbeatAttemptError;
    const attempt = this.requireAttempt(input.attemptId);
    const renewed: RuntimeTurnAttemptRecord = {
      ...attempt,
      lastHeartbeatAt: input.heartbeatAt!,
      leaseExpiresAt: input.leaseExpiresAt,
      updatedAt: input.heartbeatAt!,
    };
    this.attempts.set(input.attemptId, renewed);
    this.afterOperation?.("heartbeatAttempt");
    return this.resultFor("heartbeatAttempt", renewed);
  }

  markTurnAttemptSafety(input: StoreInput<"markTurnAttemptSafety">): RuntimeTurnAttemptRecord {
    this.calls.push({ operation: "markSafety", input });
    if (this.markSafetyError) throw this.markSafetyError;
    const attempt = this.requireAttempt(input.attemptId);
    const marked: RuntimeTurnAttemptRecord = {
      ...attempt,
      leaseExpiresAt: this.markSafetyLeaseExpiresAt ?? attempt.leaseExpiresAt,
      startedTool: attempt.startedTool || input.startedTool === true,
      materializedOutput: attempt.materializedOutput || input.materializedOutput === true,
      updatedAt: input.markedAt!,
    };
    this.attempts.set(input.attemptId, marked);
    this.afterOperation?.("markSafety");
    return this.resultFor("markSafety", marked);
  }

  terminalizeTurnAttempt(input: StoreInput<"terminalizeTurnAttempt">): RuntimeTurnAttemptRecord {
    this.calls.push({ operation: "terminalAttempt", input });
    if (this.terminalAttemptError) throw this.terminalAttemptError;
    const attempt = this.requireAttempt(input.attemptId);
    const terminal: RuntimeTurnAttemptRecord = {
      ...attempt,
      status: this.terminalAttemptStatus ?? input.status,
      leaseExpiresAt: this.terminalAttemptLeaseExpiresAt ?? attempt.leaseExpiresAt,
      completedAt: this.terminalAttemptCompletedAt ?? input.completedAt!,
      metadata: { ...(attempt.metadata ?? {}), ...(input.metadata ?? {}) },
      updatedAt: input.completedAt!,
    };
    this.attempts.set(input.attemptId, terminal);
    this.afterOperation?.("terminalAttempt");
    return this.resultFor("terminalAttempt", terminal);
  }

  private resultFor<T>(operation: string, record: T): T {
    return this.invalidResultOperation === operation ? (null as T) : record;
  }

  private requireBoot(): RuntimeBootEpochRecord {
    if (!this.boot) throw new Error("fake boot missing");
    return this.boot;
  }

  private requireAttempt(attemptId: string): RuntimeTurnAttemptRecord {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) throw new Error(`fake attempt missing: ${attemptId}`);
    return attempt;
  }
}

class FakeTimers {
  callback: (() => void) | null = null;
  intervalMs: number | null = null;
  unrefCalls = 0;
  clearCalls = 0;
  private handle: RuntimeCrashRecoveryTimer | null = null;

  readonly setInterval = (callback: () => void, intervalMs: number): RuntimeCrashRecoveryTimer => {
    this.callback = callback;
    this.intervalMs = intervalMs;
    this.handle = {
      unref: () => {
        this.unrefCalls += 1;
      },
    };
    return this.handle;
  };

  readonly clearInterval = (timer: RuntimeCrashRecoveryTimer): void => {
    const handle = this.handle;
    if (!handle) throw new Error("fake timer was not scheduled");
    expect(timer).toBe(handle);
    this.clearCalls += 1;
  };

  tick(): void {
    if (!this.callback) throw new Error("fake timer was not scheduled");
    this.callback();
  }
}

function turnAttemptInput(attemptId: string): RuntimeCrashRecoveryStartTurnAttemptInput {
  return {
    attemptId,
    turnId: `turn:${attemptId}`,
    runId: `run:${attemptId}`,
    sessionKey: "agent:dev:main",
    sessionName: "main",
    agentId: "dev",
    provider: "codex",
    model: "gpt-test",
    requestBlobSha256: `sha:${attemptId}`,
    originKind: "human",
    deliveryBarrier: "after_response",
  };
}

function createHarness(overrides: Partial<RuntimeCrashRecoveryCoordinatorOptions> = {}): {
  coordinator: RuntimeCrashRecoveryCoordinator;
  store: FakeCrashRecoveryStore;
  timers: FakeTimers;
  setNow(value: number): void;
} {
  const store = new FakeCrashRecoveryStore();
  const timers = new FakeTimers();
  let currentTime = 1_000;
  const coordinator = new RuntimeCrashRecoveryCoordinator({
    instanceId: "test-instance",
    pid: 42,
    bootEpoch: "boot-test",
    store,
    now: () => currentTime,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    ...overrides,
  });
  return {
    coordinator,
    store,
    timers,
    setNow(value: number) {
      currentTime = value;
    },
  };
}

function inputOf<Name extends keyof CrashRecoveryStore>(call: StoreCall): StoreInput<Name> {
  return call.input as StoreInput<Name>;
}

describe("RuntimeCrashRecoveryCoordinator", () => {
  it("does not start the host when boot persistence returns after the new lease expires", () => {
    const ownershipNotifications: RuntimeCrashRecoveryOwnershipLostError[] = [];
    const { coordinator, store, setNow } = createHarness({
      onOwnershipLost: (error) => ownershipNotifications.push(error),
    });
    store.afterOperation = (operation) => {
      if (operation === "createBoot") setNow(31_000);
    };

    expect(() => coordinator.start()).toThrow(RuntimeCrashRecoveryOwnershipLostError);

    expect(store.boot).toMatchObject({ status: "active" });
    expect(coordinator.ownershipFailure).toBeInstanceOf(RuntimeCrashRecoveryOwnershipLostError);
    expect(coordinator.acceptingDeliveries).toBe(false);
    expect(ownershipNotifications).toHaveLength(1);
  });

  it("creates one active boot, unrefs its timer, and renews boot before active attempts", () => {
    const { coordinator, store, timers, setNow } = createHarness();

    const boot = coordinator.start();
    expect(boot.status).toBe("active");
    expect(coordinator.boot).toBe(boot);
    expect(coordinator.bootEpoch).toBe("boot-test");
    expect(coordinator.acceptingDeliveries).toBe(true);
    expect(timers.intervalMs).toBe(10_000);
    expect(timers.unrefCalls).toBe(1);
    expect(inputOf<"createBootEpoch">(store.calls[0]!)).toMatchObject({
      bootEpoch: "boot-test",
      startedAt: 1_000,
      lastHeartbeatAt: 1_000,
      leaseExpiresAt: 31_000,
    });

    setNow(2_000);
    coordinator.startTurnAttempt(turnAttemptInput("attempt-a"));
    setNow(5_000);
    coordinator.heartbeatNow();

    expect(store.calls.map((call) => call.operation)).toEqual([
      "createBoot",
      "createAttempt",
      "heartbeatBoot",
      "heartbeatAttempt",
    ]);
    expect(inputOf<"heartbeatBootEpoch">(store.calls[2]!)).toMatchObject({
      heartbeatAt: 5_000,
      leaseExpiresAt: 35_000,
    });
    expect(inputOf<"heartbeatTurnAttempt">(store.calls[3]!)).toMatchObject({
      bootEpoch: "boot-test",
      heartbeatAt: 5_000,
      leaseExpiresAt: 35_000,
    });
  });

  it("rechecks the clock after each attempt heartbeat before renewing another attempt", () => {
    const { coordinator, store, setNow } = createHarness();
    coordinator.start();
    setNow(2_000);
    coordinator.startTurnAttempt(turnAttemptInput("attempt-heartbeat-a"));
    coordinator.startTurnAttempt(turnAttemptInput("attempt-heartbeat-b"));
    setNow(5_000);
    let attemptHeartbeats = 0;
    store.afterOperation = (operation) => {
      if (operation !== "heartbeatAttempt") return;
      attemptHeartbeats += 1;
      if (attemptHeartbeats === 1) setNow(35_000);
    };

    expect(() => coordinator.heartbeatNow()).toThrow(RuntimeCrashRecoveryOwnershipLostError);

    expect(store.calls.filter((call) => call.operation === "heartbeatBoot")).toHaveLength(1);
    expect(store.calls.filter((call) => call.operation === "heartbeatAttempt")).toHaveLength(1);
    expect(coordinator.acceptingDeliveries).toBe(false);
  });

  it("bounds a newly started attempt by the current boot lease", () => {
    const { coordinator, store, setNow } = createHarness();
    coordinator.start();
    setNow(30_000);

    const attempt = coordinator.startTurnAttempt(turnAttemptInput("attempt-near-expiry"));

    expect(attempt.startedAt).toBe(30_000);
    expect(attempt.lastHeartbeatAt).toBe(30_000);
    expect(attempt.leaseExpiresAt).toBe(31_000);
    expect(attempt.leaseExpiresAt).toBeLessThanOrEqual(coordinator.boot!.leaseExpiresAt);
    expect(inputOf<"createTurnAttempt">(store.calls[1]!)).toMatchObject({
      bootEpoch: "boot-test",
      startedAt: 30_000,
      lastHeartbeatAt: 30_000,
      leaseExpiresAt: 31_000,
    });
  });

  it("fails closed when attempt creation returns a non-finite lease", () => {
    const { coordinator, store } = createHarness();
    coordinator.start();
    store.createAttemptLeaseExpiresAt = Number.NaN;

    expect(() => coordinator.startTurnAttempt(turnAttemptInput("attempt-invalid-lease"))).toThrow(
      RuntimeCrashRecoveryOwnershipLostError,
    );

    expect(coordinator.ownershipFailure).toBeInstanceOf(RuntimeCrashRecoveryOwnershipLostError);
    expect(coordinator.acceptingDeliveries).toBe(false);
  });

  it("fails closed and notifies active ownership when attempt creation throws", () => {
    const hostNotifications: RuntimeCrashRecoveryOwnershipLostError[] = [];
    const activeNotifications: RuntimeCrashRecoveryOwnershipLostError[] = [];
    const { coordinator, store } = createHarness({
      onOwnershipLost: (error) => hostNotifications.push(error),
    });
    coordinator.start();
    coordinator.startTurnAttempt(turnAttemptInput("attempt-existing"), {
      onOwnershipLost: (error) => activeNotifications.push(error),
    });
    const storeError = new Error("create attempt write failed");
    store.createAttemptError = storeError;

    expect(() => coordinator.startTurnAttempt(turnAttemptInput("attempt-failing"))).toThrow(
      RuntimeCrashRecoveryOwnershipLostError,
    );

    expect(coordinator.acceptingDeliveries).toBe(false);
    expect(coordinator.ownershipFailure).toBeInstanceOf(RuntimeCrashRecoveryOwnershipLostError);
    expect(coordinator.ownershipFailure?.cause).toBe(storeError);
    expect(activeNotifications).toEqual([coordinator.ownershipFailure!]);
    expect(hostNotifications).toEqual([coordinator.ownershipFailure!]);
    expect(() => coordinator.startTurnAttempt(turnAttemptInput("attempt-after-loss"))).toThrow(
      coordinator.ownershipFailure!,
    );
    expect(store.calls.filter((call) => call.operation === "createAttempt")).toHaveLength(2);
  });

  it("fails closed when a live coordinator store mutation returns no record", () => {
    const operations = [
      "heartbeatBoot",
      "createAttempt",
      "heartbeatAttempt",
      "markSafety",
      "terminalAttempt",
      "gracefulBoot",
    ] as const;

    for (const operation of operations) {
      const { coordinator, store, setNow } = createHarness();
      coordinator.start();
      const attemptId = `attempt-invalid-${operation}`;
      if (operation === "heartbeatAttempt" || operation === "markSafety" || operation === "terminalAttempt") {
        coordinator.startTurnAttempt(turnAttemptInput(attemptId));
      }
      store.invalidResultOperation = operation;
      setNow(2_000);

      expect(() => {
        if (operation === "heartbeatBoot" || operation === "heartbeatAttempt") {
          coordinator.heartbeatNow();
        } else if (operation === "createAttempt") {
          coordinator.startTurnAttempt(turnAttemptInput(attemptId));
        } else if (operation === "markSafety") {
          coordinator.markTurnAttemptSafety({ attemptId, startedTool: true });
        } else if (operation === "terminalAttempt") {
          coordinator.terminalizeTurnAttempt({ attemptId, status: "complete" });
        } else {
          coordinator.stopGracefully("invalid result");
        }
      }).toThrow(RuntimeCrashRecoveryOwnershipLostError);

      expect(coordinator.ownershipFailure).toBeInstanceOf(RuntimeCrashRecoveryOwnershipLostError);
      expect(coordinator.acceptingDeliveries).toBe(false);
    }
  });

  it("fences intake immediately when the observed boot lease is no longer live", () => {
    const { coordinator, setNow } = createHarness();
    coordinator.start();

    setNow(30_999);
    expect(coordinator.acceptingDeliveries).toBe(true);

    setNow(31_000);
    expect(coordinator.acceptingDeliveries).toBe(false);
    expect(coordinator.ownershipFailure).toBeNull();
  });

  it("fails closed when a boot heartbeat returns after its renewed lease has expired", () => {
    const { coordinator, store, setNow } = createHarness();
    coordinator.start();
    setNow(5_000);
    store.afterOperation = (operation) => {
      if (operation === "heartbeatBoot") setNow(35_000);
    };

    expect(() => coordinator.heartbeatNow()).toThrow(RuntimeCrashRecoveryOwnershipLostError);

    expect(store.calls.filter((call) => call.operation === "heartbeatBoot")).toHaveLength(1);
    expect(coordinator.acceptingDeliveries).toBe(false);
    expect(coordinator.ownershipFailure).toBeInstanceOf(RuntimeCrashRecoveryOwnershipLostError);
  });

  it("does not renew a boot when the heartbeat write crosses the previous lease", () => {
    const { coordinator, store, setNow } = createHarness();
    const previousBoot = coordinator.start();
    setNow(5_000);
    store.afterOperation = (operation) => {
      if (operation === "heartbeatBoot") setNow(32_000);
    };

    expect(() => coordinator.heartbeatNow()).toThrow(RuntimeCrashRecoveryOwnershipLostError);

    expect(previousBoot.leaseExpiresAt).toBe(31_000);
    expect(store.boot).toMatchObject({ lastHeartbeatAt: 5_000, leaseExpiresAt: 35_000 });
    expect(coordinator.boot).toBe(previousBoot);
    expect(coordinator.acceptingDeliveries).toBe(false);
  });

  it("does not renew an attempt when its heartbeat write crosses the previous attempt lease", () => {
    const { coordinator, store, setNow } = createHarness();
    coordinator.start();
    setNow(2_000);
    const previousAttempt = coordinator.startTurnAttempt(turnAttemptInput("attempt-crossed-lease"));
    setNow(5_000);
    store.afterOperation = (operation) => {
      if (operation === "heartbeatAttempt") setNow(32_000);
    };

    expect(() => coordinator.heartbeatNow()).toThrow(RuntimeCrashRecoveryOwnershipLostError);

    expect(previousAttempt.leaseExpiresAt).toBe(31_000);
    expect(store.attempts.get("attempt-crossed-lease")).toMatchObject({
      lastHeartbeatAt: 5_000,
      leaseExpiresAt: 35_000,
    });
    expect(coordinator.getActiveTurnAttempt("attempt-crossed-lease")).toBeNull();
    expect(coordinator.acceptingDeliveries).toBe(false);
  });

  it("keeps trace startedAt while leasing from the current ownership observation", () => {
    const { coordinator, store, setNow } = createHarness();
    coordinator.start();
    setNow(2_000);

    const attempt = coordinator.startTurnAttempt({
      ...turnAttemptInput("attempt-observed-now"),
      startedAt: 1_500,
    });

    expect(attempt.startedAt).toBe(1_500);
    expect(attempt.lastHeartbeatAt).toBe(2_000);
    expect(inputOf<"createTurnAttempt">(store.calls[1]!)).toMatchObject({
      startedAt: 1_500,
      lastHeartbeatAt: 2_000,
      leaseExpiresAt: 31_000,
    });
  });

  it("does not release a newly persisted attempt after the ownership clock expires inside the store", () => {
    const notified: RuntimeCrashRecoveryOwnershipLostError[] = [];
    const { coordinator, store, setNow } = createHarness();
    coordinator.start();
    setNow(2_000);
    store.afterOperation = (operation) => {
      if (operation === "createAttempt") setNow(31_000);
    };

    expect(() =>
      coordinator.startTurnAttempt(turnAttemptInput("attempt-delayed-create"), {
        onOwnershipLost: (error) => notified.push(error),
      }),
    ).toThrow(RuntimeCrashRecoveryOwnershipLostError);

    expect(store.attempts.get("attempt-delayed-create")).toMatchObject({ status: "running" });
    expect(coordinator.getActiveTurnAttempt("attempt-delayed-create")).toBeNull();
    expect(notified).toHaveLength(1);
    expect(coordinator.acceptingDeliveries).toBe(false);
  });

  it("owns safety and terminal timestamps and stops heartbeating terminal attempts", () => {
    const { coordinator, store, setNow } = createHarness();
    coordinator.start();
    setNow(2_000);
    const started = coordinator.startTurnAttempt(turnAttemptInput("attempt-markers"));
    expect(coordinator.getActiveTurnAttempt("attempt-markers")).toBe(started);

    setNow(2_500);
    const marked = coordinator.markTurnAttemptSafety({
      attemptId: "attempt-markers",
      startedTool: true,
      materializedOutput: true,
      markedAt: 2_400,
    });
    expect(marked.startedTool).toBe(true);
    expect(marked.materializedOutput).toBe(true);
    expect(inputOf<"markTurnAttemptSafety">(store.calls[2]!)).toMatchObject({ markedAt: 2_400 });

    setNow(2_600);
    expect(
      coordinator.markTurnAttemptSafety({
        attemptId: "attempt-markers",
        startedTool: true,
        materializedOutput: true,
      }),
    ).toBe(marked);
    expect(store.calls.filter((call) => call.operation === "markSafety")).toHaveLength(1);

    setNow(2_750);
    const terminal = coordinator.terminalizeTurnAttempt({
      attemptId: "attempt-markers",
      status: "complete",
      completedAt: 2_700,
      metadata: { response: "stored" },
    });
    expect(terminal.status).toBe("complete");
    expect(terminal.completedAt).toBe(2_700);
    expect(coordinator.getActiveTurnAttempt("attempt-markers")).toBeNull();

    setNow(3_000);
    coordinator.heartbeatNow();
    expect(store.calls.filter((call) => call.operation === "heartbeatAttempt")).toHaveLength(0);
  });

  it("fails closed and notifies every attempt when a safety marker fence is lost", () => {
    const notified: string[] = [];
    const { coordinator, store, timers, setNow } = createHarness({
      onOwnershipLost: () => notified.push("host"),
    });
    coordinator.start();
    setNow(2_000);
    coordinator.startTurnAttempt(turnAttemptInput("attempt-marker-a"), {
      onOwnershipLost: () => notified.push("a"),
    });
    coordinator.startTurnAttempt(turnAttemptInput("attempt-marker-b"), {
      onOwnershipLost: () => notified.push("b"),
    });
    const cause = new CrashRecoveryLedgerConflictError("lost safety marker fence");
    store.markSafetyError = cause;

    let thrown: unknown;
    try {
      coordinator.markTurnAttemptSafety({ attemptId: "attempt-marker-a", startedTool: true });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(RuntimeCrashRecoveryOwnershipLostError);
    expect((thrown as Error).cause).toBe(cause);
    expect(notified).toEqual(["a", "b", "host"]);
    expect(coordinator.acceptingDeliveries).toBe(false);
    expect(timers.clearCalls).toBe(1);
    expect(() => coordinator.startTurnAttempt(turnAttemptInput("attempt-marker-rejected"))).toThrow(
      RuntimeCrashRecoveryOwnershipLostError,
    );
    expect(() => coordinator.heartbeatNow()).toThrow(RuntimeCrashRecoveryOwnershipLostError);
    expect(notified).toEqual(["a", "b", "host"]);
  });

  it("fails closed and preserves the cause when a terminal fence is lost", () => {
    const { coordinator, store, timers, setNow } = createHarness();
    coordinator.start();
    let notified = false;
    setNow(2_000);
    coordinator.startTurnAttempt(turnAttemptInput("attempt-terminal"), {
      onOwnershipLost: () => {
        notified = true;
      },
    });
    const cause = new CrashRecoveryLedgerConflictError("lost terminal fence");
    store.terminalAttemptError = cause;

    let thrown: unknown;
    try {
      coordinator.terminalizeTurnAttempt({ attemptId: "attempt-terminal", status: "complete" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(RuntimeCrashRecoveryOwnershipLostError);
    expect((thrown as Error).cause).toBe(cause);
    expect(notified).toBe(true);
    expect(coordinator.acceptingDeliveries).toBe(false);
    expect(timers.clearCalls).toBe(1);
    expect(() => coordinator.stopGracefully()).toThrow(RuntimeCrashRecoveryOwnershipLostError);
    expect(store.calls.filter((call) => call.operation === "gracefulBoot")).toHaveLength(0);
  });

  it("fails closed when the store does not persist the requested first terminal", () => {
    const { coordinator, store, setNow } = createHarness();
    coordinator.start();
    setNow(2_000);
    coordinator.startTurnAttempt(turnAttemptInput("attempt-terminal-mismatch"));
    store.terminalAttemptStatus = "aborted";

    expect(() =>
      coordinator.terminalizeTurnAttempt({
        attemptId: "attempt-terminal-mismatch",
        status: "complete",
        completedAt: 2_000,
      }),
    ).toThrow(RuntimeCrashRecoveryOwnershipLostError);
    expect(coordinator.acceptingDeliveries).toBe(false);
    expect(coordinator.getActiveTurnAttempt("attempt-terminal-mismatch")).toBeNull();
  });

  it("aborts every active attempt at one timestamp before gracefully stopping the boot", () => {
    const { coordinator, store, timers, setNow } = createHarness();
    coordinator.start();
    setNow(2_000);
    coordinator.startTurnAttempt(turnAttemptInput("attempt-a"));
    setNow(3_000);
    coordinator.startTurnAttempt(turnAttemptInput("attempt-b"));
    setNow(9_000);

    const boot = coordinator.stopGracefully("daemon shutdown");

    expect(boot.status).toBe("graceful_stopped");
    expect(boot.gracefulStoppedAt).toBe(9_000);
    expect(boot.stopReason).toBe("daemon shutdown");
    expect(coordinator.acceptingDeliveries).toBe(false);
    expect(timers.clearCalls).toBe(1);
    expect(store.calls.slice(-3).map((call) => call.operation)).toEqual([
      "terminalAttempt",
      "terminalAttempt",
      "gracefulBoot",
    ]);
    for (const call of store.calls.slice(-3, -1)) {
      expect(inputOf<"terminalizeTurnAttempt">(call)).toMatchObject({
        status: "aborted",
        completedAt: 9_000,
      });
    }
    expect(inputOf<"markBootEpochGracefulStopped">(store.calls.at(-1)!)).toMatchObject({
      stoppedAt: 9_000,
      reason: "daemon shutdown",
    });
  });

  it("fails closed when a timer tick arrives after lease expiry", () => {
    const { coordinator, store, timers, setNow } = createHarness();
    coordinator.start();
    setNow(2_000);
    let callbackError: RuntimeCrashRecoveryOwnershipLostError | null = null;
    coordinator.startTurnAttempt(turnAttemptInput("attempt-expired"), {
      onOwnershipLost: (error) => {
        callbackError = error;
      },
    });
    setNow(31_000);

    timers.tick();

    expect(callbackError).toBeInstanceOf(RuntimeCrashRecoveryOwnershipLostError);
    expect(coordinator.ownershipFailure).toBe(callbackError);
    expect(coordinator.acceptingDeliveries).toBe(false);
    expect(timers.clearCalls).toBe(1);
    expect(store.calls.filter((call) => call.operation === "heartbeatBoot")).toHaveLength(0);
    expect(() => coordinator.startTurnAttempt(turnAttemptInput("attempt-rejected"))).toThrow(
      RuntimeCrashRecoveryOwnershipLostError,
    );
    expect(() => coordinator.stopGracefully()).toThrow(RuntimeCrashRecoveryOwnershipLostError);
    expect(store.calls.filter((call) => call.operation === "gracefulBoot")).toHaveLength(0);
    expect(store.boot?.status).toBe("active");
  });

  it("rejects attempt creation when the current boot lease has already expired", () => {
    const ownershipNotifications: RuntimeCrashRecoveryOwnershipLostError[] = [];
    const { coordinator, store, setNow } = createHarness({
      onOwnershipLost: (error) => ownershipNotifications.push(error),
    });
    coordinator.start();
    setNow(31_000);

    expect(() =>
      coordinator.startTurnAttempt({
        ...turnAttemptInput("attempt-after-expiry"),
        startedAt: 2_000,
      }),
    ).toThrow(RuntimeCrashRecoveryOwnershipLostError);

    expect(store.calls.filter((call) => call.operation === "createAttempt")).toHaveLength(0);
    expect(coordinator.acceptingDeliveries).toBe(false);
    expect(ownershipNotifications).toHaveLength(1);
  });

  it("rejects safety mutation when the active attempt lease has expired", () => {
    const { coordinator, store, setNow } = createHarness();
    coordinator.start();
    store.createAttemptLeaseExpiresAt = 2_500;
    setNow(2_000);
    coordinator.startTurnAttempt(turnAttemptInput("attempt-short-lease"));
    setNow(2_500);

    expect(() => coordinator.markTurnAttemptSafety({ attemptId: "attempt-short-lease", startedTool: true })).toThrow(
      RuntimeCrashRecoveryOwnershipLostError,
    );

    expect(store.calls.filter((call) => call.operation === "markSafety")).toHaveLength(0);
    expect(coordinator.acceptingDeliveries).toBe(false);
  });

  it("does not release a safety marker after the ownership clock expires inside the store", () => {
    const { coordinator, store, setNow } = createHarness();
    coordinator.start();
    setNow(2_000);
    coordinator.startTurnAttempt(turnAttemptInput("attempt-delayed-marker"));
    store.afterOperation = (operation) => {
      if (operation === "markSafety") setNow(31_000);
    };

    expect(() => coordinator.markTurnAttemptSafety({ attemptId: "attempt-delayed-marker", startedTool: true })).toThrow(
      RuntimeCrashRecoveryOwnershipLostError,
    );

    expect(store.attempts.get("attempt-delayed-marker")).toMatchObject({ startedTool: true });
    expect(coordinator.acceptingDeliveries).toBe(false);
  });

  it("does not let an invalid safety row renew an attempt across its previous lease", () => {
    const { coordinator, store, setNow } = createHarness();
    coordinator.start();
    store.createAttemptLeaseExpiresAt = 2_500;
    setNow(2_000);
    coordinator.startTurnAttempt(turnAttemptInput("attempt-marker-invalid-renewal"));
    store.markSafetyLeaseExpiresAt = 31_000;
    store.afterOperation = (operation) => {
      if (operation === "markSafety") setNow(2_600);
    };

    expect(() =>
      coordinator.markTurnAttemptSafety({ attemptId: "attempt-marker-invalid-renewal", startedTool: true }),
    ).toThrow(RuntimeCrashRecoveryOwnershipLostError);

    expect(store.attempts.get("attempt-marker-invalid-renewal")).toMatchObject({
      startedTool: true,
      leaseExpiresAt: 31_000,
    });
    expect(coordinator.getActiveTurnAttempt("attempt-marker-invalid-renewal")).toBeNull();
    expect(coordinator.acceptingDeliveries).toBe(false);
  });

  it("rejects terminal mutation when the current ownership lease has expired", () => {
    const { coordinator, store, setNow } = createHarness();
    coordinator.start();
    setNow(2_000);
    coordinator.startTurnAttempt(turnAttemptInput("attempt-terminal-expired"));
    setNow(31_000);

    expect(() =>
      coordinator.terminalizeTurnAttempt({ attemptId: "attempt-terminal-expired", status: "aborted" }),
    ).toThrow(RuntimeCrashRecoveryOwnershipLostError);

    expect(store.calls.filter((call) => call.operation === "terminalAttempt")).toHaveLength(0);
    expect(coordinator.getActiveTurnAttempt("attempt-terminal-expired")).toBeNull();
  });

  it("fails closed when terminal persistence returns after its ownership lease expires", () => {
    const { coordinator, store, setNow } = createHarness();
    coordinator.start();
    setNow(2_000);
    coordinator.startTurnAttempt(turnAttemptInput("attempt-delayed-terminal"));
    store.afterOperation = (operation) => {
      if (operation === "terminalAttempt") setNow(31_000);
    };

    expect(() =>
      coordinator.terminalizeTurnAttempt({ attemptId: "attempt-delayed-terminal", status: "complete" }),
    ).toThrow(RuntimeCrashRecoveryOwnershipLostError);

    expect(store.attempts.get("attempt-delayed-terminal")).toMatchObject({ status: "complete" });
    expect(coordinator.acceptingDeliveries).toBe(false);
  });

  it("does not let an invalid terminal row renew an attempt across its previous lease", () => {
    const { coordinator, store, setNow } = createHarness();
    coordinator.start();
    store.createAttemptLeaseExpiresAt = 2_500;
    setNow(2_000);
    coordinator.startTurnAttempt(turnAttemptInput("attempt-terminal-invalid-renewal"));
    store.terminalAttemptLeaseExpiresAt = 31_000;
    store.afterOperation = (operation) => {
      if (operation === "terminalAttempt") setNow(2_600);
    };

    expect(() =>
      coordinator.terminalizeTurnAttempt({ attemptId: "attempt-terminal-invalid-renewal", status: "complete" }),
    ).toThrow(RuntimeCrashRecoveryOwnershipLostError);

    expect(store.attempts.get("attempt-terminal-invalid-renewal")).toMatchObject({
      status: "complete",
      leaseExpiresAt: 31_000,
    });
    expect(coordinator.getActiveTurnAttempt("attempt-terminal-invalid-renewal")).toBeNull();
    expect(coordinator.acceptingDeliveries).toBe(false);
  });

  it("never marks an expired boot graceful or terminalizes its remaining attempts", () => {
    const { coordinator, store, setNow } = createHarness();
    coordinator.start();
    setNow(2_000);
    coordinator.startTurnAttempt(turnAttemptInput("attempt-before-expired-stop"));
    setNow(31_000);

    expect(() => coordinator.stopGracefully("too late")).toThrow(RuntimeCrashRecoveryOwnershipLostError);

    expect(store.calls.filter((call) => call.operation === "terminalAttempt")).toHaveLength(0);
    expect(store.calls.filter((call) => call.operation === "gracefulBoot")).toHaveLength(0);
    expect(store.boot?.status).toBe("active");
    expect(coordinator.acceptingDeliveries).toBe(false);
  });

  it("rechecks ownership after every attempt write during graceful stop", () => {
    const { coordinator, store, setNow } = createHarness();
    coordinator.start();
    setNow(2_000);
    coordinator.startTurnAttempt(turnAttemptInput("attempt-stop-a"));
    coordinator.startTurnAttempt(turnAttemptInput("attempt-stop-b"));
    setNow(3_000);
    let terminalWrites = 0;
    store.afterOperation = (operation) => {
      if (operation !== "terminalAttempt") return;
      terminalWrites += 1;
      if (terminalWrites === 1) setNow(31_000);
    };

    expect(() => coordinator.stopGracefully("clock expired during stop")).toThrow(
      RuntimeCrashRecoveryOwnershipLostError,
    );

    expect(store.calls.filter((call) => call.operation === "terminalAttempt")).toHaveLength(1);
    expect(store.calls.filter((call) => call.operation === "gracefulBoot")).toHaveLength(0);
    expect(store.boot?.status).toBe("active");
    expect(coordinator.acceptingDeliveries).toBe(false);
  });

  it("does not let a graceful abort row renew an attempt across its previous lease", () => {
    const { coordinator, store, setNow } = createHarness();
    coordinator.start();
    store.createAttemptLeaseExpiresAt = 2_500;
    setNow(2_000);
    coordinator.startTurnAttempt(turnAttemptInput("attempt-stop-invalid-renewal"));
    store.terminalAttemptLeaseExpiresAt = 31_000;
    store.afterOperation = (operation) => {
      if (operation === "terminalAttempt") setNow(2_600);
    };

    expect(() => coordinator.stopGracefully("invalid attempt renewal")).toThrow(RuntimeCrashRecoveryOwnershipLostError);

    expect(store.attempts.get("attempt-stop-invalid-renewal")).toMatchObject({
      status: "aborted",
      leaseExpiresAt: 31_000,
    });
    expect(store.calls.filter((call) => call.operation === "gracefulBoot")).toHaveLength(0);
    expect(coordinator.acceptingDeliveries).toBe(false);
  });

  it("does not report graceful success when the boot lease expires inside the terminal store write", () => {
    const { coordinator, store, setNow } = createHarness();
    coordinator.start();
    setNow(3_000);
    store.afterOperation = (operation) => {
      if (operation === "gracefulBoot") setNow(31_000);
    };

    expect(() => coordinator.stopGracefully("delayed graceful write")).toThrow(RuntimeCrashRecoveryOwnershipLostError);

    expect(store.calls.filter((call) => call.operation === "gracefulBoot")).toHaveLength(1);
    expect(coordinator.ownershipFailure).toBeInstanceOf(RuntimeCrashRecoveryOwnershipLostError);
    expect(coordinator.acceptingDeliveries).toBe(false);
  });

  it("fails closed on heartbeat CAS loss, notifies all attempts, and never marks graceful", () => {
    const { coordinator, store, timers, setNow } = createHarness();
    coordinator.start();
    const notified: string[] = [];
    setNow(2_000);
    coordinator.startTurnAttempt(turnAttemptInput("attempt-a"), {
      onOwnershipLost: () => {
        notified.push("a");
        throw new Error("callback failure must not stop later callbacks");
      },
    });
    coordinator.startTurnAttempt(turnAttemptInput("attempt-b"), {
      onOwnershipLost: () => notified.push("b"),
    });
    store.heartbeatBootError = new CrashRecoveryLedgerConflictError("lost boot heartbeat fence");
    setNow(5_000);

    expect(() => coordinator.heartbeatNow()).toThrow(RuntimeCrashRecoveryOwnershipLostError);

    expect(notified).toEqual(["a", "b"]);
    expect(timers.clearCalls).toBe(1);
    expect(store.calls.filter((call) => call.operation === "heartbeatAttempt")).toHaveLength(0);
    expect(() => coordinator.startTurnAttempt(turnAttemptInput("attempt-c"))).toThrow(
      RuntimeCrashRecoveryOwnershipLostError,
    );
    expect(() => coordinator.stopGracefully("should not persist")).toThrow(RuntimeCrashRecoveryOwnershipLostError);
    expect(store.calls.filter((call) => call.operation === "gracefulBoot")).toHaveLength(0);
  });

  it("requires heartbeat cadence to stay below the lease", () => {
    expect(
      () =>
        new RuntimeCrashRecoveryCoordinator({
          instanceId: "test-instance",
          leaseMs: 10_000,
          heartbeatIntervalMs: 10_000,
        }),
    ).toThrow("heartbeatIntervalMs must be shorter than leaseMs");
  });
});
