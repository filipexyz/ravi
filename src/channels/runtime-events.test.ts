import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { getHistory } from "../db.js";
import { nats } from "../nats.js";
import {
  closeRouterDb,
  dbCreateAgent,
  dbGetAgent,
  dbGetChatMessage,
  dbGetChannelBackendIngressReceiptByTurnId,
  dbGetChannelBackendRuntimeState,
  dbRecordChannelBackendRuntimeEvent,
  getDb,
} from "../router/router-db.js";
import { resolveSession } from "../router/sessions.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import type { RuntimeHostStreamingSession } from "../runtime/host-session.js";
import { runRuntimeEventLoop } from "../runtime/host-event-loop.js";
import { RuntimeSessionDispatcher } from "../runtime/session-dispatcher.js";
import { createQueuedRuntimeUserMessage } from "../runtime/delivery-queue.js";
import type { RuntimeCrashRecoveryCoordinator } from "../runtime/crash-recovery.js";
import type { ChannelBackendPromptMetadata } from "../runtime/message-types.js";
import {
  PROVIDER_CAPACITY_EXHAUSTED_MESSAGE,
  PROVIDER_CAPACITY_UNSAFE_MESSAGE,
} from "../runtime/provider-capacity-retry.js";
import type { RuntimeCapabilities, RuntimeEvent, RuntimeSessionHandle } from "../runtime/types.js";
import {
  acceptChannelIngress,
  CHANNEL_BACKEND_PROTOCOL,
  CHANNEL_BACKEND_SCHEMA_VERSION,
  channelOutputSinks,
  setChannelBackendPromptPublisherForTests,
  type ChannelIngressRequest,
  type ChannelOutputEnvelope,
} from "./backend.js";
import {
  CHANNEL_RUNTIME_EVENTS_PROTOCOL,
  CHANNEL_RUNTIME_EVENTS_SCHEMA_VERSION,
  ChannelRuntimeEventSinkRegistry,
  channelRuntimeEventSinks,
  classifyChannelRuntimeFailure,
  projectChannelRuntimeEvent,
  readChannelRuntime,
  requestChannelRuntimeInterrupt,
  setChannelBackendEgressRequesterForRuntime,
  setChannelRuntimeAbortPublisherForTests,
  setChannelRuntimeGenerationIdForTests,
  type ChannelInterruptRequest,
  type KnownChannelRuntimeEvent,
} from "./runtime-events.js";
import {
  CHANNEL_OUTPUT_HANDOFF_CAPABILITY,
  ChannelOutputHandoffError,
  createChannelOutputHandoffIdentity,
  type ChannelOutputEmissionContext,
} from "./output-handoff.js";
import { persistDeliveredMessage } from "./outbound-consumer.js";
import { buildChannelTextOutboundJob } from "./outbound-stream.js";
import {
  assertSlackAutomaticTerminalPart,
  freezeSlackAutomaticTerminalManifest,
  getSlackAutomaticTerminalManifest,
  prepareSlackAutomaticTerminalManifest,
  type SlackAutomaticTerminalManifestInput,
} from "./slack/automatic-terminal-manifest.js";
import { renderSlackBackendOutput } from "./slack/driver.js";

let stateDir: string | null = null;
let unregisterOutput: (() => void) | undefined;
let unregisterRuntimeEvents: (() => void) | undefined;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-channel-runtime-events-");
  setChannelRuntimeGenerationIdForTests("runtime-generation-a");
  dbCreateAgent({
    id: "agent-a",
    name: "Agent A",
    cwd: "/tmp/ravi-channel-runtime-agent-a",
  });
  setChannelBackendPromptPublisherForTests(mock(async () => {}));
});

