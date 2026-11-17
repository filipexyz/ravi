import { prError, type PublicationTimeout } from "./contracts.js";

/** Budget of a publication with nothing to upload, and of the preflight that measures the upload. */
export const PUBLICATION_TIMEOUT_MS = 180_000;
/** No publication, adaptive or overridden, runs longer than this. */
export const PUBLICATION_TIMEOUT_CEILING_MS = 900_000;
export const PUBLICATION_TIMEOUT_ENV = "RAVI_PR_PUBLISH_TIMEOUT_MS";
/** One extra second per this many bytes: the upload rate the budget assumes (about 2 Mbit/s). */
export const PUBLICATION_BYTES_PER_EXTRA_SECOND = 250 * 1024;
/** Deadline of one subprocess before any allowance for the bytes it carries. */
export const PUBLICATION_REQUEST_TIMEOUT_MS = 20_000;

const extraMs = (bytes: number) => Math.ceil(Math.max(0, bytes) / PUBLICATION_BYTES_PER_EXTRA_SECOND) * 1000;

/**
 * Total time budget of one publication: the base plus one second per 250 KiB the preflight measured,
 * never above the ceiling. The operator's override replaces the adaptive value and obeys the same ceiling.
 */
export function publicationBudgetMs(uploadBytes: number, env: NodeJS.ProcessEnv = process.env): number {
  const override = env[PUBLICATION_TIMEOUT_ENV]?.trim();
  if (override) {
    const value = /^\d{1,12}$/.test(override) ? Number(override) : 0;
    if (value <= 0)
      throw prError(
        "USAGE_ERROR",
        `${PUBLICATION_TIMEOUT_ENV} must be a positive whole number of milliseconds (at most ${PUBLICATION_TIMEOUT_CEILING_MS}).`,
        {},
        2,
      );
    return Math.min(value, PUBLICATION_TIMEOUT_CEILING_MS);
  }
  return Math.min(PUBLICATION_TIMEOUT_MS + extraMs(uploadBytes), PUBLICATION_TIMEOUT_CEILING_MS);
}

/** Deadline of one GitHub request that carries `bytes`, at the same assumed rate. */
export function publicationRequestTimeoutMs(bytes: number): number {
  return PUBLICATION_REQUEST_TIMEOUT_MS + extraMs(bytes);
}

/** A deadline measured from the start of the publication, re-armed once the preflight knows the upload size. */
export function createPublicationDeadline(initialMs: number) {
  const controller = new AbortController();
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const setBudget = (budgetMs: number) => {
    if (controller.signal.aborted) return;
    clearTimeout(timer);
    const left = startedAt + budgetMs - Date.now();
    if (left <= 0) return controller.abort();
    timer = setTimeout(() => controller.abort(), left);
    timer.unref?.();
  };
  setBudget(initialMs);
  return { signal: controller.signal as AbortSignal, setBudget, dispose: () => clearTimeout(timer) };
}

const mib = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;

/** The timeout a caller can act on: the phase, what GitHub already confirmed and what was still missing. */
export function publicationTimeoutError(timeout: PublicationTimeout, details: Record<string, unknown> = {}) {
  const progress =
    timeout.objectCount === null || timeout.uploadBytes === null
      ? "before the upload size was measured; this attempt uploaded nothing"
      : `after uploading ${timeout.objectsUploaded} of ${timeout.objectCount} objects (${mib(timeout.bytesUploaded)} of ${mib(timeout.uploadBytes)})`;
  return prError(
    "PUBLICATION_TIMEOUT",
    `Publication exceeded its ${Math.round(timeout.budgetMs / 1000)}s budget in phase ${timeout.phase}, ${progress}. ` +
      `Rerun with the same --expect-sha: objects GitHub already holds are skipped. ` +
      `${PUBLICATION_TIMEOUT_ENV} raises the budget up to ${PUBLICATION_TIMEOUT_CEILING_MS / 1000}s.`,
    { ...details, retryable: true, timeout },
  );
}
