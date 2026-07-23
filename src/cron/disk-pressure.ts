/**
 * Disk-pressure classification for cron shell failures.
 *
 * Cron shell jobs that fail because the host ran out of space surface as
 * generic non-zero exits or opaque spawn errors. Operators then chase the
 * command instead of the real cause. This helper recognizes the common
 * out-of-space signatures and returns a stable, actionable hint so the
 * failure is classified as disk pressure in `lastError` and notifications.
 */

const DISK_PRESSURE_PATTERNS: RegExp[] = [
  /ENOSPC/i,
  /no space left on device/i,
  /cannot create temp(?:orary)? file/i,
  /failed to (?:create|write) temp(?:orary)? file/i,
  /write error: no space/i,
  /disk (?:is )?full/i,
  /quota exceeded/i,
];

export const DISK_PRESSURE_HINT =
  "Host disk or temp space is exhausted (ENOSPC). Run `ravi doctor --domain runtime` to inspect free space " +
  "for the working, temp, and state directories, then free space with an approved cleanup before rerunning.";

/**
 * Returns true when any of the provided text fragments look like an
 * out-of-disk / temp-file-creation failure.
 */
export function isDiskPressureFailure(...fragments: Array<string | null | undefined>): boolean {
  for (const fragment of fragments) {
    if (!fragment) continue;
    for (const pattern of DISK_PRESSURE_PATTERNS) {
      if (pattern.test(fragment)) return true;
    }
  }
  return false;
}

/**
 * Returns the disk-pressure fix hint when the fragments indicate an
 * out-of-space failure, otherwise undefined.
 */
export function classifyDiskPressureHint(...fragments: Array<string | null | undefined>): string | undefined {
  return isDiskPressureFailure(...fragments) ? DISK_PRESSURE_HINT : undefined;
}
