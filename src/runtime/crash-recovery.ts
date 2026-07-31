import { isDeepStrictEqual } from "node:util";
import type {
  CrashRecoveryStore,
  CreateRuntimeBootEpochInput,
  CreateRuntimeTurnAttemptInput,
  RuntimeBootEpochRecord,
  RuntimeTurnAttemptRecord,
} from "./crash-recovery-store.js";
import { sqliteCrashRecoveryStore } from "./crash-recovery-store.js";

export const DEFAULT_CRASH_RECOVERY_LEASE_MS = 30_000;
export const DEFAULT_CRASH_RECOVERY_HEARTBEAT_INTERVAL_MS = 10_000;

export interface RuntimeCrashRecoveryTimer {
  unref?(): void;
}

export type RuntimeCrashRecoveryCoordinatorStore = Pick<
  CrashRecoveryStore,
  | "createBootEpoch"
  | "heartbeatBootEpoch"
  | "markBootEpochGracefulStopped"
  | "createTurnAttempt"
  | "heartbeatTurnAttempt"
  | "markTurnAttemptSafety"
  | "terminalizeTurnAttempt"
>;

export type RuntimeCrashRecoveryOwnershipLostCallback = (error: RuntimeCrashRecoveryOwnershipLostError) => void;

export interface RuntimeCrashRecoveryCoordinatorOptions {
  instanceId: string;
  pid?: number;
  bootEpoch?: string;
  bootMetadata?: CreateRuntimeBootEpochInput["metadata"];
  leaseMs?: number;
  heartbeatIntervalMs?: number;
  store?: RuntimeCrashRecoveryCoordinatorStore;
  now?: () => number;
  setInterval?: (callback: () => void, intervalMs: number) => RuntimeCrashRecoveryTimer;
  clearInterval?: (timer: RuntimeCrashRecoveryTimer) => void;
  onOwnershipLost?: RuntimeCrashRecoveryOwnershipLostCallback;
}

export type RuntimeCrashRecoveryStartTurnAttemptInput = Omit<
  CreateRuntimeTurnAttemptInput,
  "bootEpoch" | "lastHeartbeatAt" | "leaseExpiresAt"
>;

export interface RuntimeCrashRecoveryAttemptOptions {
  onOwnershipLost?: RuntimeCrashRecoveryOwnershipLostCallback;
}

export type RuntimeCrashRecoverySafetyInput = Parameters<CrashRecoveryStore["markTurnAttemptSafety"]>[0];

export type RuntimeCrashRecoveryTerminalInput = Parameters<CrashRecoveryStore["terminalizeTurnAttempt"]>[0];

type CoordinatorState = "idle" | "running" | "stopping" | "graceful_stopped" | "ownership_lost";

interface ActiveAttempt {
  record: RuntimeTurnAttemptRecord;
  onOwnershipLost?: RuntimeCrashRecoveryOwnershipLostCallback;
}

export class RuntimeCrashRecoveryOwnershipLostError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "RuntimeCrashRecoveryOwnershipLostError";
  }
}

/**
 * Owns the live crash-recovery leases for one runtime host process.
 *
 * This class deliberately does not inspect or mutate prior boots. Classification,
 * sweeping, and replay are separate recovery responsibilities.
 */
export class RuntimeCrashRecoveryCoordinator {
  private readonly instanceId: string;
  private readonly pid: number;
  private readonly configuredBootEpoch: string | undefined;
  private readonly bootMetadata: CreateRuntimeBootEpochInput["metadata"];
  private readonly leaseMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly store: RuntimeCrashRecoveryCoordinatorStore;
  private readonly now: () => number;
  private readonly scheduleInterval: (callback: () => void, intervalMs: number) => RuntimeCrashRecoveryTimer;
  private readonly cancelInterval: (timer: RuntimeCrashRecoveryTimer) => void;
  private readonly onOwnershipLost: RuntimeCrashRecoveryOwnershipLostCallback | undefined;

