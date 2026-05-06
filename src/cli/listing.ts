import { Buffer } from "node:buffer";
import { parseDurationMs } from "../cron/schedule.js";
import { fail } from "./context.js";

export type ListOrder = "asc" | "desc";

export interface ListCursorPayload {
  sort: string;
  order: ListOrder;
  value: number;
  id: string;
  filters?: string;
}

const DURATION_RE = /^\d+[smhd]$/i;

export function parseListLimit(
  value: string | undefined,
  options: { defaultValue: number; maxValue?: number; flag?: string },
): number {
  const flag = options.flag ?? "--limit";
  const normalized = value?.trim();
  if (!normalized) {
    return options.defaultValue;
  }

  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== normalized) {
    fail(`Invalid ${flag} value: ${value}. Use a positive integer.`);
  }
  if (options.maxValue && parsed > options.maxValue) {
    fail(`Invalid ${flag} value: ${value}. Maximum is ${options.maxValue}.`);
  }
  return parsed;
}

export function parseListOrder(value: string | undefined, defaultValue: ListOrder = "desc"): ListOrder {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return defaultValue;
  if (normalized !== "asc" && normalized !== "desc") {
    fail(`Invalid --order value: ${value}. Use asc|desc.`);
  }
  return normalized;
}

export function parseListSort<T extends string>(value: string | undefined, allowed: readonly T[], defaultValue: T): T {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return defaultValue;
  if (!allowed.includes(normalized as T)) {
    fail(`Invalid --sort value: ${value}. Use ${allowed.join("|")}.`);
  }
  return normalized as T;
}

export function parseListTimeBound(value: string | undefined, flag: string, now = Date.now()): number | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;

  if (DURATION_RE.test(normalized)) {
    try {
      return now - parseDurationMs(normalized.toLowerCase());
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  if (/^\d+$/.test(normalized)) {
    const parsed = Number.parseInt(normalized, 10);
    if (Number.isSafeInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  const parsed = Date.parse(normalized);
  if (Number.isFinite(parsed)) {
    return parsed;
  }

  fail(`Invalid ${flag} value: ${value}. Use a duration like 1d, epoch ms, or ISO datetime.`);
}

export function encodeListCursor(payload: ListCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeListCursor(value: string | undefined): ListCursorPayload | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;

  try {
    const parsed = JSON.parse(Buffer.from(normalized, "base64url").toString("utf8")) as Partial<ListCursorPayload>;
    if (
      typeof parsed.sort === "string" &&
      (parsed.order === "asc" || parsed.order === "desc") &&
      typeof parsed.value === "number" &&
      Number.isFinite(parsed.value) &&
      typeof parsed.id === "string" &&
      parsed.id.trim()
    ) {
      return {
        sort: parsed.sort,
        order: parsed.order,
        value: parsed.value,
        id: parsed.id,
        ...(typeof parsed.filters === "string" ? { filters: parsed.filters } : {}),
      };
    }
  } catch {
    // Fall through to the normalized CLI error below.
  }

  fail("Invalid --cursor value. Use the opaque nextCursor returned by the previous page.");
}
