import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { nats } from "../nats.js";
import {
  closeRouterDb,
  dbCreateAgent,
  dbGetAgent,
  dbGetChatMessage,
  dbGetChannelBackendRuntimeState,
  getDb,
} from "../router/router-db.js";
import { resolveSession } from "../router/sessions.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import type { RuntimeHostStreamingSession } from "../runtime/host-session.js";
import { runRuntimeEventLoop } from "../runtime/host-event-loop.js";
import type { ChannelBackendPromptMetadata } from "../runtime/message-types.js";
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
  projectChannelRuntimeEvent,
  readChannelRuntime,
  requestChannelRuntimeInterrupt,
  setChannelBackendEgressRequesterForRuntime,
  setChannelRuntimeAbortPublisherForTests,
  type ChannelInterruptRequest,
  type KnownChannelRuntimeEvent,
} from "./runtime-events.js";

let stateDir: string | null = null;
let unregisterOutput: (() => void) | undefined;
let unregisterRuntimeEvents: (() => void) | undefined;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-channel-runtime-events-");
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
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

describe("channel runtime event projection", () => {
  it("installs durable runtime state and interrupt outbox tables", () => {
    const tables = getDb()
      .prepare(
        `
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN ('channel_backend_runtime_state', 'channel_backend_runtime_interrupts')
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
    ]);
    expect(stateColumns).toEqual(
      new Set(["turn_id", "state", "last_sequence", "last_delta_sequence", "assistant_message_id", "updated_at"]),
    );
  });

  it("adds the delta sequence column to an existing runtime state table", () => {
    getDb().exec("ALTER TABLE channel_backend_runtime_state DROP COLUMN last_delta_sequence");
    closeRouterDb();

    const stateColumns = new Set(
      (
        getDb().prepare("PRAGMA table_info(channel_backend_runtime_state)").all() as Array<{
          name: string;
        }>
      ).map((column) => column.name),
    );

    expect(stateColumns).toContain("last_delta_sequence");
  });

  it("emits ordered safe events and persists one canonical terminal assistant message", async () => {
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

    expect(
      readChannelRuntime({
        protocol: CHANNEL_RUNTIME_EVENTS_PROTOCOL,
        schemaVersion: CHANNEL_RUNTIME_EVENTS_SCHEMA_VERSION,
        requestId: "readback-a",
        binding: metadata.binding,
      }),
    ).toMatchObject({
      state: "completed",
      lastSequence: 4,
      assistantMessageId: runtime?.assistantMessageId,
    });
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
      "turn.assistant_delta",
      "turn.assistant_message",
      "turn.assistant_message",
      "turn.terminal_output",
    ]);
    expect(events[1]).toMatchObject({
      payload: {
        phase: "commentary",
        text: "Checking",
      },
    });
    expect(events[2]).toMatchObject({
      payload: {
        phase: "commentary",
        content: [{ type: "text", text: "Checking the durable state." }],
      },
    });
    expect(events[3]).toMatchObject({
      payload: {
        phase: "final_answer",
        content: [{ type: "text", text: "Final answer only." }],
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

async function acceptedMetadata(): Promise<ChannelBackendPromptMetadata> {
  const result = await acceptChannelIngress(ingressRequest());
  if (!result.binding) throw new Error("fixture ingress was rejected");
  return {
    protocol: CHANNEL_BACKEND_PROTOCOL,
    schemaVersion: CHANNEL_BACKEND_SCHEMA_VERSION,
    ingressRequestId: "request-a",
    correlationId: "request-a",
    binding: result.binding,
    target: {
      channelKind: "custom",
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
    agentMode: "sentinel",
  };
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