  private state: CoordinatorState = "idle";
  private currentBoot: RuntimeBootEpochRecord | null = null;
  private heartbeatTimer: RuntimeCrashRecoveryTimer | null = null;
  private readonly activeAttempts = new Map<string, ActiveAttempt>();
  private ownershipLostError: RuntimeCrashRecoveryOwnershipLostError | null = null;

  constructor(options: RuntimeCrashRecoveryCoordinatorOptions) {
    this.instanceId = requireNonEmptyText(options.instanceId, "instanceId");
    this.pid = requirePositiveInteger(options.pid ?? process.pid, "pid");
    this.configuredBootEpoch = options.bootEpoch;
    this.bootMetadata = options.bootMetadata;
    this.leaseMs = requirePositiveInteger(options.leaseMs ?? DEFAULT_CRASH_RECOVERY_LEASE_MS, "leaseMs");
    this.heartbeatIntervalMs = requirePositiveInteger(
      options.heartbeatIntervalMs ?? DEFAULT_CRASH_RECOVERY_HEARTBEAT_INTERVAL_MS,
      "heartbeatIntervalMs",
    );
    if (this.heartbeatIntervalMs >= this.leaseMs) {
      throw new Error("heartbeatIntervalMs must be shorter than leaseMs");
    }

    this.store = options.store ?? sqliteCrashRecoveryStore;
    this.now = options.now ?? Date.now;
    this.scheduleInterval =
      options.setInterval ??
      ((callback, intervalMs) => setInterval(callback, intervalMs) as unknown as RuntimeCrashRecoveryTimer);
    this.cancelInterval =
      options.clearInterval ?? ((timer) => clearInterval(timer as unknown as ReturnType<typeof setInterval>));
    this.onOwnershipLost = options.onOwnershipLost;
  }

  get boot(): RuntimeBootEpochRecord | null {
    return this.currentBoot;
  }

  get bootEpoch(): string | null {
    return this.currentBoot?.bootEpoch ?? null;
  }

  get acceptingDeliveries(): boolean {
    const boot = this.currentBoot;
    if (this.state !== "running" || boot?.status !== "active") return false;
    const observedAt = this.now();
    return Number.isSafeInteger(observedAt) && observedAt >= boot.lastHeartbeatAt && observedAt < boot.leaseExpiresAt;
  }

  get ownershipFailure(): RuntimeCrashRecoveryOwnershipLostError | null {
    return this.ownershipLostError;
  }

  getActiveTurnAttempt(attemptId: string): Readonly<RuntimeTurnAttemptRecord> | null {
    return this.activeAttempts.get(attemptId)?.record ?? null;
  }

  start(): RuntimeBootEpochRecord {
    if (this.state !== "idle") {
      throw new Error(`Crash recovery coordinator cannot start from state ${this.state}`);
    }

    const startedAt = this.readNow();
    const boot = this.store.createBootEpoch({
      bootEpoch: this.configuredBootEpoch,
      instanceId: this.instanceId,
      pid: this.pid,
      startedAt,
      lastHeartbeatAt: startedAt,
      leaseExpiresAt: startedAt + this.leaseMs,
      metadata: this.bootMetadata,
    });
    if (
      !boot ||
      !isNonEmptyText(boot.bootEpoch) ||
      boot.status !== "active" ||
      (this.configuredBootEpoch !== undefined && boot.bootEpoch !== this.configuredBootEpoch) ||
      boot.instanceId !== this.instanceId ||
      boot.pid !== this.pid ||
      boot.startedAt !== startedAt ||
      boot.lastHeartbeatAt !== startedAt ||
      boot.leaseExpiresAt !== startedAt + this.leaseMs ||
      boot.gracefulStoppedAt !== null ||
      boot.abandonedAt !== null ||
      boot.stopReason !== null ||
      !hasSameJsonValue(boot.metadata, this.bootMetadata ?? null) ||
      boot.createdAt !== startedAt ||
      boot.updatedAt !== startedAt
    ) {
      throw new Error("Crash recovery store returned a non-live boot epoch from createBootEpoch");
    }

    this.currentBoot = boot;
    this.state = "running";
    this.observeLiveBoot(`complete boot creation for ${boot.bootEpoch}`);
    try {
      const timer = this.scheduleInterval(() => {
        try {
          this.heartbeatNow();
        } catch {
          // heartbeatNow has already made the coordinator fail-closed and
          // notified every active attempt. Timer callbacks must not leak an
          // unhandled exception into the host event loop.
        }
      }, this.heartbeatIntervalMs);
      this.heartbeatTimer = timer;
      timer.unref?.();
    } catch (cause) {
      throw this.enterFailClosed("Failed to start the crash recovery heartbeat timer", cause);
    }
    return boot;
  }

