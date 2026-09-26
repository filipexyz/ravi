import { describe, expect, it } from "bun:test";
import type { DaemonRestartSessionSnapshotRecord } from "../router/router-db.js";
import {
  CRASH_RECOVERY_RESTART_RESUME_MODE_METADATA_KEY,
  buildDaemonRestartNoticePrompt,
  buildDaemonRestartResumePrompt,
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
        snapshot: snapshotRecord({ metadata: { [CRASH_RECOVERY_RESTART_RESUME_MODE_METADATA_KEY]: "continue" } }),
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
          metadata: { live: true, [CRASH_RECOVERY_RESTART_RESUME_MODE_METADATA_KEY]: "continue" },
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
