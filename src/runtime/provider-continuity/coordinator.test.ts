import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { saveMessage } from "../../db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import {
  buildProviderContinuityResumePrompt,
  handleProviderContinuityFailure,
  markProviderContinuityDelivery,
  markProviderContinuitySuccess,
  markProviderContinuityToolCompleted,
  markProviderContinuityToolStarted,
  prepareProviderContinuityRequest,
  providerContinuityActivationReason,
  resumeProviderContinuityJournal,
  waitProviderContinuityJournal,
  wakeProviderContinuityJournal,
} from "./coordinator.js";
import {
  getActiveProviderContinuityJournalForSession,
  getProviderContinuityEffect,
  getProviderContinuityPolicy,
  requireProviderContinuityJournal,
  saveProviderContinuityHealth,
  saveProviderContinuityJournal,
  writeProviderContinuityPolicy,
} from "./store.js";
import { readProviderContinuityTrace } from "./events.js";
import { recordProviderContinuityTargetFailure } from "./recovery.js";
import {
  PROVIDER_CONTINUITY_SNAPSHOT,
  PROVIDER_CONTINUITY_SPEC_VERSION,
  providerContinuityJournalSchema,
  type ProviderContinuityFailureEvidence,
  type ProviderContinuityPolicyConfig,
  type ProviderContinuityTarget,
} from "./types.js";

let stateDir: string | null = null;
let previousLiveGate: string | undefined;

const primary: ProviderContinuityTarget = { provider: "codex", model: "gpt-5" };
const secondary: ProviderContinuityTarget = { provider: "claude", model: "sonnet" };
const tertiary: ProviderContinuityTarget = { provider: "pi", model: "openai/gpt-5" };

function config(enabled = true): ProviderContinuityPolicyConfig {
  return {
    specVersion: PROVIDER_CONTINUITY_SPEC_VERSION,
    compatibilitySnapshotId: PROVIDER_CONTINUITY_SNAPSHOT,
    strategy: "ordered",
    targets: [primary, secondary],
    deadlineMs: 120_000,
    enabled,
  };
}

function writePolicy(policy = config(), now = 1_000): void {
  const current = getProviderContinuityPolicy("main");
  writeProviderContinuityPolicy({
    agentId: "main",
    expectedVersion: current?.version ?? 0,
    policy,
    now,
  });
}

function prompt(messageId: string, now: number) {
  return {
    prompt: `coordinator branch ${messageId}`,
    _agentId: "main",
    context: {
      channelId: "synthetic",
      channelName: "Synthetic",
      accountId: "test",
      chatId: "test-chat",
      messageId,
      senderId: "synthetic-user",
      isGroup: false,
      timestamp: now,
    },
  };
}

function prepare(messageId: string, now: number) {
  const result = prepareProviderContinuityRequest({
    agentId: "main",
    sessionName: `main-dm-${messageId}`,
    prompt: prompt(messageId, now),
    activation: "synthetic",
    now,
  });
  if (!result.active || !result.ready) throw new Error(`Request '${messageId}' was not ready: ${result.reason}.`);
  return result;
}

function overload(now: number, retryAfterMs = 1_000): ProviderContinuityFailureEvidence {
  return {
    kind: "overload",
    confidence: "high",
    safeToRetry: true,
    safeToSwitch: true,
    credentialRecoveryEligible: false,
    qualifiedForCircuit: true,
    code: "provider_overloaded",
    message: "synthetic overload",
    retryAfterMs,
    observedAt: now,
    fingerprint: `overload-${now}-${retryAfterMs}`,
  };
}

function open(target: ProviderContinuityTarget, base: number, retryAfterMs = 1_000) {
  let health;
  for (let index = 0; index < 3; index += 1) {
    health = recordProviderContinuityTargetFailure({
      agentId: "main",
      target,
      evidence: overload(base + index, retryAfterMs),
      now: base + index,
    });
  }
  if (!health) throw new Error("Target did not receive synthetic failures.");
  return health;
}