  heartbeatNow(): RuntimeBootEpochRecord {
    const { boot, observedAt: heartbeatAt } = this.observeLiveBoot("heartbeat");

    let renewedBoot: RuntimeBootEpochRecord;
    try {
      // The boot fence must be renewed before any attempt owned by it.
      renewedBoot = this.store.heartbeatBootEpoch({
        bootEpoch: boot.bootEpoch,
        heartbeatAt,
        leaseExpiresAt: heartbeatAt + this.leaseMs,
      });
    } catch (cause) {
      throw this.enterFailClosed(`Lost crash recovery boot ownership for ${boot.bootEpoch}`, cause);
    }

    if (
      !renewedBoot ||
      renewedBoot.status !== "active" ||
      renewedBoot.bootEpoch !== boot.bootEpoch ||
      renewedBoot.instanceId !== boot.instanceId ||
      renewedBoot.pid !== boot.pid ||
      renewedBoot.startedAt !== boot.startedAt ||
      renewedBoot.lastHeartbeatAt !== heartbeatAt ||
      renewedBoot.leaseExpiresAt !== heartbeatAt + this.leaseMs ||
      renewedBoot.gracefulStoppedAt !== null ||
      renewedBoot.abandonedAt !== null ||
      renewedBoot.stopReason !== null ||
      !hasSameJsonValue(renewedBoot.metadata, boot.metadata) ||
      renewedBoot.createdAt !== boot.createdAt ||
      renewedBoot.updatedAt !== heartbeatAt
    ) {
      throw this.enterFailClosed(`Crash recovery boot ${boot.bootEpoch} was not renewed as active`);
    }
    // A renewal is valid only if the write completed while the lease that
    // authorized it was still live. Do not publish the renewed record first:
    // validating against its later expiry would allow a stalled write to
    // resurrect ownership after the previous lease had already elapsed.
    const renewedBootObservedAt = this.observeOwnedBoot(boot, `complete boot heartbeat for ${boot.bootEpoch}`);
    this.currentBoot = renewedBoot;
    this.assertBootLeaseLive(renewedBoot, renewedBootObservedAt, `accept renewed boot ${boot.bootEpoch}`);

    for (const [attemptId, activeAttempt] of this.activeAttempts) {
      const { boot: liveBoot, observedAt: attemptHeartbeatAt } = this.observeLiveBoot(`heartbeat attempt ${attemptId}`);
      this.requireLiveActiveAttempt(attemptId, attemptHeartbeatAt);
      const attemptLeaseExpiresAt = Math.min(attemptHeartbeatAt + this.leaseMs, liveBoot.leaseExpiresAt);
      try {
        const attempt = this.store.heartbeatTurnAttempt({
          attemptId,
          bootEpoch: liveBoot.bootEpoch,
          heartbeatAt: attemptHeartbeatAt,
          leaseExpiresAt: attemptLeaseExpiresAt,
        });
        if (
          !attempt ||
          attempt.status !== "running" ||
          !hasSameAttemptIdentity(activeAttempt.record, attempt) ||
          attempt.lastHeartbeatAt !== attemptHeartbeatAt ||
          attempt.leaseExpiresAt !== attemptLeaseExpiresAt ||
          attempt.completedAt !== null ||
          attempt.startedTool !== activeAttempt.record.startedTool ||
          attempt.materializedOutput !== activeAttempt.record.materializedOutput ||
          !hasSameJsonValue(attempt.metadata, activeAttempt.record.metadata) ||
          attempt.updatedAt !== attemptHeartbeatAt
        ) {
          throw new Error(`Crash recovery store returned an invalid renewed attempt ${attemptId}`);
        }
        const { observedAt: renewedAttemptObservedAt } = this.observeLiveBoot(
          `complete attempt heartbeat for ${attemptId}`,
        );
        // Preserve and validate the previous attempt fence before publishing
        // the renewed record. Otherwise a store call that returned after the
        // old attempt lease expired could be accepted against its new lease.
        this.requireLiveActiveAttempt(attemptId, renewedAttemptObservedAt);
        activeAttempt.record = attempt;
        this.requireLiveActiveAttempt(attemptId, renewedAttemptObservedAt);
      } catch (cause) {
        throw this.enterFailClosed(`Lost crash recovery attempt ownership for ${attemptId}`, cause);
      }
    }

    return renewedBoot;
  }

