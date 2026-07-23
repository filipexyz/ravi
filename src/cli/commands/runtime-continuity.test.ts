import "reflect-metadata";

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { dbCreateAgent } from "../../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import {
  prepareProviderContinuityRequest,
  waitProviderContinuityJournal,
  wakeProviderContinuityJournal,
} from "../../runtime/provider-continuity/coordinator.js";
import {
  markProviderContinuityEffectAmbiguous,
  markProviderContinuityEffectStarted,
  prepareProviderContinuityEffect,
} from "../../runtime/provider-continuity/effects.js";
import { recordProviderContinuityEvent } from "../../runtime/provider-continuity/events.js";
import { getProviderContinuityPolicy, writeProviderContinuityPolicy } from "../../runtime/provider-continuity/store.js";
import {
  PROVIDER_CONTINUITY_SNAPSHOT,
  PROVIDER_CONTINUITY_SPEC_VERSION,
  type ProviderContinuityPolicyConfig,
} from "../../runtime/provider-continuity/types.js";
import {
  getCommandAccessMetadata,
  getCommandsMetadata,
  getGroupMetadata,
  getOptionsMetadata,
  getReturnsMetadata,
} from "../decorators.js";
import { RuntimeContinuityCommands } from "./runtime-continuity.js";

let stateDir: string | null = null;

const targetsJson = JSON.stringify([
  { provider: "codex", model: "gpt-5" },
  { provider: "claude", model: "sonnet" },
]);

const policy: ProviderContinuityPolicyConfig = {
  specVersion: PROVIDER_CONTINUITY_SPEC_VERSION,
  compatibilitySnapshotId: PROVIDER_CONTINUITY_SNAPSHOT,
  strategy: "ordered",
  targets: JSON.parse(targetsJson),
  deadlineMs: 120_000,
  enabled: true,
};

function installPolicy(now = Date.now()): void {
  const current = getProviderContinuityPolicy("main");
  writeProviderContinuityPolicy({
    agentId: "main",
    expectedVersion: current?.version ?? 0,
    policy,
    now,
  });
}

function prepare(messageId: string, now = Date.now()) {
  if (!getProviderContinuityPolicy("main")) installPolicy(now - 1);
  const result = prepareProviderContinuityRequest({
    agentId: "main",
    sessionName: `main-dm-${messageId}`,
    prompt: {
      prompt: `synthetic CLI request ${messageId}`,
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
    },
    activation: "synthetic",
    now,
  });
  if (!result.active || !result.ready) throw new Error(`Synthetic CLI request was not ready: ${result.reason}.`);
  return result;
}

function parsePrintedJson(log: ReturnType<typeof spyOn>): unknown {
  const call = log.mock.calls.at(-1);
  if (!call) throw new Error("Expected CLI JSON output.");
  return JSON.parse(String(call[0]));
}

