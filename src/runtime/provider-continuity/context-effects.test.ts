import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import {
  appendProviderContinuityToolRecord,
  buildProviderContinuityPortableContext,
  resumePromptFromPortableContext,
  translateProviderContinuityContext,
} from "./context.js";
import {
  completeProviderContinuityEffect,
  markProviderContinuityEffectAmbiguous,
  markProviderContinuityEffectStarted,
  prepareProviderContinuityEffect,
  reconcileProviderContinuityEffect,
} from "./effects.js";
import { prepareProviderContinuityRequest } from "./coordinator.js";
import {
  getProviderContinuityPolicy,
  requireProviderContinuityJournal,
  saveProviderContinuityJournal,
  writeProviderContinuityPolicy,
} from "./store.js";
import {
  PROVIDER_CONTINUITY_SNAPSHOT,
  PROVIDER_CONTINUITY_SPEC_VERSION,
  providerContinuityJournalSchema,
  type ProviderContinuityPolicyConfig,
} from "./types.js";

let stateDir: string | null = null;

const policy: ProviderContinuityPolicyConfig = {
  specVersion: PROVIDER_CONTINUITY_SPEC_VERSION,
  compatibilitySnapshotId: PROVIDER_CONTINUITY_SNAPSHOT,
  strategy: "ordered",
  targets: [
    { provider: "codex", model: "gpt-5" },
    { provider: "claude", model: "sonnet" },
  ],
  deadlineMs: 120_000,
  enabled: true,
};

function prepare(messageId: string, now: number) {
  const result = prepareProviderContinuityRequest({
    agentId: "main",
    sessionName: `main-dm-${messageId}`,
    prompt: {
      prompt: `synthetic request ${messageId}`,
      _agentId: "main",
      context: {
        channelId: "test",
        channelName: "Test",
        accountId: "test",
        chatId: "test-chat",
        messageId,
        senderId: "synthetic-user",
        isGroup: false,
        timestamp: now,
      },
    },
    activation: "synthetic",
    now,
  });
  if (!result.active || !result.ready) throw new Error("Synthetic continuity request did not become ready.");
  return result;
}