  startTurnAttempt(
    input: RuntimeCrashRecoveryStartTurnAttemptInput,
    options: RuntimeCrashRecoveryAttemptOptions = {},
  ): RuntimeTurnAttemptRecord {
    const { boot, observedAt } = this.observeLiveBoot(`start attempt for turn ${input.turnId}`);
    const startedAt = input.startedAt === undefined ? observedAt : this.readTimestamp(input.startedAt);
    if (startedAt > observedAt) {
      throw new Error("Crash recovery attempt startedAt cannot be after the current ownership observation");
    }
    const leaseExpiresAt = Math.min(observedAt + this.leaseMs, boot.leaseExpiresAt);
    if (leaseExpiresAt <= observedAt) {
      throw this.enterFailClosed(`No live crash recovery lease remains for turn ${input.turnId}`);
    }

    let attempt: RuntimeTurnAttemptRecord;
    try {
      attempt = this.store.createTurnAttempt({
        ...input,
        bootEpoch: boot.bootEpoch,
        startedAt,
        lastHeartbeatAt: observedAt,
        leaseExpiresAt,
      });
    } catch (cause) {
      throw this.enterFailClosed(
        `Lost crash recovery ownership while creating an attempt for turn ${input.turnId}`,
        cause,
      );
    }
    if (
      !attempt ||
      !isNonEmptyText(attempt.attemptId) ||
      attempt.status !== "running" ||
      (input.attemptId !== undefined && attempt.attemptId !== input.attemptId) ||
      attempt.turnId !== input.turnId ||
      attempt.recoveredFromAttemptId !== (input.recoveredFromAttemptId ?? null) ||
      attempt.runId !== input.runId ||
      attempt.sessionKey !== input.sessionKey ||
      attempt.sessionName !== (input.sessionName ?? null) ||
      attempt.agentId !== input.agentId ||
      attempt.provider !== input.provider ||
      attempt.model !== input.model ||
      attempt.bootEpoch !== boot.bootEpoch ||
      attempt.startedAt !== startedAt ||
      !Number.isSafeInteger(attempt.leaseExpiresAt) ||
      attempt.leaseExpiresAt > boot.leaseExpiresAt ||
      attempt.leaseExpiresAt <= observedAt ||
      attempt.lastHeartbeatAt !== observedAt ||
      attempt.completedAt !== null ||
      attempt.requestBlobSha256 !== (input.requestBlobSha256 ?? null) ||
      attempt.userPromptSha256 !== (input.userPromptSha256 ?? null) ||
      attempt.systemPromptSha256 !== (input.systemPromptSha256 ?? null) ||
      !hasSameJsonValue(attempt.checkpoint, input.checkpoint ?? null) ||
      attempt.originKind !== input.originKind ||
      !hasSameJsonValue(attempt.source, input.source ?? null) ||
      !hasSameJsonValue(attempt.turnProvenance, input.turnProvenance ?? null) ||
      attempt.taskBarrierTaskId !== (input.taskBarrierTaskId ?? null) ||
      attempt.deliveryBarrier !== input.deliveryBarrier ||
      !hasSameJsonValue(attempt.pendingIds, input.pendingIds ?? []) ||
      attempt.startedTool !== false ||
      attempt.materializedOutput !== false ||
      attempt.recoveryClaimId !== null ||
      attempt.recoveryStatus !== null ||
      attempt.recoveryReason !== null ||
      attempt.recoveryRunId !== null ||
      attempt.recoveredAt !== null ||
      !hasSameJsonValue(attempt.metadata, input.metadata ?? null) ||
      attempt.createdAt !== startedAt ||
      attempt.updatedAt !== startedAt
    ) {
      throw this.enterFailClosed(`Crash recovery store returned an invalid new attempt for turn ${input.turnId}`);
    }

    this.activeAttempts.set(attempt.attemptId, {
      record: attempt,
      onOwnershipLost: options.onOwnershipLost,
    });
    const { observedAt: persistedAt } = this.observeLiveBoot(`complete attempt creation for turn ${input.turnId}`);
    return this.requireLiveActiveAttempt(attempt.attemptId, persistedAt).record;
  }

