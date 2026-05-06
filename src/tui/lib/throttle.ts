export interface ThrottledFlush {
  schedule(): void;
  flushNow(): void;
  cancel(): void;
}

/**
 * Trailing-edge throttle: ensures `flush` runs at most once per `windowMs`.
 *
 * `schedule()` may be called many times in rapid succession — a single timer
 * is armed on the first call and `flush` is invoked at the trailing edge of
 * the window. Subsequent calls during the window are no-ops.
 *
 * `flushNow()` runs `flush` synchronously and clears any pending timer.
 * `cancel()` discards any pending flush without running it.
 */
export function createThrottledFlush(flush: () => void, windowMs: number): ThrottledFlush {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = (): void => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, windowMs);
  };

  const flushNow = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    flush();
  };

  const cancel = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return { schedule, flushNow, cancel };
}
