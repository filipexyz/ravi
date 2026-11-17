import { AsyncLocalStorage } from "node:async_hooks";

export const DEFAULT_WORK_DRAIN_TIMEOUT_MS = 10_000;

export interface WorkDrainStatus {
  scope: string;
  phase: "accepting" | "draining" | "drained" | "blocked";
  pending: number;
  accepted: number;
  completed: number;
  failures: readonly string[];
}

/** Component evidence only. This does not attest process exit or durable queues outside this scope. */
export interface WorkDrainProof {
  protocol: "ravi.work-drain/v1";
  scope: string;
  accepted: number;
  completed: number;
  completedAt: number;
}

/** Synchronous admission fence plus accounting that survives callers catching failures. */
export class TrackedWorkDrain {
  private accepting = true;
  private accepted = 0;
  private completed = 0;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly failures = new Set<string>();
  private readonly activeWork = new AsyncLocalStorage<{ active: boolean }>();

  constructor(private readonly scope: string) {}

  run<T>(label: string, work: () => T | Promise<T>): Promise<T> {
    if (!this.accepting) return Promise.reject(new Error(`WORK_DRAIN_ADMISSION_CLOSED: ${this.scope}`));
    return this.track(label, work);
  }

  /** Accounts for existing detached work without changing whether its callback executes. */
  runContinuation<T>(label: string, work: () => T | Promise<T>): Promise<T> {
    if (!this.accepting && !this.activeWork.getStore()?.active) {
      this.recordFailure(`unowned-continuation:${label}`);
    }
    return this.track(label, work);
  }

  private track<T>(label: string, work: () => T | Promise<T>): Promise<T> {
    this.accepted += 1;
    const admission = { active: true };
    let resolveTask!: (value: T | PromiseLike<T>) => void;
    let rejectTask!: (error: unknown) => void;
    const task = new Promise<T>((resolve, reject) => {
      resolveTask = resolve;
      rejectTask = reject;
    });
    this.pending.add(task);
    void task.then(
      () => {
        admission.active = false;
        this.completed += 1;
        this.pending.delete(task);
      },
      () => {
        // no-cause: This accounting observer latches failure; callers retain the original rejected task.
        admission.active = false;
        this.recordFailure(label);
        this.pending.delete(task);
      },
    );
    try {
      resolveTask(this.activeWork.run(admission, work));
    } catch (error) {
      rejectTask(error);
    }
    return task;
  }

  recordFailure(label: string): void {
    this.failures.add(label);
  }

  beginDrain(): void {
    this.accepting = false;
  }

  status(): WorkDrainStatus {
    return {
      scope: this.scope,
      phase: this.failures.size ? "blocked" : this.accepting ? "accepting" : this.pending.size ? "draining" : "drained",
      pending: this.pending.size,
      accepted: this.accepted,
      completed: this.completed,
      failures: [...this.failures],
    };
  }

  async waitForDrain(timeoutMs = DEFAULT_WORK_DRAIN_TIMEOUT_MS): Promise<WorkDrainProof> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new RangeError("Drain timeout must be positive");
    this.beginDrain();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          // Accepted handlers can register detached continuations while draining.
          while (this.pending.size) await Promise.allSettled([...this.pending]);
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            this.recordFailure("drain-timeout");
            reject(new Error(`WORK_DRAIN_TIMEOUT: ${this.scope}`));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (this.failures.size) throw new Error(`WORK_DRAIN_UNPROVEN: ${this.scope}: ${[...this.failures].join(", ")}`);
    return {
      protocol: "ravi.work-drain/v1",
      scope: this.scope,
      accepted: this.accepted,
      completed: this.completed,
      completedAt: Date.now(),
    };
  }
}
