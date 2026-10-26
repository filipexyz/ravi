/** Human byte formatting shared by storage output and notifications. */

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

export function formatByteSize(bytes: number): string {
  const value = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  if (value < 1024) return `${value} B`;
  let scaled = value / 1024;
  let index = 0;
  while (scaled >= 1024 && index < UNITS.length - 1) {
    scaled /= 1024;
    index += 1;
  }
  return `${scaled.toFixed(1)} ${UNITS[index]}`;
}

/** Same scale, but always expressed in GB for the weekly operator message. */
export function formatGigabytes(bytes: number): string {
  return `${(Math.max(0, bytes) / 1024 ** 3).toFixed(2)} GB`;
}