describe("provider continuity coordinator branches", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-provider-continuity-coordinator-");
    previousLiveGate = process.env.RAVI_PROVIDER_CONTINUITY_LIVE;
    delete process.env.RAVI_PROVIDER_CONTINUITY_LIVE;
  });

  afterEach(async () => {
    if (previousLiveGate === undefined) {
      delete process.env.RAVI_PROVIDER_CONTINUITY_LIVE;
    } else {
      process.env.RAVI_PROVIDER_CONTINUITY_LIVE = previousLiveGate;
    }
    previousLiveGate = undefined;
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("preserves legacy behavior for absent, disabled, and live-gated policies", () => {
    const absent = prepareProviderContinuityRequest({
      agentId: "main",
      sessionName: "main-dm-absent",
      prompt: { prompt: "no source id" },
      activation: "synthetic",
      now: 10_000,
    });
    expect(absent).toMatchObject({ active: false, reason: "no_policy" });

    writePolicy(config(false), 10_001);
    const disabled = prepareProviderContinuityRequest({
      agentId: "main",
      sessionName: "main-dm-disabled",
      prompt: prompt("disabled", 10_002),
      activation: "synthetic",
      now: 10_002,
    });
    expect(disabled).toMatchObject({ active: false, reason: "policy_disabled" });

    writePolicy(config(true), 10_003);
    const gated = prepareProviderContinuityRequest({
      agentId: "main",
      sessionName: "main-dm-gated",
      prompt: prompt("gated", 10_004),
      now: 10_004,
    });
    expect(gated).toMatchObject({ active: false, reason: "live_activation_blocked" });
    expect(providerContinuityActivationReason()).toContain("blocked");
    process.env.RAVI_PROVIDER_CONTINUITY_LIVE = "1";
    expect(providerContinuityActivationReason()).toBe("enabled");
  });

  it("readbacks existing waiting, HOLD, terminal, and malformed-running journals safely", () => {
    writePolicy();
    const waiting = prepare("waiting", 20_000);
    waitProviderContinuityJournal(waiting.journal.logicalRequestId, 20_100, 20_001);
    expect(
      prepareProviderContinuityRequest({
        agentId: "main",
        sessionName: "main-dm-waiting",
        prompt: { ...prompt("waiting", 20_000), _continuity: waiting.metadata },
        activation: "synthetic",
        now: 20_002,
      }),
    ).toMatchObject({ active: true, ready: false, reason: "waiting" });

    const held = prepare("held", 20_200);
    handleProviderContinuityFailure({
      metadata: held.metadata,
      runtimeProvider: held.metadata.target.provider,
      model: held.metadata.target.model,
      error: "unknown synthetic failure",
      now: 20_201,
    });
    expect(
      prepareProviderContinuityRequest({
        agentId: "main",
        sessionName: "main-dm-held",
        prompt: { ...prompt("held", 20_200), _continuity: held.metadata },
        activation: "synthetic",
        now: 20_202,
      }),
    ).toMatchObject({ active: true, ready: false, reason: "hold" });

    const completed = prepare("completed", 20_300);
    markProviderContinuitySuccess({ metadata: completed.metadata, now: 20_301 });
    expect(
      prepareProviderContinuityRequest({
        agentId: "main",
        sessionName: "main-dm-completed",
        prompt: { ...prompt("completed", 20_300), _continuity: completed.metadata },
        activation: "synthetic",
        now: 20_302,
      }),
    ).toMatchObject({ active: true, ready: false, reason: "terminal" });

    const malformed = prepare("malformed", 20_400);
    saveProviderContinuityJournal(
      providerContinuityJournalSchema.parse({
        ...malformed.journal,
        attempts: malformed.journal.attempts.map((attempt) => ({
          ...attempt,
          completedAt: 20_401,
          outcome: "failed",
          failure: overload(20_401),
        })),
        state: "pending",
        updatedAt: 20_401,
      }),
    );
    expect(
      prepareProviderContinuityRequest({
        agentId: "main",
        sessionName: "main-dm-malformed",
        prompt: { ...prompt("malformed", 20_400), _continuity: malformed.metadata },
        activation: "synthetic",
        now: 20_402,
      }),
    ).toMatchObject({ active: true, ready: false, reason: "hold" });
  });

  it("starts one persisted probe and emits bounded wait or exhaustion when no target is callable", () => {
    writePolicy();
    const openedPrimary = open(primary, 30_000);
    const probeAt = (openedPrimary.probeEligibleAt ?? 60_000) + 1;
    const probe = prepare("probe", probeAt);
    expect(probe).toMatchObject({
      metadata: { targetIndex: 0, probeLeaseId: expect.any(String) },
      journal: { attempts: [expect.objectContaining({ kind: "probe" })] },
    });

    open(secondary, 30_100);
    const waitingResult = prepareProviderContinuityRequest({
      agentId: "main",
      sessionName: "main-dm-all-waiting",
      prompt: prompt("all-waiting", 30_103),
      activation: "synthetic",
      now: 30_103,
    });
    expect(waitingResult).toMatchObject({ active: true, ready: false, reason: "waiting" });

    const longBase = 100_000;
    open(primary, longBase, 500_000);
    open(secondary, longBase + 10, 500_000);
    const exhausted = prepareProviderContinuityRequest({
      agentId: "main",
      sessionName: "main-dm-no-target",
      prompt: prompt("no-target", longBase + 20),
      activation: "synthetic",
      now: longBase + 20,
    });
    expect(exhausted).toMatchObject({
      active: true,
      ready: false,
      reason: "terminal",
      journal: { state: "exhausted", terminalOutcome: "exhaustion" },
    });
  });

  it("resumes an untouched request through one persisted half-open probe after its durable wake", () => {
    writePolicy();
    const openedPrimary = open(primary, 33_000);
    open(secondary, 33_100);
    const waiting = prepareProviderContinuityRequest({
      agentId: "main",
      sessionName: "main-dm-initial-wait-probe",
      prompt: prompt("initial-wait-probe", 33_103),
      activation: "synthetic",
      now: 33_103,
    });
    expect(waiting).toMatchObject({
      active: true,
      ready: false,
      reason: "waiting",
      journal: { attempts: [], state: "waiting" },
    });
    if (!waiting.active) throw new Error("Expected active continuity request.");
    const wakeAt = openedPrimary.probeEligibleAt;
    if (!wakeAt) throw new Error("Primary did not persist probe eligibility.");

    expect(wakeProviderContinuityJournal(waiting.journal.logicalRequestId, wakeAt)).toMatchObject({
      changed: true,
      journal: { state: "pending" },
    });
    const resumed = resumeProviderContinuityJournal(waiting.journal.logicalRequestId, wakeAt + 1);
    expect(resumed).toMatchObject({
      resumed: true,
      reason: "resume_next_target",
      target: primary,
      journal: {
        state: "running",
        currentTargetIndex: 0,
        attempts: [
          expect.objectContaining({
            target: primary,
            kind: "probe",
            probeLeaseId: expect.any(String),
            outcome: "running",
          }),
        ],
        decisions: expect.arrayContaining([expect.objectContaining({ action: "probe" })]),
      },
    });
    expect(resumeProviderContinuityJournal(waiting.journal.logicalRequestId, wakeAt + 60_002)).toMatchObject({
      resumed: false,
      reason: "probe_lease_not_current",
      journal: {
        state: "hold",
        holdReason: "stale_evidence",
        terminalDetail: "probe_lease_not_current",
        attempts: [expect.objectContaining({ kind: "probe", outcome: "hold" })],
      },
    });
  });

  it("reconstructs the persisted probe lease when completion is resolved by session", () => {
    writePolicy();
    const openedPrimary = open(primary, 35_000);
    const probeAt = (openedPrimary.probeEligibleAt ?? 65_000) + 1;
    const probe = prepare("probe-session-success", probeAt);
    expect(probe.metadata.probeLeaseId).toBeTruthy();

    const succeeded = markProviderContinuitySuccess({
      sessionName: "main-dm-probe-session-success",
      now: probeAt + 1,
    });
    expect(succeeded).toMatchObject({
      state: "succeeded",
      terminalOutcome: "success",
      attempts: [expect.objectContaining({ kind: "probe", outcome: "succeeded" })],
    });
  });

  it("handles session readback, tool effects, resume prompts, and stable delivery ids", () => {
    writePolicy();
    const prepared = prepare("helpers", 40_000);
    const bySession = handleProviderContinuityFailure({
      sessionName: "main-dm-helpers",
      runtimeProvider: "codex",
      model: "gpt-5",
      rawEvent: { status: 503, message: "overloaded" },
      now: 40_001,
    });
    expect(bySession).toMatchObject({ active: true, action: "switch_target", target: secondary });
    if (!bySession.journal) throw new Error("Switched journal missing.");

    const resume = buildProviderContinuityResumePrompt(bySession.journal, {
      prompt: "stashed placeholder",
      _agentId: "main",
    });
    expect(resume).toMatchObject({
      prompt: "coordinator branch helpers",
      _runtimeProviderId: "claude",
      _runtimeModel: "sonnet",
      _resumeStashedMessages: true,
    });

    markProviderContinuityToolStarted({
      sessionName: "main-dm-helpers",
      toolCallId: "tool-helpers",
      toolName: "synthetic_write",
      arguments: { value: 1 },
      now: 40_002,
    });
    markProviderContinuityToolCompleted({
      sessionName: "main-dm-helpers",
      toolCallId: "tool-helpers",
      toolName: "synthetic_write",
      content: { ok: true },
      now: 40_003,
    });
    const effectId = requireProviderContinuityJournal(bySession.journal.logicalRequestId).activeEffectId;
    expect(effectId).not.toBeNull();
    expect(effectId ? getProviderContinuityEffect(effectId)?.status : null).toBe("succeeded");

    const delivery = markProviderContinuityDelivery({
      logicalRequestId: bySession.journal.logicalRequestId,
      state: "delivered",
      now: 40_004,
    });
    expect(delivery).toMatchObject({
      deliveryId: prepared.metadata.deliveryId,
      deliveryState: "delivered",
    });

    markProviderContinuityToolStarted({
      sessionName: "missing-session",
      toolCallId: "no-op",
      toolName: "no_op",
    });
    markProviderContinuityToolCompleted({
      sessionName: "missing-session",
      toolCallId: "no-op",
      toolName: "no_op",
    });
    expect(
      handleProviderContinuityFailure({
        sessionName: "missing-session",
        runtimeProvider: "codex",
        model: "gpt-5",
        error: "none",
      }),
    ).toEqual({ active: false, action: "legacy", reason: "no_active_continuity_journal" });
  });

  it("requires reconciliation when a turn completes with an unresolved effect", () => {
    writePolicy();
    const prepared = prepare("unresolved-effect", 50_000);
    markProviderContinuityToolStarted({
      sessionName: "main-dm-unresolved-effect",
      toolCallId: "tool-unresolved",
      toolName: "synthetic_write",
      arguments: { value: 1 },
      now: 50_001,
    });
    const result = markProviderContinuitySuccess({ sessionName: "main-dm-unresolved-effect", now: 50_002 });
    expect(result).toMatchObject({
      state: "reconciliation_required",
      holdReason: "effect_started",
      terminalOutcome: null,
    });
    expect(resumeProviderContinuityJournal(prepared.journal.logicalRequestId, 50_003)).toMatchObject({
      resumed: false,
      reason: "effect_started",
    });
    expect(() => waitProviderContinuityJournal(prepared.journal.logicalRequestId, 50_100, 50_003)).toThrow(
      "reconciliation",
    );
  });

  it("keeps the oldest running journal bound to an active session turn", () => {
    writePolicy();
    const first = prepareProviderContinuityRequest({
      agentId: "main",
      sessionName: "main-dm-shared",
      prompt: prompt("shared-first", 55_000),
      activation: "synthetic",
      now: 55_000,
    });
    const queued = prepareProviderContinuityRequest({
      agentId: "main",
      sessionName: "main-dm-shared",
      prompt: prompt("shared-queued", 55_001),
      activation: "synthetic",
      now: 55_001,
    });
    if (!first.active || !first.ready || !queued.active || !queued.ready) {
      throw new Error("Synthetic shared-session requests were not ready.");
    }

    expect(getActiveProviderContinuityJournalForSession("main-dm-shared")?.logicalRequestId).toBe(
      first.journal.logicalRequestId,
    );
    markProviderContinuitySuccess({ sessionName: "main-dm-shared", now: 55_002 });
    expect(requireProviderContinuityJournal(first.journal.logicalRequestId).terminalOutcome).toBe("success");
    expect(getActiveProviderContinuityJournalForSession("main-dm-shared")?.logicalRequestId).toBe(
      queued.journal.logicalRequestId,
    );
  });

  it("persists canonical Ravi history and uses it in a cross-provider resume", () => {
    writePolicy();
    saveMessage("main-dm-portable-history", "user", "earlier user context", undefined, {
      agentId: "main",
      sourceMessageId: "history-user",
    });
    saveMessage("main-dm-portable-history", "assistant", "earlier assistant context", undefined, {
      agentId: "main",
      sourceMessageId: "history-assistant",
    });
    const prepared = prepare("portable-history", 55_500);
    expect(prepared.journal.contextSnapshot.messages.map((message) => message.content)).toEqual([
      "earlier user context",
      "earlier assistant context",
      "coordinator branch portable-history",
    ]);

    const failed = handleProviderContinuityFailure({
      metadata: prepared.metadata,
      runtimeProvider: "codex",
      model: "gpt-5",
      rawEvent: { status: 503, message: "overloaded" },
      now: 55_501,
    });
    if (!failed.journal) throw new Error("Cross-provider journal missing.");
    const resume = buildProviderContinuityResumePrompt(failed.journal, {
      prompt: "placeholder",
      _agentId: "main",
    });
    expect(resume.prompt).toContain("earlier user context");
    expect(resume.prompt).toContain("earlier assistant context");
    expect(resume.prompt).toContain("coordinator branch portable-history");
    expect(resume).toMatchObject({
      _runtimeProviderId: "claude",
      _runtimeModel: "sonnet",
      _resumeStashedMessages: true,
    });
  });

  it("re-reads recovery after a durable wait and starts the first newly eligible later target", () => {
    writePolicy();
    const openedSecondary = open(secondary, 56_000, 5_000);
    const prepared = prepare("wait-resume", 56_010);
    const failed = handleProviderContinuityFailure({
      metadata: prepared.metadata,
      runtimeProvider: "codex",
      model: "gpt-5",
      rawEvent: { status: 503, message: "overloaded" },
      now: 56_011,
    });
    expect(failed).toMatchObject({ action: "wait", journal: { state: "waiting" } });
    const wakeAt = failed.journal?.wakeAt;
    if (!wakeAt) throw new Error("Failure did not persist a durable wake.");

    saveProviderContinuityHealth({
      ...openedSecondary,
      state: "closed",
      consecutiveQualifiedFailures: 0,
      probationSuccesses: 0,
      openedAt: null,
      probeEligibleAt: null,
      probeLeaseId: null,
      probeLeaseExpiresAt: null,
      stableSince: null,
      updatedAt: wakeAt,
    });
    expect(wakeProviderContinuityJournal(prepared.journal.logicalRequestId, wakeAt)).toMatchObject({
      changed: true,
      journal: { state: "pending" },
    });
    const resumed = resumeProviderContinuityJournal(prepared.journal.logicalRequestId, wakeAt + 1);
    expect(resumed).toMatchObject({
      resumed: true,
      reason: "resume_next_target",
      target: secondary,
      journal: {
        currentTargetIndex: 1,
        state: "running",
        attempts: [
          expect.objectContaining({ targetIndex: 0, outcome: "failed" }),
          expect.objectContaining({ targetIndex: 1, outcome: "running" }),
        ],
      },
    });
  });

  it("records every ineligible target skipped while resuming the frozen order", () => {
    writePolicy({ ...config(), targets: [primary, secondary, tertiary] });
    open(secondary, 58_000, 60_000);
    const openedTertiary = open(tertiary, 58_100);
    const prepared = prepare("resume-skip", 58_200);
    const failed = handleProviderContinuityFailure({
      metadata: prepared.metadata,
      runtimeProvider: "codex",
      model: "gpt-5",
      rawEvent: { status: 503, message: "overloaded" },
      now: 58_201,
    });
    expect(failed).toMatchObject({ action: "wait", journal: { state: "waiting" } });
    const wakeAt = failed.journal?.wakeAt;
    if (!wakeAt) throw new Error("Failure did not persist a durable wake.");

    saveProviderContinuityHealth({
      ...openedTertiary,
      state: "closed",
      consecutiveQualifiedFailures: 0,
      probationSuccesses: 0,
      openedAt: null,
      probeEligibleAt: null,
      probeLeaseId: null,
      probeLeaseExpiresAt: null,
      stableSince: null,
      updatedAt: wakeAt,
    });
    wakeProviderContinuityJournal(prepared.journal.logicalRequestId, wakeAt);
    const resumed = resumeProviderContinuityJournal(prepared.journal.logicalRequestId, wakeAt + 1);

    expect(resumed).toMatchObject({
      resumed: true,
      target: tertiary,
      journal: {
        decisions: expect.arrayContaining([
          expect.objectContaining({
            action: "skip_target",
            fromTargetIndex: 1,
            rejectionReasons: ["circuit_open"],
          }),
          expect.objectContaining({ action: "switch_target", fromTargetIndex: 0, toTargetIndex: 2 }),
        ]),
      },
    });
    expect(
      readProviderContinuityTrace({
        logicalRequestId: prepared.journal.logicalRequestId,
      }).events.map((event) => event.type),
    ).toContain("continuity.decision.skip_target");
  });

  it("returns one composed terminal failure when a provider fails after a terminal effect", () => {
    writePolicy();
    const prepared = prepare("terminal-effect", 57_000);
    markProviderContinuityToolStarted({
      sessionName: "main-dm-terminal-effect",
      toolCallId: "tool-terminal",
      toolName: "synthetic_write",
      arguments: { authorization: "Bearer secret-token" },
      now: 57_001,
    });
    markProviderContinuityToolCompleted({
      sessionName: "main-dm-terminal-effect",
      toolCallId: "tool-terminal",
      toolName: "synthetic_write",
      arguments: { authorization: "Bearer secret-token" },
      content: { ok: true, apiKey: "sensitive" },
      now: 57_002,
    });
    const failed = handleProviderContinuityFailure({
      metadata: prepared.metadata,
      runtimeProvider: "codex",
      model: "gpt-5",
      rawEvent: { status: 503, message: "overloaded" },
      now: 57_003,
    });
    expect(failed).toMatchObject({
      action: "terminal",
      reason: "provider_failed_after_terminal_effect",
      journal: { state: "failed", terminalOutcome: "failure", effectBoundary: "terminal" },
    });
    expect(JSON.stringify(failed.journal?.contextSnapshot.toolRecords)).not.toContain("secret-token");
    expect(
      markProviderContinuityDelivery({
        logicalRequestId: prepared.journal.logicalRequestId,
        state: "delivered",
        now: 57_004,
      }).deliveryState,
    ).toBe("delivered");
    expect(
      markProviderContinuityDelivery({
        logicalRequestId: prepared.journal.logicalRequestId,
        state: "ambiguous",
        now: 57_005,
      }).deliveryState,
    ).toBe("delivered");
  });

  it("recovers a started effect boundary before making a post-crash failover decision", () => {
    writePolicy();
    const prepared = prepare("effect-crash-window", 58_000);
    markProviderContinuityToolStarted({
      sessionName: "main-dm-effect-crash-window",
      toolCallId: "tool-crash-window",
      toolName: "synthetic_write",
      arguments: { value: 1 },
      now: 58_001,
    });
    const started = requireProviderContinuityJournal(prepared.journal.logicalRequestId);
    saveProviderContinuityJournal(
      providerContinuityJournalSchema.parse({
        ...started,
        effectBoundary: "intention",
        updatedAt: 58_002,
      }),
    );

    const failed = handleProviderContinuityFailure({
      metadata: prepared.metadata,
      runtimeProvider: "codex",
      model: "gpt-5",
      rawEvent: { status: 503, message: "overloaded" },
      now: 58_003,
    });
    expect(failed).toMatchObject({
      action: "hold",
      reason: "external_effect_started",
      journal: {
        state: "reconciliation_required",
        holdReason: "effect_started",
        effectBoundary: "started",
      },
    });
  });

  it("covers terminal, not-due, invalid-wait, and deadline wake readbacks", () => {
    writePolicy();
    const terminal = prepare("terminal-readback", 60_000);
    markProviderContinuitySuccess({ metadata: terminal.metadata, now: 60_001 });
    expect(resumeProviderContinuityJournal(terminal.journal.logicalRequestId, 60_002)).toMatchObject({
      resumed: false,
      reason: "terminal_success",
    });
    expect(wakeProviderContinuityJournal(terminal.journal.logicalRequestId, 60_002).changed).toBe(false);
    expect(() => waitProviderContinuityJournal(terminal.journal.logicalRequestId, 60_100, 60_002)).toThrow("terminal");

    const waiting = prepare("not-due-readback", 60_100);
    waitProviderContinuityJournal(waiting.journal.logicalRequestId, 60_200, 60_101);
    expect(resumeProviderContinuityJournal(waiting.journal.logicalRequestId, 60_150)).toMatchObject({
      resumed: false,
      reason: "wait_not_due",
    });
    expect(() => waitProviderContinuityJournal(waiting.journal.logicalRequestId, 60_100, 60_101)).toThrow("Wait time");

    const expiredRunning = prepare("deadline-running-readback", 60_250);
    expect(
      prepareProviderContinuityRequest({
        agentId: "main",
        sessionName: "main-dm-deadline-running-readback",
        prompt: { ...prompt("deadline-running-readback", 60_250), _continuity: expiredRunning.metadata },
        activation: "synthetic",
        now: expiredRunning.journal.deadlineAt,
      }),
    ).toMatchObject({
      active: true,
      ready: false,
      reason: "terminal",
      journal: { state: "exhausted", terminalOutcome: "exhaustion", terminalDetail: "deadline_expired" },
    });

    const expiring = prepare("deadline-wake", 60_300);
    waitProviderContinuityJournal(expiring.journal.logicalRequestId, expiring.journal.deadlineAt - 1, 60_301);
    expect(wakeProviderContinuityJournal(expiring.journal.logicalRequestId, expiring.journal.deadlineAt)).toMatchObject(
      {
        changed: true,
        journal: { state: "exhausted", terminalOutcome: "exhaustion" },
      },
    );

    const missingTarget = prepare("missing-target", 60_400);
    saveProviderContinuityJournal(
      providerContinuityJournalSchema.parse({
        ...missingTarget.journal,
        currentTargetIndex: 99,
        updatedAt: 60_401,
      }),
    );
    expect(resumeProviderContinuityJournal(missingTarget.journal.logicalRequestId, 60_402)).toMatchObject({
      resumed: false,
      reason: "current_target_missing",
    });
  });

  const restricted = {
    requiresMcpServers: false,
    requiresRemoteSpawn: false,
    toolAccessMode: "restricted",
  } as const;

  it("skips a runtime-incompatible primary and selects the next compatible target for a restricted turn", () => {
    // Chain [pi, claude]: pi is provider-native (no Ravi permission hooks) and cannot serve a
    // restricted turn, so initial selection must skip it and start on claude.
    writePolicy({ ...config(), targets: [tertiary, secondary] });
    const prepared = prepareProviderContinuityRequest({
      agentId: "main",
      sessionName: "main-dm-restricted-initial",
      prompt: prompt("restricted-initial", 62_000),
      activation: "synthetic",
      compatibility: restricted,
      now: 62_000,
    });
    expect(prepared).toMatchObject({
      active: true,
      ready: true,
      metadata: { target: secondary },
      journal: {
        currentTargetIndex: 1,
        compatibilityRequest: { toolAccessMode: "restricted" },
        decisions: expect.arrayContaining([
          expect.objectContaining({
            action: "skip_target",
            fromTargetIndex: 0,
            rejectionReasons: ["compatibility:restricted_tool_access_unsupported"],
          }),
        ]),
      },
    });
  });

  it("skips a runtime-incompatible failover target and switches to the next compatible one", () => {
    // Chain [codex, pi, claude]: a restricted turn starts on codex (Ravi-host). When codex fails,
    // failover must skip pi (provider-native) and switch to claude rather than migrate onto pi.
    writePolicy({ ...config(), targets: [primary, tertiary, secondary] });
    const prepared = prepareProviderContinuityRequest({
      agentId: "main",
      sessionName: "main-dm-restricted-failover",
      prompt: prompt("restricted-failover", 63_000),
      activation: "synthetic",
      compatibility: restricted,
      now: 63_000,
    });
    if (!prepared.active || !prepared.ready)
      throw new Error(`Restricted failover request not ready: ${prepared.reason}.`);
    expect(prepared.journal.currentTargetIndex).toBe(0);

    const failed = handleProviderContinuityFailure({
      metadata: prepared.metadata,
      runtimeProvider: "codex",
      model: "gpt-5",
      rawEvent: { status: 503, message: "overloaded" },
      now: 63_001,
    });
    expect(failed).toMatchObject({
      active: true,
      action: "switch_target",
      target: secondary,
      journal: {
        currentTargetIndex: 2,
        decisions: expect.arrayContaining([
          expect.objectContaining({
            action: "skip_target",
            fromTargetIndex: 1,
            rejectionReasons: expect.arrayContaining(["compatibility:restricted_tool_access_unsupported"]),
          }),
          expect.objectContaining({ action: "switch_target", fromTargetIndex: 0, toTargetIndex: 2 }),
        ]),
      },
    });
  });

  it("terminates with a clear compatibility reason when no target can serve a restricted turn", () => {
    // Chain [pi] only: a restricted turn has no compatible target, so continuity must terminate
    // cleanly with an actionable reason instead of leaking a raw assertRuntimeCompatibility throw.
    writePolicy({ ...config(), targets: [tertiary] });
    const terminal = prepareProviderContinuityRequest({
      agentId: "main",
      sessionName: "main-dm-restricted-exhausted",
      prompt: prompt("restricted-exhausted", 64_000),
      activation: "synthetic",
      compatibility: restricted,
      now: 64_000,
    });
    expect(terminal).toMatchObject({
      active: true,
      ready: false,
      reason: "terminal",
      journal: {
        state: "exhausted",
        terminalOutcome: "exhaustion",
        compatibilityRequest: { toolAccessMode: "restricted" },
      },
      userMessage: expect.stringContaining("compatibility:restricted_tool_access_unsupported"),
    });
  });
});