afterEach(async () => {
  unregisterOutput?.();
  unregisterOutput = undefined;
  unregisterRuntimeEvents?.();
  unregisterRuntimeEvents = undefined;
  setChannelBackendPromptPublisherForTests();
  setChannelBackendEgressRequesterForRuntime();
  setChannelRuntimeAbortPublisherForTests();
  setChannelRuntimeGenerationIdForTests();
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

describe("channel runtime event projection", () => {
  for (const invalidation of ["throw", "owner_lost"] as const) {
    it(`keeps synchronous bootstrap callback refusal distinct from notification failure (${invalidation})`, async () => {
      const metadata = await acceptedMetadata();
      const events: KnownChannelRuntimeEvent[] = [];
      const callbacks: Array<string | undefined> = [];
      const refusal = new Error("bootstrap commit callback refused");
      let owns = true;
      const projection = projectChannelRuntimeEvent({
        metadata,
        event: { type: "turn.failed", error: "synthetic failure" },
        sinks: runtimeSinks(metadata, events),
        beforeRecordEvent: () => owns,
        afterRecordEvent: (state) => {
          callbacks.push(state);
          if (state !== "running") return;
          if (invalidation === "throw") throw refusal;
          owns = false;
        },
      });
      if (invalidation === "throw") await expect(projection).rejects.toBe(refusal);
      else expect(await projection).toHaveLength(1);
      expect(callbacks).toEqual(["running"]);
      expect(events).toEqual([]);
      expect(dbGetChannelBackendRuntimeState(metadata.binding.turnId)).toMatchObject({
        state: "running",
        lastSequence: 1,
      });
    });
  }

  it("does not replay a committed failed terminal when its callback throws before notifications", async () => {
    const metadata = await acceptedMetadata();
    const events: KnownChannelRuntimeEvent[] = [];
    const outputs: ChannelOutputEnvelope[] = [];
    const callbacks: Array<string | undefined> = [];
    const refusal = new Error("terminal commit callback refused");
    unregisterOutput = channelOutputSinks.register(metadata.target, {
      async emit(output) {
        outputs.push(output);
      },
    });
    await expect(
      projectChannelRuntimeEvent({
        metadata,
        event: { type: "turn.failed", error: "synthetic failure" },
        sinks: runtimeSinks(metadata, events),
        terminalRecovery: { mayRecover: () => true },
        afterRecordEvent: (state) => {
          callbacks.push(state);
          if (state === "failed") throw refusal;
        },
      }),
    ).rejects.toBe(refusal);
    expect(callbacks).toEqual(["running", "failed"]);
    expect(events).toEqual([]);
    expect(outputs).toEqual([]);
    expect(dbGetChannelBackendRuntimeState(metadata.binding.turnId)).toMatchObject({
      state: "failed",
      lastSequence: 2,
    });
  });

  it("commits failure before the first bootstrap notification can retire its owner", async () => {
    const metadata = await acceptedMetadata();
    const events: KnownChannelRuntimeEvent[] = [];
    const outputs: ChannelOutputEnvelope[] = [];
    const sinks = new ChannelRuntimeEventSinkRegistry();
    let owns = true;
    let bootstrapCalls = 0;
    let stateAtBootstrap: ReturnType<typeof dbGetChannelBackendRuntimeState> | undefined;
    sinks.register(metadata.target, {
      async emit(event) {
        events.push(event);
        if (event.kind !== "turn.state_changed") return;
        bootstrapCalls++;
        stateAtBootstrap = dbGetChannelBackendRuntimeState(metadata.binding.turnId);
        expect(event).toMatchObject({ sequence: 1, payload: { state: "running" } });
        await Promise.resolve();
        owns = false;
      },
    });
    unregisterOutput = channelOutputSinks.register(metadata.target, {
      async emit(output) {
        outputs.push(output);
      },
    });

    const projected = await projectChannelRuntimeEvent({
      metadata,
      event: { type: "turn.failed", error: "synthetic private failure", recoverable: false },
      occurredAt: 1793810000000,
      sinks,
      beforeRecordEvent: () => owns,
    });

    expect(bootstrapCalls).toBe(1);
    expect(owns).toBe(false);
    expect(stateAtBootstrap).toMatchObject({ state: "failed", lastSequence: 2 });
    expect(projected).toEqual(events);
    expect(events.map((event) => [event.kind, event.sequence])).toEqual([
      ["turn.state_changed", 1],
      ["turn.terminal_output", 2],
    ]);
    expect(events[1]).toMatchObject({ payload: { state: "failed" }, correlation: { binding: metadata.binding } });
    expect(events[0]?.occurredAt).toBe(events[1]?.occurredAt);
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toMatchObject({ kind: "safe_error", binding: metadata.binding, target: metadata.target });
    expect(JSON.stringify([events, outputs])).not.toContain("synthetic private failure");
    expect(dbGetChannelBackendRuntimeState(metadata.binding.turnId)).toMatchObject({
      state: "failed",
      lastSequence: 2,
    });
  });

  it("refuses a stale failure before the bootstrap write without notifying sinks", async () => {
    const metadata = await acceptedMetadata();
    const initial = dbGetChannelBackendRuntimeState(metadata.binding.turnId);
    const events: KnownChannelRuntimeEvent[] = [];
    const outputs: ChannelOutputEnvelope[] = [];
    unregisterOutput = channelOutputSinks.register(metadata.target, {
      async emit(output) {
        outputs.push(output);
      },
    });
    const projected = await projectChannelRuntimeEvent({
      metadata,
      event: { type: "turn.failed", error: "synthetic failure" },
      sinks: runtimeSinks(metadata, events),
      beforeRecordEvent: () => false,
    });
    expect(projected).toEqual([]);
    expect(events).toEqual([]);
    expect(outputs).toEqual([]);
    expect(dbGetChannelBackendRuntimeState(metadata.binding.turnId)).toEqual(initial);
  });

  it("retains the bootstrap notification error while attempting the committed failure and output", async () => {
    const metadata = await acceptedMetadata();
    const firstError = new Error("bootstrap notification refused");
    const order: string[] = [];
    const sinks = new ChannelRuntimeEventSinkRegistry();
    sinks.register(metadata.target, {
      async emit(event) {
        order.push(event.kind);
        expect(dbGetChannelBackendRuntimeState(metadata.binding.turnId)?.state).toBe("failed");
        throw event.kind === "turn.state_changed" ? firstError : new Error("terminal notification refused");
      },
    });
    unregisterOutput = channelOutputSinks.register(metadata.target, {
      async emit(output) {
        order.push(output.kind);
        expect(output.binding).toEqual(metadata.binding);
        throw new Error("output refused");
      },
    });
    await expect(
      projectChannelRuntimeEvent({
        metadata,
        event: { type: "turn.failed", error: "synthetic failure" },
        sinks,
      }),
    ).rejects.toBe(firstError);
    expect(order).toEqual(["turn.state_changed", "turn.terminal_output", "safe_error"]);
    expect(dbGetChannelBackendRuntimeState(metadata.binding.turnId)).toMatchObject({
      state: "failed",
      lastSequence: 2,
    });
  });

  it("recovers only a missing text handoff despite an independent notification failure", async () => {
    const metadata = await acceptedMetadata("slack");
    const outputCalls: Array<{ output: ChannelOutputEnvelope; context?: ChannelOutputEmissionContext }> = [];
    const fingerprint = "a".repeat(64);
    const notificationFailure = new Error("synthetic notification refusal");
    let afterCommitCalls = 0;
    let terminalNotifications = 0;
    const sinks = new ChannelRuntimeEventSinkRegistry();
    sinks.register(metadata.target, {
      async emit(event) {
        if (event.kind === "turn.terminal_output") {
          terminalNotifications += 1;
          throw notificationFailure;
        }
      },
    });
    unregisterOutput = channelOutputSinks.register(metadata.target, {
      handoffCapability: CHANNEL_OUTPUT_HANDOFF_CAPABILITY,
      async emit(output, context) {
        outputCalls.push({ output, context });
        const identity = createChannelOutputHandoffIdentity(output);
        if (outputCalls.length === 1) {
          throw new ChannelOutputHandoffError({
            capability: CHANNEL_OUTPUT_HANDOFF_CAPABILITY,
            schemaVersion: 1,
            identity,
            disposition: "finished_pre_save_missing",
            operationFinished: true,
            code: "SQLITE_BUSY",
            idempotencyKey: output.outputId,
            requestFingerprint: fingerprint,
          });
        }
        return {
          capability: CHANNEL_OUTPUT_HANDOFF_CAPABILITY,
          schemaVersion: 1,
          identity,
          idempotencyKey: output.outputId,
          requestFingerprint: fingerprint,
          durableSaveConfirmed: true,
          disposition: "deferred",
        };
      },
    });
    await expect(
      projectChannelRuntimeEvent({
        metadata,
        event: { type: "turn.complete", usage: { inputTokens: 0, outputTokens: 0 } },
        responseText: "Complete terminal\nall lines retained",
        occurredAt: Date.parse("2026-11-04T06:00:00.000Z"),
        sinks,
        terminalRecovery: { mayRecover: () => true },
        afterRecordEvent: (state) => {
          if (state === "completed") afterCommitCalls += 1;
        },
      }),
    ).rejects.toBe(notificationFailure);
    expect(afterCommitCalls).toBe(1);
    expect(terminalNotifications).toBe(1);
    expect(outputCalls).toHaveLength(2);
    expect(outputCalls[1]!.output).toEqual(outputCalls[0]!.output);
    expect(outputCalls[1]!.context).toEqual({
      capability: CHANNEL_OUTPUT_HANDOFF_CAPABILITY,
      expectedRequestFingerprint: fingerprint,
    });
    expect(dbGetChannelBackendRuntimeState(metadata.binding.turnId)).toMatchObject({
      state: "completed",
      lastSequence: 2,
      lastDeltaSequence: 0,
    });
    expect(terminalDatabaseCounts(metadata).assistants).toBe(1);
  });

  it("does not restart persistence when the committed callback throws", async () => {
    const metadata = await acceptedMetadata();
    const callbackError = new Error("synthetic post-commit callback failure");
    let callbacks = 0;
    const output = mock(async () => {});
    unregisterOutput = channelOutputSinks.register(metadata.target, { emit: output });
    await expect(
      projectChannelRuntimeEvent({
        metadata,
        event: { type: "turn.complete", usage: { inputTokens: 0, outputTokens: 0 } },
        responseText: "One committed reply",
        sinks: runtimeSinks(metadata, []),
        terminalRecovery: { mayRecover: () => true },
        afterRecordEvent: (state) => {
          if (state !== "completed") return;
          callbacks += 1;
          throw callbackError;
        },
      }),
    ).rejects.toBe(callbackError);
    expect(callbacks).toBe(1);
    expect(output).not.toHaveBeenCalled();
    expect(dbGetChannelBackendRuntimeState(metadata.binding.turnId)).toMatchObject({
      state: "completed",
      lastSequence: 2,
    });
    expect(terminalDatabaseCounts(metadata).assistants).toBe(1);
  });

  it("commits the terminal, assistant and exact manifest before notifying or releasing output", async () => {
    const metadata = await acceptedMetadata();
    const order: string[] = [];
    let frozen: ChannelOutputEnvelope | undefined;
    const text = "Complete terminal\nwith every line";
    const prepared = prepareSlackAutomaticTerminalManifest(terminalManifestInput(metadata, text));
    const sinks = new ChannelRuntimeEventSinkRegistry();
    sinks.register(metadata.target, {
      async emit(event) {
        if (event.kind !== "turn.terminal_output") return;
        expect(getSlackAutomaticTerminalManifest(prepared.responseId)).toEqual(prepared);
        order.push("notification");
      },
    });
    unregisterOutput = channelOutputSinks.register(metadata.target, {
      async emit(output) {
        expect(output).toEqual(frozen!);
        order.push("delivery");
      },
    });
    await projectChannelRuntimeEvent({
      metadata,
      event: { type: "turn.complete", usage: { inputTokens: 0, outputTokens: 0 } },
      responseText: text,
      sinks,
      prepareTerminalManifest: ({ state, output }) => {
        expect(state).toBe("completed");
        frozen = output;
        expect(output?.kind).toBe("assistant_message");
        expect(getDb().inTransaction).toBe(false);
        expect(getSlackAutomaticTerminalManifest(prepared.responseId)).toBeNull();
        order.push("prepare");
        return prepared;
      },
      afterRecordEvent: (state, manifest) => {
        if (state !== "completed") return;
        expect(getDb().inTransaction).toBe(false);
        expect(manifest).toEqual(prepared);
        expect(getSlackAutomaticTerminalManifest(prepared.responseId)).toEqual(prepared);
        const runtime = dbGetChannelBackendRuntimeState(metadata.binding.turnId)!;
        expect(runtime.state).toBe("completed");
        expect(dbGetChatMessage(runtime.assistantMessageId!)?.content).toEqual({
          blocks: [{ type: "text", text }],
        });
        expect(assertSlackAutomaticTerminalPart(manifest!, { type: "text", text })).toBe(`${prepared.responseId}:text`);
        order.push("commit");
      },
    });
    expect(order).toEqual(["prepare", "commit", "notification", "delivery"]);
  });

  it("does not release a terminal when its manifest cannot be frozen", async () => {
    const metadata = await acceptedMetadata();
    const send = mock(async () => {});
    unregisterOutput = channelOutputSinks.register(metadata.target, { emit: send });
    await expect(
      projectChannelRuntimeEvent({
        metadata,
        event: { type: "turn.failed", error: "provider unavailable" },
        sinks: runtimeSinks(metadata, []),
        prepareTerminalManifest: ({ state, output }) => {
          expect(state).toBe("failed");
          expect(output?.kind).toBe("safe_error");
          throw new Error("manifest persistence unavailable");
        },
      }),
    ).rejects.toThrow("manifest persistence unavailable");
    expect(send).not.toHaveBeenCalled();
    expect(dbGetChannelBackendRuntimeState(metadata.binding.turnId)).toMatchObject({
      state: "running",
      lastSequence: 1,
    });
    expect(terminalDatabaseCounts(metadata)).toEqual({ assistants: 0, manifests: 0 });
  });

  for (const refusal of ["before_running", "after_running"] as const) {
    it(`fences terminal writes before commit and retains accepted failure after notification (${refusal})`, async () => {
      const metadata = await acceptedMetadata();
      const initial = dbGetChannelBackendRuntimeState(metadata.binding.turnId);
      const events: KnownChannelRuntimeEvent[] = [];
      const outputs: ChannelOutputEnvelope[] = [];
      const sinks = new ChannelRuntimeEventSinkRegistry();
      let mayRecord = refusal !== "before_running";
      const guardedStates: Array<string | undefined> = [];
      sinks.register(metadata.target, {
        async emit(event) {
          events.push(event);
          if (event.kind === "turn.state_changed") {
            expect(dbGetChannelBackendRuntimeState(metadata.binding.turnId)?.state).toBe("failed");
            await Promise.resolve();
            mayRecord = false;
          }
        },
      });
      unregisterOutput = channelOutputSinks.register(metadata.target, {
        async emit(output) {
          outputs.push(output);
        },
      });

      const projected = await projectChannelRuntimeEvent({
        metadata,
        event: { type: "turn.failed", error: "synthetic provider failure", recoverable: false },
        sinks,
        beforeRecordEvent: (state) => {
          guardedStates.push(state);
          return mayRecord;
        },
      });

      expect(projected).toEqual(events);
      if (refusal === "before_running") {
        expect(guardedStates).toEqual(["running"]);
        expect(outputs).toEqual([]);
        expect(events).toEqual([]);
        expect(dbGetChannelBackendRuntimeState(metadata.binding.turnId)).toEqual(initial);
      } else {
        expect(guardedStates).toContain("running");
        expect(guardedStates).toContain("failed");
        expect(events.map((event) => event.kind)).toEqual(["turn.state_changed", "turn.terminal_output"]);
        expect(outputs).toEqual([expect.objectContaining({ kind: "safe_error", binding: metadata.binding })]);
        expect(dbGetChannelBackendRuntimeState(metadata.binding.turnId)).toMatchObject({
          state: "failed",
          lastSequence: 2,
        });
        expect(dbGetChannelBackendRuntimeState(metadata.binding.turnId)?.assistantMessageId).toBeUndefined();
      }
    });
  }

  it("installs runtime, interrupt and terminal manifest tables in the central schema", () => {
    const tables = getDb()
      .prepare(
        `
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN (
            'channel_backend_runtime_state', 'channel_backend_runtime_interrupts',
            'slack_automatic_terminal_manifests'
          )
        ORDER BY name
      `,
      )
      .all() as Array<{ name: string }>;
    const stateColumns = new Set(
      (
        getDb().prepare("PRAGMA table_info(channel_backend_runtime_state)").all() as Array<{
          name: string;
        }>
      ).map((column) => column.name),
    );

    expect(tables.map((table) => table.name)).toEqual([
      "channel_backend_runtime_interrupts",
      "channel_backend_runtime_state",
      "slack_automatic_terminal_manifests",
    ]);
    expect(stateColumns).toEqual(
      new Set([
        "trace_turn_id",
        "turn_id",
        "state",
        "last_sequence",
        "last_delta_sequence",
        "assistant_message_id",
        "runtime_generation_id",
        "terminal_error_json",
        "updated_at",
      ]),
    );
    expect(getDb().prepare("PRAGMA table_info(slack_automatic_terminal_manifests)").all()).toMatchObject([
      { name: "response_id", pk: 1 },
      { name: "request_fingerprint", notnull: 1 },
      { name: "manifest_json", notnull: 1 },
    ]);
  });

  it("retries a real SQLITE_BUSY at COMMIT with one preparation and one committed terminal", async () => {
    const metadata = await acceptedMetadata();
    const before = startRunningRuntime(metadata);
    const database = getDb();
    database.exec("PRAGMA journal_mode = DELETE");
    database.exec("PRAGMA busy_timeout = 0");
    const reader = new Database(database.filename, { create: false, readwrite: true });
    reader.exec("BEGIN");
    reader.prepare("SELECT state FROM channel_backend_runtime_state WHERE turn_id = ?").get(metadata.binding.turnId);
    const prepared = prepareSlackAutomaticTerminalManifest(terminalManifestInput(metadata));
    const prepare = mock(() => prepared);
    const afterCommit = mock(() => {
      expect(database.inTransaction).toBe(false);
      expect(getSlackAutomaticTerminalManifest(prepared.responseId)).toEqual(prepared);
    });
    const send = mock(async () => {});
    unregisterOutput = channelOutputSinks.register(metadata.target, { emit: send });
    const events: KnownChannelRuntimeEvent[] = [];
    const originalExec = database.exec.bind(database);
    let attempts = 0;
    let busyCommits = 0;
    const exec = spyOn(database, "exec").mockImplementation((sql, ...rest) => {
      if (sql === "BEGIN IMMEDIATE") attempts += 1;
      try {
        return originalExec(sql, ...rest);
      } catch (error) {
        if (sql !== "COMMIT") throw error;
        busyCommits += 1;
        try {
          expect(error).toMatchObject({ code: "SQLITE_BUSY" });
          expect(database.inTransaction).toBe(true);
          expect(dbGetChannelBackendRuntimeState(metadata.binding.turnId)?.state).toBe("completed");
          expect(terminalDatabaseCounts(metadata)).toEqual({ assistants: 1, manifests: 1 });
          expect(
            reader
              .prepare("SELECT state, last_sequence FROM channel_backend_runtime_state WHERE turn_id = ?")
              .get(metadata.binding.turnId),
          ).toEqual({ state: before.state, last_sequence: before.lastSequence });
          expect(reader.prepare("SELECT COUNT(*) AS count FROM slack_automatic_terminal_manifests").get()).toEqual({
            count: 0,
          });
          expect(afterCommit).not.toHaveBeenCalled();
          expect(send).not.toHaveBeenCalled();
        } finally {
          reader.exec("ROLLBACK");
        }
        // Re-throw SQLite's original lock error so executeWrite owns the retry.
        throw error;
      }
    });
    try {
      await projectChannelRuntimeEvent({
        metadata,
        event: { type: "turn.complete", usage: { inputTokens: 0, outputTokens: 0 } },
        responseText: "Complete terminal",
        sinks: runtimeSinks(metadata, events),
        prepareTerminalManifest: prepare,
        afterRecordEvent: afterCommit,
      });
      expect(attempts).toBe(2);
      expect(busyCommits).toBe(1);
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(afterCommit).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledTimes(1);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: "turn.terminal_output", sequence: 2 });
      expect(dbGetChannelBackendRuntimeState(metadata.binding.turnId)).toMatchObject({
        state: "completed",
        lastSequence: 2,
      });
      expect(terminalDatabaseCounts(metadata)).toEqual({ assistants: 1, manifests: 1 });
    } finally {
      exec.mockRestore();
      if (reader.inTransaction) reader.exec("ROLLBACK");
      reader.close();
    }
  });

  it("rolls back the assistant and runtime when manifest INSERT fails and allows the same terminal to retry", async () => {
    const metadata = await acceptedMetadata();
    const before = startRunningRuntime(metadata);
    const prepared = prepareSlackAutomaticTerminalManifest(terminalManifestInput(metadata));
    const afterCommit = mock(() => {});
    const send = mock(async () => {});
    const events: KnownChannelRuntimeEvent[] = [];
    unregisterOutput = channelOutputSinks.register(metadata.target, { emit: send });
    getDb().exec(`CREATE TRIGGER reject_terminal_manifest BEFORE INSERT ON slack_automatic_terminal_manifests
      BEGIN SELECT RAISE(ABORT, 'manifest insert rejected'); END`);
    const project = () =>
      projectChannelRuntimeEvent({
        metadata,
        event: { type: "turn.complete", usage: { inputTokens: 0, outputTokens: 0 } },
        responseText: "Complete terminal",
        sinks: runtimeSinks(metadata, events),
        prepareTerminalManifest: () => prepared,
        afterRecordEvent: afterCommit,
      });
    await expect(project()).rejects.toThrow("manifest insert rejected");
    expect(dbGetChannelBackendRuntimeState(metadata.binding.turnId)).toEqual(before);
    expect(terminalDatabaseCounts(metadata)).toEqual({ assistants: 0, manifests: 0 });
    expect(afterCommit).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    getDb().exec("DROP TRIGGER reject_terminal_manifest");
    await project();
    expect(dbGetChannelBackendRuntimeState(metadata.binding.turnId)).toMatchObject({
      state: "completed",
      lastSequence: 2,
    });
    expect(terminalDatabaseCounts(metadata)).toEqual({ assistants: 1, manifests: 1 });
    expect(afterCommit).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  for (const boundary of ["transaction entry", "assistant write", "runtime write"] as const) {
    it(`keeps the terminal uncommitted when ownership is refused at ${boundary}`, async () => {
      const metadata = await acceptedMetadata();
      const before = startRunningRuntime(metadata);
      const prepared = prepareSlackAutomaticTerminalManifest(terminalManifestInput(metadata));
      const prepare = mock(() => prepared);
      const afterCommit = mock(() => {});
      const send = mock(async () => {});
      const events: KnownChannelRuntimeEvent[] = [];
      unregisterOutput = channelOutputSinks.register(metadata.target, { emit: send });
      const projected = await projectChannelRuntimeEvent({
        metadata,
        event: { type: "turn.complete", usage: { inputTokens: 0, outputTokens: 0 } },
        responseText: "Complete terminal",
        sinks: runtimeSinks(metadata, events),
        beforeRecordEvent: () => {
          if (!getDb().inTransaction) return true;
          if (boundary === "transaction entry") return false;
          if (boundary === "assistant write") return terminalDatabaseCounts(metadata).assistants === 0;
          return dbGetChannelBackendRuntimeState(metadata.binding.turnId)?.state !== "completed";
        },
        prepareTerminalManifest: prepare,
        afterRecordEvent: afterCommit,
      });
      expect(projected).toEqual([]);
      expect(events).toEqual([]);
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(afterCommit).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      expect(dbGetChannelBackendRuntimeState(metadata.binding.turnId)).toEqual(before);
      expect(terminalDatabaseCounts(metadata)).toEqual({ assistants: 0, manifests: 0 });
    });
  }

  it("does not prepare or commit a terminal after the running notification yields to another owner", async () => {
    const metadata = await acceptedMetadata();
    let ownsRequest = true;
    const sinks = new ChannelRuntimeEventSinkRegistry();
    sinks.register(metadata.target, {
      async emit(event) {
        expect(event).toMatchObject({ kind: "turn.state_changed", payload: { state: "running" } });
        await Promise.resolve();
        ownsRequest = false;
      },
    });
    const prepare = mock(() => prepareSlackAutomaticTerminalManifest(terminalManifestInput(metadata)));
    const afterCommit = mock(() => {});
    const send = mock(async () => {});
    unregisterOutput = channelOutputSinks.register(metadata.target, { emit: send });
    const projected = await projectChannelRuntimeEvent({
      metadata,
      event: { type: "turn.complete", usage: { inputTokens: 0, outputTokens: 0 } },
      responseText: "Complete terminal",
      sinks,
      beforeRecordEvent: () => ownsRequest,
      prepareTerminalManifest: prepare,
      afterRecordEvent: afterCommit,
    });
    expect(projected).toHaveLength(1);
    expect(prepare).not.toHaveBeenCalled();
    expect(afterCommit).toHaveBeenCalledTimes(1);
    expect(afterCommit).toHaveBeenCalledWith("running", undefined);
    expect(send).not.toHaveBeenCalled();
    expect(dbGetChannelBackendRuntimeState(metadata.binding.turnId)).toMatchObject({
      state: "running",
      lastSequence: 1,
    });
    expect(terminalDatabaseCounts(metadata)).toEqual({ assistants: 0, manifests: 0 });
  });

  for (const field of ["turnId", "sourceId", "sourceReceivedAt", "kind"] as const) {
    it(`rejects a terminal manifest with the wrong ${field} without changing an existing manifest`, async () => {
      const metadata = await acceptedMetadata();
      const before = startRunningRuntime(metadata);
      const source = terminalManifestInput(metadata);
      const existing = freezeSlackAutomaticTerminalManifest(source);
      const mismatch = prepareSlackAutomaticTerminalManifest({
        ...source,
        ...(field === "turnId" ? { turnId: "other-turn" } : {}),
        ...(field === "sourceId" ? { sourceId: "other-source" } : {}),
        ...(field === "sourceReceivedAt" ? { sourceReceivedAt: source.sourceReceivedAt + 1 } : {}),
        ...(field === "kind" ? { kind: "safe_error" as const } : {}),
      });
      expect(() =>
        dbRecordChannelBackendRuntimeEvent({
          turnId: metadata.binding.turnId,
          state: "completed",
          assistantText: "Complete terminal",
          runtimeGenerationId: "runtime-generation-a",
          slackTerminalManifest: mismatch,
        }),
      ).toThrow("does not match the channel runtime transition");
      expect(dbGetChannelBackendRuntimeState(metadata.binding.turnId)).toEqual(before);
      expect(getSlackAutomaticTerminalManifest(existing.responseId)).toEqual(existing);
      expect(terminalDatabaseCounts(metadata)).toEqual({ assistants: 0, manifests: 1 });
    });
  }

  it("rolls back a conflicting manifest identity without replacing the existing ledger entry", async () => {
    const metadata = await acceptedMetadata();
    const before = startRunningRuntime(metadata);
    const source = terminalManifestInput(metadata);
    const existing = freezeSlackAutomaticTerminalManifest(source);
    const conflicting = prepareSlackAutomaticTerminalManifest({ ...source, text: "Changed terminal" });
    expect(() =>
      dbRecordChannelBackendRuntimeEvent({
        turnId: metadata.binding.turnId,
        state: "completed",
        assistantText: "Changed terminal",
        runtimeGenerationId: "runtime-generation-a",
        slackTerminalManifest: conflicting,
      }),
    ).toThrow("identity conflict");
    expect(dbGetChannelBackendRuntimeState(metadata.binding.turnId)).toEqual(before);
    expect(getSlackAutomaticTerminalManifest(existing.responseId)).toEqual(existing);
    expect(terminalDatabaseCounts(metadata)).toEqual({ assistants: 0, manifests: 1 });
  });

  it("preserves the committed terminal and manifest when a later terminal transition is rejected", async () => {
    const metadata = await acceptedMetadata();
    startRunningRuntime(metadata);
    const source = terminalManifestInput(metadata);
    const prepared = prepareSlackAutomaticTerminalManifest(source);
    const committed = dbRecordChannelBackendRuntimeEvent({
      turnId: metadata.binding.turnId,
      state: "completed",
      assistantText: "Complete terminal",
      runtimeGenerationId: "runtime-generation-a",
      slackTerminalManifest: prepared,
    });
    const assistant = dbGetChatMessage(committed.runtime.assistantMessageId!);
    expect(() =>
      dbRecordChannelBackendRuntimeEvent({
        turnId: metadata.binding.turnId,
        state: "failed",
        runtimeGenerationId: "runtime-generation-b",
        terminalError: { code: "RUNTIME_FAILED" },
        slackTerminalManifest: prepareSlackAutomaticTerminalManifest({ ...source, kind: "safe_error", text: "Failed" }),
      }),
    ).toThrow("already terminal");
    expect(dbGetChannelBackendRuntimeState(metadata.binding.turnId)).toEqual(committed.runtime);
    expect(dbGetChatMessage(committed.runtime.assistantMessageId!)).toEqual(assistant);
    expect(getSlackAutomaticTerminalManifest(prepared.responseId)).toEqual(prepared);
    expect(terminalDatabaseCounts(metadata)).toEqual({ assistants: 1, manifests: 1 });
  });

  it("adds readback metadata columns to an existing runtime state table", () => {
    getDb().exec("ALTER TABLE channel_backend_runtime_state DROP COLUMN last_delta_sequence");
    getDb().exec("ALTER TABLE channel_backend_runtime_state DROP COLUMN runtime_generation_id");
    getDb().exec("ALTER TABLE channel_backend_runtime_state DROP COLUMN terminal_error_json");
    closeRouterDb();

    const stateColumns = new Set(
      (
        getDb().prepare("PRAGMA table_info(channel_backend_runtime_state)").all() as Array<{
          name: string;
        }>
      ).map((column) => column.name),
    );

    expect(stateColumns).toContain("last_delta_sequence");
    expect(stateColumns).toContain("runtime_generation_id");
    expect(stateColumns).toContain("terminal_error_json");
  });

  it("emits ordered safe events and persists one canonical terminal assistant message", async () => {
    const metadata = await acceptedMetadata();
    metadata.traceTurnId = "physical-trace-turn";
    const events: KnownChannelRuntimeEvent[] = [];
    const outputs: ChannelOutputEnvelope[] = [];
    const sinks = runtimeSinks(metadata, events);
    unregisterOutput = channelOutputSinks.register(metadata.target, {
      async emit(output) {
        expect(output.traceTurnId).toBe("physical-trace-turn");
        outputs.push(output);
      },
    });

    await projectChannelRuntimeEvent({
      metadata,
      event: {
        type: "text.delta",
        text: "Hello",
        metadata: { nativeEvent: "provider.delta" },
      },
      occurredAt: Date.parse("2026-07-24T18:00:01.000Z"),
      sinks,
    });
    await projectChannelRuntimeEvent({
      metadata,
      event: {
        type: "tool.started",
        toolUse: {
          id: "tool-call-a",
          name: "Local Lookup",
          input: { token: "provider-secret-must-not-leak" },
        },
        rawEvent: { token: "provider-secret-must-not-leak" },
      },
      toolPresentation: {
        title: "Look up local records",
        summary: "scope=current conversation",
        category: "records",
        operation: "read",
        risk: "low",
        parameters: [
          {
            name: "scope",
            value: "current conversation",
          },
        ],
      },
      occurredAt: Date.parse("2026-07-24T18:00:02.000Z"),
      sinks,
    });
    await projectChannelRuntimeEvent({
      metadata,
      event: {
        type: "turn.complete",
        usage: { inputTokens: 3, outputTokens: 2 },
        rawEvent: { token: "provider-secret-must-not-leak" },
      },
      responseText: "Hello world",
      occurredAt: Date.parse("2026-07-24T18:00:03.000Z"),
      sinks,
    });

    expect(events.map((event) => event.kind)).toEqual([
      "turn.state_changed",
      "turn.assistant_delta",
      "turn.tool_summary",
      "turn.terminal_output",
    ]);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
    expect(events[1]).toMatchObject({
      payload: {
        blockIndex: 0,
        deltaSequence: 1,
        text: "Hello",
      },
    });
    expect(events[2]).toMatchObject({
      payload: {
        toolName: "local.lookup",
        phase: "running",
        presentation: {
          title: "Look up local records",
          summary: "scope=current conversation",
          category: "records",
          operation: "read",
          risk: "low",
        },
      },
    });
    expect(JSON.stringify(events)).not.toContain("provider-secret-must-not-leak");

    const runtime = dbGetChannelBackendRuntimeState(metadata.binding.turnId);
    expect(runtime).toMatchObject({
      state: "completed",
      lastSequence: 4,
    });
    expect(runtime?.assistantMessageId).toMatch(/^cm_[0-9a-f]{24}$/);
    expect(dbGetChatMessage(runtime!.assistantMessageId!)).toMatchObject({
      chatId: metadata.binding.chatId,
      actorType: "agent",
      agentId: "agent-a",
      content: {
        blocks: [{ type: "text", text: "Hello world" }],
      },
    });
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toMatchObject({
      binding: metadata.binding,
      target: metadata.target,
      kind: "assistant_message",
      content: [{ type: "text", text: "Hello world" }],
    });
    const canonicalMessageCountBeforeDelivery = (
      getDb().prepare("SELECT COUNT(*) AS count FROM chat_messages WHERE chat_id = ?").get(metadata.binding.chatId) as {
        count: number;
      }
    ).count;
    const delivered = persistDeliveredMessage(
      buildChannelTextOutboundJob({
        requestId: "channel-output:terminal-a",
        sessionName: metadata.binding.sessionId,
        emitId: "terminal-a",
        idempotencyKey: "terminal-a",
        canonicalMessageId: runtime?.assistantMessageId,
        target: {
          channel: metadata.target.channelKind,
          accountId: metadata.target.connectionId,
          instanceId: metadata.binding.channelInstanceId,
          chatId: metadata.target.conversationId,
          canonicalChatId: metadata.binding.chatId,
        },
        text: "Hello world",
      }),
      {
        provider: "custom",
        platformMessageId: "provider-output-a",
        providerTimestamp: Date.parse("2026-07-24T18:00:04.000Z"),
      },
      "Hello world",
    );
    expect(delivered).toMatchObject({
      canonicalMessageId: runtime?.assistantMessageId,
      platformMessageId: "provider-output-a",
    });
    expect(
      (
        getDb()
          .prepare("SELECT COUNT(*) AS count FROM chat_messages WHERE chat_id = ?")
          .get(metadata.binding.chatId) as { count: number }
      ).count,
    ).toBe(canonicalMessageCountBeforeDelivery);

    const readback = readChannelRuntime({
      protocol: CHANNEL_RUNTIME_EVENTS_PROTOCOL,
      schemaVersion: CHANNEL_RUNTIME_EVENTS_SCHEMA_VERSION,
      requestId: "readback-a",
      binding: metadata.binding,
    });
    expect(readback).toMatchObject({
      state: "completed",
      lastSequence: 4,
      assistantMessageId: runtime?.assistantMessageId,
      runtimeGenerationId: "runtime-generation-a",
      lastEventRuntimeGenerationId: "runtime-generation-a",
    });
    expect(readback.terminalEvent).toEqual(lastTerminalEvent(events));
  });

  it("projects approval lifecycle and failures without provider payloads", async () => {
    const metadata = await acceptedMetadata();
    const events: KnownChannelRuntimeEvent[] = [];
    const outputs: ChannelOutputEnvelope[] = [];
    const sinks = runtimeSinks(metadata, events);
    unregisterOutput = channelOutputSinks.register(metadata.target, {
      async emit(output) {
        outputs.push(output);
      },
    });

    await projectChannelRuntimeEvent({
      metadata,
      event: {
        type: "approval.requested",
        approval: {
          kind: "file_change",
          toolName: "Local Write",
        },
        rawEvent: { patch: "private provider payload" },
      },
      sinks,
    });
    expect(dbGetChannelBackendRuntimeState(metadata.binding.turnId)?.state).toBe("waiting_approval");

    await projectChannelRuntimeEvent({
      metadata,
      event: {
        type: "approval.resolved",
        approval: {
          kind: "file_change",
          toolName: "Local Write",
          approved: false,
          reason: "private provider reason",
        },
      },
      sinks,
    });
    expect(dbGetChannelBackendRuntimeState(metadata.binding.turnId)?.state).toBe("running");

    await projectChannelRuntimeEvent({
      metadata,
      event: {
        type: "turn.failed",
        error: "provider credential and private diagnostics",
        recoverable: true,
        rawEvent: { diagnostics: "private provider payload" },
      },
      sinks,
    });

    expect(events.map((event) => event.kind)).toEqual([
      "turn.state_changed",
      "turn.approval_requested",
      "turn.approval_resolved",
      "turn.terminal_output",
    ]);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("private provider");
    expect(serialized).not.toContain("credential");
    expect(events.at(-1)).toMatchObject({
      payload: {
        state: "failed",
        error: {
          code: "INTERNAL",
          category: "internal",
          retryable: true,
        },
      },
    });
    expect(outputs).toEqual([
      expect.objectContaining({
        kind: "safe_error",
        error: expect.objectContaining({
          code: "INTERNAL",
          retryable: true,
        }),
      }),
    ]);
    const readback = readChannelRuntime({
      protocol: CHANNEL_RUNTIME_EVENTS_PROTOCOL,
      schemaVersion: CHANNEL_RUNTIME_EVENTS_SCHEMA_VERSION,
      requestId: "readback-failed",
      binding: metadata.binding,
    });
    expect(readback.terminalEvent).toEqual(lastTerminalEvent(events));
  });

  it("reports a provider billing failure by class without its text", async () => {
    const metadata = await acceptedMetadata();
    const events: KnownChannelRuntimeEvent[] = [];
    const outputs: ChannelOutputEnvelope[] = [];
    unregisterOutput = channelOutputSinks.register(metadata.target, {
      async emit(output) {
        outputs.push(output);
      },
    });

    await projectChannelRuntimeEvent({
      metadata,
      event: { type: "turn.failed", error: "402 Insufficient Balance", recoverable: true },
      sinks: runtimeSinks(metadata, events),
    });

    expect(JSON.stringify([events, outputs])).not.toContain("Insufficient");
    expect(outputs).toEqual([
      expect.objectContaining({
        kind: "safe_error",
        error: expect.objectContaining({ code: "UNAVAILABLE", category: "availability", retryable: false }),
      }),
    ]);
  });

  it.each([
    { name: "exhausted", message: PROVIDER_CAPACITY_EXHAUSTED_MESSAGE, retryable: true },
    { name: "replay-unsafe", message: PROVIDER_CAPACITY_UNSAFE_MESSAGE, retryable: false },
  ])(
    "preserves $name capacity replay safety through the automatic terminal manifest",
    async ({ message, retryable }) => {
      const metadata = await acceptedMetadata();
      const events: KnownChannelRuntimeEvent[] = [];
      const outputs: ChannelOutputEnvelope[] = [];
      let terminalManifest: ReturnType<typeof prepareSlackAutomaticTerminalManifest> | undefined;
      let renderedText: string | undefined;
      unregisterOutput = channelOutputSinks.register(metadata.target, {
        async emit(output) {
          expect(getSlackAutomaticTerminalManifest(terminalManifest!.responseId)).toEqual(terminalManifest!);
          expect(
            assertSlackAutomaticTerminalPart(terminalManifest!, {
              type: "text",
              text: renderSlackBackendOutput(output),
            }),
          ).toBe(`${terminalManifest!.responseId}:text`);
          outputs.push(output);
        },
      });
      await projectChannelRuntimeEvent({
        metadata,
        event: {
          type: "turn.failed",
          error: message,
          recoverable: false,
          rawEvent: { code: "serverOverloaded", diagnostics: "private provider payload" },
        },
        sinks: runtimeSinks(metadata, events),
        prepareTerminalManifest: ({ state, output }) => {
          expect(state).toBe("failed");
          expect(output?.kind).toBe("safe_error");
          renderedText = renderSlackBackendOutput(output!);
          terminalManifest = prepareSlackAutomaticTerminalManifest({
            ...terminalManifestInput(metadata, renderedText),
            kind: "safe_error",
          });
          return terminalManifest;
        },
      });
      expect(outputs).toHaveLength(1);
      expect(outputs[0]).toMatchObject({
        kind: "safe_error",
        error: { code: "OVERLOADED", category: "capacity", retryable },
      });
      expect(dbGetChannelBackendRuntimeState(metadata.binding.turnId)).toMatchObject({
        state: "failed",
        terminalError: { code: "OVERLOADED", category: "capacity", retryable },
      });
      expect(terminalDatabaseCounts(metadata)).toEqual({ assistants: 0, manifests: 1 });
      if (retryable) expect(renderedText).toContain("try again");
      else {
        expect(renderedText).toContain("completed work are preserved");
        expect(renderedText).not.toContain("try again");
      }
      expect(JSON.stringify([outputs, events])).not.toContain("private provider payload");
    },
  );

  it("classifies runtime failure text into channel-safe codes", () => {
    expect(classifyChannelRuntimeFailure("402 Insufficient Balance", true)).toEqual({
      code: "UNAVAILABLE",
      category: "availability",
      retryable: false,
    });
    expect(
      classifyChannelRuntimeFailure("Claude provider error (billing_error): credit balance is too low", true),
    ).toEqual({
      code: "UNAVAILABLE",
      category: "availability",
      retryable: false,
    });
    expect(classifyChannelRuntimeFailure("401 Incorrect API key provided", true)).toMatchObject({
      code: "UNAVAILABLE",
      retryable: false,
    });
    expect(
      classifyChannelRuntimeFailure("No managed runtime credential could be resolved for agent main", true),
    ).toMatchObject({
      code: "UNAVAILABLE",
      retryable: false,
    });
    expect(classifyChannelRuntimeFailure("429 Rate limit reached for requests", false)).toEqual({
      code: "RATE_LIMITED",
      category: "capacity",
      retryable: true,
    });
    expect(classifyChannelRuntimeFailure("Claude provider error (overloaded)", false)).toEqual({
      code: "OVERLOADED",
      category: "capacity",
      retryable: true,
    });
    expect(classifyChannelRuntimeFailure("503 Service Unavailable", false)).toMatchObject({
      code: "OVERLOADED",
      retryable: true,
    });
    expect(classifyChannelRuntimeFailure("Claude provider error (http_502)", false)).toEqual({
      code: "UNAVAILABLE",
      category: "availability",
      retryable: true,
    });
    expect(classifyChannelRuntimeFailure("TypeError: Cannot read properties of undefined", true)).toEqual({
      code: "INTERNAL",
      category: "internal",
      retryable: true,
    });
    expect(classifyChannelRuntimeFailure("Pi turn failed", false)).toEqual({
      code: "INTERNAL",
      category: "internal",
      retryable: false,
    });
  });

  it("distinguishes a nonterminal turn left by an earlier runtime generation", async () => {
    const metadata = await acceptedMetadata();
    const events: KnownChannelRuntimeEvent[] = [];

    await projectChannelRuntimeEvent({
      metadata,
      event: {
        type: "text.delta",
        text: "partial",
      },
      occurredAt: Date.parse("2026-07-24T18:00:01.000Z"),
      sinks: runtimeSinks(metadata, events),
    });

    setChannelRuntimeGenerationIdForTests("runtime-generation-b");
    const readback = readChannelRuntime({
      protocol: CHANNEL_RUNTIME_EVENTS_PROTOCOL,
      schemaVersion: CHANNEL_RUNTIME_EVENTS_SCHEMA_VERSION,
      requestId: "readback-after-restart",
      binding: metadata.binding,
    });

    expect(readback).toMatchObject({
      state: "running",
      lastSequence: 2,
      runtimeGenerationId: "runtime-generation-b",
      lastEventRuntimeGenerationId: "runtime-generation-a",
    });
    expect(readback.terminalEvent).toBeUndefined();
    expect(dbGetChannelBackendRuntimeState(metadata.binding.turnId)?.state).toBe("running");
  });

  it("keeps terminal readback durable when delivery sinks are temporarily unavailable", async () => {
    const metadata = await acceptedMetadata();

    await expect(
      projectChannelRuntimeEvent({
        metadata,
        event: {
          type: "turn.complete",
          usage: { inputTokens: 1, outputTokens: 1 },
        },
        responseText: "Durable result",
        sinks: new ChannelRuntimeEventSinkRegistry(),
      }),
    ).rejects.toThrow("unavailable");

    const runtime = dbGetChannelBackendRuntimeState(metadata.binding.turnId);
    expect(runtime).toMatchObject({
      state: "completed",
      lastSequence: 2,
    });
    expect(dbGetChatMessage(runtime!.assistantMessageId!)).toMatchObject({
      content: {
        blocks: [{ type: "text", text: "Durable result" }],
      },
    });
  });

  it("relays events and output through remote egress when sinks live in another process", async () => {
    const metadata = await acceptedMetadata();
    const events: KnownChannelRuntimeEvent[] = [];
    const outputs: ChannelOutputEnvelope[] = [];
    setChannelBackendEgressRequesterForRuntime({
      async emitRuntimeEvent(_target, event) {
        events.push(event);
      },
      async emitOutput(output) {
        outputs.push(output);
      },
    });

    await projectChannelRuntimeEvent({
      metadata,
      event: {
        type: "turn.complete",
        usage: { inputTokens: 2, outputTokens: 1 },
      },
      responseText: "Remote result",
      sinks: new ChannelRuntimeEventSinkRegistry(),
    });

    expect(events.map((event) => event.kind)).toEqual(["turn.state_changed", "turn.terminal_output"]);
    expect(outputs).toEqual([
      expect.objectContaining({
        kind: "assistant_message",
        content: [{ type: "text", text: "Remote result" }],
      }),
    ]);
  });

  it("preserves terminal persistence and attempts output after remote notification refusal", async () => {
    const metadata = await acceptedMetadata();
    const events: KnownChannelRuntimeEvent[] = [];
    const outputs: ChannelOutputEnvelope[] = [];
    const refusal = new Error("synthetic incompatible runtime-event reply");
    setChannelBackendEgressRequesterForRuntime({
      async emitRuntimeEvent(_target, event) {
        events.push(event);
        if (event.kind === "turn.terminal_output") {
          const committed = dbGetChannelBackendRuntimeState(metadata.binding.turnId);
          expect(committed).toMatchObject({ state: "completed", lastSequence: 2 });
          expect(dbGetChatMessage(committed!.assistantMessageId!)).toMatchObject({
            content: { blocks: [{ type: "text", text: "Remote complete result" }] },
          });
          expect(terminalDatabaseCounts(metadata).assistants).toBe(1);
          throw refusal;
        }
      },
      async emitOutput(output) {
        outputs.push(output);
      },
    });

    await expect(
      projectChannelRuntimeEvent({
        metadata,
        event: { type: "turn.complete", usage: { inputTokens: 2, outputTokens: 1 } },
        responseText: "Remote complete result",
        sinks: new ChannelRuntimeEventSinkRegistry(),
      }),
    ).rejects.toBe(refusal);

    expect(events.map((event) => event.kind)).toEqual(["turn.state_changed", "turn.terminal_output"]);
    expect(outputs).toEqual([
      expect.objectContaining({
        kind: "assistant_message",
        content: [{ type: "text", text: "Remote complete result" }],
      }),
    ]);
    expect(dbGetChannelBackendRuntimeState(metadata.binding.turnId)).toMatchObject({
      state: "completed",
      lastSequence: 2,
    });
    expect(terminalDatabaseCounts(metadata).assistants).toBe(1);
  });

  // The first CLI tool presentation loads the complete command registry. Keep
  // this integration check independent of cold-start scheduling on busy hosts.
  it("projects a real host runtime turn through its active channel binding", async () => {
    const metadata = await acceptedMetadata();
    const events: KnownChannelRuntimeEvent[] = [];
    const outputs: ChannelOutputEnvelope[] = [];
    const emitSpy = spyOn(nats, "emit").mockImplementation(async () => {});
    unregisterRuntimeEvents = channelRuntimeEventSinks.register(metadata.target, {
      async emit(event) {
        events.push(event);
      },
    });
    unregisterOutput = channelOutputSinks.register(metadata.target, {
      async emit(output) {
        outputs.push(output);
      },
    });
    const runtimeSession = runtimeHandle([
      {
        type: "text.delta",
        text: "Checking",
        metadata: { item: { id: "commentary-a", phase: "commentary" } },
      },
      {
        type: "assistant.message",
        text: "Checking the durable state.",
        metadata: { item: { id: "commentary-a", phase: "commentary" } },
      },
      {
        type: "tool.started",
        toolUse: {
          id: "tool-self-chat",
          name: "self_chat",
          input: { depth: "summary" },
        },
      },
      {
        type: "tool.completed",
        toolUseId: "tool-self-chat",
        toolName: "self_chat",
        content: [{ type: "text", text: "safe result" }],
      },
      {
        type: "assistant.message",
        text: "Final answer only.",
        metadata: { item: { id: "final-a", phase: "final_answer" } },
      },
      {
        type: "turn.complete",
        usage: { inputTokens: 3, outputTokens: 2 },
      },
    ]);
    const session = resolveSession(metadata.binding.sessionId);
    const agent = dbGetAgent(metadata.binding.agentId);
    if (!session || !agent) throw new Error("accepted fixture did not create local runtime identities");
    const streaming = streamingSession(metadata, runtimeSession);

    try {
      await runRuntimeEventLoop({
        runId: "channel-runtime-run-a",
        sessionName: session.name!,
        session,
        agent,
        streaming,
        runtimeSession,
        runtimeCapabilities,
        model: "channel-runtime-model",
        instanceId: "test-instance",
        defaultRuntimeProviderId: "test-provider",
        streamingSessions: new Map([[session.name!, streaming]]),
        stashedMessages: new Map(),
        safeEmit: async () => {},
        drainPendingStarts: () => {},
      });
    } finally {
      emitSpy.mockRestore();
    }

    expect(events.map((event) => event.kind)).toEqual([
      "turn.state_changed",
      "turn.assistant_message",
      "turn.tool_summary",
      "turn.tool_summary",
      "turn.terminal_output",
    ]);
    expect(events[1]).toMatchObject({
      payload: {
        phase: "commentary",
        content: [{ type: "text", text: "Checking the durable state." }],
      },
    });
    expect(events[2]).toMatchObject({
      payload: {
        toolName: "self_chat",
        phase: "running",
        presentation: {
          title: "Show the current chat binding and participants",
          category: "self",
          operation: "read",
          risk: "low",
          summary: "depth=summary",
        },
      },
    });
    expect(events[3]).toMatchObject({
      payload: {
        toolName: "self_chat",
        phase: "completed",
        presentation: {
          title: "Show the current chat binding and participants",
          summary: "depth=summary",
        },
        durationMs: expect.any(Number),
      },
    });
    expect(events.at(-1)).toMatchObject({
      payload: {
        state: "completed",
        content: [{ type: "text", text: "Final answer only." }],
      },
    });
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toMatchObject({
      kind: "assistant_message",
      content: [{ type: "text", text: "Final answer only." }],
    });
    expect(dbGetChannelBackendRuntimeState(metadata.binding.turnId)).toMatchObject({
      state: "completed",
      lastSequence: 5,
    });
    expect(emitSpy.mock.calls.some(([topic]) => String(topic).endsWith(".response"))).toBe(false);
    expect(streaming.currentChannelBackend).toBeUndefined();
  }, 20_000);

  it("projects only sanitized commentary after host response policy", async () => {
    const metadata = await acceptedMetadata();
    const events: KnownChannelRuntimeEvent[] = [];
    const outputs: ChannelOutputEnvelope[] = [];
    const emitSpy = spyOn(nats, "emit").mockImplementation(async () => {});
    unregisterRuntimeEvents = channelRuntimeEventSinks.register(metadata.target, {
      async emit(event) {
        events.push(event);
      },
    });
    unregisterOutput = channelOutputSinks.register(metadata.target, {
      async emit(output) {
        outputs.push(output);
      },
    });

    try {
      await runAcceptedHostRuntime(metadata, [
        {
          type: "text.delta",
          text: "@@SILENT@@ No response requested.",
          metadata: { item: { id: "silent-delta", phase: "commentary" } },
        },
        {
          type: "assistant.message",
          text: "@@SILENT@@",
          metadata: { item: { id: "silent-a", phase: "commentary" } },
        },
        {
          type: "assistant.message",
          text: "No response requested.",
          metadata: { item: { id: "silent-b", phase: "commentary" } },
        },
        {
          type: "assistant.message",
          text: "Routine finished HEARTBEAT_OK",
          metadata: { item: { id: "silent-c", phase: "commentary" } },
        },
        {
          type: "assistant.message",
          text: "@@SILENT@@ Checking the current state.",
          metadata: { item: { id: "commentary-a", phase: "commentary" } },
        },
        {
          type: "turn.complete",
          usage: { inputTokens: 2, outputTokens: 1 },
        },
      ]);
    } finally {
      emitSpy.mockRestore();
    }

    expect(events.filter((event) => event.kind === "turn.assistant_message")).toEqual([
      expect.objectContaining({
        payload: {
          phase: "commentary",
          content: [{ type: "text", text: "Checking the current state." }],
        },
      }),
    ]);
    expect(events.some((event) => event.kind === "turn.assistant_delta")).toBe(false);
    expect(outputs).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({
      kind: "turn.state_changed",
      payload: { state: "completed" },
    });
    const readback = readChannelRuntime({
      protocol: CHANNEL_RUNTIME_EVENTS_PROTOCOL,
      schemaVersion: CHANNEL_RUNTIME_EVENTS_SCHEMA_VERSION,
      requestId: "readback-suppressed-policy-output",
      binding: metadata.binding,
    });
    expect(readback).toMatchObject({
      state: "completed",
      lastSequence: events.at(-1)?.sequence,
    });
    expect(readback.assistantMessageId).toBeUndefined();
    expect(readback.terminalEvent).toBeUndefined();
  });

  it("suppresses a truncated silence marker but delivers commentary that cites the marker", async () => {
    const metadata = await acceptedMetadata();
    const events: KnownChannelRuntimeEvent[] = [];
    const outputs: ChannelOutputEnvelope[] = [];
    const emitSpy = spyOn(nats, "emit").mockImplementation(async () => {});
    unregisterRuntimeEvents = channelRuntimeEventSinks.register(metadata.target, {
      async emit(event) {
        events.push(event);
      },
    });
    unregisterOutput = channelOutputSinks.register(metadata.target, {
      async emit(output) {
        outputs.push(output);
      },
    });

    try {
      await runAcceptedHostRuntime(metadata, [
        {
          type: "assistant.message",
          text: "@@SILEN",
          metadata: { item: { id: "truncated-silent", phase: "commentary" } },
        },
        {
          type: "assistant.message",
          text: "Para silenciar, responda @@SILENT@@ no fim.",
          metadata: { item: { id: "cited-marker", phase: "commentary" } },
        },
        {
          type: "turn.complete",
          usage: { inputTokens: 2, outputTokens: 1 },
        },
      ]);
    } finally {
      emitSpy.mockRestore();
    }

    expect(events.filter((event) => event.kind === "turn.assistant_message")).toEqual([
      expect.objectContaining({
        payload: {
          phase: "commentary",
          content: [{ type: "text", text: "Para silenciar, responda @@SILENT@@ no fim." }],
        },
      }),
    ]);
    expect(outputs).toHaveLength(0);
  });

  it("keeps suppressed non-commentary outcomes off the channel and off durable chat.db rows", async () => {
    const metadata = await acceptedMetadata();
    const events: KnownChannelRuntimeEvent[] = [];
    const outputs: ChannelOutputEnvelope[] = [];
    const emitSpy = spyOn(nats, "emit").mockImplementation(async () => {});
    unregisterRuntimeEvents = channelRuntimeEventSinks.register(metadata.target, {
      async emit(event) {
        events.push(event);
      },
    });
    unregisterOutput = channelOutputSinks.register(metadata.target, {
      async emit(output) {
        outputs.push(output);
      },
    });

    try {
      await runAcceptedHostRuntime(metadata, [
        {
          type: "text.delta",
          text: "Routine finished HEARTBEAT_OK",
          metadata: { item: { id: "heartbeat-delta", phase: "final_answer" } },
        },
        {
          type: "assistant.message",
          text: "Routine finished HEARTBEAT_OK",
          metadata: { item: { id: "heartbeat-final", phase: "final_answer" } },
        },
        {
          type: "assistant.message",
          text: "No response requested.",
          metadata: { item: { id: "no-response-final", phase: "final_answer" } },
        },
        {
          type: "turn.complete",
          usage: { inputTokens: 2, outputTokens: 1 },
        },
      ]);
    } finally {
      emitSpy.mockRestore();
    }

    expect(events.some((event) => event.kind === "turn.assistant_delta")).toBe(false);
    expect(events.some((event) => event.kind === "turn.assistant_message")).toBe(false);
    expect(events.at(-1)).toMatchObject({
      kind: "turn.state_changed",
      payload: { state: "completed" },
    });
    const readback = readChannelRuntime({
      protocol: CHANNEL_RUNTIME_EVENTS_PROTOCOL,
      schemaVersion: CHANNEL_RUNTIME_EVENTS_SCHEMA_VERSION,
      requestId: "readback-suppressed-non-commentary",
      binding: metadata.binding,
    });
    expect(readback).toMatchObject({
      state: "completed",
      lastSequence: events.at(-1)?.sequence,
    });
    expect(readback.assistantMessageId).toBeUndefined();
    expect(readback.terminalEvent).toBeUndefined();
    expect(outputs).toHaveLength(0);
    expect(
      getHistory(metadata.binding.sessionId)
        .filter((message) => message.role === "assistant")
        .map((message) => message.content),
    ).toEqual([]);
  });

  it("does not project assistant content from an interrupted channel turn", async () => {
    const metadata = await acceptedMetadata();
    const events: KnownChannelRuntimeEvent[] = [];
    const emitSpy = spyOn(nats, "emit").mockImplementation(async () => {});
    unregisterRuntimeEvents = channelRuntimeEventSinks.register(metadata.target, {
      async emit(event) {
        events.push(event);
      },
    });

    try {
      await runAcceptedHostRuntime(
        metadata,
        [
          {
            type: "assistant.message",
            text: "Discard this interrupted commentary.",
            metadata: { item: { id: "commentary-a", phase: "commentary" } },
          },
          { type: "turn.interrupted" },
        ],
        (streaming) => {
          streaming.interrupted = true;
        },
      );
    } finally {
      emitSpy.mockRestore();
    }

    expect(events.some((event) => event.kind === "turn.assistant_message")).toBe(false);
    expect(events.at(-1)).toMatchObject({
      kind: "turn.terminal_output",
      payload: { state: "interrupted" },
    });
  });

  for (const terminalType of ["turn.interrupted", "turn.complete"] as const) {
    it(`keeps a yielded channel request open across ${terminalType} until its continuation replies`, async () => {
      const metadata = await acceptedMetadata();
      const events: KnownChannelRuntimeEvent[] = [];
      const outputs: ChannelOutputEnvelope[] = [];
      const emitSpy = spyOn(nats, "emit").mockImplementation(async () => {});
      unregisterRuntimeEvents = channelRuntimeEventSinks.register(metadata.target, {
        async emit(event) {
          events.push(event);
        },
      });
      unregisterOutput = channelOutputSinks.register(metadata.target, {
        async emit(output) {
          outputs.push(output);
        },
      });
      try {
        await runAcceptedHostRuntime(
          metadata,
          [
            { type: "tool.started", toolUse: { id: "yield-tool", name: "read", input: {} } },
            { type: "tool.completed", toolUseId: "yield-tool", toolName: "read", content: "done" },
            terminalType === "turn.complete"
              ? { type: "turn.complete", usage: { inputTokens: 1, outputTokens: 0 } }
              : { type: "turn.interrupted" },
          ],
          (streaming) => {
            streaming.currentTurnSuperseded = true;
            streaming.currentTurnYieldContinuationId = "pending-continuation";
            streaming.interrupted = true;
          },
        );
        expect(dbGetChannelBackendRuntimeState(metadata.binding.turnId)?.state).toBe("running");
        expect(events.some((event) => event.kind === "turn.terminal_output")).toBe(false);
        expect(outputs).toHaveLength(0);

        await runAcceptedHostRuntime(metadata, [
          { type: "assistant.message", text: "Original work completed after yielding." },
          { type: "turn.complete", usage: { inputTokens: 1, outputTokens: 1 } },
        ]);
      } finally {
        emitSpy.mockRestore();
      }
      expect(dbGetChannelBackendRuntimeState(metadata.binding.turnId)?.state).toBe("completed");
      expect(events.filter((event) => event.kind === "turn.terminal_output")).toHaveLength(1);
      expect(outputs).toHaveLength(1);
    });
  }

  for (const deferred of [false, true]) {
    it(`closes a waiting continuation's channel request on ${deferred ? "deferred" : "immediate"} session abort`, async () => {
      const metadata = await acceptedMetadata();
      const events: KnownChannelRuntimeEvent[] = [];
      unregisterRuntimeEvents = channelRuntimeEventSinks.register(metadata.target, {
        async emit(event) {
          events.push(event);
        },
      });
      await projectChannelRuntimeEvent({
        metadata,
        event: { type: "tool.started", toolUse: { id: "original-tool", name: "read", input: {} } },
      });
      const session = resolveSession(metadata.binding.sessionId)!;
      const dispatcher = new RuntimeSessionDispatcher({
        instanceId: "test",
        maxConcurrentSessions: 2,
        interactiveReservedSessions: 0,
        safeEmit: async () => {},
        notifyRuntimeRecoveryExhausted: async () => {},
        getConfigModel: () => "test-model",
        crashRecovery: { acceptingDeliveries: true } as RuntimeCrashRecoveryCoordinator,
      });
      const continuation = {
        ...createQueuedRuntimeUserMessage({
          prompt: "resume the original work",
          _channelBackend: metadata,
          deliveryBarrier: "after_response",
        }),
        yieldedRequest: "original work",
      };
      const streaming = streamingSession(metadata, runtimeHandle([]));
      streaming.currentSource = {
        channel: "slack",
        accountId: "slack-account",
        chatId: "other-chat",
        threadId: "other-thread",
      };
      streaming.currentChannelBackend = undefined;
      streaming.pendingMessages = [continuation];
      streaming.toolResultDeliveryPending = deferred;
      dispatcher.streamingSessions.set(session.name!, streaming);
      dispatcher.stashedMessages.set(session.name!, [{ ...continuation }]);

      expect(dbGetChannelBackendRuntimeState(metadata.binding.turnId)?.state).toBe("running");
      expect(dispatcher.abortSession(session.name!)).toBe(true);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(dbGetChannelBackendRuntimeState(metadata.binding.turnId)?.state).toBe("interrupted");
      expect(events.filter((event) => event.kind === "turn.terminal_output")).toHaveLength(1);
      expect(streaming.pendingMessages).toEqual([]);
      expect(dispatcher.stashedMessages.has(session.name!)).toBe(false);
      expect(streaming.pendingAbort).toBe(deferred);
      expect(streaming.abortController.signal.aborted).toBe(!deferred);
    });
  }

  it("still terminalizes an explicitly aborted channel turn while a yield is pending", async () => {
    const metadata = await acceptedMetadata();
    const emitSpy = spyOn(nats, "emit").mockImplementation(async () => {});
    try {
      await runAcceptedHostRuntime(metadata, [{ type: "turn.interrupted" }], (streaming) => {
        streaming.currentTurnSuperseded = true;
        streaming.currentTurnYieldContinuationId = "pending-continuation";
        streaming.internalAbortReason = "explicit_abort";
        streaming.interrupted = true;
      });
    } finally {
      emitSpy.mockRestore();
    }
    expect(dbGetChannelBackendRuntimeState(metadata.binding.turnId)?.state).toBe("interrupted");
  });

  it("keeps sentinel assistant content off the channel output path", async () => {
    const metadata = await acceptedMetadata();
    const events: KnownChannelRuntimeEvent[] = [];
    const outputs: ChannelOutputEnvelope[] = [];
    const emitSpy = spyOn(nats, "emit").mockImplementation(async () => {});
    unregisterRuntimeEvents = channelRuntimeEventSinks.register(metadata.target, {
      async emit(event) {
        events.push(event);
      },
    });
    unregisterOutput = channelOutputSinks.register(metadata.target, {
      async emit(output) {
        outputs.push(output);
      },
    });

    try {
      await runAcceptedHostRuntime(
        metadata,
        [
          {
            type: "text.delta",
            text: "Hidden",
            metadata: { item: { id: "commentary-a", phase: "commentary" } },
          },
          {
            type: "assistant.message",
            text: "Hidden commentary.",
            metadata: { item: { id: "commentary-a", phase: "commentary" } },
          },
          {
            type: "assistant.message",
            text: "Hidden final answer.",
            metadata: { item: { id: "final-a", phase: "final_answer" } },
          },
          {
            type: "turn.complete",
            usage: { inputTokens: 2, outputTokens: 1 },
          },
        ],
        (streaming) => {
          streaming.agentMode = "sentinel";
        },
      );
    } finally {
      emitSpy.mockRestore();
    }

    expect(
      events.some((event) => event.kind === "turn.assistant_delta" || event.kind === "turn.assistant_message"),
    ).toBe(false);
    expect(outputs).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({
      kind: "turn.state_changed",
      payload: { state: "completed" },
    });
    const readback = readChannelRuntime({
      protocol: CHANNEL_RUNTIME_EVENTS_PROTOCOL,
      schemaVersion: CHANNEL_RUNTIME_EVENTS_SCHEMA_VERSION,
      requestId: "readback-sentinel-completed",
      binding: metadata.binding,
    });
    expect(readback).toMatchObject({
      state: "completed",
      lastSequence: events.at(-1)?.sequence,
    });
    expect(readback.assistantMessageId).toBeUndefined();
    expect(readback.terminalEvent).toBeUndefined();
  });

  it("closes an unrecoverable host loop without leaving channel readback running forever", async () => {
    const metadata = await acceptedMetadata();
    const events: KnownChannelRuntimeEvent[] = [];
    unregisterRuntimeEvents = channelRuntimeEventSinks.register(metadata.target, {
      async emit(event) {
        events.push(event);
      },
    });
    const runtimeSession = runtimeHandle([]);
    const session = resolveSession(metadata.binding.sessionId);
    const agent = dbGetAgent(metadata.binding.agentId);
    if (!session || !agent) throw new Error("accepted fixture did not create local runtime identities");
    const streaming = streamingSession(metadata, runtimeSession);
    streaming.currentTraceTurnId = "trace-unterminated-channel-turn";
    streaming.currentTraceTurnStartedAt = Date.now();

    await runRuntimeEventLoop({
      runId: "channel-runtime-run-unterminated",
      sessionName: session.name!,
      session,
      agent,
      streaming,
      runtimeSession,
      runtimeCapabilities,
      model: "channel-runtime-model",
      instanceId: "test-instance",
      defaultRuntimeProviderId: "test-provider",
      streamingSessions: new Map([[session.name!, streaming]]),
      stashedMessages: new Map(),
      safeEmit: async () => {},
      drainPendingStarts: () => {},
    });

    expect(events.map((event) => event.kind)).toEqual(["turn.state_changed", "turn.terminal_output"]);
    expect(events.at(-1)).toMatchObject({
      payload: {
        state: "interrupted",
      },
    });
    expect(dbGetChannelBackendRuntimeState(metadata.binding.turnId)?.state).toBe("interrupted");
    expect(
      readChannelRuntime({
        protocol: CHANNEL_RUNTIME_EVENTS_PROTOCOL,
        schemaVersion: CHANNEL_RUNTIME_EVENTS_SCHEMA_VERSION,
        requestId: "readback-interrupted",
        binding: metadata.binding,
      }).terminalEvent,
    ).toEqual(lastTerminalEvent(events));
  });
});

describe("channel runtime interruption", () => {
  it("publishes one abort for concurrent-safe idempotent retries", async () => {
    const metadata = await acceptedMetadata();
    const publish = mock(async () => {});
    setChannelRuntimeAbortPublisherForTests(publish);
    const firstRequest = interruptRequest(metadata);

    const first = await requestChannelRuntimeInterrupt(firstRequest);
    await projectChannelRuntimeEvent({
      metadata,
      event: { type: "turn.interrupted" },
      sinks: runtimeSinks(metadata, []),
    });
    const duplicate = await requestChannelRuntimeInterrupt({
      ...firstRequest,
      requestId: "interrupt-retry",
      requestedAt: "2026-07-24T18:00:05.000Z",
    });

    expect(first.disposition).toBe("requested");
    expect(duplicate.disposition).toBe("duplicate");
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      "ravi.session.abort",
      expect.objectContaining({
        sessionName: metadata.binding.sessionId,
        correlationId: "interrupt-a",
      }),
    );
  });

  it("releases a failed publication claim so the same request can retry", async () => {
    const metadata = await acceptedMetadata();
    let attempts = 0;
    setChannelRuntimeAbortPublisherForTests(async () => {
      attempts++;
      if (attempts === 1) throw new Error("transport unavailable");
    });
    const request = interruptRequest(metadata);

    const unavailable = await requestChannelRuntimeInterrupt(request);
    const recovered = await requestChannelRuntimeInterrupt({
      ...request,
      requestId: "interrupt-retry",
      requestedAt: "2026-07-24T18:00:05.000Z",
    });

    expect(unavailable).toMatchObject({
      disposition: "rejected",
      error: {
        code: "UNAVAILABLE",
        retryable: true,
      },
    });
    expect(recovered.disposition).toBe("duplicate");
    expect(attempts).toBe(2);
  });

  it("fails closed for a binding that does not match the accepted turn", async () => {
    const metadata = await acceptedMetadata();
    const publish = mock(async () => {});
    setChannelRuntimeAbortPublisherForTests(publish);

    const result = await requestChannelRuntimeInterrupt({
      ...interruptRequest(metadata),
      binding: {
        ...metadata.binding,
        messageId: "different-message",
      },
    });

    expect(result).toMatchObject({
      disposition: "rejected",
      error: {
        code: "NOT_FOUND",
        category: "validation",
      },
    });
    expect(publish).not.toHaveBeenCalled();
  });
});

function startRunningRuntime(metadata: ChannelBackendPromptMetadata) {
  return dbRecordChannelBackendRuntimeEvent({
    turnId: metadata.binding.turnId,
    state: "running",
    runtimeGenerationId: "runtime-generation-a",
    occurredAt: Date.parse("2026-07-24T18:00:01.000Z"),
  }).runtime;
}

function terminalManifestInput(
  metadata: ChannelBackendPromptMetadata,
  text = "Complete terminal",
): SlackAutomaticTerminalManifestInput {
  const receipt = dbGetChannelBackendIngressReceiptByTurnId(metadata.binding.turnId)!;
  // These DB/projector tests supply trusted internal prepared metadata. The
  // custom ingress is not Slack admission or authority; native bot origin and
  // destination resolution are exercised by the Slack host/origin suites.
  return {
    turnId: receipt.turnId,
    sourceId: receipt.messageId,
    sourceReceivedAt: receipt.acceptedAt,
    scope: "fixture-installation:C123",
    target: {
      channel: "slack",
      accountId: "fixture-slack",
      instanceId: "fixture-slack",
      chatId: "C123",
      canonicalChatId: receipt.chatId,
    },
    kind: "final_answer",
    text,
    media: [],
  };
}

function terminalDatabaseCounts(metadata: ChannelBackendPromptMetadata) {
  const database = getDb();
  const assistants = database
    .prepare("SELECT COUNT(*) AS count FROM chat_messages WHERE chat_id = ? AND actor_type = 'agent'")
    .get(metadata.binding.chatId) as { count: number };
  const manifests = database.prepare("SELECT COUNT(*) AS count FROM slack_automatic_terminal_manifests").get() as {
    count: number;
  };
  return { assistants: assistants.count, manifests: manifests.count };
}

function runtimeSinks(
  metadata: ChannelBackendPromptMetadata,
  events: KnownChannelRuntimeEvent[],
): ChannelRuntimeEventSinkRegistry {
  const sinks = new ChannelRuntimeEventSinkRegistry();
  sinks.register(metadata.target, {
    async emit(event) {
      events.push(event);
    },
  });
  return sinks;
}

function lastTerminalEvent(
  events: KnownChannelRuntimeEvent[],
): Extract<KnownChannelRuntimeEvent, { kind: "turn.terminal_output" }> {
  const event = events.at(-1);
  if (event?.kind !== "turn.terminal_output") {
    throw new Error("Expected the last runtime event to be terminal output");
  }
  return event;
}

async function acceptedMetadata(channelKind = "custom"): Promise<ChannelBackendPromptMetadata> {
  const request = ingressRequest();
  const result = await acceptChannelIngress({ ...request, external: { ...request.external, channelKind } });
  if (!result.binding) throw new Error("fixture ingress was rejected");
  return {
    protocol: CHANNEL_BACKEND_PROTOCOL,
    schemaVersion: CHANNEL_BACKEND_SCHEMA_VERSION,
    ingressRequestId: "request-a",
    correlationId: "request-a",
    binding: result.binding,
    target: {
      channelKind,
      connectionId: "connection-a",
      conversationId: "external-conversation-a",
    },
  };
}

function interruptRequest(metadata: ChannelBackendPromptMetadata): ChannelInterruptRequest {
  return {
    protocol: CHANNEL_RUNTIME_EVENTS_PROTOCOL,
    schemaVersion: CHANNEL_RUNTIME_EVENTS_SCHEMA_VERSION,
    requestId: "interrupt-a",
    idempotencyKey: "interrupt-idempotency-a",
    binding: metadata.binding,
    requestedAt: "2026-07-24T18:00:04.000Z",
  };
}

function ingressRequest(): ChannelIngressRequest {
  return {
    protocol: CHANNEL_BACKEND_PROTOCOL,
    schemaVersion: CHANNEL_BACKEND_SCHEMA_VERSION,
    requestId: "request-a",
    idempotencyKey: "idempotency-a",
    localActorId: "actor-a",
    channelInstanceId: "channel-instance-a",
    agentId: "agent-a",
    external: {
      channelKind: "custom",
      connectionId: "connection-a",
      conversationId: "external-conversation-a",
      senderId: "external-sender-a",
      messageId: "external-message-a",
    },
    content: [{ type: "text", text: "fixture input" }],
    receivedAt: "2026-07-24T18:00:00.000Z",
  };
}

function runtimeHandle(events: RuntimeEvent[]): RuntimeSessionHandle {
  return {
    provider: "test-provider",
    events: (async function* () {
      for (const event of events) yield event;
    })(),
    async interrupt() {},
  };
}

function streamingSession(
  metadata: ChannelBackendPromptMetadata,
  runtimeSession: RuntimeSessionHandle,
): RuntimeHostStreamingSession {
  return {
    agentId: metadata.binding.agentId,
    queryHandle: runtimeSession,
    starting: false,
    abortController: new AbortController(),
    pushMessage: null,
    pendingWake: false,
    pendingMessages: [],
    currentSource: {
      channel: metadata.target.channelKind,
      accountId: metadata.target.connectionId,
      instanceId: metadata.binding.channelInstanceId,
      chatId: metadata.target.conversationId,
      canonicalChatId: metadata.binding.chatId,
      sourceMessageId: metadata.binding.messageId,
    },
    currentChannelBackend: metadata,
    currentModel: "channel-runtime-model",
    toolRunning: false,
    lastActivity: Date.now(),
    done: false,
    interrupted: false,
    turnActive: true,
    compacting: false,
    onTurnComplete: null,
    currentToolSafety: null,
    pendingAbort: false,
    agentMode: "active",
  };
}

async function runAcceptedHostRuntime(
  metadata: ChannelBackendPromptMetadata,
  events: RuntimeEvent[],
  configure?: (streaming: RuntimeHostStreamingSession) => void,
): Promise<RuntimeHostStreamingSession> {
  const runtimeSession = runtimeHandle(events);
  const session = resolveSession(metadata.binding.sessionId);
  const agent = dbGetAgent(metadata.binding.agentId);
  if (!session || !agent) throw new Error("accepted fixture did not create local runtime identities");
  const streaming = streamingSession(metadata, runtimeSession);
  configure?.(streaming);

  await runRuntimeEventLoop({
    runId: `channel-runtime-${metadata.binding.turnId}`,
    sessionName: session.name!,
    session,
    agent,
    streaming,
    runtimeSession,
    runtimeCapabilities,
    model: "channel-runtime-model",
    instanceId: "test-instance",
    defaultRuntimeProviderId: "test-provider",
    streamingSessions: new Map([[session.name!, streaming]]),
    stashedMessages: new Map(),
    safeEmit: async () => {},
    drainPendingStarts: () => {},
  });
  return streaming;
}

const runtimeCapabilities: RuntimeCapabilities = {
  runtimeControl: { supported: false, operations: [] },
  dynamicTools: { mode: "none" },
  execution: { mode: "sdk" },
  sessionState: { mode: "provider-session-id" },
  usage: { semantics: "terminal-event" },
  tools: {
    permissionMode: "ravi-host",
    accessRequirement: "tool_and_executable",
    supportsParallelCalls: false,
  },
  systemPrompt: { mode: "append" },
  terminalEvents: { guarantee: "adapter" },
  skillVisibility: { availability: "none", loadedState: "none" },
  supportsSessionResume: false,
  supportsSessionFork: false,
  supportsPartialText: true,
  supportsToolHooks: false,
  supportsHostSessionHooks: false,
  supportsPlugins: false,
  supportsMcpServers: false,
  supportsRemoteSpawn: false,
};