  markTurnAttemptSafety(input: RuntimeCrashRecoverySafetyInput): RuntimeTurnAttemptRecord {
    const { observedAt } = this.observeLiveBoot(`mark turn attempt safety for ${input.attemptId}`);
    const activeAttempt = this.requireLiveActiveAttempt(input.attemptId, observedAt);
    if (!input.startedTool && !input.materializedOutput) {
      throw new Error("At least one monotonic safety marker must be set");
    }
    if (
      (!input.startedTool || activeAttempt.record.startedTool) &&
      (!input.materializedOutput || activeAttempt.record.materializedOutput)
    ) {
      return activeAttempt.record;
    }
    const markedAt = input.markedAt === undefined ? observedAt : this.readTimestamp(input.markedAt);
    if (markedAt > observedAt) {
      throw new Error("Crash recovery safety markedAt cannot be after the current ownership observation");
    }
    let attempt: RuntimeTurnAttemptRecord;
    try {
      attempt = this.store.markTurnAttemptSafety({ ...input, markedAt });
    } catch (cause) {
      throw this.enterFailClosed(`Lost crash recovery safety marker fence for ${input.attemptId}`, cause);
    }
    if (
      !attempt ||
      attempt.status !== "running" ||
      !hasSameAttemptIdentity(activeAttempt.record, attempt) ||
      attempt.lastHeartbeatAt !== activeAttempt.record.lastHeartbeatAt ||
      attempt.leaseExpiresAt !== activeAttempt.record.leaseExpiresAt ||
      attempt.startedTool !== (activeAttempt.record.startedTool || input.startedTool === true) ||
      attempt.materializedOutput !== (activeAttempt.record.materializedOutput || input.materializedOutput === true) ||
      !hasSameJsonValue(attempt.metadata, activeAttempt.record.metadata) ||
      attempt.updatedAt !== markedAt
    ) {
      throw this.enterFailClosed(`Crash recovery store returned an invalid marked attempt ${input.attemptId}`);
    }
    const { observedAt: persistedAt } = this.observeLiveBoot(
      `complete turn attempt safety marker for ${input.attemptId}`,
    );
    this.requireLiveActiveAttempt(input.attemptId, persistedAt);
    activeAttempt.record = attempt;
    return this.requireLiveActiveAttempt(input.attemptId, persistedAt).record;
  }

