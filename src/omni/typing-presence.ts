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

export interface TypingPresenceClock {
  now(): number;
}

export type TypingPresenceSessionActivityResolver = (sessionName: string) => boolean;

const defaultTimers: TypingPresenceTimers = {
  setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
  clearInterval: (handle) => clearInterval(handle),
};

const defaultClock: TypingPresenceClock = {
  now: () => Date.now(),
};

const DEFAULT_STALE_AFTER_MS = 2 * 60 * 1000;

export class TypingPresenceHeartbeat {
  private readonly sessions = new Map<
    string,
    { target: TypingPresenceTarget; timer: IntervalHandle; lastActivityAt: number }
  >();

  constructor(
    private readonly sendPresence: (target: TypingPresenceTarget, active: boolean) => Promise<void>,
    private readonly refreshMs = 20_000,
    private readonly timers: TypingPresenceTimers = defaultTimers,
    private readonly staleAfterMs = DEFAULT_STALE_AFTER_MS,
    private readonly clock: TypingPresenceClock = defaultClock,
    private readonly isSessionActive?: TypingPresenceSessionActivityResolver,
  ) {}

  async start(sessionName: string, target: TypingPresenceTarget): Promise<void> {
    const previous = this.sessions.get(sessionName);
    if (previous) {
      this.timers.clearInterval(previous.timer);
      if (!this.sameTarget(previous.target, target)) {
        await this.safeSend(sessionName, previous.target, false);
      }
    }

    const lastActivityAt = this.clock.now();
    await this.safeSend(sessionName, target, true);

    const timer = this.timers.setInterval(() => {
      const current = this.sessions.get(sessionName);
      if (!current) return;
      if (this.isSessionActive && !this.isSessionActive(sessionName)) {
        log.info("Stopping typing presence heartbeat for inactive session", { sessionName });
        void this.stop(sessionName);
        return;
      }
      const ageMs = this.clock.now() - current.lastActivityAt;
      if (ageMs >= this.staleAfterMs) {
        log.warn("Stopping stale typing presence heartbeat", { sessionName, ageMs, staleAfterMs: this.staleAfterMs });
        void this.stop(sessionName);
        return;
      }
      void this.safeSend(sessionName, current.target, true);
    }, this.refreshMs);

    timer.unref?.();
    this.sessions.set(sessionName, { target, timer, lastActivityAt });
  }

  async renew(sessionName: string): Promise<boolean> {
    const current = this.sessions.get(sessionName);
    if (!current) return false;

    current.lastActivityAt = this.clock.now();
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
