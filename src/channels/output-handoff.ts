import { createHash } from "node:crypto";
import { z } from "zod";
import type { ChannelOutputEnvelope } from "./backend.js";

/** Internal durable Slack adapter contract; this capability grants no authority. */
export const CHANNEL_OUTPUT_HANDOFF_CAPABILITY = "ravi.channel.output.durable-slack.v1" as const;
export const CHANNEL_OUTPUT_HANDOFF_SCHEMA_VERSION = 1 as const;

const opaqueId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._~-]*$/);
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const binding = z
  .object({
    channelInstanceId: opaqueId,
    agentId: opaqueId,
    chatId: opaqueId,
    messageId: opaqueId,
    sessionId: opaqueId,
    turnId: opaqueId,
  })
  .strict();
const target = z
  .object({
    channelKind: z
      .string()
      .min(1)
      .max(96)
      .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/),
    connectionId: opaqueId,
    conversationId: opaqueId,
  })
  .strict();

/**
 * Only a restriction travels across the runner boundary. Receivers must support
 * this exact capability before calling a sink, and compare a pinned fingerprint
 * before saving. No owner callback, retry permission or downgrade is encoded.
 */
export const ChannelOutputEmissionContextSchema = z
  .object({
    capability: z.literal(CHANNEL_OUTPUT_HANDOFF_CAPABILITY),
    expectedRequestFingerprint: fingerprint.optional(),
  })
  .strict();

/**
 * Sanitized correlation for one frozen output. The hash covers the full envelope
 * (including content, error, correlation and emittedAt); explicit binding and
 * target prevent a matching output id alone from authorizing another target.
 */
export const ChannelOutputHandoffIdentitySchema = z
  .object({
    outputId: opaqueId,
    outputFingerprint: fingerprint,
    binding,
    target,
  })
  .strict();

/** Closed SQLite codes only; arbitrary error messages never authorize a retry. */
export const ChannelOutputHandoffTransientCodeSchema = z.enum([
  "SQLITE_BUSY",
  "SQLITE_BUSY_RECOVERY",
  "SQLITE_BUSY_SNAPSHOT",
  "SQLITE_BUSY_TIMEOUT",
  "SQLITE_LOCKED",
  "SQLITE_LOCKED_SHAREDCACHE",
  "SQLITE_LOCKED_VTAB",
]);

const evidenceBase = {
  capability: z.literal(CHANNEL_OUTPUT_HANDOFF_CAPABILITY),
  schemaVersion: z.literal(CHANNEL_OUTPUT_HANDOFF_SCHEMA_VERSION),
  identity: ChannelOutputHandoffIdentitySchema,
};
const preparedIdentity = {
  idempotencyKey: opaqueId,
  requestFingerprint: fingerprint,
};

/**
 * Positive save evidence from the known adapter, never a Slack delivery ACK.
 * Pending/deferred ownership belongs to the existing outbox reconciler;
 * published and suppressed are terminal for host handoff, including coalescing.
 * A generic resolved Promise<void> or legacy ok:true cannot populate this type.
 */
export const ChannelOutputHandoffConfirmationSchema = z
  .object({
    ...evidenceBase,
    ...preparedIdentity,
    durableSaveConfirmed: z.literal(true),
    disposition: z.enum(["pending", "deferred", "published", "suppressed"]),
  })
  .strict();

/**
 * Completed pre-save absence is the only retry candidate. It requires a real
 * prepared job and a readback made after the synchronous save returned/threw.
 * Not-started has no job fingerprint and is never automatically replayed.
 * Unknown includes timeouts and unreadable state; absence during an in-flight
 * call is not evidence of rollback. Conflict is permanently non-retryable.
 */
export const ChannelOutputHandoffEvidenceSchema = z.discriminatedUnion("disposition", [
  z
    .object({
      ...evidenceBase,
      disposition: z.literal("not_started"),
      operationFinished: z.literal(true),
      code: z.enum(["SINK_UNAVAILABLE", "UNSUPPORTED_CAPABILITY"]),
    })
    .strict(),
  z
    .object({
      ...evidenceBase,
      ...preparedIdentity,
      disposition: z.literal("finished_pre_save_missing"),
      operationFinished: z.literal(true),
      code: ChannelOutputHandoffTransientCodeSchema,
    })
    .strict(),
  z
    .object({
      ...evidenceBase,
      idempotencyKey: opaqueId.optional(),
      requestFingerprint: fingerprint.optional(),
      disposition: z.literal("conflict"),
      operationFinished: z.literal(true),
      code: z.enum(["REQUEST_FINGERPRINT_CONFLICT", "OUTPUT_IDENTITY_CONFLICT", "INVALID_OUTPUT"]),
    })
    .strict(),
  z
    .object({
      ...evidenceBase,
      idempotencyKey: opaqueId.optional(),
      requestFingerprint: fingerprint.optional(),
      disposition: z.literal("unknown"),
      operationFinished: z.boolean(),
      code: z.enum([
        "OUTCOME_UNKNOWN",
        "UNCLASSIFIED",
        "OUTBOX_SAVE_FAILED",
        "OUTBOX_READBACK_FAILED",
        "INVALID_CONFIRMATION",
        "TRANSPORT_FAILED",
      ]),
    })
    .strict(),
]);

