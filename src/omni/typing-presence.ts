import { logger } from "../utils/logger.js";

const log = logger.child("omni:typing-presence");

export interface TypingPresenceTarget {
  instanceId: string;
  to: string;
}

type IntervalHandle = ReturnType<typeof setInterval>;

export interface TypingPresenceTimers {
  setInterval(callback: () => void, intervalMs: number): IntervalHandle;
  clearInterval(handle: IntervalHandle): void;
}

const defaultTimers: TypingPresenceTimers = {
  setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
  clearInterval: (handle) => clearInterval(handle),
};

export class TypingPresenceHeartbeat {
  private readonly sessions = new Map<string, { target: TypingPresenceTarget; timer: IntervalHandle }>();

  constructor(
    private readonly sendPresence: (target: TypingPresenceTarget, active: boolean) => Promise<void>,
    private readonly refreshMs = 20_000,
    private readonly timers: TypingPresenceTimers = defaultTimers,
  ) {}

  async start(sessionName: string, target: TypingPresenceTarget): Promise<void> {
    const previous = this.sessions.get(sessionName);
    if (previous) {
      this.timers.clearInterval(previous.timer);
      if (!this.sameTarget(previous.target, target)) {
        await this.safeSend(sessionName, previous.target, false);
      }
    }

    await this.safeSend(sessionName, target, true);

    const timer = this.timers.setInterval(() => {
      void this.safeSend(sessionName, target, true);
    }, this.refreshMs);

    timer.unref?.();
    this.sessions.set(sessionName, { target, timer });
  }

  async renew(sessionName: string): Promise<boolean> {
    const current = this.sessions.get(sessionName);
    if (!current) return false;

    await this.safeSend(sessionName, current.target, true);
    return true;
  }

  async stop(sessionName: string): Promise<void> {
    const current = this.sessions.get(sessionName);
    if (!current) return;

    this.sessions.delete(sessionName);
    this.timers.clearInterval(current.timer);
    await this.safeSend(sessionName, current.target, false);
  }

  async stopAll(): Promise<void> {
    const sessionNames = [...this.sessions.keys()];
    await Promise.all(sessionNames.map((sessionName) => this.stop(sessionName)));
  }

  has(sessionName: string): boolean {
    return this.sessions.has(sessionName);
  }

  private sameTarget(left: TypingPresenceTarget, right: TypingPresenceTarget): boolean {
    return left.instanceId === right.instanceId && left.to === right.to;
  }

  private async safeSend(sessionName: string, target: TypingPresenceTarget, active: boolean): Promise<void> {
    try {
      await this.sendPresence(target, active);
    } catch (error) {
      log.debug("Typing presence update failed", { sessionName, active, error });
    }
  }
}