  terminalizeTurnAttempt(input: RuntimeCrashRecoveryTerminalInput): RuntimeTurnAttemptRecord {
    const { observedAt } = this.observeLiveBoot(`terminalize turn attempt ${input.attemptId}`);
    const activeAttempt = this.requireLiveActiveAttempt(input.attemptId, observedAt);
    const completedAt = input.completedAt === undefined ? observedAt : this.readTimestamp(input.completedAt);
    if (completedAt > observedAt) {
      throw new Error("Crash recovery attempt completedAt cannot be after the current ownership observation");
    }
    const expectedMetadata = { ...(activeAttempt.record.metadata ?? {}), ...(input.metadata ?? {}) };
    let attempt: RuntimeTurnAttemptRecord;
    try {
      attempt = this.store.terminalizeTurnAttempt({ ...input, completedAt });
    } catch (cause) {
      throw this.enterFailClosed(`Lost crash recovery terminal fence for ${input.attemptId}`, cause);
    }
    if (
      !attempt ||
      attempt.status !== input.status ||
      !hasSameAttemptIdentity(activeAttempt.record, attempt) ||
      attempt.lastHeartbeatAt !== activeAttempt.record.lastHeartbeatAt ||
      attempt.leaseExpiresAt !== activeAttempt.record.leaseExpiresAt ||
      attempt.completedAt !== completedAt ||
      attempt.startedTool !== activeAttempt.record.startedTool ||
      attempt.materializedOutput !== activeAttempt.record.materializedOutput ||
      !hasSameJsonValue(attempt.metadata, expectedMetadata) ||
      attempt.updatedAt !== completedAt
    ) {
      throw this.enterFailClosed(`Crash recovery store did not terminalize attempt ${input.attemptId}`);
    }
    const { observedAt: persistedAt } = this.observeLiveBoot(
      `complete turn attempt terminalization for ${input.attemptId}`,
    );
    this.requireLiveActiveAttempt(input.attemptId, persistedAt);
    activeAttempt.record = attempt;
    this.requireLiveActiveAttempt(input.attemptId, persistedAt);
    this.activeAttempts.delete(input.attemptId);
    return attempt;
  }

  stopGracefully(reason?: string): RuntimeBootEpochRecord {
    if (this.state === "graceful_stopped" && this.currentBoot) {
      return this.currentBoot;
    }
    const { boot } = this.observeLiveBoot("stop gracefully");
    this.state = "stopping";
    this.clearHeartbeatTimer();

    try {
      for (const [attemptId, activeAttempt] of [...this.activeAttempts]) {
        const attemptObservedAt = this.observeOwnedBoot(boot, `abort attempt ${attemptId} during graceful stop`);
        this.requireLiveActiveAttempt(attemptId, attemptObservedAt);
        const attempt = this.store.terminalizeTurnAttempt({
          attemptId,
          status: "aborted",
          completedAt: attemptObservedAt,
        });
        if (
          !attempt ||
          attempt.status !== "aborted" ||
          !hasSameAttemptIdentity(activeAttempt.record, attempt) ||
          attempt.lastHeartbeatAt !== activeAttempt.record.lastHeartbeatAt ||
          attempt.leaseExpiresAt !== activeAttempt.record.leaseExpiresAt ||
          attempt.completedAt !== attemptObservedAt ||
          attempt.startedTool !== activeAttempt.record.startedTool ||
          attempt.materializedOutput !== activeAttempt.record.materializedOutput ||
          !hasSameJsonValue(attempt.metadata, { ...(activeAttempt.record.metadata ?? {}) }) ||
          attempt.updatedAt !== attemptObservedAt
        ) {
          throw new Error(`Crash recovery store did not abort attempt ${attemptId}`);
        }
        const persistedAt = this.observeOwnedBoot(boot, `complete graceful abort for attempt ${attemptId}`);
        this.requireLiveActiveAttempt(attemptId, persistedAt);
        activeAttempt.record = attempt;
        this.requireLiveActiveAttempt(attemptId, persistedAt);
        this.activeAttempts.delete(attemptId);
      }

      const stoppedAt = this.observeOwnedBoot(boot, `mark boot ${boot.bootEpoch} gracefully stopped`);
      const stoppedBoot = this.store.markBootEpochGracefulStopped({
        bootEpoch: boot.bootEpoch,
        stoppedAt,
        reason,
      });
      if (
        !stoppedBoot ||
        stoppedBoot.status !== "graceful_stopped" ||
        stoppedBoot.bootEpoch !== boot.bootEpoch ||
        stoppedBoot.instanceId !== boot.instanceId ||
        stoppedBoot.pid !== boot.pid ||
        stoppedBoot.startedAt !== boot.startedAt ||
        stoppedBoot.lastHeartbeatAt !== boot.lastHeartbeatAt ||
        stoppedBoot.leaseExpiresAt !== boot.leaseExpiresAt ||
        stoppedBoot.gracefulStoppedAt !== stoppedAt ||
        stoppedBoot.abandonedAt !== null ||
        stoppedBoot.stopReason !== (reason?.trim() || null) ||
        !hasSameJsonValue(stoppedBoot.metadata, boot.metadata) ||
        stoppedBoot.createdAt !== boot.createdAt ||
        stoppedBoot.updatedAt !== stoppedAt
      ) {
        throw new Error(`Crash recovery store did not gracefully stop boot ${boot.bootEpoch}`);
      }
      this.observeOwnedBoot(boot, `complete graceful stop for boot ${boot.bootEpoch}`);
      this.currentBoot = stoppedBoot;
      this.state = "graceful_stopped";
      return stoppedBoot;
    } catch (cause) {
      throw this.enterFailClosed(`Failed to gracefully stop crash recovery boot ${boot.bootEpoch}`, cause);
    }
  }

