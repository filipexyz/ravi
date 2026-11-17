import { describe, expect, it } from "bun:test";
import type { ChannelOutputEnvelope } from "./backend.js";
import {
  CHANNEL_OUTPUT_HANDOFF_CAPABILITY,
  CHANNEL_OUTPUT_HANDOFF_SCHEMA_VERSION,
  ChannelOutputEmissionContextSchema,
  ChannelOutputHandoffConfirmationSchema,
  ChannelOutputHandoffError,
  ChannelOutputHandoffEvidenceSchema,
  type ChannelOutputHandoffConfirmation,
  type ChannelOutputHandoffEvidence,
  channelOutputHandoffConfirmationMatches,
  channelOutputHandoffEvidenceMatches,
  channelOutputHandoffIdentityMatches,
  channelOutputHandoffTransientCode,
  createChannelOutputHandoffIdentity,
  getChannelOutputHandoffEvidence,
} from "./output-handoff.js";

const firstFingerprint = "a".repeat(64);
const changedFingerprint = "b".repeat(64);

describe("channel output handoff evidence contract", () => {
  it("binds evidence to content, correlation, time and every binding/target field, not outputId alone", () => {
    const output = makeOutput();
    const identity = createChannelOutputHandoffIdentity(output);
    const changes: ChannelOutputEnvelope[] = [
      { ...output, content: [{ type: "text", text: "Different complete answer" }] },
      { ...output, correlationId: "different-correlation" },
      { ...output, causationId: "different-ingress" },
      { ...output, emittedAt: "2026-11-04T09:00:02.000Z" },
    ];
    for (const field of Object.keys(output.binding) as Array<keyof ChannelOutputEnvelope["binding"]>) {
      changes.push({ ...output, binding: { ...output.binding, [field]: `different-${field}` } });
    }
    for (const field of Object.keys(output.target) as Array<keyof ChannelOutputEnvelope["target"]>) {
      changes.push({ ...output, target: { ...output.target, [field]: `different-${field.toLowerCase()}` } });
    }
    expect(channelOutputHandoffIdentityMatches(identity, output)).toBe(true);
    for (const changed of changes) {
      expect(changed.outputId).toBe(output.outputId);
      expect(channelOutputHandoffIdentityMatches(identity, changed)).toBe(false);
      expect(channelOutputHandoffEvidenceMatches(makePreSaveEvidence(output), changed)).toBe(false);
      expect(channelOutputHandoffConfirmationMatches(makeConfirmation(output), changed)).toBe(false);
    }
  });

  it("keeps full-output identity across transport object ordering and JSON round trips", () => {
    const output = makeOutput();
    const reordered: ChannelOutputEnvelope = {
      ...output,
      binding: {
        turnId: output.binding.turnId,
        sessionId: output.binding.sessionId,
        messageId: output.binding.messageId,
        chatId: output.binding.chatId,
        agentId: output.binding.agentId,
        channelInstanceId: output.binding.channelInstanceId,
      },
      target: {
        conversationId: output.target.conversationId,
        connectionId: output.target.connectionId,
        channelKind: output.target.channelKind,
      },
    };
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(output));
    expect(createChannelOutputHandoffIdentity(reordered)).toEqual(createChannelOutputHandoffIdentity(output));
    const evidence = ChannelOutputHandoffEvidenceSchema.parse(JSON.parse(JSON.stringify(makePreSaveEvidence(output))));
    expect(channelOutputHandoffEvidenceMatches(evidence, reordered, firstFingerprint)).toBe(true);
  });

  it("accepts known durable dispositions without confusing them with platform delivery", () => {
    const output = makeOutput();
    for (const disposition of ["pending", "deferred", "published", "suppressed"] as const) {
      const confirmation = makeConfirmation(output, disposition);
      const parsed = ChannelOutputHandoffConfirmationSchema.parse(JSON.parse(JSON.stringify(confirmation)));
      expect(parsed.disposition).toBe(disposition);
      expect(parsed.durableSaveConfirmed).toBe(true);
      expect(channelOutputHandoffConfirmationMatches(parsed, output, firstFingerprint)).toBe(true);
      expect(parsed).not.toHaveProperty("sent");
      expect(parsed).not.toHaveProperty("delivered");
      expect(parsed).not.toHaveProperty("providerMessageId");
      expect(ChannelOutputHandoffConfirmationSchema.safeParse({ ...confirmation, disposition: "sent" }).success).toBe(
        false,
      );
    }
  });

  it("leaves void, generic success and malformed acknowledgements unclassified", () => {
    const output = makeOutput();
    const confirmation = makeConfirmation(output);
    const acknowledgements: unknown[] = [
      undefined,
      { ok: true },
      { protocol: "ravi.channel.backend-egress", schemaVersion: 1, ok: true },
      { ...confirmation, durableSaveConfirmed: false },
      { ...confirmation, capability: "unrecognized-adapter" },
      { ...confirmation, schemaVersion: 0 },
      { ...confirmation, requestFingerprint: "not-a-fingerprint" },
      { ...confirmation, providerMessageId: "unexpected-platform-ack" },
    ];
    for (const acknowledgement of acknowledgements) {
      expect(ChannelOutputHandoffConfirmationSchema.safeParse(acknowledgement).success).toBe(false);
      expect(
        channelOutputHandoffConfirmationMatches(
          acknowledgement as ChannelOutputHandoffConfirmation,
          output,
          firstFingerprint,
        ),
      ).toBe(false);
    }
    expect(
      channelOutputHandoffConfirmationMatches(
        { ...confirmation, idempotencyKey: "different-output" },
        output,
        firstFingerprint,
      ),
    ).toBe(false);
    expect(
      channelOutputHandoffConfirmationMatches(
        { ...confirmation, requestFingerprint: changedFingerprint },
        output,
        firstFingerprint,
      ),
    ).toBe(false);
  });

  it("requires completed prepared-job evidence and an exact transient code for a pre-save candidate", () => {
    const output = makeOutput();
    const evidence = makePreSaveEvidence(output);
    expect(ChannelOutputHandoffEvidenceSchema.safeParse(evidence).success).toBe(true);
    for (const invalid of [
      { ...evidence, operationFinished: false },
      { ...evidence, operationFinished: undefined },
      { ...evidence, requestFingerprint: undefined },
      { ...evidence, idempotencyKey: undefined },
      { ...evidence, code: "UNAVAILABLE" },
      { ...evidence, code: "SQLITE_BUSY_CUSTOM" },
      { ...evidence, message: "database is locked" },
    ]) {
      expect(ChannelOutputHandoffEvidenceSchema.safeParse(invalid).success).toBe(false);
      expect(channelOutputHandoffEvidenceMatches(invalid as ChannelOutputHandoffEvidence, output)).toBe(false);
    }
    expect(channelOutputHandoffEvidenceMatches({ ...evidence, idempotencyKey: "different-output" }, output)).toBe(
      false,
    );
  });

  it("keeps not-started and unfinished unknown outcomes separate from pre-save absence", () => {
    const output = makeOutput();
    const identity = createChannelOutputHandoffIdentity(output);
    const notStarted: ChannelOutputHandoffEvidence = {
      capability: CHANNEL_OUTPUT_HANDOFF_CAPABILITY,
      schemaVersion: CHANNEL_OUTPUT_HANDOFF_SCHEMA_VERSION,
      identity,
      disposition: "not_started",
      operationFinished: true,
      code: "SINK_UNAVAILABLE",
    };
    const timeout: ChannelOutputHandoffEvidence = {
      capability: CHANNEL_OUTPUT_HANDOFF_CAPABILITY,
      schemaVersion: CHANNEL_OUTPUT_HANDOFF_SCHEMA_VERSION,
      identity,
      disposition: "unknown",
      operationFinished: false,
      code: "OUTCOME_UNKNOWN",
    };
    for (const evidence of [notStarted, timeout]) {
      const parsed = ChannelOutputHandoffEvidenceSchema.parse(evidence);
      expect(parsed.disposition).not.toBe("finished_pre_save_missing");
      expect(parsed).not.toHaveProperty("requestFingerprint");
      expect(parsed).not.toHaveProperty("idempotencyKey");
      expect(channelOutputHandoffEvidenceMatches(parsed, output, firstFingerprint)).toBe(true);
    }
    expect(
      ChannelOutputHandoffEvidenceSchema.safeParse({
        ...notStarted,
        requestFingerprint: firstFingerprint,
        idempotencyKey: output.outputId,
      }).success,
    ).toBe(false);
    expect(
      ChannelOutputHandoffEvidenceSchema.safeParse({
        ...timeout,
        disposition: "finished_pre_save_missing",
        code: "SQLITE_BUSY",
        requestFingerprint: firstFingerprint,
        idempotencyKey: output.outputId,
      }).success,
    ).toBe(false);
  });

  it("never replaces a caller pin with later mismatching evidence or a missing job fingerprint", () => {
    const output = makeOutput();
    const initial = makePreSaveEvidence(output);
    const context = ChannelOutputEmissionContextSchema.parse({
      capability: CHANNEL_OUTPUT_HANDOFF_CAPABILITY,
      expectedRequestFingerprint: initial.requestFingerprint,
    });
    const changed = makePreSaveEvidence(output, changedFingerprint);
    const conflict: ChannelOutputHandoffEvidence = {
      ...changed,
      disposition: "conflict",
      code: "REQUEST_FINGERPRINT_CONFLICT",
    };
    const notStarted: ChannelOutputHandoffEvidence = {
      capability: CHANNEL_OUTPUT_HANDOFF_CAPABILITY,
      schemaVersion: CHANNEL_OUTPUT_HANDOFF_SCHEMA_VERSION,
      identity: initial.identity,
      disposition: "not_started",
      operationFinished: true,
      code: "SINK_UNAVAILABLE",
    };
    expect(channelOutputHandoffEvidenceMatches(initial, output, context.expectedRequestFingerprint)).toBe(true);
    expect(channelOutputHandoffEvidenceMatches(changed, output)).toBe(true);
    expect(channelOutputHandoffEvidenceMatches(changed, output, context.expectedRequestFingerprint)).toBe(false);
    expect(channelOutputHandoffEvidenceMatches(conflict, output, context.expectedRequestFingerprint)).toBe(false);
    expect(channelOutputHandoffEvidenceMatches(notStarted, output, context.expectedRequestFingerprint)).toBe(true);
    expect(notStarted).not.toHaveProperty("requestFingerprint");
    expect(new ChannelOutputHandoffError(conflict).evidence).toMatchObject({
      disposition: "conflict",
      requestFingerprint: changedFingerprint,
    });
    expect(context.expectedRequestFingerprint).toBe(firstFingerprint);
    expect(initial.requestFingerprint).toBe(firstFingerprint);
    expect(
      channelOutputHandoffConfirmationMatches(makeConfirmation(output), output, context.expectedRequestFingerprint),
    ).toBe(true);
  });

  it("clones and freezes error evidence so later mutation cannot replace its prepared request or target", () => {
    const output = makeOutput();
    const draft = structuredClone(makePreSaveEvidence(output));
    const error = new ChannelOutputHandoffError(draft);
    draft.requestFingerprint = changedFingerprint;
    draft.identity.target.conversationId = "changed-conversation";
    draft.identity.binding.turnId = "changed-turn";
    expect(error.evidence).toMatchObject({
      requestFingerprint: firstFingerprint,
      identity: { target: output.target, binding: output.binding },
    });
    expect(Object.isFrozen(error.evidence)).toBe(true);
    expect(Object.isFrozen(error.evidence.identity)).toBe(true);
    expect(Object.isFrozen(error.evidence.identity.binding)).toBe(true);
    expect(Object.isFrozen(error.evidence.identity.target)).toBe(true);
    expect(Reflect.set(error.evidence, "requestFingerprint", changedFingerprint)).toBe(false);
    expect(Reflect.set(error.evidence.identity.target, "conversationId", "changed-again")).toBe(false);
    const extracted = getChannelOutputHandoffEvidence(error);
    expect(extracted).toEqual(error.evidence);
    expect(Object.isFrozen(extracted)).toBe(true);
  });

  it("does not infer classified handoff evidence or SQLite codes from arbitrary error text or objects", () => {
    const evidence = makePreSaveEvidence(makeOutput());
    expect(getChannelOutputHandoffEvidence(new Error("finished_pre_save_missing SQLITE_BUSY"))).toBeUndefined();
    expect(getChannelOutputHandoffEvidence({ evidence })).toBeUndefined();
    expect(getChannelOutputHandoffEvidence(Object.assign(new Error("untyped"), { evidence }))).toBeUndefined();
    expect(channelOutputHandoffTransientCode(new Error("SQLITE_BUSY database is locked"))).toBeUndefined();
    expect(channelOutputHandoffTransientCode({ code: "SQLITE_BUSY" })).toBeUndefined();
    expect(channelOutputHandoffTransientCode(Object.assign(new Error("ignored text"), { code: "SQLITE_BUSY" }))).toBe(
      "SQLITE_BUSY",
    );
    expect(channelOutputHandoffTransientCode(Object.assign(new Error("ignored text"), { code: "SQLITE_LOCKED" }))).toBe(
      "SQLITE_LOCKED",
    );
    expect(
      channelOutputHandoffTransientCode(Object.assign(new Error("database is busy"), { code: "EIO" })),
    ).toBeUndefined();
  });

  it("recognizes a separately loaded SDK error class only through the exact strict error contract", () => {
    class MirroredSdkHandoffError extends Error {
      constructor(readonly evidence: unknown) {
        super("sanitized SDK handoff error");
        this.name = "ChannelOutputHandoffError";
      }
    }
    const evidence = makePreSaveEvidence(makeOutput());
    const mirrored = new MirroredSdkHandoffError(structuredClone(evidence));
    expect(mirrored).not.toBeInstanceOf(ChannelOutputHandoffError);
    const extracted = getChannelOutputHandoffEvidence(mirrored);
    expect(extracted).toEqual(evidence);
    expect(Object.isFrozen(extracted)).toBe(true);
    expect(
      getChannelOutputHandoffEvidence(new MirroredSdkHandoffError({ ...evidence, operationFinished: false })),
    ).toBeUndefined();
    expect(
      getChannelOutputHandoffEvidence(new MirroredSdkHandoffError({ ...evidence, capability: "legacy-sink" })),
    ).toBeUndefined();
    expect(getChannelOutputHandoffEvidence({ name: "ChannelOutputHandoffError", evidence })).toBeUndefined();
    expect(getChannelOutputHandoffEvidence(Object.assign(new Error("generic"), { evidence }))).toBeUndefined();
  });

  it("restricts the emission context to a known capability and data-only fingerprint", () => {
    const context = { capability: CHANNEL_OUTPUT_HANDOFF_CAPABILITY, expectedRequestFingerprint: firstFingerprint };
    expect(ChannelOutputEmissionContextSchema.parse(context)).toEqual(context);
    for (const invalid of [
      { expectedRequestFingerprint: firstFingerprint },
      { ...context, capability: "legacy-sink" },
      { ...context, expectedRequestFingerprint: "invalid" },
      { ...context, mayRetry: true },
      { ...context, ownerPredicate: () => true },
    ]) {
      expect(ChannelOutputEmissionContextSchema.safeParse(invalid).success).toBe(false);
    }
  });
});

