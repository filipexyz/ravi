export function timestampLikeToNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint" && value > 0n) {
    const asNumber = Number(value);
    return Number.isFinite(asNumber) ? asNumber : undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (!value || typeof value !== "object") return undefined;

  const record = value as Record<string, unknown>;
  const direct =
    timestampLikeToNumber(record.seconds) ??
    timestampLikeToNumber(record._seconds) ??
    timestampLikeToNumber(record.timestamp) ??
    timestampLikeToNumber(record.value);
  if (direct !== undefined) return direct;

  if (typeof record.low === "number" && typeof record.high === "number") {
    const longValue = (BigInt(record.high) << 32n) + BigInt(record.low >>> 0);
    if (longValue <= 0n) return undefined;
    const asNumber = Number(longValue);
    return Number.isFinite(asNumber) ? asNumber : undefined;
  }

  return undefined;
}

export function timestampLikeToMs(value: unknown): number | undefined {
  const timestamp = timestampLikeToNumber(value);
  if (timestamp === undefined || timestamp <= 0) return undefined;
  return timestamp > 1e12 ? Math.trunc(timestamp) : Math.trunc(timestamp * 1000);
}

export function firstProviderTimestampMs(...values: unknown[]): number | undefined {
  for (const value of values) {
    const timestamp = timestampLikeToMs(value);
    if (timestamp !== undefined) return timestamp;
  }
  return undefined;
}
