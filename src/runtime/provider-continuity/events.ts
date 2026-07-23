import { createHash } from "node:crypto";
import {
  appendProviderContinuityEvent,
  listProviderContinuityEvents,
  requireProviderContinuityJournal,
} from "./store.js";
import {
  PROVIDER_CONTINUITY_SNAPSHOT,
  PROVIDER_CONTINUITY_SPEC_VERSION,
  providerContinuityContractHeader,
  providerContinuityEffectSchema,
  providerContinuityJournalSchema,
  type ProviderContinuityEvent,
  type ProviderContinuityEffect,
  type ProviderContinuityJournal,
  type ProviderContinuityJsonValue,
} from "./types.js";

const SENSITIVE_KEY =
  /(authorization|api[-_]?key|credential|secret|password|cookie|access[-_]?token|refresh[-_]?token)/i;
const SECRET_LIKE_VALUE =
  /\b(?:(?:sk|rk|pk|rctx|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9+/=_-]{6,}|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{20,})\b|bearer\s+[A-Za-z0-9._~+/-]{6,}/gi;
const NAMED_SECRET_VALUE =
  /(\b(?:api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret)\s*[:=]\s*["']?)[^&\s"',;]{6,}/gi;
const MAX_PUBLIC_STRING_LENGTH = 1_000;

export function redactProviderContinuityValue(value: unknown, key = ""): ProviderContinuityJsonValue {
  if (SENSITIVE_KEY.test(key)) return "[redacted]";
  if (value === null) return null;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactProviderContinuityValue(value.message, "message"),
    };
  }
  if (typeof value === "string") {
    const redacted = value.replace(SECRET_LIKE_VALUE, "[redacted]").replace(NAMED_SECRET_VALUE, "$1[redacted]");
    return redacted.length > MAX_PUBLIC_STRING_LENGTH
      ? `${redacted.slice(0, MAX_PUBLIC_STRING_LENGTH)}…[truncated]`
      : redacted;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map((item) => redactProviderContinuityValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [
        childKey,
        redactProviderContinuityValue(childValue, childKey),
      ]),
    );
  }
  return null;
}

export function publicProviderContinuityJournal(journal: ProviderContinuityJournal): ProviderContinuityJournal {
  return providerContinuityJournalSchema.parse({
    ...journal,
    contextSnapshot: {
      ...journal.contextSnapshot,
      messages: journal.contextSnapshot.messages.map((message) => ({
        ...message,
        content: "[redacted]",
      })),
      toolRecords: journal.contextSnapshot.toolRecords.map((record) => ({
        ...record,
        input: record.input === null ? null : "[redacted]",
        output: record.output === null ? null : "[redacted]",
      })),
      attachments: journal.contextSnapshot.attachments.map((attachment) => ({
        ...attachment,
        reference: "[redacted]",
      })),
    },
    attempts: journal.attempts.map((attempt) => ({
      ...attempt,
      failure: attempt.failure
        ? {
            ...attempt.failure,
            message: "[redacted]",
          }
        : null,
    })),
  });
}

export function publicProviderContinuityEffect(effect: ProviderContinuityEffect): ProviderContinuityEffect {
  return providerContinuityEffectSchema.parse({
    ...effect,
    result: effect.result === null ? null : "[redacted]",
  });
}

export function providerContinuityFingerprint(value: unknown): string {
  const canonical = JSON.stringify(stableValue(redactProviderContinuityValue(value)));
  return createHash("sha256").update(canonical).digest("hex");
}

function stableValue(value: ProviderContinuityJsonValue): ProviderContinuityJsonValue {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, ProviderContinuityJsonValue>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([childKey, childValue]) => [childKey, stableValue(childValue)]),
    );
  }
  return value;
}

export function recordProviderContinuityEvent(input: {
  logicalRequestId?: string | null;
  agentId?: string | null;
  type: string;
  payload?: Record<string, unknown>;
  now?: number;
}): ProviderContinuityEvent {
  const redacted = redactProviderContinuityValue(input.payload ?? {});
  return appendProviderContinuityEvent({
    logicalRequestId: input.logicalRequestId ?? null,
    agentId: input.agentId ?? null,
    type: input.type.trim(),
    payload: redacted && typeof redacted === "object" && !Array.isArray(redacted) ? redacted : { value: redacted },
    createdAt: input.now ?? Date.now(),
    specVersion: PROVIDER_CONTINUITY_SPEC_VERSION,
    compatibilitySnapshotId: PROVIDER_CONTINUITY_SNAPSHOT,
  });
}

function encodeCursor(eventId: number): string {
  return Buffer.from(`provider-continuity:${eventId}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw new Error("Invalid provider continuity trace cursor.");
  }
  const match = /^provider-continuity:(\d+)$/.exec(decoded);
  if (!match) throw new Error("Invalid provider continuity trace cursor.");
  const value = Number(match[1]);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid provider continuity trace cursor.");
  return value;
}

export function readProviderContinuityTrace(input: { logicalRequestId: string; cursor?: string; limit?: number }) {
  const journal = requireProviderContinuityJournal(input.logicalRequestId);
  const afterEventId = decodeCursor(input.cursor);
  const limit = Math.min(500, Math.max(1, input.limit ?? 50));
  const page = listProviderContinuityEvents({
    logicalRequestId: journal.logicalRequestId,
    afterEventId,
    limit,
  });
  const last = page.events.at(-1);
  return {
    ...providerContinuityContractHeader(),
    logicalRequestId: journal.logicalRequestId,
    journal: publicProviderContinuityJournal(journal),
    events: page.events,
    pagination: {
      limit,
      cursor: input.cursor ?? null,
      nextCursor: page.hasMore && last ? encodeCursor(last.eventId) : null,
      hasMore: page.hasMore,
    },
  };
}

export function providerContinuityRuntimeEvent(input: {
  logicalRequestId: string;
  agentId: string;
  type: string;
  payload?: Record<string, unknown>;
}) {
  const event = recordProviderContinuityEvent(input);
  return {
    type: input.type,
    logicalRequestId: input.logicalRequestId,
    agentId: input.agentId,
    eventId: event.eventId,
    specVersion: PROVIDER_CONTINUITY_SPEC_VERSION,
    compatibilitySnapshotId: PROVIDER_CONTINUITY_SNAPSHOT,
    payload: event.payload,
  };
}
