import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { listLocalInboxItems } from "../inbox/index.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  RUNTIME_RECOVERY_EXHAUSTED_SUBJECT,
  notifyRuntimeRecoveryExhausted,
  setRuntimeRecoveryAlertPublisherForTests,
} from "./runtime-recovery-alert.js";

let stateDir: string | null = null;
let published: Array<{ subject: string; payload: Record<string, unknown> }> = [];

describe("runtime recovery operator alert", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-runtime-recovery-alert-test-");
    published = [];
    setRuntimeRecoveryAlertPublisherForTests((subject, payload) => {
      published.push({ subject, payload });
    });
  });

  afterEach(async () => {
    setRuntimeRecoveryAlertPublisherForTests();
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("creates one urgent inbox item and one triggerable event per failed source message", async () => {
    const input = {
      sessionKey: "agent:main:slack:main:channel:C123",
      sessionName: "support",
      agentId: "main",
      provider: "codex" as const,
      reason: "runtime_event_loop_closed",
      restartAttempts: 2,
      stashedQueueSize: 1,
      sourceMessageId: "message-123",
      occurredAt: 1_785_260_000_000,
    };

    const first = await notifyRuntimeRecoveryExhausted(input);
    const duplicate = await notifyRuntimeRecoveryExhausted(input);

    expect(first).toMatchObject({ created: true, published: true });
    expect(duplicate).toMatchObject({ created: false, published: false });
    expect(listLocalInboxItems()).toHaveLength(1);
    expect(listLocalInboxItems()[0]).toMatchObject({
      sourceDomain: "system",
      sourceType: "runtime_recovery_exhausted",
      status: "open",
      priority: "urgent",
      metadata: {
        sessionName: "support",
        agentId: "main",
        provider: "codex",
        reason: "runtime_event_loop_closed",
        restartAttempts: 2,
      },
    });
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      subject: RUNTIME_RECOVERY_EXHAUSTED_SUBJECT,
      payload: {
        version: 1,
        eventType: "inbox.system.runtime_recovery_exhausted",
        severity: "critical",
        sessionName: "support",
        agentId: "main",
        provider: "codex",
        restartAttempts: 2,
      },
    });
    expect(JSON.stringify(published[0]?.payload)).not.toContain("message-123");
  });
});