  private requireRunningBoot(operation: string): RuntimeBootEpochRecord {
    if (this.state === "ownership_lost" && this.ownershipLostError) {
      throw this.ownershipLostError;
    }
    if (this.state !== "running" || !this.currentBoot || this.currentBoot.status !== "active") {
      throw new Error(`Crash recovery coordinator cannot ${operation} from state ${this.state}`);
    }
    return this.currentBoot;
  }

  private requireActiveAttempt(attemptId: string): ActiveAttempt {
    const attempt = this.activeAttempts.get(attemptId);
    if (!attempt) {
      throw new Error(`Crash recovery attempt is not active in this coordinator: ${attemptId}`);
    }
    return attempt;
  }

  private observeLiveBoot(operation: string): { boot: RuntimeBootEpochRecord; observedAt: number } {
    const boot = this.requireRunningBoot(operation);
    const observedAt = this.readOwnershipNow(operation);
    this.assertBootLeaseLive(boot, observedAt, operation);
    return { boot, observedAt };
  }

  private observeOwnedBoot(boot: RuntimeBootEpochRecord, operation: string): number {
    if (this.currentBoot?.bootEpoch !== boot.bootEpoch || this.currentBoot.status !== "active") {
      throw this.enterFailClosed(`Crash recovery boot ownership changed before ${operation} for ${boot.bootEpoch}`);
    }
    const observedAt = this.readOwnershipNow(operation);
    this.assertBootLeaseLive(boot, observedAt, operation);
    return observedAt;
  }

  private assertBootLeaseLive(boot: RuntimeBootEpochRecord, observedAt: number, operation: string): void {
    if (observedAt < boot.lastHeartbeatAt) {
      throw this.enterFailClosed(`Crash recovery clock moved behind boot ownership for ${boot.bootEpoch}`);
    }
    if (observedAt >= boot.leaseExpiresAt) {
      throw this.enterFailClosed(`Crash recovery boot lease expired before ${operation} for ${boot.bootEpoch}`);
    }
  }

  private requireLiveActiveAttempt(attemptId: string, observedAt: number): ActiveAttempt {
    const attempt = this.requireActiveAttempt(attemptId);
    const boot = this.currentBoot;
    if (attempt.record.bootEpoch !== boot?.bootEpoch) {
      throw this.enterFailClosed(`Crash recovery attempt ${attemptId} is owned by a different boot epoch`);
    }
    if (attempt.record.leaseExpiresAt > boot.leaseExpiresAt) {
      throw this.enterFailClosed(`Crash recovery attempt ${attemptId} outlived its owning boot lease`);
    }
    if (observedAt < attempt.record.lastHeartbeatAt) {
      throw this.enterFailClosed(`Crash recovery clock moved behind attempt ownership for ${attemptId}`);
    }
    if (observedAt >= attempt.record.leaseExpiresAt) {
      throw this.enterFailClosed(`Crash recovery attempt lease expired before owner mutation for ${attemptId}`);
    }
    return attempt;
  }

