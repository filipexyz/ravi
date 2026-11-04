import { describe, expect, it, spyOn } from "bun:test";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import type { ChannelOutputEnvelope } from "../channels/backend.js";
import type { RuntimeHostStreamingSession, RuntimeUserMessage } from "./host-session.js";
import type { ChannelBackendPromptMetadata, ResponseMessage } from "./message-types.js";
import type { ModelBrokerAttemptFeedback } from "./model-broker.js";
import type { RuntimeCapabilities, RuntimeEvent, RuntimeSessionHandle } from "./types.js";

// Opt-in retained integration suite. Discovery without the dedicated memory
// preload skips every case and provides NO coverage or validation. Run each
// selected case in a fresh, network-denied process with retained evidence.
const retainedConfigured = Boolean(process.env.PR795_RETAINED_STATE || process.env.PR795_RUN_EVIDENCE);
let fixtureSequence = 0;

/** Rejects an unguarded invocation before importing any module that opens Ravi state. */
async function retainedStateRoot(): Promise<string> {
  const state = process.env.PR795_RETAINED_STATE;
  const evidence = process.env.PR795_RUN_EVIDENCE;
  if (!state || !evidence || !isAbsolute(state) || !isAbsolute(evidence)) {
    throw new Error("This suite requires absolute retained state/evidence roots and the memory preload");
  }
  if (process.env.RAVI_STATE_DIR !== state || homedir() !== join(state, "home")) {
    throw new Error("The retained-memory preload must isolate Ravi state and homedir before runtime imports");
  }
  const { Database } = await import("bun:sqlite");
  const probe = new Database(":memory:");
  const anchor = relative(state, probe.filename);
  if (!anchor || anchor === ".." || anchor.startsWith(`..${sep}`) || isAbsolute(anchor)) {
    throw new Error("SQLite preload missing: expected a retained synthetic identity anchor");
  }
  // The filename alias is an anchor; SQLite's own database list must still
  // report a memory database. Leave this connection open for preload snapshots.
  expect(probe.query("PRAGMA database_list").all()).toEqual([{ seq: 0, name: "main", file: "" }]);
  return state;
}

/** Loads the real host, queue, coordinator and channel projection only after the isolation gate. */
async function dependencies() {
  return {
    backend: await import("../channels/backend.js"),
    runtimeEvents: await import("../channels/runtime-events.js"),
    origin: await import("../channels/slack/automatic-output-origin.js"),
    manifest: await import("../channels/slack/automatic-terminal-manifest.js"),
    driver: await import("../channels/slack/driver.js"),
    config: await import("../config-store.js"),
    history: await import("../db.js"),
    bus: await import("../nats.js"),
    router: await import("../router/router-db.js"),
    sessions: await import("../router/sessions.js"),
    host: await import("./host-event-loop.js"),
    hostSession: await import("./host-session.js"),
    queue: await import("./delivery-queue.js"),
    recovery: await import("./crash-recovery.js"),
    recoveryStore: await import("./crash-recovery-store.js"),
    trace: await import("../session-trace/runtime-trace.js"),
    brokers: await import("./model-broker-registry.js"),
    dispatcher: await import("./session-dispatcher.js"),
  };
}