describe("provider continuity portable context and effects", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-provider-continuity-effects-");
    expect(getProviderContinuityPolicy("main")).toBeNull();
    writeProviderContinuityPolicy({
      agentId: "main",
      expectedVersion: 0,
      policy,
      now: 1_000,
    });
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("builds deterministic redacted context and rejects forbidden tool/safety loss", () => {
    const syntheticApiKey = ["s", "k-secret_abcdef123456"].join("");
    const input = {
      messages: [{ id: "m1", role: "user" as const, content: `use ${syntheticApiKey}` }],
      toolRecords: [
        { id: "t1", name: "write", input: { authorization: "Bearer abcdef123" }, status: "started" as const },
      ],
      safetyControls: { permission: "required", apiKey: "hidden" },
      runtimeControls: { mode: "synthetic" },
      now: 2_000,
    };
    const first = buildProviderContinuityPortableContext(input);
    const second = buildProviderContinuityPortableContext(input);
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(JSON.stringify(first)).not.toContain("abcdef123456");
    expect(JSON.stringify(first)).not.toContain("Bearer abcdef123");

    const translation = translateProviderContinuityContext({
      context: first,
      target: { provider: "claude", model: "sonnet" },
      unsupportedPaths: ["toolRecords", "runtimeControls.optional"],
      approvedLossPaths: ["toolRecords", "runtimeControls.optional"],
    });
    expect(translation.eligible).toBe(false);
    expect(translation.context.forbiddenLosses).toEqual(["toolRecords"]);
    expect(translation.context.transformations.at(-1)).toMatchObject({
      path: "runtimeControls.optional",
      approvedLoss: true,
    });
  });

  it("normalizes attachments, updates tool records, and resumes the last canonical user message", () => {
    const context = buildProviderContinuityPortableContext({
      messages: [
        { role: "system", content: "synthetic system" },
        { role: "user", content: "first request" },
        { role: "assistant", content: "intermediate" },
        { role: "user", content: "resume this request" },
      ],
      attachments: [
        {
          id: " attachment-1 ",
          reference: "https://example.test/object",
          mediaType: " application/json ",
          fingerprint: "attachment-fingerprint",
        },
      ],
      now: 2_100,
    });
    expect(context.messages[0]?.id).toMatch(/^pcm_/);
    expect(context.attachments[0]).toEqual({
      id: "attachment-1",
      reference: "https://example.test/object",
      mediaType: "application/json",
      fingerprint: "attachment-fingerprint",
    });
    const resume = resumePromptFromPortableContext(context);
    expect(resume).toContain("Resume the same Ravi logical request");
    expect(resume).toContain("resume this request");
    expect(resume).toContain("synthetic system");

    const started = appendProviderContinuityToolRecord({
      context,
      tool: {
        id: "tool-context",
        name: "synthetic_write",
        input: { value: 1 },
        status: "started",
      },
    });
    const completed = appendProviderContinuityToolRecord({
      context: started,
      tool: {
        id: "tool-context",
        name: "synthetic_write",
        input: { value: 1 },
        output: { ok: true },
        status: "succeeded",
      },
    });
    expect(completed.toolRecords).toHaveLength(1);
    expect(completed.toolRecords[0]).toMatchObject({
      id: "tool-context",
      status: "succeeded",
      input: { value: 1 },
      output: { ok: true },
      inputFingerprint: expect.any(String),
      outputFingerprint: expect.any(String),
    });
    expect(completed.fingerprint).not.toBe(started.fingerprint);
    const completedResume = resumePromptFromPortableContext(completed);
    expect(completedResume).toContain('"name":"synthetic_write"');
    expect(completedResume).toContain('"output":{"ok":true}');

    const noUser = buildProviderContinuityPortableContext({
      messages: [{ role: "system", content: "no user message" }],
      now: 2_101,
    });
    expect(() => resumePromptFromPortableContext(noUser)).toThrow("no canonical user message");
  });

  it("deduplicates a terminal effect by stable identity", () => {
    const request = prepare("effect-dedupe", 3_000);
    const first = prepareProviderContinuityEffect({
      logicalRequestId: request.journal.logicalRequestId,
      toolCallId: "tool-1",
      operation: "orders_create",
      arguments: { order: "synthetic-1" },
      now: 3_001,
    });
    expect(first).toMatchObject({ execute: true, deduplicated: false });
    markProviderContinuityEffectStarted(first.effect.effectId, 3_002);
    const completed = completeProviderContinuityEffect({
      effectId: first.effect.effectId,
      outcome: "succeeded",
      result: { success: true, contentItems: [{ type: "inputText", text: "created synthetic-1" }] },
      now: 3_003,
    });
    expect(completed.effect.status).toBe("succeeded");
    expect(requireProviderContinuityJournal(request.journal.logicalRequestId).contextSnapshot.toolRecords).toEqual([
      expect.objectContaining({
        id: "tool-1",
        name: "orders_create",
        input: { order: "synthetic-1" },
        output: { success: true, contentItems: [{ type: "inputText", text: "created synthetic-1" }] },
        status: "succeeded",
      }),
    ]);
    const completedJournal = requireProviderContinuityJournal(request.journal.logicalRequestId);
    saveProviderContinuityJournal(
      providerContinuityJournalSchema.parse({
        ...completedJournal,
        effectBoundary: "started",
        contextSnapshot: {
          ...completedJournal.contextSnapshot,
          toolRecords: completedJournal.contextSnapshot.toolRecords.map((record) => ({
            ...record,
            output: null,
            outputFingerprint: null,
            status: "started",
          })),
        },
        updatedAt: 3_003,
      }),
    );

    const replay = prepareProviderContinuityEffect({
      logicalRequestId: request.journal.logicalRequestId,
      toolCallId: "tool-1",
      operation: "orders_create",
      arguments: { order: "synthetic-1" },
      now: 3_004,
    });
    expect(replay).toMatchObject({ execute: false, deduplicated: true, reason: "terminal_succeeded" });
    expect(replay.effect.effectId).toBe(first.effect.effectId);
    expect(replay.journal).toMatchObject({
      effectBoundary: "terminal",
      contextSnapshot: {
        toolRecords: [
          expect.objectContaining({
            id: "tool-1",
            status: "succeeded",
            output: { success: true, contentItems: [{ type: "inputText", text: "created synthetic-1" }] },
          }),
        ],
      },
    });
  });

  it("turns an effect identity collision into reconciliation-required HOLD", () => {
    const request = prepare("effect-collision", 4_000);
    const first = prepareProviderContinuityEffect({
      logicalRequestId: request.journal.logicalRequestId,
      toolCallId: "tool-collision",
      operation: "payments_capture",
      arguments: { amount: 10 },
      now: 4_001,
    });
    expect(() =>
      prepareProviderContinuityEffect({
        logicalRequestId: request.journal.logicalRequestId,
        toolCallId: "tool-collision",
        operation: "payments_capture",
        arguments: { amount: 11 },
        now: 4_002,
      }),
    ).toThrow("collision");
    expect(requireProviderContinuityJournal(request.journal.logicalRequestId)).toMatchObject({
      state: "reconciliation_required",
      holdReason: "idempotency_collision",
      activeEffectId: first.effect.effectId,
    });
  });

  it("requires explicit readback to reconcile an ambiguous effect", () => {
    const request = prepare("effect-reconcile", 5_000);
    const first = prepareProviderContinuityEffect({
      logicalRequestId: request.journal.logicalRequestId,
      toolCallId: "tool-ambiguous",
      operation: "invoice_issue",
      arguments: { invoice: "synthetic" },
      now: 5_001,
    });
    markProviderContinuityEffectStarted(first.effect.effectId, 5_002);
    const ambiguous = markProviderContinuityEffectAmbiguous({
      effectId: first.effect.effectId,
      error: new Error("socket closed after write"),
      now: 5_003,
    });
    expect(ambiguous.journal.state).toBe("reconciliation_required");

    const reconciled = reconcileProviderContinuityEffect({
      effectId: first.effect.effectId,
      outcome: "succeeded",
      evidenceRef: "synthetic-readback-1",
      now: 5_004,
    });
    expect(reconciled).toMatchObject({
      changed: true,
      effect: { status: "reconciled", result: { outcome: "succeeded" } },
      journal: { state: "pending", effectBoundary: "terminal", holdReason: null },
    });
    const replay = reconcileProviderContinuityEffect({
      effectId: first.effect.effectId,
      outcome: "succeeded",
      evidenceRef: "synthetic-readback-1",
      now: 5_005,
    });
    expect(replay.changed).toBe(false);
  });
});