describe("runtime continuity CLI F01-F10 functional contracts", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-runtime-continuity-cli-");
    spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    mock.restore();
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("F01 returns a typed nullable show envelope", () => {
    const commands = new RuntimeContinuityCommands();
    const result = commands.show("main", true);
    expect(result).toMatchObject({
      specVersion: "1.0.0",
      compatibilitySnapshotId: PROVIDER_CONTINUITY_SNAPSHOT,
      policy: null,
      health: [],
      liveActivation: { enabled: false },
    });
    expect(getReturnsMetadata(RuntimeContinuityCommands).get("show")?.safeParse(result).success).toBe(true);
  });

  it("F02 explains the absence of a policy without provider activity", () => {
    const result = new RuntimeContinuityCommands().explain("main", true);
    expect(result).toMatchObject({
      agentId: "main",
      policyVersion: 0,
      enabled: false,
      selectedTargetIndex: null,
    });
    expect(getReturnsMetadata(RuntimeContinuityCommands).get("explain")?.safeParse(result).success).toBe(true);
  });

  it("F03 freezes a typed single-agent preview", () => {
    const result = new RuntimeContinuityCommands().preview("main", targetsJson, "0", "120000", false, true);
    expect(result.plan).toMatchObject({
      selector: { kind: "single", agentIds: ["main"] },
      exactAgentIds: ["main"],
      items: [{ agentId: "main", action: "create", valid: true }],
    });
    expect(getReturnsMetadata(RuntimeContinuityCommands).get("preview")?.safeParse(result).success).toBe(true);
  });

  it("F04 applies and idempotently replays an approved preview", () => {
    const commands = new RuntimeContinuityCommands();
    const preview = commands.preview("main", targetsJson, "0", undefined, false, true);
    const first = commands.apply("main", preview.plan.planHash, "approval-f04", "idempotency-f04", true);
    const replay = commands.apply("main", preview.plan.planHash, "approval-f04", "idempotency-f04", true);
    expect(first).toEqual(replay);
    expect(first).toMatchObject({ changed: true, outcome: "applied", policy: { version: 1 } });
  });

  it("F05 sets a policy through compare-and-set with typed JSON output", () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    const result = new RuntimeContinuityCommands().set(
      "main",
      targetsJson,
      "0",
      "approval-f05",
      "idempotency-f05",
      undefined,
      false,
      true,
    );
    expect(parsePrintedJson(log)).toEqual(result);
    expect(result).toMatchObject({ changed: true, outcome: "applied", policy: { version: 1 } });
  });

  it("F06 reorders by exact zero-based indices", () => {
    const commands = new RuntimeContinuityCommands();
    commands.set("main", targetsJson, "0", "approval-f06-set", "idempotency-f06-set", undefined, false, true);
    const result = commands.reorder("main", "1", "0", "1", "approval-f06", "idempotency-f06", true);
    expect(result.policy?.targets).toEqual([
      { provider: "claude", model: "sonnet" },
      { provider: "codex", model: "gpt-5" },
    ]);
  });

  it("F07 clears only the expected policy version", () => {
    installPolicy();
    const result = new RuntimeContinuityCommands().clear("main", "1", "approval-f07", "idempotency-f07", true);
    expect(result).toMatchObject({ changed: true, outcome: "applied", policy: null });
    expect(getProviderContinuityPolicy("main")).toBeNull();
  });

  it("F08 freezes selected agents for batch application", () => {
    dbCreateAgent({ id: "agent-a", cwd: stateDir ?? "/tmp" });
    dbCreateAgent({ id: "agent-b", cwd: stateDir ?? "/tmp" });
    const result = new RuntimeContinuityCommands().batchPreview(
      "agent-b,agent-a,agent-b",
      false,
      targetsJson,
      undefined,
      false,
      true,
    );
    expect(result.batch.plan.exactAgentIds).toEqual(["agent-b", "agent-a"]);
    expect(result.batch.status).toBe("preview");
  });

  it("F09 applies and reads back an immutable batch", () => {
    dbCreateAgent({ id: "agent-a", cwd: stateDir ?? "/tmp" });
    const commands = new RuntimeContinuityCommands();
    const preview = commands.batchPreview("main,agent-a", false, targetsJson, undefined, false, true);
    const applied = commands.batchApply(
      preview.batch.batchId,
      preview.batch.plan.planHash,
      "approval-f09",
      "idempotency-f09",
      true,
    );
    expect(applied.batch.status).toBe("success");
    expect(commands.batchStatus(preview.batch.batchId, true)).toEqual(applied);
  });

  it("F10 rejects empty, invalid, and timed-out inputs with zero writes", () => {
    const commands = new RuntimeContinuityCommands();
    expect(() => commands.preview("main", undefined, "0", undefined, false, true)).toThrow("--targets is required");
    expect(() => commands.preview("main", "[]", "0", undefined, false, true)).toThrow();
    expect(() => commands.preview("main", targetsJson, "0", "999", false, true)).toThrow();
    expect(getProviderContinuityPolicy("main")).toBeNull();
  });
});