const capabilities: RuntimeCapabilities = {
  runtimeControl: { supported: false, operations: [] },
  dynamicTools: { mode: "none" },
  execution: { mode: "sdk" },
  sessionState: { mode: "provider-session-id" },
  usage: { semantics: "terminal-event" },
  tools: { permissionMode: "ravi-host", accessRequirement: "tool_and_executable", supportsParallelCalls: false },
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

/** Canonical provider final; channel text is asserted independently after projection. */
function final(text: string): RuntimeEvent {
  return { type: "assistant.message", text, metadata: { item: { id: "final", phase: "final_answer" } } };
}

/**
 * Creates accepted synthetic ingress and a real message generator. Only external
 * NATS delivery and provider events are supplied by the fixture; replay safety,
 * queue selection, terminal transactions and Slack manifests remain real.
 */
async function fixture(options: { senderKind?: "bot" | "user"; provider?: string; durable?: boolean } = {}) {
  const state = await retainedStateRoot();
  const d = await dependencies();
  const id = `direct-${++fixtureSequence}`;
  const senderKind = options.senderKind ?? "bot";
  const provider = options.provider ?? "claude";
  const agentId = `agent-${id}`;
  const instanceId = `local-${id}`;
  const chatId = `CDIRECT${fixtureSequence}`;
  const threadId = "1.000001";
  const sessionName = `session-${id}`;
  const sessionKey = `agent:${agentId}:slack:${instanceId}:group:${chatId}`;
  const requestId = `request-${id}`;
  const target = { channelKind: "slack", connectionId: instanceId, conversationId: `${chatId}~${threadId}` };
  d.router.dbCreateAgent({ id: agentId, name: "Synthetic direct interrupt agent", cwd: state });
  d.router.dbUpsertChannel({ name: instanceId, provider: "slack", credentialConnection: `installation-${id}` });
  d.config.configStore.refresh();
  d.backend.setChannelBackendPromptPublisherForTests(async () => {});
  const chat = d.router.dbUpsertChat({ channel: "slack", instanceId, platformChatId: chatId, chatType: "group" });
  const message = d.router.dbUpsertChatMessage({
    chatId: chat.id,
    channel: "slack",
    instanceId,
    providerMessageId: threadId,
    rawChatId: chatId,
    actorType: "unknown",
    rawProvenance: { source: "slack.socket_mode", senderKind },
  });
  d.sessions.getOrCreateSession(sessionKey, agentId, state, {
    name: sessionName,
    channel: "slack",
    accountId: instanceId,
    chatType: "group",
    lastChannel: "slack",
    lastAccountId: instanceId,
    lastTo: chatId,
  });
  const source = {
    channel: "slack",
    accountId: instanceId,
    instanceId,
    chatId,
    threadId,
    canonicalChatId: chat.id,
    sourceMessageId: threadId,
  };
  const accepted = await d.backend.acceptResolvedChannelIngress({
    request: {
      protocol: "ravi.channel.backend",
      schemaVersion: 1,
      requestId,
      idempotencyKey: `input-${id}`,
      localActorId: `unknown-${id}`,
      channelInstanceId: instanceId,
      agentId,
      external: { ...target, senderId: senderKind === "bot" ? "BSYNTHETIC" : "USYNTHETIC", messageId: threadId },
      content: [{ type: "text", text: "Synthetic independent notice" }],
      receivedAt: "2026-11-03T12:00:00.000Z",
    },
    canonical: { chatId: chat.id, messageId: message.canonicalMessageId },
    session: { key: sessionKey, name: sessionName },
    prompt: { prompt: "Synthetic independent notice", context: {}, source },
  });
  if (!accepted.binding) throw new Error("Synthetic channel ingress rejected");
  const metadata: ChannelBackendPromptMetadata = {
    protocol: "ravi.channel.backend",
    schemaVersion: 1,
    ingressRequestId: requestId,
    correlationId: requestId,
    binding: accepted.binding,
    target,
  };
  const acceptedMetadata = structuredClone(metadata);
  const session = d.sessions.resolveSession(metadata.binding.sessionId)!;
  d.sessions.attachChatToSession({ sessionKey, chatId: chat.id, setOutputTarget: true });
  const agent = d.router.dbGetAgent(agentId)!;
  const outputs: ChannelOutputEnvelope[] = [];
  const responses: ResponseMessage[] = [];
  const physicalEvents: Array<{ type: string }> = [];
  const brokerReports: ModelBrokerAttemptFeedback[] = [];
  const abortEvents: Array<Record<string, unknown>> = [];
  const handoffs: Array<{ ids: string[]; metadata?: ChannelBackendPromptMetadata; continuationId?: string }> = [];
  const attemptIds: string[] = [];
  const restarts: Array<{ sessionName: string; reason: string }> = [];
  let emissionHook: (() => Promise<void>) | undefined;
  let brokerHook: (() => Promise<void>) | undefined;
  const emit = spyOn(d.bus.nats, "emit").mockImplementation(async (topic, data) => {
    if (topic === `ravi.session.${sessionName}.response`) responses.push(data as ResponseMessage);
  });
  const unbindRuntimeSink = d.runtimeEvents.channelRuntimeEventSinks.register(target, { async emit() {} });
  const unbindOutputSink = d.backend.channelOutputSinks.register(target, {
    async emit(output) {
      if (senderKind === "bot") {
        const context = d.origin.resolveSlackAutomaticOutputContextFromBinding(acceptedMetadata.binding)!;
        const manifest = d.manifest.getSlackAutomaticTerminalManifest(
          d.manifest.slackAutomaticTerminalResponseId(context.turnId, context.target),
        );
        expect(manifest).not.toBeNull();
        expect(
          d.manifest.assertSlackAutomaticTerminalPart(manifest!, {
            type: "text",
            text: d.driver.renderSlackBackendOutput(output),
          }),
        ).toBe(`${manifest!.responseId}:text`);
      }
      outputs.push(output);
    },
  });
  let interruptCalls = 0;
  const interrupt = async () => {
    interruptCalls++;
  };
  const streaming: RuntimeHostStreamingSession = {
    agentId,
    queryHandle: { provider, events: (async function* () {})(), interrupt },
    starting: false,
    abortController: new AbortController(),
    pushMessage: null,
    pendingWake: false,
    pendingMessages: [],
    currentChannelBackend: metadata,
    currentSource: source,
    currentModel: "test",
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
    toolEffectFence: d.hostSession.resolveRuntimeToolEffectFence(provider, capabilities.tools.permissionMode),
  };
  const active = d.queue.createQueuedRuntimeUserMessage({
    prompt: "Synthetic independent notice",
    source,
    _channelBackend: metadata,
  });
  streaming.pendingMessages = [active];
  const coordinator = options.durable
    ? new d.recovery.RuntimeCrashRecoveryCoordinator({ instanceId: `synthetic-${id}` })
    : undefined;
  coordinator?.start();
  const dispatcher = coordinator
    ? new d.dispatcher.RuntimeSessionDispatcher({
        instanceId: `synthetic-${id}`,
        maxConcurrentSessions: 1,
        interactiveReservedSessions: 0,
        crashRecovery: coordinator,
        safeEmit: async (_topic, data) => {
          abortEvents.push(structuredClone(data));
        },
        async notifyRuntimeRecoveryExhausted() {
          throw new Error("Synthetic abort must not start runtime recovery");
        },
        getConfigModel: () => "test",
      })
    : undefined;
  const stashedMessages = dispatcher?.stashedMessages ?? new Map<string, RuntimeUserMessage[]>();
  const streamingSessions = dispatcher?.streamingSessions ?? new Map<string, RuntimeHostStreamingSession>();
  streamingSessions.set(sessionName, streaming);
  const input = d.queue.createRuntimeMessageGenerator({
    sessionName,
    session: streaming,
    stashedMessages,
    beforeTurnStart: ({ deliverableMessages }) => {
      const launch = [...deliverableMessages].reverse().find((entry) => entry.launchPrompt)?.launchPrompt;
      if (!launch) throw new Error("Expected the actual queue launch envelope");
      streaming.currentChannelBackend = launch._channelBackend;
      streaming.currentSource = launch.source;
      streaming.currentTurnAuthority = d.queue.pickRuntimeTurnAuthorityEnvelope(launch);
      handoffs.push({
        ids: [...(streaming.currentTurnPendingIds ?? [])],
        metadata: structuredClone(launch._channelBackend),
        continuationId: streaming.currentTurnYieldContinuationId,
      });
      if (coordinator) {
        const trace = d.trace.recordAdapterRequestTrace({
          turnId: `${id}-physical-${handoffs.length}`,
          runId: `run-${id}`,
          sessionKey,
          sessionName,
          agentId,
          provider,
          model: "test",
          prompt: launch.prompt,
          systemPrompt: "Synthetic retained integration fixture",
          cwd: state,
          resume: false,
          fork: false,
          source: launch.source,
          deliveryBarrier: active.deliveryBarrier ?? "after_tool",
          hasHooks: false,
          pluginNames: [],
          mcpServerNames: [],
          hasRemoteSpawn: false,
          capabilitySummary: { ...capabilities },
        });
        if (!trace) throw new Error("The durable fixture requires the real recorded request blob");
        streaming.currentTraceTurnId = trace.turnId;
        streaming.currentTraceTurnStartedAt = trace.startedAt;
        streaming.currentTraceRequestBlobSha256 = trace.requestBlobSha256;
        streaming.currentTraceUserPromptSha256 = trace.userPromptSha256;
        streaming.currentTraceSystemPromptSha256 = trace.systemPromptSha256;
        streaming.currentTraceTurnTerminalRecorded = false;
        const attempt = coordinator.startTurnAttempt({
          turnId: trace.turnId,
          runId: `run-${id}`,
          sessionKey,
          sessionName,
          agentId,
          provider,
          model: "test",
          requestBlobSha256: trace.requestBlobSha256,
          userPromptSha256: trace.userPromptSha256,
          systemPromptSha256: trace.systemPromptSha256,
          originKind: "human",
          source: launch.source,
          deliveryBarrier: active.deliveryBarrier ?? "after_tool",
          pendingIds: [...(streaming.currentTurnPendingIds ?? [])],
        });
        streaming.currentCrashRecoveryAttemptId = attempt.attemptId;
        attemptIds.push(attempt.attemptId);
      }
    },
  });
  const brokerId = `retained-broker-${id}`;

  return {
    d,
    session,
    streaming,
    streamingSessions,
    stashedMessages,
    metadata: acceptedMetadata,
    active,
    input,
    outputs,
    responses,
    physicalEvents,
    brokerReports,
    abortEvents,
    handoffs,
    attemptIds,
    restarts,
    interruptCalls: () => interruptCalls,
    /** Uses the actual caller that assigns explicit_abort and releases runtime ownership. */
    abort() {
      if (!dispatcher) throw new Error("Real dispatcher abort requires the durable memory fixture");
      return dispatcher.abortSession(sessionName);
    },
    /** Reads the immutable accepted binding even when a queued envelope is deliberately mutated. */
    logical: () => d.router.dbGetChannelBackendRuntimeState(acceptedMetadata.binding.turnId),
    /** Reads the accepted bot's manifest without deriving identity from current mutable state. */
    manifest: () => {
      const context = d.origin.resolveSlackAutomaticOutputContextFromBinding(acceptedMetadata.binding);
      return context
        ? d.manifest.getSlackAutomaticTerminalManifest(
            d.manifest.slackAutomaticTerminalResponseId(context.turnId, context.target),
          )
        : null;
    },
    /** Injects races at the real awaited physical terminal emission, after host receipt. */
    onEmission(hook: () => Promise<void>) {
      emissionHook = hook;
    },
    /** Injects races inside the registered broker's real awaited feedback call. */
    onBroker(hook: () => Promise<void>) {
      brokerHook = hook;
      d.brokers.registerModelBroker(brokerId, () => ({
        id: brokerId,
        async resolveRoute() {
          throw new Error("Synthetic interruption fixture must not resolve a model route");
        },
        async reportAttempt(report) {
          brokerReports.push(structuredClone(report));
          await brokerHook?.();
          return { recorded: true, nextAction: "retain" };
        },
      }));
      streaming.currentRuntimeCredential = {
        attemptId: `attempt-${id}`,
        credentialId: `synthetic-${id}`,
        modelBrokerId: brokerId,
        modelBrokerLeaseId: `lease-${id}`,
        modelBrokerRuntimeId: `runtime-${id}`,
        modelBrokerSessionKey: sessionKey,
        modelBrokerTurnId: `turn-${id}`,
        label: "Synthetic broker fixture",
        fingerprint: "synthetic-no-secret",
        runtimeProvider: provider,
        authMethod: "model-broker",
        resolvedEnv: {},
        sensitiveEnvKeys: [],
        remoteForwardEnvKeys: [],
        bindings: [],
      };
    },
    /** Consumes canonical synthetic events through the real host event loop. */
    async run(events: AsyncIterable<RuntimeEvent>) {
      const runtimeSession: RuntimeSessionHandle = { provider, events, interrupt };
      streaming.queryHandle = runtimeSession;
      await d.host.runRuntimeEventLoop({
        runId: `run-${id}`,
        sessionName,
        session,
        agent,
        streaming,
        runtimeSession,
        runtimeCapabilities: capabilities,
        model: "test",
        instanceId: `synthetic-${id}`,
        defaultRuntimeProviderId: provider,
        streamingSessions,
        stashedMessages,
        crashRecovery: coordinator,
        safeEmit: async (_topic, data) => {
          if (typeof data.type === "string" && data.type.startsWith("turn.")) {
            physicalEvents.push({ type: data.type });
          }
          if (data.type === "turn.interrupted") await emissionHook?.();
        },
        restartStashedSession: async (restart) => {
          restarts.push(restart);
        },
        drainPendingStarts() {},
      });
    },
    /** Releases process-local handles only; the runner retains all filesystem evidence. */
    async release() {
      // In-memory registrations/timers only. Every file, DB anchor and snapshot
      // is retained; no teardown hook or physical deletion is installed.
      await input.return(undefined);
      emit.mockRestore();
      unbindRuntimeSink();
      unbindOutputSink();
      d.backend.setChannelBackendPromptPublisherForTests();
      if (brokerHook) d.brokers.unregisterModelBroker(brokerId);
      if (coordinator?.acceptingDeliveries) coordinator.stopGracefully("retained_test_complete");
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Advances the actual generator, asserting this is direct replay without a yield continuation. */
async function handoff(f: Fixture): Promise<void> {
  expect((await f.input.next()).done).toBe(false);
  expect(f.streaming.currentTurnYieldContinuationId).toBeUndefined();
}

/** Asserts the accepted logical request has not acquired a terminal or manifest. */
function expectOpen(f: Fixture): void {
  expect([undefined, "accepted", "running"]).toContain(f.logical()?.state);
  expect(f.manifest()).toBeNull();
}

/** Asserts the physical terminal and accepted logical cancellation independently. */
function expectCancelled(f: Fixture): void {
  expect(f.streaming.currentCrashRecoveryTerminal?.status).toBe("interrupted");
  expect(f.logical()?.state).toBe("interrupted");
  expect(f.manifest()?.kind).toBe("cancelled");
  expect(f.outputs).toEqual([]);
  expect(f.handoffs).toHaveLength(1);
}

/** A distinct owner never inherits the old generator's terminal resolver or abort controller. */
function replaceOwner(f: Fixture): RuntimeHostStreamingSession {
  const replacement: RuntimeHostStreamingSession = {
    ...f.streaming,
    pendingMessages: [],
    starting: true,
    done: false,
    turnActive: false,
    currentChannelBackend: undefined,
    currentCrashRecoveryTerminal: undefined,
    currentCrashRecoveryAttemptId: undefined,
    currentTurnPendingIds: undefined,
    onTurnComplete: null,
    pushMessage: null,
    abortController: new AbortController(),
  };
  f.streamingSessions.set(f.session.name!, replacement);
  return replacement;
}

describe.skipIf(!retainedConfigured)("direct interrupted retention / retained memory host", () => {
  for (const senderKind of ["bot", "user"] as const) {
    it(`re-yields the accepted ${senderKind} envelope and projects its complete final`, async () => {
      const f = await fixture({ senderKind });
      const answer = "Complete legitimate final\n1. First fact\n2. Second fact";
      let firstTerminal: RuntimeHostStreamingSession["currentCrashRecoveryTerminal"];
      try {
        await f.run(
          (async function* () {
            await handoff(f);
            const envelope = structuredClone(f.active.launchPrompt);
            yield { type: "turn.interrupted" };
            firstTerminal = f.streaming.currentCrashRecoveryTerminal;
            const terminalSnapshot = structuredClone(firstTerminal);
            expect(firstTerminal?.status).toBe("interrupted");
            expectOpen(f);
            expect(f.outputs).toEqual([]);
            expect(f.streaming.pendingMessages).toEqual([f.active]);
            await handoff(f);
            expect(f.active.launchPrompt).toEqual(envelope);
            expect(f.streaming.currentChannelBackend).toEqual(f.metadata);
            expect(f.handoffs[1]?.ids).toEqual(f.handoffs[0]?.ids);
            yield final(answer);
            yield { type: "turn.complete", usage: { inputTokens: 0, outputTokens: 0 } };
            expect(firstTerminal).toEqual(terminalSnapshot);
          })(),
        );
        expect(f.handoffs).toHaveLength(2);
        expect(f.physicalEvents).toEqual([{ type: "turn.interrupted" }, { type: "turn.complete" }]);
        expect(firstTerminal?.status).toBe("interrupted");
        expect(f.streaming.currentCrashRecoveryTerminal?.status).toBe("complete");
        expect(f.logical()?.state).toBe("completed");
        expect(f.outputs).toHaveLength(1);
        expect(f.outputs[0]).toMatchObject({ kind: "assistant_message", binding: f.metadata.binding });
        expect(f.d.driver.renderSlackBackendOutput(f.outputs[0]!)).toBe(answer);
        expect(f.responses).toEqual([]);
        expect(
          f.d.history
            .getRecentHistory(f.session.name!, 20)
            .some((message) => message.role === "assistant" && message.content === answer),
        ).toBe(true);
        expect(f.manifest()?.kind ?? null).toBe(senderKind === "bot" ? "final_answer" : null);
      } finally {
        await f.release();
      }
    });
  }

  it("projects an ordinary final without interruption", async () => {
    const f = await fixture();
    try {
      await f.run(
        (async function* () {
          await handoff(f);
          yield final("Ordinary complete answer");
          yield { type: "turn.complete", usage: { inputTokens: 0, outputTokens: 0 } };
        })(),
      );
      expect(f.handoffs).toHaveLength(1);
      expect(f.logical()?.state).toBe("completed");
      expect(f.manifest()?.kind).toBe("final_answer");
      expect(f.outputs.map((output) => f.d.driver.renderSlackBackendOutput(output))).toEqual([
        "Ordinary complete answer",
      ]);
    } finally {
      await f.release();
    }
  });

  for (const fence of ["event-observed", "started-tool", "materialized-output", "mutated-input"] as const) {
    it(`refuses ${fence} replay and actually yields the unrelated successor`, async () => {
      const f = await fixture({ provider: fence === "event-observed" ? "codex" : "claude", durable: true });
      try {
        await f.run(
          (async function* () {
            await handoff(f);
            const successor = f.d.queue.createQueuedRuntimeUserMessage({ prompt: "Independent successor" });
            f.streaming.pendingMessages.push(successor);
            if (fence === "started-tool") {
              yield { type: "tool.started", toolUse: { id: "synthetic-tool", name: "read", input: {} } };
            }
            if (fence === "materialized-output") yield { type: "text.delta", text: "Partial unaccepted text" };
            if (fence === "mutated-input") f.streaming.currentTurnInputMutated = true;
            yield { type: "turn.interrupted" };
            expect(f.logical()?.state).toBe("interrupted");
            expect(f.manifest()?.kind).toBe("cancelled");
            expect(f.streaming.pendingMessages).toEqual([successor]);
            const physical = f.d.recoveryStore.getRuntimeTurnAttempt(f.attemptIds[0]!);
            expect(physical?.status).toBe("interrupted");
            expect(physical?.startedTool).toBe(fence === "started-tool");
            expect(physical?.materializedOutput).toBe(fence === "materialized-output");
            expect(f.streaming.currentCrashRecoveryTerminal?.inputMutated).toBe(fence === "mutated-input");
            await handoff(f);
            expect(f.handoffs[1]?.ids).toEqual([successor.pendingId!]);
            expect(f.streaming.currentChannelBackend).toBeUndefined();
            yield { type: "turn.complete", usage: { inputTokens: 0, outputTokens: 0 } };
          })(),
        );
        expect(f.outputs).toEqual([]);
        expect(f.logical()?.state).toBe("interrupted");
        expect(f.handoffs).toHaveLength(2);
      } finally {
        await f.release();
      }
    });
  }

  for (const selection of ["superseded", "successor-only"] as const) {
    it(`does not mistake ${selection} work for the original request`, async () => {
      const f = await fixture();
      try {
        await f.run(
          (async function* () {
            await handoff(f);
            const successor = f.d.queue.createQueuedRuntimeUserMessage({ prompt: "Independent successor" });
            f.streaming.pendingMessages = selection === "superseded" ? [f.active, successor] : [successor];
            f.streaming.currentTurnSuperseded = selection === "superseded";
            yield { type: "turn.interrupted" };
            expectCancelled(f);
            await handoff(f);
            expect(f.handoffs[1]?.ids).toEqual([successor.pendingId!]);
            expect(f.streaming.currentChannelBackend).toBeUndefined();
            yield { type: "turn.complete", usage: { inputTokens: 0, outputTokens: 0 } };
          })(),
        );
        expect(f.logical()?.state).toBe("interrupted");
        expect(f.outputs).toEqual([]);
      } finally {
        await f.release();
      }
    });
  }

  const bindingFields = ["channelInstanceId", "agentId", "chatId", "messageId", "sessionId", "turnId"] as const;
  const targetFields = ["channelKind", "connectionId", "conversationId"] as const;
  const envelopeMutations: Array<{ name: string; mutate: (message: RuntimeUserMessage) => void }> = [
    ...bindingFields.map((field) => ({
      name: `binding.${field}`,
      mutate: (message: RuntimeUserMessage) => {
        message.launchPrompt!._channelBackend!.binding[field] = `different-${field}`;
      },
    })),
    ...targetFields.map((field) => ({
      name: `target.${field}`,
      mutate: (message: RuntimeUserMessage) => {
        message.launchPrompt!._channelBackend!.target[field] = `different-${field}`;
      },
    })),
    {
      name: "ingressRequestId",
      mutate: (message) => {
        message.launchPrompt!._channelBackend!.ingressRequestId = "different-request";
      },
    },
    {
      name: "correlationId",
      mutate: (message) => {
        message.launchPrompt!._channelBackend!.correlationId = "different-correlation";
      },
    },
    {
      name: "prompt",
      mutate: (message) => {
        message.launchPrompt!.prompt = "Different accepted instruction";
      },
    },
    {
      name: "source",
      mutate: (message) => {
        message.launchPrompt!.source!.sourceMessageId = "different-source";
      },
    },
    {
      name: "authority",
      mutate: (message) => {
        message.launchPrompt!._bridgeTurnId = "different-authority";
      },
    },
    {
      name: "queue-content",
      mutate: (message) => {
        message.message.content = "Different provider instruction";
      },
    },
  ];
  for (const mutation of envelopeMutations) {
    it(`does not retain a reused pendingId after ${mutation.name} changes during terminal emission`, async () => {
      const f = await fixture();
      let changed = false;
      const originalId = f.active.pendingId;
      try {
        f.onEmission(async () => {
          await Promise.resolve();
          mutation.mutate(f.active);
          changed = true;
        });
        await f.run(
          (async function* () {
            await handoff(f);
            yield { type: "turn.interrupted" };
          })(),
        );
        expect(changed).toBe(true);
        expect(f.active.pendingId).toBe(originalId);
        expectCancelled(f);
      } finally {
        await f.release();
      }
    });
  }

  for (const missing of ["pending-id", "yielded-ids", "channel-envelope"] as const) {
    it(`does not infer retention from incomplete ${missing} identity`, async () => {
      const f = await fixture();
      try {
        f.onEmission(async () => {
          await Promise.resolve();
          if (missing === "pending-id") f.active.pendingId = undefined;
          if (missing === "channel-envelope") f.active.launchPrompt!._channelBackend = undefined;
        });
        await f.run(
          (async function* () {
            await handoff(f);
            // Missing handoff identity cannot be reconstructed from the latest
            // channel target or an arbitrary queued request.
            if (missing === "yielded-ids") f.streaming.currentTurnPendingIds = undefined;
            yield { type: "turn.interrupted" };
          })(),
        );
        expectCancelled(f);
      } finally {
        await f.release();
      }
    });
  }

  for (const boundary of ["before-terminal", "terminal-emission", "broker-await"] as const) {
    for (const change of ["explicit-abort", "owner-replaced", "owner-absent"] as const) {
      it(`rechecks ${change} at ${boundary}`, async () => {
        const f = await fixture({ durable: change === "explicit-abort" });
        let replacement: RuntimeHostStreamingSession | undefined;
        let changes = 0;
        const changeOwner = async () => {
          await Promise.resolve();
          changes++;
          if (change === "explicit-abort") {
            // The actual dispatcher supplies the positive cancellation reason
            // and removes the owner slot; no invented marker grants authority.
            expect(f.abort()).toBe(true);
          } else {
            if (change === "owner-replaced") replacement = replaceOwner(f);
            else f.streamingSessions.delete(f.session.name!);
            f.d.hostSession.shutdownRuntimeStreamingSession(f.streaming);
          }
        };
        try {
          if (boundary === "terminal-emission") f.onEmission(changeOwner);
          if (boundary === "broker-await") f.onBroker(changeOwner);
          await f.run(
            (async function* () {
              await handoff(f);
              if (boundary === "before-terminal") await changeOwner();
              yield { type: "turn.interrupted" };
            })(),
          );
          expect(changes).toBe(1);
          expect(f.handoffs).toHaveLength(1);
          expect(f.outputs).toEqual([]);
          if (boundary === "before-terminal") {
            // readNextRuntimeEvent ignores a returned provider terminal once
            // done=true. These controls do not claim the direct path ran or
            // constrain unrelated unterminated-turn logical projection.
            expect(f.physicalEvents).toEqual([]);
            expect(f.streaming.currentCrashRecoveryTerminal?.status).toBe(
              change === "explicit-abort" ? "aborted" : undefined,
            );
          } else {
            expect(f.streaming.currentCrashRecoveryTerminal?.status).toBe("interrupted");
            expect(f.physicalEvents).toEqual([{ type: "turn.interrupted" }]);
            if (change === "explicit-abort") expectCancelled(f);
            else expectOpen(f);
          }
          if (change === "explicit-abort") {
            expect(f.streaming.internalAbortReason).toBe("explicit_abort");
            expect(f.abortEvents).toHaveLength(1);
            expect(f.abortEvents[0]).toMatchObject({ type: "turn.interrupted", reason: "explicit_abort" });
            expect(f.interruptCalls()).toBeGreaterThan(0);
            expect((await f.input.next()).done).toBe(true);
          }
          if (replacement) {
            expect(f.streamingSessions.get(f.session.name!)).toBe(replacement);
            expect(replacement.starting).toBe(true);
            expect(replacement.done).toBe(false);
            expect(replacement.abortController.signal.aborted).toBe(false);
          }
          if (boundary === "broker-await") {
            expect(f.brokerReports).toHaveLength(1);
            expect(f.brokerReports[0]).toMatchObject({ outcome: "abandoned", effectState: "none" });
          }
        } finally {
          await f.release();
        }
      });
    }
  }

  for (const boundary of ["terminal-emission", "broker-await"] as const) {
    it(`does not grant absent-owner authority from user_interrupt at ${boundary}`, async () => {
      const f = await fixture();
      const closeWithoutExplicitWitness = async () => {
        await Promise.resolve();
        f.d.hostSession.shutdownRuntimeStreamingSession(f.streaming, "user_interrupt");
        f.streamingSessions.delete(f.session.name!);
      };
      try {
        if (boundary === "terminal-emission") f.onEmission(closeWithoutExplicitWitness);
        else f.onBroker(closeWithoutExplicitWitness);
        await f.run(
          (async function* () {
            await handoff(f);
            yield { type: "turn.interrupted" };
          })(),
        );
        expect(f.streaming.currentCrashRecoveryTerminal?.status).toBe("interrupted");
        expect(f.streaming.internalAbortReason).toBe("user_interrupt");
        expect(f.d.hostSession.isExplicitLocalRuntimeAbort(f.streaming.internalAbortReason)).toBe(false);
        expect(f.handoffs).toHaveLength(1);
        expect(f.outputs).toEqual([]);
        expectOpen(f);
      } finally {
        await f.release();
      }
    });
  }

  it("projects cancellation when the retained generator is physically closed under the original owner", async () => {
    const f = await fixture();
    try {
      f.onEmission(async () => {
        f.streaming.done = true;
        f.streaming.abortController.abort();
      });
      await f.run(
        (async function* () {
          await handoff(f);
          yield { type: "turn.interrupted" };
        })(),
      );
      expect(f.streaming.internalAbortReason).toBeUndefined();
      expectCancelled(f);
    } finally {
      await f.release();
    }
  });

  for (const loseOwner of [false, true]) {
    it(`preserves the physical terminal when emission rejects (${loseOwner ? "owner lost" : "original owner"})`, async () => {
      const f = await fixture();
      const failure = new Error("Synthetic interrupted terminal emission rejection");
      let replacement: RuntimeHostStreamingSession | undefined;
      try {
        f.onEmission(async () => {
          await Promise.resolve();
          if (loseOwner) replacement = replaceOwner(f);
          throw failure;
        });
        await expect(
          f.run(
            (async function* () {
              await handoff(f);
              yield { type: "turn.interrupted" };
            })(),
          ),
        ).rejects.toBe(failure);
        expect(f.streaming.currentCrashRecoveryTerminal?.status).toBe("interrupted");
        expect(f.physicalEvents).toEqual([{ type: "turn.interrupted" }]);
        expect(f.handoffs).toHaveLength(1);
        expect(f.outputs).toEqual([]);
        if (loseOwner) {
          expectOpen(f);
          expect(f.streamingSessions.get(f.session.name!)).toBe(replacement);
          expect(replacement?.done).toBe(false);
        } else {
          expectCancelled(f);
        }
        expect((await f.input.next()).done).toBe(true);
      } finally {
        await f.release();
      }
    });
  }
});