  private enterFailClosed(message: string, cause?: unknown): RuntimeCrashRecoveryOwnershipLostError {
    if (this.state === "ownership_lost" && this.ownershipLostError) {
      return this.ownershipLostError;
    }

    const error = new RuntimeCrashRecoveryOwnershipLostError(message, { cause });
    this.state = "ownership_lost";
    this.ownershipLostError = error;
    this.clearHeartbeatTimer();

    const attempts = [...this.activeAttempts.values()];
    this.activeAttempts.clear();
    for (const attempt of attempts) {
      try {
        attempt.onOwnershipLost?.(error);
      } catch {
        // Every attempt must receive the notification even if one callback is faulty.
      }
    }
    try {
      this.onOwnershipLost?.(error);
    } catch {
      // The coordinator is already fenced. Host cleanup must not replace the
      // original ownership error or prevent the caller from observing it.
    }
    return error;
  }

  private clearHeartbeatTimer(): void {
    const timer = this.heartbeatTimer;
    this.heartbeatTimer = null;
    if (!timer) return;
    try {
      this.cancelInterval(timer);
    } catch {
      // State is updated before cancellation so a custom timer implementation
      // cannot leave the coordinator accepting work after cancellation fails.
    }
  }

  private readNow(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("Crash recovery clock must return a non-negative safe integer timestamp");
    }
    return value;
  }

  private readOwnershipNow(operation: string): number {
    try {
      return this.readNow();
    } catch (cause) {
      throw this.enterFailClosed(`Crash recovery clock failed while attempting to ${operation}`, cause);
    }
  }

  private readTimestamp(value: number | undefined): number {
    if (value === undefined) return this.readNow();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("Crash recovery timestamp must be a non-negative safe integer");
    }
    return value;
  }
}

function requireNonEmptyText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must be a non-empty string`);
  return normalized;
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function hasSameAttemptIdentity(previous: RuntimeTurnAttemptRecord, next: RuntimeTurnAttemptRecord): boolean {
  return (
    next.attemptId === previous.attemptId &&
    next.turnId === previous.turnId &&
    next.recoveredFromAttemptId === previous.recoveredFromAttemptId &&
    next.runId === previous.runId &&
    next.sessionKey === previous.sessionKey &&
    next.sessionName === previous.sessionName &&
    next.agentId === previous.agentId &&
    next.provider === previous.provider &&
    next.model === previous.model &&
    next.bootEpoch === previous.bootEpoch &&
    next.startedAt === previous.startedAt &&
    next.requestBlobSha256 === previous.requestBlobSha256 &&
    next.userPromptSha256 === previous.userPromptSha256 &&
    next.systemPromptSha256 === previous.systemPromptSha256 &&
    hasSameJsonValue(next.checkpoint, previous.checkpoint) &&
    next.originKind === previous.originKind &&
    hasSameJsonValue(next.source, previous.source) &&
    hasSameJsonValue(next.turnProvenance, previous.turnProvenance) &&
    next.taskBarrierTaskId === previous.taskBarrierTaskId &&
    next.deliveryBarrier === previous.deliveryBarrier &&
    hasSameJsonValue(next.pendingIds, previous.pendingIds) &&
    next.recoveryClaimId === previous.recoveryClaimId &&
    next.recoveryStatus === previous.recoveryStatus &&
    next.recoveryReason === previous.recoveryReason &&
    next.recoveryRunId === previous.recoveryRunId &&
    next.recoveredAt === previous.recoveredAt &&
    next.createdAt === previous.createdAt
  );
}

function hasSameJsonValue(left: unknown, right: unknown): boolean {
  try {
    return isDeepStrictEqual(normalizeJsonValue(left), normalizeJsonValue(right));
  } catch {
    return false;
  }
}

function normalizeJsonValue(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? undefined : JSON.parse(serialized);
}