export type ChannelOutputEmissionContext = z.infer<typeof ChannelOutputEmissionContextSchema>;
export type ChannelOutputHandoffIdentity = z.infer<typeof ChannelOutputHandoffIdentitySchema>;
export type ChannelOutputHandoffTransientCode = z.infer<typeof ChannelOutputHandoffTransientCodeSchema>;
export type ChannelOutputHandoffConfirmation = z.infer<typeof ChannelOutputHandoffConfirmationSchema>;
export type ChannelOutputHandoffEvidence = z.infer<typeof ChannelOutputHandoffEvidenceSchema>;

/**
 * Typed, sanitized evidence only. Construction clones, validates and freezes the
 * fields so later code cannot replace the caller's first prepared fingerprint.
 * Transport must parse the same schema rather than reconstructing from messages.
 */
export class ChannelOutputHandoffError extends Error {
  readonly evidence: ChannelOutputHandoffEvidence;

  constructor(evidence: ChannelOutputHandoffEvidence) {
    const parsed = ChannelOutputHandoffEvidenceSchema.parse(evidence);
    super(`Channel output handoff ${parsed.disposition}: ${parsed.code}`);
    this.name = "ChannelOutputHandoffError";
    this.evidence = freezeHandoffValue(parsed);
  }
}

/** Creates immutable identity from an already validated, frozen output. */
export function createChannelOutputHandoffIdentity(envelope: ChannelOutputEnvelope): ChannelOutputHandoffIdentity {
  return freezeHandoffValue(
    ChannelOutputHandoffIdentitySchema.parse({
      outputId: envelope.outputId,
      outputFingerprint: createHash("sha256").update(canonicalOutputJson(envelope)).digest("hex"),
      binding: envelope.binding,
      target: envelope.target,
    }),
  );
}

/**
 * Rebinds evidence to the caller's exact output, not a mutable current source.
 * A failed match never relaxes or replaces an already pinned request hash.
 */
export function channelOutputHandoffIdentityMatches(
  identity: ChannelOutputHandoffIdentity,
  envelope: ChannelOutputEnvelope,
): boolean {
  const parsed = ChannelOutputHandoffIdentitySchema.safeParse(identity);
  if (!parsed.success) return false;
  return canonicalOutputJson(parsed.data) === canonicalOutputJson(createChannelOutputHandoffIdentity(envelope));
}

/** Validates positive confirmation symmetrically with typed failure evidence. */
export function channelOutputHandoffConfirmationMatches(
  confirmation: ChannelOutputHandoffConfirmation,
  envelope: ChannelOutputEnvelope,
  expectedRequestFingerprint?: string,
): boolean {
  const parsed = ChannelOutputHandoffConfirmationSchema.safeParse(confirmation);
  return (
    parsed.success &&
    parsed.data.idempotencyKey === envelope.outputId &&
    channelOutputHandoffIdentityMatches(parsed.data.identity, envelope) &&
    (expectedRequestFingerprint === undefined || parsed.data.requestFingerprint === expectedRequestFingerprint)
  );
}

/**
 * Binds validated failure evidence to the same frozen output and optional pin.
 * Missing prepared identity is valid only for nonauthorizing dispositions: this
 * helper never grants a retry or clears a caller's pin. A different actual job
 * fingerprint must remain visible as a conflict, never rewritten to the pin.
 */
export function channelOutputHandoffEvidenceMatches(
  evidence: ChannelOutputHandoffEvidence,
  envelope: ChannelOutputEnvelope,
  expectedRequestFingerprint?: string,
): boolean {
  const parsed = ChannelOutputHandoffEvidenceSchema.safeParse(evidence);
  if (!parsed.success || !channelOutputHandoffIdentityMatches(parsed.data.identity, envelope)) return false;
  if (
    "idempotencyKey" in parsed.data &&
    parsed.data.idempotencyKey !== undefined &&
    parsed.data.idempotencyKey !== envelope.outputId
  )
    return false;
  return (
    !("requestFingerprint" in parsed.data) ||
    parsed.data.requestFingerprint === undefined ||
    expectedRequestFingerprint === undefined ||
    parsed.data.requestFingerprint === expectedRequestFingerprint
  );
}

/**
 * Extracts the exact error contract across separately loaded runtime/SDK classes.
 * Requires an Error with the explicit class name and strict evidence, never a
 * plain object, generic Error.evidence or message inference. Callers must first
 * require the registered known adapter capability: this parser grants no trust
 * or retry authority to an arbitrary sink or external serialized object.
 */
export function getChannelOutputHandoffEvidence(error: unknown): ChannelOutputHandoffEvidence | undefined {
  if (!(error instanceof Error) || error.name !== "ChannelOutputHandoffError" || !("evidence" in error)) {
    return undefined;
  }
  const parsed = ChannelOutputHandoffEvidenceSchema.safeParse(error.evidence);
  return parsed.success ? freezeHandoffValue(parsed.data) : undefined;
}

/** Reads an exact SQLite code without interpreting user-controlled error text. */
export function channelOutputHandoffTransientCode(error: unknown): ChannelOutputHandoffTransientCode | undefined {
  if (!(error instanceof Error) || !("code" in error)) return undefined;
  const parsed = ChannelOutputHandoffTransientCodeSchema.safeParse(error.code);
  return parsed.success ? parsed.data : undefined;
}

/** Canonicalizes JSON data so schema field order does not change output identity. */
function canonicalOutputJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalOutputJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .filter((key) => object[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalOutputJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Freezes only cloned, schema-validated JSON evidence, never runtime owners. */
function freezeHandoffValue<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeHandoffValue(child);
    Object.freeze(value);
  }
  return value;
}