describe("runtime continuity CLI U01-U11 operational round trips", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-runtime-continuity-cli-roundtrip-");
    spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    mock.restore();
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("U01 registers all 16 commands with JSON, access/risk, help, and typed returns", () => {
    const instance = new RuntimeContinuityCommands();
    const commands = getCommandsMetadata(RuntimeContinuityCommands);
    const returns = getReturnsMetadata(RuntimeContinuityCommands);
    const access = getCommandAccessMetadata(RuntimeContinuityCommands);
    expect(getGroupMetadata(RuntimeContinuityCommands)).toMatchObject({
      name: "runtime.continuity",
      scope: "admin",
    });
    expect(commands).toHaveLength(16);
    expect(returns.size).toBe(16);
    expect(access.size).toBe(16);
    for (const command of commands) {
      expect(command.helpAfter).toContain("Examples:");
      expect(getOptionsMetadata(instance, command.method).some((option) => option.flags.includes("--json"))).toBe(true);
      expect(returns.has(command.method)).toBe(true);
      expect(access.has(command.method)).toBe(true);
    }
  });

  it("U02 round-trips the latest persisted decision", () => {
    const prepared = prepare("u02");
    const result = new RuntimeContinuityCommands().decision(prepared.journal.logicalRequestId, true);
    expect(result).toMatchObject({
      journal: { logicalRequestId: prepared.journal.logicalRequestId },
      decision: { action: "start" },
    });
    expect(getReturnsMetadata(RuntimeContinuityCommands).get("decision")?.safeParse(result).success).toBe(true);
  });

  it("U03 reads a safe durable resume without invoking a provider", () => {
    const prepared = prepare("u03");
    const result = new RuntimeContinuityCommands().resume(prepared.journal.logicalRequestId, true);
    expect(result).toMatchObject({ resumed: true, target: policy.targets[0], reason: "resume_ready" });
  });

  it("U04 persists a bounded wait through the public command", () => {
    const now = Date.now();
    const prepared = prepare("u04", now);
    const result = new RuntimeContinuityCommands().wait(prepared.journal.logicalRequestId, String(now + 30_000), true);
    expect(result).toMatchObject({
      changed: true,
      journal: { state: "waiting", wakeAt: now + 30_000 },
    });
  });

  it("U05 reads a not-yet-due wake as an idempotent no-op", () => {
    const now = Date.now();
    const prepared = prepare("u05", now);
    waitProviderContinuityJournal(prepared.journal.logicalRequestId, now + 30_000, now + 1);
    const result = new RuntimeContinuityCommands().wake(prepared.journal.logicalRequestId, true);
    expect(result).toMatchObject({ changed: false, journal: { state: "waiting" } });
  });

  it("U06 reconciles an ambiguous effect by stable identity", () => {
    const prepared = prepare("u06");
    const effect = prepareProviderContinuityEffect({
      logicalRequestId: prepared.journal.logicalRequestId,
      toolCallId: "tool-u06",
      operation: "synthetic_write",
      arguments: { value: 1 },
    });
    markProviderContinuityEffectStarted(effect.effect.effectId);
    markProviderContinuityEffectAmbiguous({
      effectId: effect.effect.effectId,
      error: new Error("synthetic ambiguity"),
    });
    const result = new RuntimeContinuityCommands().reconcile(effect.effect.effectId, "succeeded", "readback-u06", true);
    expect(result).toMatchObject({
      changed: true,
      effect: { status: "reconciled", result: "[redacted]" },
      journal: {
        state: "pending",
        contextSnapshot: {
          toolRecords: [expect.objectContaining({ output: "[redacted]" })],
        },
      },
    });
  });

  it("U07 round-trips opaque cursor pagination", () => {
    const prepared = prepare("u07");
    recordProviderContinuityEvent({
      logicalRequestId: prepared.journal.logicalRequestId,
      agentId: "main",
      type: "continuity.synthetic.u07",
      payload: { ordinal: 2 },
    });
    const commands = new RuntimeContinuityCommands();
    const first = commands.trace(prepared.journal.logicalRequestId, undefined, "1", true);
    expect(first.pagination).toMatchObject({ limit: 1, hasMore: true });
    const second = commands.trace(
      prepared.journal.logicalRequestId,
      first.pagination.nextCursor ?? undefined,
      "1",
      true,
    );
    expect(second.events[0]?.eventId).toBeGreaterThan(first.events[0]?.eventId ?? 0);
  });

  it("U08 reconstructs action, result, event, and readback for a wake", () => {
    const now = Date.now();
    const prepared = prepare("u08", now);
    waitProviderContinuityJournal(prepared.journal.logicalRequestId, now + 10, now + 1);
    const woke = wakeProviderContinuityJournal(prepared.journal.logicalRequestId, now + 10);
    const readback = new RuntimeContinuityCommands().decision(prepared.journal.logicalRequestId, true);
    const trace = new RuntimeContinuityCommands().trace(prepared.journal.logicalRequestId, undefined, "50", true);
    expect(woke).toMatchObject({ changed: true, journal: { state: "pending" } });
    expect(readback.journal.state).toBe("pending");
    expect(trace.events.map((event) => event.type)).toContain("continuity.recovery.wake");
  });

  it("U09 shows health and ordered eligibility through public read models", () => {
    installPolicy();
    const commands = new RuntimeContinuityCommands();
    const show = commands.show("main", true);
    const explain = commands.explain("main", true);
    expect(show.policy?.targets).toEqual(policy.targets);
    expect(explain.orderedTargets.map((item) => item.target)).toEqual(policy.targets);
    expect(explain.selectedTargetIndex).toBe(0);
  });

  it("U10 redacts sensitive event payloads in public trace output", () => {
    const prepared = prepare("u10");
    recordProviderContinuityEvent({
      logicalRequestId: prepared.journal.logicalRequestId,
      agentId: "main",
      type: "continuity.synthetic.u10",
      payload: { authorization: "Bearer abcdefghijkl", secret: "sk-secret_abcdef123456" },
    });
    const trace = new RuntimeContinuityCommands().trace(prepared.journal.logicalRequestId, undefined, "50", true);
    const serialized = JSON.stringify(trace);
    expect(serialized).not.toContain("abcdefghijkl");
    expect(serialized).not.toContain("abcdef123456");
    expect(serialized).not.toContain("synthetic CLI request u10");
    expect(trace.journal.contextSnapshot.messages[0]?.content).toBe("[redacted]");
  });

  it("U11 carries the immutable spec snapshot through every public return schema", () => {
    const prepared = prepare("u11");
    const commands = new RuntimeContinuityCommands();
    const outputs = [
      commands.show("main", true),
      commands.explain("main", true),
      commands.decision(prepared.journal.logicalRequestId, true),
      commands.resume(prepared.journal.logicalRequestId, true),
      commands.trace(prepared.journal.logicalRequestId, undefined, "50", true),
    ];
    for (const output of outputs) {
      expect(output).toMatchObject({
        specVersion: PROVIDER_CONTINUITY_SPEC_VERSION,
        compatibilitySnapshotId: PROVIDER_CONTINUITY_SNAPSHOT,
      });
    }
  });
});
