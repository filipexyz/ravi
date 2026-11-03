import { describe, expect, test } from "bun:test";

import {
  managedRaviFailureDiagnostic,
  managedRaviLifecycleActions,
  managedRaviLiveText,
  managedRaviTranscript,
} from "./managed-ravi-view";
import type {
  ManagedRaviAggregate,
  ManagedRaviCommand,
  ManagedRaviSessionEvent,
} from "./types";

describe("managed Ravi product projection", () => {
  test("offers only state-coherent lifecycle actions", () => {
    expect(managedRaviLifecycleActions(aggregate("ready"))).toEqual([
      "stop",
      "restart",
      "backup",
      "delete",
    ]);
    expect(managedRaviLifecycleActions(aggregate("stopped"))).toEqual([
      "start",
      "backup",
      "delete",
    ]);
    expect(managedRaviLifecycleActions(aggregate("failed"))).toEqual([
      "retry",
      "delete",
    ]);
    expect(managedRaviLifecycleActions(aggregate("provisioning"))).toEqual([]);

    const stoppedWithBackup = aggregate("stopped");
    stoppedWithBackup.backups = [
      {
        backupRef: `mbk_${"a".repeat(32)}`,
        contentDigest: `sha256:${"b".repeat(64)}`,
        createdAt: new Date().toISOString(),
        operationId: "backup-operation",
        sizeBytes: 1024,
        sourceVmId: "source-vm",
      },
    ];
    expect(managedRaviLifecycleActions(stoppedWithBackup)).toContain("restore");
  });

  test("uses the latest reconciled Ravi history as the transcript", () => {
    const command = managedCommand({
      result: {
        history: {
          messages: [
            { role: "user", text: "Oi" },
            { role: "assistant", text: "Ola" },
          ],
        },
      },
      status: "succeeded",
    });
    expect(managedRaviTranscript([command])).toEqual([
      { id: "history:0:user", role: "user", text: "Oi" },
      { id: "history:1:assistant", role: "assistant", text: "Ola" },
    ]);
  });

  test("keeps a failed prompt visible without exposing raw failure metadata", () => {
    const command = managedCommand({
      failureCode: "managed_runtime_provider_unavailable",
      status: "failed",
    });
    expect(managedRaviTranscript([command])).toEqual([
      { id: `${command.id}:prompt`, role: "user", text: "Oi" },
      {
        id: `${command.id}:failure`,
        role: "system",
        text: "Provider unavailable",
      },
    ]);
  });

  test("extracts assistant text only from response events", () => {
    const event = {
      commandId: "command",
      createdAt: new Date().toISOString(),
      eventType: "ravi.session.managed-ravi.response",
      id: "event",
      payload: { data: { text: "OK" } },
      sequence: 1,
      severity: "info",
    } satisfies ManagedRaviSessionEvent;
    expect(managedRaviLiveText(event)).toBe("OK");
    expect(managedRaviLiveText({ ...event, eventType: "session.tool.started" })).toBeNull();
  });

  test("projects safe actionable diagnostics for a failed operation", () => {
    const failed = aggregate("failed");
    failed.instance.failureCode = "managed_runtime_control_failed";
    failed.instance.provisioningPhase = "provider_prepare";
    failed.latestOperation = {
      action: "create",
      attemptCount: 1,
      completedAt: "2026-07-16T13:41:17.090Z",
      createdAt: "2026-07-16T13:41:16.026Z",
      failureCode: "managed_vm_not_found",
      id: "d1ab4d04-7a38-485c-8b52-6126f0197b6d",
      phase: "provider_inspect",
      progressPercent: 10,
      startedAt: "2026-07-16T13:41:16.200Z",
      status: "failed",
      updatedAt: "2026-07-16T13:41:17.090Z",
    };

    expect(managedRaviFailureDiagnostic(failed)).toEqual({
      action: "create",
      code: "managed_vm_not_found",
      completedAt: "2026-07-16T13:41:17.090Z",
      guidance: "Retry resumes from the last verified phase without allocating a duplicate VM.",
      operationId: "d1ab4d04-7a38-485c-8b52-6126f0197b6d",
      phase: "provider_inspect",
      retryable: true,
      summary: "Managed vm not found",
    });
  });

  test("hides a stale instance failure while retry is active", () => {
    const retrying = aggregate("provisioning");
    retrying.instance.failureCode = "managed_runtime_control_failed";
    retrying.latestOperation = {
      action: "retry",
      attemptCount: 1,
      completedAt: null,
      createdAt: "2026-07-16T13:51:00.000Z",
      failureCode: null,
      id: "c240337d-b2cc-46bf-ad05-4bdb08218a52",
      phase: "bootstrapping",
      progressPercent: 20,
      startedAt: "2026-07-16T13:51:01.000Z",
      status: "running",
      updatedAt: "2026-07-16T13:51:03.000Z",
    };

    expect(managedRaviFailureDiagnostic(retrying)).toBeNull();
  });
});

function aggregate(
  observedState: ManagedRaviAggregate["instance"]["observedState"],
): ManagedRaviAggregate {
  const now = new Date().toISOString();
  return {
    backups: [],
    connections: observedState === "ready" ? [
      {
        id: "connection",
        kind: "private_ravi_sdk",
        lastConnectedAt: now,
        lastHeartbeatAt: now,
        protocolVersion: "1",
        revokedAt: null,
        status: "online",
      },
    ] : [],
    instance: {
      createdAt: now,
      desiredState: observedState === "stopped" ? "stopped" : "running",
      displayName: "Ravi P0",
      failureCode: null,
      id: "instance",
      lastHeartbeatAt: now,
      observedState,
      placementClass: "shared-small",
      projectId: "project",
      provisioningPhase: null,
      runtimeModel: null,
      runtimeProvider: "codex",
      runtimeVersion: null,
      updatedAt: now,
    },
    latestOperation: null,
  };
}

function managedCommand(
  overrides: Partial<ManagedRaviCommand>,
): ManagedRaviCommand {
  const now = new Date().toISOString();
  return {
    action: "prompt_send",
    attemptCount: 1,
    completedAt: now,
    createdAt: now,
    failureCode: null,
    id: "70000000-0000-4000-8000-000000000001",
    input: { prompt: "Oi" },
    instanceId: "instance",
    phase: "completed",
    result: null,
    sessionId: "session",
    startedAt: now,
    status: "succeeded",
    updatedAt: now,
    ...overrides,
  };
}