/** Pure output fixture; importing backend runtime is unnecessary for this contract. */
function makeOutput(): ChannelOutputEnvelope {
  return {
    protocol: "ravi.channel.backend",
    schemaVersion: 1,
    outputId: "output-a",
    correlationId: "correlation-a",
    causationId: "ingress-a",
    binding: {
      channelInstanceId: "slack-main",
      agentId: "agent-a",
      chatId: "chat-a",
      messageId: "message-a",
      sessionId: "session-a",
      turnId: "turn-a",
    },
    target: { channelKind: "slack", connectionId: "workspace-a", conversationId: "conversation-a" },
    kind: "assistant_message",
    content: [{ type: "text", text: "Complete frozen answer" }],
    emittedAt: "2026-11-04T09:00:01.000Z",
  };
}

/** Completed pre-save evidence with one prepared request for the frozen output. */
function makePreSaveEvidence(
  output: ChannelOutputEnvelope,
  requestFingerprint = firstFingerprint,
): Extract<ChannelOutputHandoffEvidence, { disposition: "finished_pre_save_missing" }> {
  return {
    capability: CHANNEL_OUTPUT_HANDOFF_CAPABILITY,
    schemaVersion: CHANNEL_OUTPUT_HANDOFF_SCHEMA_VERSION,
    identity: createChannelOutputHandoffIdentity(output),
    idempotencyKey: output.outputId,
    requestFingerprint,
    disposition: "finished_pre_save_missing",
    operationFinished: true,
    code: "SQLITE_BUSY",
  };
}

/** Known adapter save confirmation, distinct from any provider delivery status. */
function makeConfirmation(
  output: ChannelOutputEnvelope,
  disposition: ChannelOutputHandoffConfirmation["disposition"] = "deferred",
): ChannelOutputHandoffConfirmation {
  return {
    capability: CHANNEL_OUTPUT_HANDOFF_CAPABILITY,
    schemaVersion: CHANNEL_OUTPUT_HANDOFF_SCHEMA_VERSION,
    identity: createChannelOutputHandoffIdentity(output),
    idempotencyKey: output.outputId,
    requestFingerprint: firstFingerprint,
    durableSaveConfirmed: true,
    disposition,
  };
}
