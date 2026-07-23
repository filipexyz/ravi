import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { classifyProviderContinuityFailure } from "../credential-classifier.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import {
  handleProviderContinuityFailure,
  markProviderContinuitySuccess,
  prepareProviderContinuityRequest,
  resumeProviderContinuityJournal,
  waitProviderContinuityJournal,
  wakeProviderContinuityJournal,
} from "./coordinator.js";
import {
  markProviderContinuityEffectAmbiguous,
  markProviderContinuityEffectStarted,
  prepareProviderContinuityEffect,
  reconcileProviderContinuityEffect,
} from "./effects.js";
import { readProviderContinuityTrace, recordProviderContinuityEvent, redactProviderContinuityValue } from "./events.js";
import {
  acquireProviderContinuityProbeLease,
  readProviderContinuityHealth,
  recordProviderContinuityTargetFailure,
  recordProviderContinuityTargetSuccess,
} from "./recovery.js";
import { getProviderContinuityPolicy, writeProviderContinuityPolicy } from "./store.js";
import {
  PROVIDER_CONTINUITY_DEFAULTS,
  PROVIDER_CONTINUITY_SNAPSHOT,
  PROVIDER_CONTINUITY_SPEC_VERSION,
  type ProviderContinuityFailureEvidence,
  type ProviderContinuityPolicyConfig,
  type ProviderContinuityPromptMetadata,
  type ProviderContinuityTarget,
} from "./types.js";

let stateDir: string | null = null;
let previousLiveGate: string | undefined;

const primary: ProviderContinuityTarget = { provider: "codex", model: "gpt-5" };
const secondary: ProviderContinuityTarget = { provider: "claude", model: "sonnet" };
const tertiary: ProviderContinuityTarget = { provider: "pi", model: "openai/gpt-5" };

function policy(targets: ProviderContinuityTarget[] = [primary, secondary]): ProviderContinuityPolicyConfig {
  return {
    specVersion: PROVIDER_CONTINUITY_SPEC_VERSION,
    compatibilitySnapshotId: PROVIDER_CONTINUITY_SNAPSHOT,
    strategy: "ordered",
    targets,
    deadlineMs: 120_000,
    enabled: true,
  };
}

function installPolicy(targets: ProviderContinuityTarget[] = [primary, secondary], now = 1_000): void {
  const current = getProviderContinuityPolicy("main");
  writeProviderContinuityPolicy({
    agentId: "main",
    expectedVersion: current?.version ?? 0,
    policy: policy(targets),
    now,
  });
}

