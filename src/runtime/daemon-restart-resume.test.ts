import { describe, expect, it } from "bun:test";
import type { DaemonRestartSessionSnapshotRecord } from "../router/router-db.js";
import {
  CRASH_RECOVERY_RESTART_RESUME_MODE_METADATA_KEY,
  buildDaemonRestartNoticePrompt,
  buildDaemonRestartResumePrompt,
  captureRestartTurnAuthority,
  resolveRestartSnapshotInterruptedAttemptId,
  restoreRestartTurnAuthority,
  deliverDaemonRestartSessionEvent,
  resolveCrashRecoveryRestartResumeDecision,
  resolveCrashRecoveryRestartResumeMode,
  type DaemonRestartSessionEventDeps,
} from "./daemon-restart-resume.js";
import type { MessageTarget } from "./message-types.js";

const UNSAFE_SNAPSHOT_METADATA = {
  live: true,
  [CRASH_RECOVERY_RESTART_RESUME_MODE_METADATA_KEY]: "skip",
  currentToolName: "Bash",
  crashRecoveryReplaySafety: {
    replayable: false,
    startedTool: true,
    materializedOutput: true,
    inputMutated: false,
    durableBinding: "active",
  },
  crashRecoveryTerminalStatus: null,
};

function snapshotRecord(
  overrides: Partial<DaemonRestartSessionSnapshotRecord> = {},
): DaemonRestartSessionSnapshotRecord {
  return {
    restartEpoch: "epoch-deliver",
    sessionKey: "agent:main:main",
    sessionName: "main",
    agentId: "main",
    runtimeProvider: "claude",
    activity: "tool_running",
    nonIdle: true,
    lastActivityAt: 1,
    stoppedAt: 1,
    pendingMessageCount: 0,
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function restartEventHarness(
  options: {
    alreadyDelivered?: boolean;
    terminalTask?: boolean;
    publishError?: Error;
    markError?: Error;
    source?: MessageTarget;
  } = {},
) {
  const published: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];
  const marked: Array<Parameters<DaemonRestartSessionEventDeps["markDelivered"]>[0]> = [];
  const deps: DaemonRestartSessionEventDeps = {
    hasDelivery: () => options.alreadyDelivered ?? false,
    markDelivered: (input) => {
      if (options.markError) throw options.markError;
      marked.push(input);
    },
    publish: async (sessionName, payload) => {
      if (options.publishError) throw options.publishError;
      published.push({ sessionName, payload });
    },
    isTerminalTaskSession: () => options.terminalTask ?? false,
    resolveSource: () => options.source,
  };
  return { deps, published, marked };
}

const RESTART_EVENT_BASE = {
  restartEpoch: "epoch-deliver",
  reason: "version update",
  sessionName: "main",
  sessionKey: "agent:main:main",
} as const;

describe("daemon restart crash-recovery resume mode", () => {
  it("keeps legacy snapshots without live instrumentation compatible", () => {
    expect(resolveCrashRecoveryRestartResumeMode()).toBe("continue");
    expect(resolveCrashRecoveryRestartResumeMode({ reason: "legacy snapshot" })).toBe("continue");
  });

  it("fails closed for invalid or missing mode on an instrumented live snapshot", () => {
    expect(
      resolveCrashRecoveryRestartResumeMode({
        live: true,
      }),
    ).toBe("skip");
    expect(
      resolveCrashRecoveryRestartResumeMode({
        [CRASH_RECOVERY_RESTART_RESUME_MODE_METADATA_KEY]: "unknown",
      }),
    ).toBe("skip");
    expect(
      resolveCrashRecoveryRestartResumeMode({
        [CRASH_RECOVERY_RESTART_RESUME_MODE_METADATA_KEY]: null,
      }),
    ).toBe("skip");
    expect(
      resolveCrashRecoveryRestartResumeMode({
        [CRASH_RECOVERY_RESTART_RESUME_MODE_METADATA_KEY]: undefined,
      }),
    ).toBe("skip");
  });

  it("accepts only the three explicit modes", () => {
    for (const mode of ["continue", "pending_only", "skip"] as const) {
      expect(
        resolveCrashRecoveryRestartResumeMode({
          [CRASH_RECOVERY_RESTART_RESUME_MODE_METADATA_KEY]: mode,
        }),
      ).toBe(mode);
    }
  });

  it("carries the snapshot provider as a last-used resume hint", () => {
    expect(
      buildDaemonRestartResumePrompt({
        restartEpoch: "epoch-codex",
        reason: "pm2-restart",
        sessionKey: "agent:main:main",
        mode: "continue",
        runtimeProvider: "codex",
      }),
    ).toMatchObject({
      _daemonRestartResume: {
        restartEpoch: "epoch-codex",
        sessionKey: "agent:main:main",
        runtimeProvider: "codex",
      },
    });
  });

  it("never builds a prompt for skip mode", () => {
    expect(
      buildDaemonRestartResumePrompt({
        restartEpoch: "epoch-test",
        reason: "test",
        sessionKey: "session-test",
        mode: "skip",
      }),
    ).toBeNull();
  });

  it("fails closed when the caller snapshot is missing or outside resume eligibility", () => {
    expect(
      resolveCrashRecoveryRestartResumeDecision({
        metadata: { [CRASH_RECOVERY_RESTART_RESUME_MODE_METADATA_KEY]: "continue" },
        snapshotPresent: true,
        snapshotEligible: false,
      }),
    ).toEqual({ mode: "skip", publish: false, reason: "ineligible_snapshot" });
    expect(
      resolveCrashRecoveryRestartResumeDecision({
        snapshotPresent: false,
        snapshotEligible: false,
      }),
    ).toEqual({ mode: "skip", publish: false, reason: "missing_snapshot" });
  });

  it("resumes pending-only when an unsafe snapshot still carries durable queued input", () => {
    expect(
      resolveCrashRecoveryRestartResumeDecision({
        metadata: {
          live: true,
          [CRASH_RECOVERY_RESTART_RESUME_MODE_METADATA_KEY]: "skip",
        },
        snapshotPresent: true,
        snapshotEligible: true,
        pendingMessageCount: 1,
      }),
    ).toEqual({ mode: "pending_only", publish: true, reason: "pending_only" });
  });

  it("keeps skip when an unsafe live snapshot has a zero pending counter", () => {
    expect(
      resolveCrashRecoveryRestartResumeDecision({
        metadata: {
          live: true,
          [CRASH_RECOVERY_RESTART_RESUME_MODE_METADATA_KEY]: "skip",
        },
        snapshotPresent: true,
        snapshotEligible: true,
        pendingMessageCount: 0,
      }),
    ).toEqual({ mode: "skip", publish: false, reason: "unsafe_snapshot" });
  });

  it("builds a notice-only envelope that never asks to continue", () => {
    const notice = buildDaemonRestartNoticePrompt({
      restartEpoch: "epoch-notice",
      reason: "version update",
      sessionKey: "agent:main:main",
      fenceReason: "unsafe_snapshot",
      snapshotMetadata: UNSAFE_SNAPSHOT_METADATA,
      runtimeProvider: "codex",
    });

    expect(notice.prompt).toStartWith("[System] Daemon reiniciou (version update).");
    expect(notice.prompt).toContain("ferramenta Bash já iniciada; resposta já emitida");
    expect(notice.prompt).toContain("Não continue nem repita trabalho interrompido");
    expect(notice.prompt).not.toContain("Continue de onde parou");
    expect(notice.deliveryBarrier).toBe("after_response");
    expect(notice._daemonRestartResume).toEqual({
      restartEpoch: "epoch-notice",
      sessionKey: "agent:main:main",
      noticeOnly: true,
      runtimeProvider: "codex",
    });
  });

  it("omits unsafe evidence the snapshot does not carry", () => {
    const notice = buildDaemonRestartNoticePrompt({
      restartEpoch: "epoch-notice",
      reason: "test",
      sessionKey: "agent:main:main",
      fenceReason: "unsafe_snapshot",
      snapshotMetadata: { live: true, [CRASH_RECOVERY_RESTART_RESUME_MODE_METADATA_KEY]: "skip" },
    });

    expect(notice.prompt).toContain("não é seguro repeti-lo.");
    expect(notice.prompt).not.toContain("repeti-lo (");
  });
});

describe("daemon restart session event delivery", () => {
  it("delivers a restart notice when an unsafe snapshot fences the resume", async () => {
    const source: MessageTarget = { channel: "whatsapp", accountId: "main", chatId: "5511999", actorType: "contact" };
    const { deps, published, marked } = restartEventHarness({ source });

    const outcome = await deliverDaemonRestartSessionEvent(
      { ...RESTART_EVENT_BASE, kind: "active", snapshot: snapshotRecord({ metadata: UNSAFE_SNAPSHOT_METADATA }) },
      deps,
    );

    expect(outcome).toMatchObject({
      status: "delivered",
      deliveryKind: "notice",
      decision: { reason: "unsafe_snapshot" },
    });
    expect(published).toHaveLength(1);
    const payload = published[0]?.payload;
    expect(published[0]?.sessionName).toBe("main");
    expect(payload?.prompt).toContain("Daemon reiniciou (version update)");
    expect(payload?.prompt).toContain("ferramenta Bash já iniciada");
    expect(payload?.prompt).not.toContain("Continue de onde parou");
    expect(payload?._daemonRestartResume).toEqual({
      restartEpoch: "epoch-deliver",
      sessionKey: "agent:main:main",
      noticeOnly: true,
      runtimeProvider: "claude",
    });
    expect(payload?.source).toEqual(source);
    expect(marked).toEqual([
      {
        restartEpoch: "epoch-deliver",
        sessionKey: "agent:main:main",
        sessionName: "main",
        deliveryKind: "notice",
        decisionReason: "unsafe_snapshot",
      },
    ]);
  });

  it("notifies the caller even when its restart snapshot is missing", async () => {
    const { deps, published, marked } = restartEventHarness();

    const outcome = await deliverDaemonRestartSessionEvent({ ...RESTART_EVENT_BASE, kind: "caller" }, deps);

    expect(outcome).toMatchObject({ status: "delivered", deliveryKind: "notice" });
    expect(published[0]?.payload.prompt).toContain("Não há snapshot de restart desta sessão");
    expect(published[0]?.payload._daemonRestartResume).toMatchObject({ noticeOnly: true });
    expect(marked.map((entry) => [entry.deliveryKind, entry.decisionReason])).toEqual([["notice", "missing_snapshot"]]);
  });

  it("notifies the caller without resuming a snapshot outside the resume window", async () => {
    const { deps, published, marked } = restartEventHarness();

    const outcome = await deliverDaemonRestartSessionEvent(
      {
        ...RESTART_EVENT_BASE,
        kind: "caller",
        snapshot: snapshotRecord({
          pendingMessageCount: 2,
          metadata: { [CRASH_RECOVERY_RESTART_RESUME_MODE_METADATA_KEY]: "continue" },
        }),
        snapshotEligible: false,
      },
      deps,
    );

    expect(outcome).toMatchObject({ status: "delivered", deliveryKind: "notice" });
    expect(published[0]?.payload.prompt).toContain("fora da janela de retomada");
    expect(published[0]?.payload._daemonRestartResume).not.toHaveProperty("pendingOnly");
    expect(marked.map((entry) => [entry.deliveryKind, entry.decisionReason])).toEqual([
      ["notice", "ineligible_snapshot"],
    ]);
  });

  it("leaves a fenced notice unrecorded when publishing it fails", async () => {
    const { deps, published, marked } = restartEventHarness({ publishError: new Error("nats down") });

    const outcome = await deliverDaemonRestartSessionEvent(
      { ...RESTART_EVENT_BASE, kind: "active", snapshot: snapshotRecord({ metadata: UNSAFE_SNAPSHOT_METADATA }) },
      deps,
    );

    expect(outcome).toMatchObject({ status: "failed", deliveryKind: "notice" });
    expect(published).toHaveLength(0);
    expect(marked).toHaveLength(0);
  });

  it("leaves a resume unrecorded when publishing it fails", async () => {
    const { deps, marked } = restartEventHarness({ publishError: new Error("nats down") });

    const outcome = await deliverDaemonRestartSessionEvent(
      {
        ...RESTART_EVENT_BASE,
        kind: "active",
        snapshot: snapshotRecord({
          metadata: { [CRASH_RECOVERY_RESTART_RESUME_MODE_METADATA_KEY]: "continue", restartTurnAuthority: { v: 1 } },
        }),
      },
      deps,
    );

    expect(outcome).toMatchObject({ status: "failed", deliveryKind: "resume" });
    expect(marked).toHaveLength(0);
  });

  it("still resumes a replay-safe snapshot and records it as a resume", async () => {
    const { deps, published, marked } = restartEventHarness();

    const outcome = await deliverDaemonRestartSessionEvent(
      {
        ...RESTART_EVENT_BASE,
        kind: "active",
        snapshot: snapshotRecord({
          runtimeProvider: "codex",
          metadata: {
            live: true,
            [CRASH_RECOVERY_RESTART_RESUME_MODE_METADATA_KEY]: "continue",
            restartTurnAuthority: { v: 1 },
          },
        }),
      },
      deps,
    );

    expect(outcome).toMatchObject({ status: "delivered", deliveryKind: "resume", decision: { mode: "continue" } });
    expect(published[0]?.payload.prompt).toBe("[System] Daemon reiniciou (version update). Continue de onde parou.");
    expect(published[0]?.payload._daemonRestartResume).toEqual({
      restartEpoch: "epoch-deliver",
      sessionKey: "agent:main:main",
      runtimeProvider: "codex",
    });
    expect(marked.map((entry) => [entry.deliveryKind, entry.decisionReason])).toEqual([["resume", "continue"]]);
  });

  it("resumes durable successors of an unsafe snapshot as a pending-only resume", async () => {
    const { deps, published, marked } = restartEventHarness();

    const outcome = await deliverDaemonRestartSessionEvent(
      {
        ...RESTART_EVENT_BASE,
        kind: "active",
        snapshot: snapshotRecord({ pendingMessageCount: 1, metadata: UNSAFE_SNAPSHOT_METADATA }),
      },
      deps,
    );

    expect(outcome).toMatchObject({ status: "delivered", deliveryKind: "resume", decision: { mode: "pending_only" } });
    expect(published[0]?.payload._daemonRestartResume).toMatchObject({ pendingOnly: true });
    expect(published[0]?.payload._daemonRestartResume).not.toHaveProperty("noticeOnly");
    expect(marked.map((entry) => [entry.deliveryKind, entry.decisionReason])).toEqual([["resume", "pending_only"]]);
  });

  it("resumes the durable capacity retry cohort without reopening its failed physical turn", async () => {
    const { deps, published, marked } = restartEventHarness();
    const metadata = {
      live: true,
      [CRASH_RECOVERY_RESTART_RESUME_MODE_METADATA_KEY]: "pending_only",
      crashRecoveryTerminalStatus: "failed",
      crashRecoveryReplaySafety: {
        replayable: false,
        startedTool: false,
        materializedOutput: false,
        inputMutated: false,
        durableBinding: "terminal",
      },
    };
    const outcome = await deliverDaemonRestartSessionEvent(
      {
        ...RESTART_EVENT_BASE,
        kind: "active",
        snapshot: snapshotRecord({ runtimeProvider: "codex", pendingMessageCount: 2, metadata }),
      },
      deps,
    );

    expect(outcome).toMatchObject({ status: "delivered", deliveryKind: "resume", decision: { mode: "pending_only" } });
    expect(published[0]?.payload._daemonRestartResume).toMatchObject({ pendingOnly: true, runtimeProvider: "codex" });
    expect(published[0]?.payload._daemonRestartResume).not.toHaveProperty("noticeOnly");
    expect(published[0]?.payload.prompt).toContain("somente as mensagens pendentes duráveis");
    expect(published[0]?.payload.prompt).not.toContain("Continue de onde parou");
    expect(marked.map((entry) => [entry.deliveryKind, entry.decisionReason])).toEqual([["resume", "pending_only"]]);

    // A failed physical attempt without separately persisted retry work stays consumed.
    expect(
      resolveCrashRecoveryRestartResumeDecision({
        metadata: { ...metadata, [CRASH_RECOVERY_RESTART_RESUME_MODE_METADATA_KEY]: "skip" },
        snapshotPresent: true,
        snapshotEligible: true,
        pendingMessageCount: 0,
      }),
    ).toEqual({ mode: "skip", publish: false, reason: "unsafe_snapshot" });
  });

  it("skips a terminal task session without publishing or recording a delivery", async () => {
    const { deps, published, marked } = restartEventHarness({ terminalTask: true });

    const outcome = await deliverDaemonRestartSessionEvent(
      {
        ...RESTART_EVENT_BASE,
        sessionName: "task-abc-work",
        kind: "active",
        snapshot: snapshotRecord({ metadata: UNSAFE_SNAPSHOT_METADATA }),
      },
      deps,
    );

    expect(outcome).toEqual({ status: "skipped_terminal_task" });
    expect(published).toHaveLength(0);
    expect(marked).toHaveLength(0);
  });

  it("does not publish again for a session already delivered in this epoch", async () => {
    const { deps, published, marked } = restartEventHarness({ alreadyDelivered: true });

    const outcome = await deliverDaemonRestartSessionEvent(
      { ...RESTART_EVENT_BASE, kind: "active", snapshot: snapshotRecord({ metadata: UNSAFE_SNAPSHOT_METADATA }) },
      deps,
    );

    expect(outcome).toEqual({ status: "already_delivered" });
    expect(published).toHaveLength(0);
    expect(marked).toHaveLength(0);
  });

  it("reports a published event as delivered even when the ledger write fails", async () => {
    const { deps, published } = restartEventHarness({ markError: new Error("database is locked") });

    const outcome = await deliverDaemonRestartSessionEvent(
      { ...RESTART_EVENT_BASE, kind: "active", snapshot: snapshotRecord({ metadata: UNSAFE_SNAPSHOT_METADATA }) },
      deps,
    );

    expect(outcome).toMatchObject({ status: "delivered", deliveryKind: "notice" });
    expect(published).toHaveLength(1);
  });
});

describe("daemon restart inputs carry the interrupted turn's authority", () => {
  const relayOrigin = {
    protocol: "ravi.runtime.turn-origin",
    schemaVersion: 1,
    producer: "session-relay",
    action: "execute",
    principal: { type: "agent", id: "main" },
    callerContextId: "ctx_caller",
  };

  it("restores the recorded relay envelope on a continuation, before the recorded source", async () => {
    const source: MessageTarget = { channel: "slack", accountId: "ravi-slack", chatId: "D1", actorType: "agent" };
    const { deps, published } = restartEventHarness({ source });

    await deliverDaemonRestartSessionEvent(
      {
        ...RESTART_EVENT_BASE,
        kind: "active",
        snapshot: snapshotRecord({
          metadata: {
            live: true,
            [CRASH_RECOVERY_RESTART_RESUME_MODE_METADATA_KEY]: "continue",
            restartTurnAuthority: { v: 1, _turnOrigin: relayOrigin, context: { actorType: "agent" } },
          },
        }),
      },
      deps,
    );

    expect(published[0]?.payload._turnOrigin).toEqual(relayOrigin);
    expect(published[0]?.payload.context).toEqual({ actorType: "agent" });
    expect(published[0]?.payload.source).toEqual(source);
  });

  it.each([
    { label: "missing", authority: undefined, reason: "authority_missing" },
    { label: "unreadable", authority: { v: 2 }, reason: "authority_unreadable" },
    { label: "automation", authority: { v: 1, automation: true }, reason: "authority_automation" },
  ])("only notifies when a continuation's recorded authority is $label", async ({ authority, reason }) => {
    const { deps, published, marked } = restartEventHarness();

    const outcome = await deliverDaemonRestartSessionEvent(
      {
        ...RESTART_EVENT_BASE,
        kind: "active",
        snapshot: snapshotRecord({
          metadata: {
            live: true,
            [CRASH_RECOVERY_RESTART_RESUME_MODE_METADATA_KEY]: "continue",
            ...(authority ? { restartTurnAuthority: authority } : {}),
          },
        }),
      },
      deps,
    );

    expect(outcome).toMatchObject({ deliveryKind: "notice", decision: { reason } });
    expect(published[0]?.payload.prompt).not.toContain("Continue de onde parou");
    expect(published[0]?.payload._daemonRestartResume).toMatchObject({ noticeOnly: true });
    expect(marked[0]?.decisionReason).toBe(reason);
  });

  it("restores the attempt's recorded envelope on a verify resume", async () => {
    const { deps, published } = restartEventHarness();
    deps.judgeInterruptedAttempt = () => ({
      kind: "resume",
      attempt: { attemptId: "attempt-relay" } as never,
      authority: { _turnOrigin: relayOrigin } as never,
    });

    await deliverDaemonRestartSessionEvent(
      {
        ...RESTART_EVENT_BASE,
        kind: "active",
        snapshot: snapshotRecord({
          metadata: { ...UNSAFE_SNAPSHOT_METADATA, turnActive: true, crashRecoveryAttemptId: "attempt-relay" },
        }),
      },
      deps,
    );

    expect(published[0]?.payload._turnOrigin).toEqual(relayOrigin);
    expect(published[0]?.payload.prompt).toContain("confira o estado real");
  });

  it("records a JSON-safe envelope and refuses automation authority", () => {
    expect(captureRestartTurnAuthority(undefined)).toEqual({ v: 1 });
    expect(
      captureRestartTurnAuthority({ _turnOrigin: relayOrigin as never, context: { senderId: undefined } as never }),
    ).toEqual({ v: 1, _turnOrigin: relayOrigin, context: {} } as never);
    expect(captureRestartTurnAuthority({ _cron: true } as never)).toEqual({ v: 1, automation: true });
    expect(
      captureRestartTurnAuthority({
        _mcpCall: { id: "mc_01jd8x00000000000000000000", server: "console", tool: "publish", status: "ok" },
      }),
    ).toEqual({
      v: 1,
      automation: true,
    });
    expect(restoreRestartTurnAuthority({ v: 1, _turnOrigin: { protocol: "other" } })).toEqual({
      ok: false,
      reason: "authority_unreadable",
    });
    // Protocol and version alone: the runtime would ignore this origin and drop its narrowing.
    expect(
      restoreRestartTurnAuthority({ v: 1, _turnOrigin: { protocol: "ravi.runtime.turn-origin", schemaVersion: 1 } }),
    ).toEqual({ ok: false, reason: "authority_unreadable" });
    expect(restoreRestartTurnAuthority({ v: 1, _turnOrigin: relayOrigin })).toMatchObject({ ok: true });
  });
});

describe("daemon restart verify-and-continue for turns interrupted mid-action", () => {
  const INTERRUPTED_SNAPSHOT_METADATA = {
    ...UNSAFE_SNAPSHOT_METADATA,
    turnActive: true,
    crashRecoveryAttemptId: "attempt-interrupted",
  };
  const interruptedAttempt = { attemptId: "attempt-interrupted" } as never;
  const recordedAuthority = { context: { actorType: "agent" } } as never;

  it("resumes an unsafe live snapshot with a verify note when its attempt is judged resumable", async () => {
    const { deps, published, marked } = restartEventHarness();
    const claims: string[] = [];
    deps.judgeInterruptedAttempt = ({ attemptId }) => {
      claims.push(attemptId);
      return { kind: "resume", attempt: interruptedAttempt, authority: recordedAuthority };
    };

    const outcome = await deliverDaemonRestartSessionEvent(
      { ...RESTART_EVENT_BASE, kind: "active", snapshot: snapshotRecord({ metadata: INTERRUPTED_SNAPSHOT_METADATA }) },
      deps,
    );

    expect(claims).toEqual(["attempt-interrupted"]);
    expect(outcome).toMatchObject({
      status: "delivered",
      deliveryKind: "resume",
      decision: { mode: "verify_continue", reason: "verify_continue" },
    });
    const payload = published[0]?.payload;
    expect(payload?.prompt).toContain("no meio do teu turno");
    expect(payload?.prompt).toContain("ferramenta Bash já iniciada");
    expect(payload?.prompt).toContain("confira o estado real");
    expect(payload?.prompt).toContain("Depois continue o trabalho de onde parou.");
    expect(payload?._daemonRestartResume).toEqual({
      restartEpoch: "epoch-deliver",
      sessionKey: "agent:main:main",
      runtimeProvider: "claude",
    });
    expect(marked).toEqual([
      {
        restartEpoch: "epoch-deliver",
        sessionKey: "agent:main:main",
        sessionName: "main",
        deliveryKind: "resume",
        decisionReason: "verify_continue",
      },
    ]);
  });

  it("carries durable successors along with the verify note instead of a pending-only resume", async () => {
    const { deps, published } = restartEventHarness();
    deps.judgeInterruptedAttempt = () => ({
      kind: "resume",
      attempt: interruptedAttempt,
      authority: recordedAuthority,
    });

    const outcome = await deliverDaemonRestartSessionEvent(
      {
        ...RESTART_EVENT_BASE,
        kind: "active",
        snapshot: snapshotRecord({
          pendingMessageCount: 2,
          metadata: {
            ...INTERRUPTED_SNAPSHOT_METADATA,
            [CRASH_RECOVERY_RESTART_RESUME_MODE_METADATA_KEY]: "pending_only",
          },
        }),
      },
      deps,
    );

    expect(outcome).toMatchObject({ deliveryKind: "resume", decision: { mode: "verify_continue" } });
    expect(published[0]?.payload._daemonRestartResume).not.toHaveProperty("pendingOnly");
  });

  it("only notifies when the interrupted turn was itself a restart resume", async () => {
    const { deps, published, marked } = restartEventHarness();
    deps.judgeInterruptedAttempt = () => ({ kind: "notice", attempt: interruptedAttempt, fenceReason: "resume_loop" });

    const outcome = await deliverDaemonRestartSessionEvent(
      { ...RESTART_EVENT_BASE, kind: "active", snapshot: snapshotRecord({ metadata: INTERRUPTED_SNAPSHOT_METADATA }) },
      deps,
    );

    expect(outcome).toMatchObject({ deliveryKind: "notice", decision: { reason: "resume_loop" } });
    expect(published[0]?.payload.prompt).toContain("já era uma retomada automática");
    expect(published[0]?.payload.prompt).not.toContain("continue o trabalho");
    expect(marked[0]?.decisionReason).toBe("resume_loop");
  });

  it("keeps the notice when the attempt is not resumable", async () => {
    const { deps } = restartEventHarness();
    deps.judgeInterruptedAttempt = () => ({ kind: "skip", reason: "superseded" });

    const outcome = await deliverDaemonRestartSessionEvent(
      { ...RESTART_EVENT_BASE, kind: "active", snapshot: snapshotRecord({ metadata: INTERRUPTED_SNAPSHOT_METADATA }) },
      deps,
    );

    expect(outcome).toMatchObject({ deliveryKind: "notice", decision: { reason: "unsafe_snapshot" } });
  });

  it("does not claim anything for a snapshot without a recorded interrupted attempt", async () => {
    const { deps } = restartEventHarness();
    let claimed = false;
    deps.judgeInterruptedAttempt = () => {
      claimed = true;
      return { kind: "resume", attempt: interruptedAttempt, authority: recordedAuthority };
    };

    const outcome = await deliverDaemonRestartSessionEvent(
      { ...RESTART_EVENT_BASE, kind: "active", snapshot: snapshotRecord({ metadata: UNSAFE_SNAPSHOT_METADATA }) },
      deps,
    );

    expect(claimed).toBe(false);
    expect(outcome).toMatchObject({ deliveryKind: "notice", decision: { reason: "unsafe_snapshot" } });
  });

  it("tells the caller which sessions already resumed on their own", async () => {
    const { deps, published } = restartEventHarness();

    await deliverDaemonRestartSessionEvent(
      { ...RESTART_EVENT_BASE, kind: "caller", resumedSessionNames: ["main-t-1", "main-t-2"] },
      deps,
    );

    expect(published[0]?.payload.prompt).toContain("tenta retomar sozinho");
    // A turn without recorded authority is not resumed: the notice must not promise it.
    expect(published[0]?.payload.prompt).toContain("não é retomado e recebe só um aviso");
    expect(published[0]?.payload.prompt).not.toContain("Não mande retomar essas de novo");
    expect(published[0]?.payload.prompt).toContain("main-t-1, main-t-2");
  });

  it("keeps the still-active task binding of an interrupted task turn on its verify resume", async () => {
    const { deps, published } = restartEventHarness();
    deps.judgeInterruptedAttempt = () => ({
      kind: "resume",
      attempt: interruptedAttempt,
      authority: recordedAuthority,
    });

    await deliverDaemonRestartSessionEvent(
      {
        ...RESTART_EVENT_BASE,
        kind: "active",
        snapshot: snapshotRecord({
          metadata: { ...INTERRUPTED_SNAPSHOT_METADATA, currentTaskBarrierTaskId: "task-42" },
        }),
      },
      deps,
    );

    expect(published[0]?.payload.taskBarrierTaskId).toBe("task-42");
  });
});

describe("which interrupted attempt a restart snapshot records", () => {
  const base = {
    turnActive: true,
    replayable: false,
    terminalTurnConsumed: false,
    hasScheduledCapacityRetry: false,
    attemptId: "attempt-1",
  };

  it("records an active, non-replayable, unfinished turn's attempt", () => {
    expect(resolveRestartSnapshotInterruptedAttemptId(base)).toBe("attempt-1");
  });

  it.each([
    { label: "an idle session", change: { turnActive: false } },
    { label: "a replayable turn (it continues instead)", change: { replayable: true } },
    { label: "a turn the provider already finished", change: { terminalTurnConsumed: true } },
    { label: "a scheduled capacity retry", change: { hasScheduledCapacityRetry: true } },
    { label: "a turn without a durable attempt", change: { attemptId: undefined } },
    { label: "a turn a newer message superseded", change: { superseded: true } },
  ])("records nothing for $label", ({ change }) => {
    expect(resolveRestartSnapshotInterruptedAttemptId({ ...base, ...change })).toBeNull();
  });
});
