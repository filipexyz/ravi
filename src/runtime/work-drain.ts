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

  constructor(private readonly scope: string) {}

  run<T>(label: string, work: () => T | Promise<T>): Promise<T> {
    if (!this.accepting) return Promise.reject(new Error(`WORK_DRAIN_ADMISSION_CLOSED: ${this.scope}`));
    this.accepted += 1;
    let resolveTask!: (value: T | PromiseLike<T>) => void;
    let rejectTask!: (error: unknown) => void;
    const task = new Promise<T>((resolve, reject) => {
      resolveTask = resolve;
      rejectTask = reject;
    });
    this.pending.add(task);
    void task.then(
      () => {
        this.completed += 1;
        this.pending.delete(task);
      },
      () => {
        this.recordFailure(label);
        this.pending.delete(task);
      },
    );
    try {
      resolveTask(work());
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
        Promise.allSettled([...this.pending]),
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
