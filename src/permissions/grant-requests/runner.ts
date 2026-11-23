import { logger } from "../../utils/logger.js";
import { sweepExpiredGrantRequests } from "./service.js";

const log = logger.child("permissions:grant-requests");

const SWEEP_INTERVAL_MS = 30_000;
let timer: ReturnType<typeof setInterval> | null = null;

/** Flip requests nobody answered to `expired`, so `pending` always means "still answerable". */
export function startGrantRequestSweeper(intervalMs: number = SWEEP_INTERVAL_MS): void {
  if (timer) return;
  timer = setInterval(() => {
    try {
      sweepExpiredGrantRequests();
    } catch (error) {
      log.warn("Grant request sweep failed", { error: error instanceof Error ? error.message : String(error) });
    }
  }, intervalMs);
  timer.unref?.();
}

export function stopGrantRequestSweeper(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