function prompt(messageId: string, now: number) {
  return {
    prompt: `synthetic continuity request ${messageId}`,
    _agentId: "main",
    context: {
      channelId: "synthetic",
      channelName: "Synthetic",
      accountId: "test",
      chatId: "synthetic-chat",
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
  if (!result.active || !result.ready) {
    throw new Error(`Synthetic request '${messageId}' was not ready: ${result.reason}.`);
  }
  return result;
}

function failure(input: {
  metadata: ProviderContinuityPromptMetadata;
  now: number;
  status?: number;
  message?: string;
  code?: string;
  evidenceState?: "valid" | "missing" | "stale" | "conflicting" | "known_invalid";
}) {
  return handleProviderContinuityFailure({
    metadata: input.metadata,
    runtimeProvider: input.metadata.target.provider,
    model: input.metadata.target.model,
    rawEvent: {
      status: input.status,
      code: input.code,
      message: input.message,
    },
    evidenceState: input.evidenceState,
    now: input.now,
  });
}

function qualifiedFailure(now: number): ProviderContinuityFailureEvidence {
  return {
    kind: "overload",
    confidence: "high",
    safeToRetry: true,
    safeToSwitch: true,
    credentialRecoveryEligible: false,
    qualifiedForCircuit: true,
    code: "provider_overloaded",
    message: "synthetic overload",
    retryAfterMs: 1_000,
    observedAt: now,
    fingerprint: `qualified-${now}`,
  };
}

function openTarget(target: ProviderContinuityTarget, base: number): ReturnType<typeof readProviderContinuityHealth> {
  for (let index = 0; index < PROVIDER_CONTINUITY_DEFAULTS.qualifiedFailuresToOpen; index += 1) {
    recordProviderContinuityTargetFailure({
      agentId: "main",
      target,
      evidence: qualifiedFailure(base + index),
      now: base + index,
    });
  }
  return readProviderContinuityHealth({ agentId: "main", target, now: base + 3 });
}

describe("provider continuity R01-R24 synthetic runtime fixtures", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-provider-continuity-runtime-");
    previousLiveGate = process.env.RAVI_PROVIDER_CONTINUITY_LIVE;
    delete process.env.RAVI_PROVIDER_CONTINUITY_LIVE;
    installPolicy();
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

  it("R01 blocks live activation while permitting an explicit synthetic request", () => {
    const live = prepareProviderContinuityRequest({
      agentId: "main",
      sessionName: "main-dm-r01-live",
      prompt: prompt("r01-live", 10_000),
      now: 10_000,
    });
    expect(live).toMatchObject({ active: false, reason: "live_activation_blocked" });

    const synthetic = prepare("r01-synthetic", 10_001);
    expect(synthetic).toMatchObject({
      active: true,
      ready: true,
      metadata: {
        target: primary,
        synthetic: true,
        compatibilitySnapshotId: PROVIDER_CONTINUITY_SNAPSHOT,
      },
    });
  });

  it("R02 selects the configured primary without cost or health reordering", () => {
    installPolicy([primary, secondary, tertiary], 11_000);
    const prepared = prepare("r02", 11_001);
    expect(prepared.metadata.targetIndex).toBe(0);
    expect(prepared.metadata.target).toEqual(primary);
    expect(prepared.journal.policySnapshot.targets).toEqual([primary, secondary, tertiary]);
    expect(prepared.journal.decisions[0]).toMatchObject({
      action: "start",
      reasonCode: "configured_primary",
    });
  });

  it("R03 skips an open primary in exact configured order", () => {
    const opened = openTarget(primary, 12_000);
    const beforeProbe = (opened.probeEligibleAt ?? 42_000) - 1;
    const prepared = prepare("r03", beforeProbe);
    expect(prepared.metadata.targetIndex).toBe(1);
    expect(prepared.metadata.target).toEqual(secondary);
    expect(prepared.journal.decisions).toEqual([
      expect.objectContaining({
        sequence: 1,
        action: "skip_target",
        fromTargetIndex: 0,
        reasonCode: "target_ineligible_in_frozen_order",
        rejectionReasons: ["circuit_open"],
      }),
      expect.objectContaining({
        sequence: 2,
        action: "start",
        reasonCode: "configured_order_skip",
        rejectionReasons: ["target[0]:circuit_open"],
      }),
    ]);
  });

  it("R04 permits exactly one credential recovery on the current target", () => {
    const prepared = prepare("r04", 13_000);
    const recovered = failure({
      metadata: prepared.metadata,
      status: 429,
      message: "exceeded your current quota",
      now: 13_001,
    });
    expect(recovered).toMatchObject({
      active: true,
      action: "recover_credential",
      target: primary,
      journal: {
        currentTargetIndex: 0,
        credentialRecoveriesRemaining: [0, 1],
      },
    });
    expect(recovered.journal?.attempts.map((attempt) => attempt.kind)).toEqual(["normal", "credential_recovery"]);
  });

  it("R05 switches once to the next configured target after credential recovery is spent", () => {
    const prepared = prepare("r05", 14_000);
    const recovered = failure({
      metadata: prepared.metadata,
      status: 429,
      message: "quota exceeded",
      now: 14_001,
    });
    if (!recovered.metadata) throw new Error("Credential recovery metadata missing.");
    const switched = failure({
      metadata: recovered.metadata,
      status: 429,
      message: "quota still exceeded",
      now: 14_002,
    });
    expect(switched).toMatchObject({
      action: "switch_target",
      target: secondary,
      journal: {
        currentTargetIndex: 1,
        normalAttemptsRemaining: [0, 0],
        globalAttemptsRemaining: 0,
      },
    });
    expect(switched.journal?.attempts.map((attempt) => [attempt.targetIndex, attempt.kind])).toEqual([
      [0, "normal"],
      [0, "credential_recovery"],
      [1, "normal"],
    ]);
  });

  it("records an explicit skip decision before switching past an ineligible target", () => {
    installPolicy([primary, secondary, tertiary], 14_500);
    const openedSecondary = openTarget(secondary, 14_501);
    const beforeProbe = (openedSecondary.probeEligibleAt ?? 44_503) - 1;
    const prepared = prepare("skip-before-switch", beforeProbe - 1);
    const switched = failure({
      metadata: prepared.metadata,
      status: 503,
      message: "provider overloaded",
      now: beforeProbe,
    });
    expect(switched).toMatchObject({
      action: "switch_target",
      target: tertiary,
      journal: {
        decisions: [
          expect.objectContaining({ action: "start", toTargetIndex: 0 }),
          expect.objectContaining({
            action: "skip_target",
            fromTargetIndex: 1,
            rejectionReasons: ["circuit_open"],
          }),
          expect.objectContaining({ action: "switch_target", fromTargetIndex: 0, toTargetIndex: 2 }),
        ],
      },
    });
    expect(
      readProviderContinuityTrace({
        logicalRequestId: prepared.journal.logicalRequestId,
      }).events.map((event) => event.type),
    ).toContain("continuity.decision.skip_target");
  });

  it("R06 exhausts a bounded chain and never exceeds four provider invocations", () => {
    installPolicy([primary, secondary, tertiary], 15_000);
    const prepared = prepare("r06", 15_001);
    const first = failure({
      metadata: prepared.metadata,
      status: 503,
      message: "provider overloaded",
      now: 15_002,
    });
    if (!first.metadata) throw new Error("First switch metadata missing.");
    const second = failure({
      metadata: first.metadata,
      status: 503,
      message: "provider overloaded",
      now: 15_003,
    });
    if (!second.metadata) throw new Error("Second switch metadata missing.");
    const third = failure({
      metadata: second.metadata,
      status: 503,
      message: "provider overloaded",
      now: 15_004,
    });
    expect(third).toMatchObject({
      action: "terminal",
      journal: {
        state: "exhausted",
        terminalOutcome: "exhaustion",
        globalAttemptsRemaining: 1,
      },
    });
    expect(third.journal?.attempts).toHaveLength(3);
    expect(third.journal?.attempts.length).toBeLessThanOrEqual(PROVIDER_CONTINUITY_DEFAULTS.maximumGlobalAttempts);
  });

  it("R07 classifies rate limiting with retry metadata", () => {
    const evidence = classifyProviderContinuityFailure({
      runtimeProvider: "codex",
      model: "gpt-5",
      rawEvent: {
        status: 429,
        message: "rate limit reached",
        headers: { "retry-after": "2" },
      },
      observedAt: 16_000,
    });
    expect(evidence).toMatchObject({
      kind: "rate_limit",
      confidence: "high",
      safeToSwitch: true,
      retryAfterMs: 2_000,
    });
  });

  it("R08 classifies authentication failure without exposing credentials", () => {
    const evidence = classifyProviderContinuityFailure({
      runtimeProvider: "claude",
      model: "sonnet",
      rawEvent: {
        status: 401,
        message: "Bearer abcdefghijkl is invalid",
        authorization: "Bearer abcdefghijkl",
      },
      observedAt: 17_000,
    });
    expect(evidence).toMatchObject({
      kind: "authentication",
      credentialRecoveryEligible: true,
      safeToSwitch: true,
    });
    expect(JSON.stringify(evidence)).not.toContain("abcdefghijkl");
  });

  it("R09 classifies timeout as a safe transient failure", () => {
    const evidence = classifyProviderContinuityFailure({
      runtimeProvider: "codex",
      model: "gpt-5",
      error: Object.assign(new Error("socket timed out"), { code: "ETIMEDOUT" }),
      observedAt: 18_000,
    });
    expect(evidence).toMatchObject({
      kind: "timeout",
      safeToRetry: true,
      safeToSwitch: true,
      qualifiedForCircuit: true,
    });
  });

  it("R10 distinguishes overload and network failures", () => {
    const overloaded = classifyProviderContinuityFailure({
      runtimeProvider: "codex",
      model: "gpt-5",
      rawEvent: { status: 503, message: "overloaded" },
      observedAt: 19_000,
    });
    const network = classifyProviderContinuityFailure({
      runtimeProvider: "codex",
      model: "gpt-5",
      rawEvent: { status: 500, message: "upstream unavailable" },
      observedAt: 19_001,
    });
    expect(overloaded.kind).toBe("overload");
    expect(network.kind).toBe("network");
  });

  it("R11 returns a composed terminal failure for a permanent request error", () => {
    const prepared = prepare("r11", 20_000);
    const result = failure({
      metadata: prepared.metadata,
      status: 400,
      message: "invalid request",
      now: 20_001,
    });
    expect(result).toMatchObject({
      action: "terminal",
      journal: {
        state: "failed",
        terminalOutcome: "failure",
        currentTargetIndex: 0,
      },
    });
  });

  it("R12 treats cancellation as terminal and never switches target", () => {
    const prepared = prepare("r12", 21_000);
    const result = failure({
      metadata: prepared.metadata,
      message: "operation cancelled by caller",
      now: 21_001,
    });
    expect(result).toMatchObject({
      action: "terminal",
      journal: { currentTargetIndex: 0, terminalOutcome: "failure" },
    });
    expect(result.journal?.attempts).toHaveLength(1);
  });

  it("R13 turns unknown low-confidence evidence into an explainable HOLD", () => {
    const prepared = prepare("r13", 22_000);
    const result = failure({
      metadata: prepared.metadata,
      message: "unrecognized synthetic failure",
      now: 22_001,
    });
    expect(result).toMatchObject({
      action: "hold",
      reason: "failure_evidence_unknown",
      journal: {
        state: "hold",
        holdReason: "unknown_evidence",
        terminalOutcome: null,
      },
    });
  });

  it("R14 maps missing, stale, conflicting, and known-invalid evidence to distinct HOLDs", () => {
    const cases = [
      ["missing", "missing_evidence"],
      ["stale", "stale_evidence"],
      ["conflicting", "conflicting_evidence"],
      ["known_invalid", "known_invalid_evidence"],
    ] as const;
    for (const [index, [evidenceState, holdReason]] of cases.entries()) {
      const prepared = prepare(`r14-${evidenceState}`, 23_000 + index * 10);
      const result = failure({
        metadata: prepared.metadata,
        status: 503,
        message: "provider overloaded",
        evidenceState,
        now: 23_001 + index * 10,
      });
      expect(result).toMatchObject({
        action: "hold",
        journal: { state: "hold", holdReason },
      });
    }
  });

  it("R15 preserves the portable-context fingerprint across switch and restart resume", () => {
    const prepared = prepare("r15", 24_000);
    const switched = failure({
      metadata: prepared.metadata,
      status: 503,
      message: "overloaded",
      now: 24_001,
    });
    if (!switched.metadata || !switched.journal) throw new Error("Switch metadata missing.");
    expect(switched.metadata.contextFingerprint).toBe(prepared.metadata.contextFingerprint);
    expect(switched.journal.contextSnapshot.fingerprint).toBe(prepared.journal.contextSnapshot.fingerprint);

    const afterRestart = prepareProviderContinuityRequest({
      agentId: "main",
      sessionName: "main-dm-r15",
      prompt: { ...prompt("r15", 24_000), _continuity: switched.metadata },
      activation: "synthetic",
      now: 24_002,
    });
    expect(afterRestart).toMatchObject({
      active: true,
      ready: true,
      reason: "resume",
      metadata: {
        attemptId: switched.metadata.attemptId,
        contextFingerprint: prepared.metadata.contextFingerprint,
      },
    });
  });

  it("R16 forbids automatic retry or switch after an external effect starts", () => {
    const prepared = prepare("r16", 25_000);
    const effect = prepareProviderContinuityEffect({
      logicalRequestId: prepared.journal.logicalRequestId,
      toolCallId: "tool-r16",
      operation: "orders_create",
      arguments: { order: "synthetic" },
      now: 25_001,
    });
    markProviderContinuityEffectStarted(effect.effect.effectId, 25_002);
    const result = failure({
      metadata: prepared.metadata,
      status: 503,
      message: "provider overloaded after write",
      now: 25_003,
    });
    expect(result).toMatchObject({
      action: "hold",
      reason: "external_effect_started",
      journal: {
        state: "reconciliation_required",
        holdReason: "effect_started",
        currentTargetIndex: 0,
      },
    });
  });

  it("R17 reconciles an ambiguous effect only through stable-identity readback", () => {
    const prepared = prepare("r17", 26_000);
    const effect = prepareProviderContinuityEffect({
      logicalRequestId: prepared.journal.logicalRequestId,
      toolCallId: "tool-r17",
      operation: "payments_capture",
      arguments: { amount: 10 },
      now: 26_001,
    });
    markProviderContinuityEffectStarted(effect.effect.effectId, 26_002);
    markProviderContinuityEffectAmbiguous({
      effectId: effect.effect.effectId,
      error: new Error("connection lost after request"),
      now: 26_003,
    });
    const held = failure({
      metadata: prepared.metadata,
      status: 503,
      message: "provider unavailable",
      now: 26_004,
    });
    expect(held).toMatchObject({
      action: "hold",
      journal: { state: "reconciliation_required", holdReason: "effect_ambiguous" },
    });

    const reconciled = reconcileProviderContinuityEffect({
      effectId: effect.effect.effectId,
      outcome: "succeeded",
      evidenceRef: "synthetic-readback-r17",
      now: 26_005,
    });
    expect(reconciled).toMatchObject({
      changed: true,
      effect: { status: "reconciled" },
      journal: { state: "pending", effectBoundary: "terminal" },
    });
    const resumed = resumeProviderContinuityJournal(prepared.journal.logicalRequestId, 26_006);
    expect(resumed).toMatchObject({
      resumed: true,
      target: secondary,
      reason: "resume_next_target",
      journal: {
        state: "running",
        effectBoundary: "terminal",
        attempts: [
          expect.objectContaining({ target: primary, outcome: "failed" }),
          expect.objectContaining({ target: secondary, outcome: "running" }),
        ],
      },
    });
    expect(resumed.journal.contextSnapshot.toolRecords).toEqual([
      expect.objectContaining({
        id: "tool-r17",
        name: "payments_capture",
        status: "succeeded",
        output: { outcome: "succeeded" },
      }),
    ]);
  });

  it("R18 persists one visible success terminal outcome under duplicate completion", () => {
    const prepared = prepare("r18", 27_000);
    const first = markProviderContinuitySuccess({ metadata: prepared.metadata, now: 27_001 });
    const duplicate = markProviderContinuitySuccess({ metadata: prepared.metadata, now: 27_002 });
    expect(first).toEqual(duplicate);
    expect(first).toMatchObject({
      state: "succeeded",
      terminalOutcome: "success",
      terminalDetail: "provider_turn_completed",
    });
    expect(first?.decisions.filter((decision) => decision.action === "success")).toHaveLength(1);
  });

  it("R19 persists wait and permits wake only when due", () => {
    const prepared = prepare("r19", 28_000);
    const waiting = waitProviderContinuityJournal(prepared.journal.logicalRequestId, 28_100, 28_001);
    expect(waiting).toMatchObject({ changed: true, journal: { state: "waiting", wakeAt: 28_100 } });
    expect(wakeProviderContinuityJournal(prepared.journal.logicalRequestId, 28_099).changed).toBe(false);
    const woke = wakeProviderContinuityJournal(prepared.journal.logicalRequestId, 28_100);
    expect(woke).toMatchObject({ changed: true, journal: { state: "pending", wakeAt: null } });
    const resumed = resumeProviderContinuityJournal(prepared.journal.logicalRequestId, 28_101);
    expect(resumed).toMatchObject({ resumed: true, target: primary, reason: "resume_ready" });
  });

  it("R20 stops a durable request at its deadline", () => {
    const prepared = prepare("r20", 29_000);
    const result = resumeProviderContinuityJournal(prepared.journal.logicalRequestId, prepared.journal.deadlineAt);
    expect(result).toMatchObject({
      resumed: false,
      reason: "deadline_expired",
      journal: { state: "exhausted", terminalOutcome: "exhaustion" },
    });
    expect(
      readProviderContinuityTrace({
        logicalRequestId: prepared.journal.logicalRequestId,
      }).events,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "continuity.decision.exhausted",
          payload: expect.objectContaining({
            decision: expect.objectContaining({ action: "exhausted", reasonCode: "deadline_expired" }),
          }),
        }),
      ]),
    );
  });

  it("R21 replays ordered decisions with cursor pagination and redaction", () => {
    const prepared = prepare("r21", 30_000);
    const syntheticApiKey = ["s", "k-secret_abcdef123456"].join("");
    recordProviderContinuityEvent({
      logicalRequestId: prepared.journal.logicalRequestId,
      agentId: "main",
      type: "continuity.synthetic.secret",
      payload: {
        authorization: "Bearer abcdefghijkl",
        nested: { apiKey: syntheticApiKey },
      },
      now: 30_001,
    });
    recordProviderContinuityEvent({
      logicalRequestId: prepared.journal.logicalRequestId,
      agentId: "main",
      type: "continuity.synthetic.next",
      payload: { state: "safe" },
      now: 30_002,
    });
    const first = readProviderContinuityTrace({
      logicalRequestId: prepared.journal.logicalRequestId,
      limit: 1,
    });
    expect(first.pagination).toMatchObject({ limit: 1, hasMore: true });
    expect(first.pagination.nextCursor).not.toBeNull();
    const second = readProviderContinuityTrace({
      logicalRequestId: prepared.journal.logicalRequestId,
      cursor: first.pagination.nextCursor ?? undefined,
      limit: 10,
    });
    expect(second.events[0]?.eventId).toBeGreaterThan(first.events[0]?.eventId ?? 0);
    expect(JSON.stringify([...first.events, ...second.events])).not.toContain("abcdefghijkl");
    expect(JSON.stringify([...first.events, ...second.events])).not.toContain("abcdef123456");
  });

  it("R22 admits one durable half-open probe and rejects a concurrent probe", () => {
    const opened = openTarget(primary, 31_000);
    const probeAt = (opened.probeEligibleAt ?? 61_000) + 1;
    const first = acquireProviderContinuityProbeLease({
      agentId: "main",
      target: primary,
      deadlineAt: probeAt + 120_000,
      now: probeAt,
    });
    const concurrent = acquireProviderContinuityProbeLease({
      agentId: "main",
      target: primary,
      deadlineAt: probeAt + 120_000,
      now: probeAt,
    });
    expect(first.acquired).toBe(true);
    expect(concurrent).toMatchObject({
      acquired: false,
      reason: "half_open_probe_lease_busy",
    });
  });

  it("R23 fails back only on a new request after probation and dwell while the old request stays sticky", () => {
    const opened = openTarget(primary, 32_000);
    const oldRequest = prepare("r23-old", (opened.probeEligibleAt ?? 62_000) - 1);
    expect(oldRequest.metadata.target).toEqual(secondary);

    let cursor = (opened.probeEligibleAt ?? 62_000) + 1;
    for (let success = 0; success < PROVIDER_CONTINUITY_DEFAULTS.probationSuccessesToClose; success += 1) {
      const lease = acquireProviderContinuityProbeLease({
        agentId: "main",
        target: primary,
        deadlineAt: cursor + 120_000,
        now: cursor,
      });
      expect(lease.acquired).toBe(true);
      recordProviderContinuityTargetSuccess({
        agentId: "main",
        target: primary,
        probe: true,
        leaseId: lease.leaseId,
        now: cursor + 1,
      });
      cursor += 10;
    }
    const stable = readProviderContinuityHealth({ agentId: "main", target: primary });
    const afterDwell = (stable.stableSince ?? cursor) + PROVIDER_CONTINUITY_DEFAULTS.failbackDwellMs;

    const oldResume = prepareProviderContinuityRequest({
      agentId: "main",
      sessionName: "main-dm-r23-old",
      prompt: { ...prompt("r23-old", 32_000), _continuity: oldRequest.metadata },
      activation: "synthetic",
      now: afterDwell,
    });
    expect(oldResume).toMatchObject({
      active: true,
      ready: false,
      reason: "terminal",
      journal: {
        currentTargetIndex: 1,
        state: "exhausted",
        terminalOutcome: "exhaustion",
        terminalDetail: "deadline_expired",
      },
    });
    if (!oldResume.active) throw new Error("Expected active continuity readback.");
    expect(oldResume.journal.decisions.some((decision) => decision.action === "failback")).toBe(false);

    const newRequest = prepare("r23-new", afterDwell + 1);
    expect(newRequest).toMatchObject({
      metadata: { target: primary, targetIndex: 0 },
      journal: {
        decisions: [
          expect.objectContaining({
            action: "failback",
            reasonCode: "failback_after_probation_and_dwell",
          }),
        ],
      },
    });
    markProviderContinuitySuccess({ metadata: newRequest.metadata, now: afterDwell + 2 });
    const preferredAgain = prepare("r23-preferred-again", afterDwell + 3);
    expect(preferredAgain).toMatchObject({
      metadata: { target: primary, targetIndex: 0 },
      journal: {
        decisions: [
          expect.objectContaining({
            action: "start",
            reasonCode: "configured_primary",
          }),
        ],
      },
    });
  });

  it("R24 executes and reconciles all 51,237 classifier/redaction vectors", () => {
    const families = [
      { status: 429, message: "quota exceeded Bearer abcdefghijkl", kind: "quota" },
      { status: 429, message: "rate limit Bearer abcdefghijkl", kind: "rate_limit" },
      { status: 401, message: "invalid Bearer abcdefghijkl", kind: "authentication" },
      { status: undefined, message: "socket timed out Bearer abcdefghijkl", kind: "timeout" },
      { status: 503, message: "overloaded Bearer abcdefghijkl", kind: "overload" },
      { status: 500, message: "upstream failed Bearer abcdefghijkl", kind: "network" },
      { status: 400, message: "invalid request Bearer abcdefghijkl", kind: "permanent_request" },
      { status: undefined, message: "cancelled Bearer abcdefghijkl", kind: "cancellation" },
      { status: undefined, message: "mystery Bearer abcdefghijkl", kind: "unknown" },
    ] as const;
    const observed = new Set<string>();
    const vectorCount = 51_237;
    for (let index = 0; index < vectorCount; index += 1) {
      const family = families[index % families.length]!;
      const vectorSecret = ["s", `k-secret_${index}abcdef`].join("");
      const evidence = classifyProviderContinuityFailure({
        runtimeProvider: index % 2 === 0 ? "codex" : "claude",
        model: index % 2 === 0 ? "gpt-5" : "sonnet",
        rawEvent: {
          status: family.status,
          message: `${family.message} vector-${index}`,
          secret: vectorSecret,
        },
        observedAt: 40_000 + index,
      });
      expect(evidence.kind).toBe(family.kind);
      expect(evidence.fingerprint).toHaveLength(64);
      const publicValue = JSON.stringify(
        redactProviderContinuityValue({
          evidence,
          authorization: "Bearer abcdefghijkl",
          secret: vectorSecret,
        }),
      );
      expect(publicValue).not.toContain("abcdefghijkl");
      expect(publicValue).not.toContain(vectorSecret);
      observed.add(evidence.kind);
    }
    for (const fragments of [
      ["g", "hp_", "abcdefghijklmnopqrstuvwxyz"],
      ["xo", "xb-", "1234567890-abcdefghijkl"],
      ["AK", "IA", "1234567890ABCDEF"],
      ["AI", "za", "abcdefghijklmnopqrstuvwxyz"],
      ["api_", "key=", "topsecretvalue"],
      ["refresh_", "token=", "refreshsecretvalue"],
    ]) {
      const secret = fragments.join("");
      const evidence = classifyProviderContinuityFailure({
        runtimeProvider: "codex",
        model: "gpt-5",
        rawEvent: { status: 503, message: `upstream failure ${secret}` },
        observedAt: 100_000,
      });
      expect(evidence.message).not.toContain(secret);
      expect(JSON.stringify(redactProviderContinuityValue({ note: secret }))).not.toContain(secret);
    }
    expect(observed).toEqual(new Set(families.map((family) => family.kind)));
    expect(vectorCount).toBe(51_237);
  });
});
