import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { configStore } from "../config-store.js";
import { getRecentHistory } from "../db.js";
import { nats } from "../nats.js";
import {
  dbCreateAgent,
  dbGetAgent,
  dbGetChannelBackendRuntimeState,
  dbUpsertChannel,
  dbUpsertChat,
  dbUpsertChatMessage,
  getDb,
} from "../router/router-db.js";
import { attachChatToSession, getOrCreateSession, resolveSession } from "../router/sessions.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  acceptResolvedChannelIngress,
  channelOutputSinks,
  setChannelBackendPromptPublisherForTests,
  type ChannelOutputEnvelope,
} from "../channels/backend.js";
import { channelRuntimeEventSinks } from "../channels/runtime-events.js";
import { resolveSlackAutomaticOutputContextFromBinding } from "../channels/slack/automatic-output-origin.js";
import {
  assertSlackAutomaticTerminalPart,
  getSlackAutomaticTerminalManifest,
  slackAutomaticTerminalResponseId,
} from "../channels/slack/automatic-terminal-manifest.js";
import { renderSlackBackendOutput } from "../channels/slack/driver.js";
import { runRuntimeEventLoop } from "./host-event-loop.js";
import {
  resolveRuntimeToolEffectFence,
  type RuntimeHostStreamingSession,
  type RuntimeUserMessage,
} from "./host-session.js";
import {
  createQueuedRuntimeUserMessage,
  createRuntimeMessageGenerator,
  pickRuntimeTurnAuthorityEnvelope,
} from "./delivery-queue.js";
import type { ChannelBackendPromptMetadata, ResponseMessage } from "./message-types.js";
import type { RuntimeCapabilities, RuntimeEvent, RuntimeSessionHandle } from "./types.js";

let stateDir: string | null = null;
const cleanups: Array<() => void> = [];

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("slack-automatic-terminal-host-");
  dbCreateAgent({ id: "agent-a", name: "Agent A", cwd: stateDir });
  dbUpsertChannel({ name: "local", provider: "slack", credentialConnection: "installation-a" });
  configStore.refresh();
  setChannelBackendPromptPublisherForTests(async () => {});
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  setChannelBackendPromptPublisherForTests();
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

async function fixture(
  senderKind: "bot" | "user" = "bot",
  failSink?: "runtime" | "output",
  provider = "claude",
  channelKind = "slack",
) {
  if (channelKind !== "slack") {
    dbUpsertChannel({ name: "local", provider: channelKind });
    configStore.refresh();
  }
  const sessionKey = `agent:agent-a:${channelKind}:local:group:C123`;
  const threadId = channelKind === "slack" ? "1.000001" : undefined;
  const chat = dbUpsertChat({ channel: channelKind, instanceId: "local", platformChatId: "C123", chatType: "group" });
  const message = dbUpsertChatMessage({
    chatId: chat.id,
    channel: channelKind,
    instanceId: "local",
    providerMessageId: "1.000001",
    rawChatId: "C123",
    actorType: "unknown",
    rawProvenance: { source: channelKind === "slack" ? "slack.socket_mode" : "test-native", senderKind },
  });
  const target = { channelKind, connectionId: "local", conversationId: threadId ? `C123~${threadId}` : "C123" };
  getOrCreateSession(sessionKey, "agent-a", stateDir!, {
    name: "terminal-session",
    channel: channelKind,
    accountId: "local",
    chatType: "group",
    lastChannel: channelKind,
    lastAccountId: "local",
    lastTo: "C123",
  });
  const result = await acceptResolvedChannelIngress({
    request: {
      protocol: "ravi.channel.backend",
      schemaVersion: 1,
      requestId: "request-a",
      idempotencyKey: "input-a",
      localActorId: "unknown-a",
      channelInstanceId: "local",
      agentId: "agent-a",
      external: { ...target, senderId: "B123", messageId: "1.000001" },
      content: [{ type: "text", text: "Independent channel notice" }],
      receivedAt: "2026-11-03T12:00:00.000Z",
    },
    canonical: { chatId: chat.id, messageId: message.canonicalMessageId },
    session: { key: sessionKey, name: "terminal-session" },
    prompt: {
      prompt: "Independent channel notice",
      context: {},
      source: {
        channel: channelKind,
        accountId: "local",
        instanceId: "local",
        chatId: "C123",
        ...(threadId ? { threadId } : {}),
        canonicalChatId: chat.id,
        sourceMessageId: "1.000001",
      },
    },
  });
  if (!result.binding) throw new Error("Fixture ingress rejected");
  const metadata: ChannelBackendPromptMetadata = {
    protocol: "ravi.channel.backend",
    schemaVersion: 1,
    ingressRequestId: "request-a",
    correlationId: "request-a",
    binding: result.binding,
    target,
  };
  const session = resolveSession(metadata.binding.sessionId)!;
  attachChatToSession({ sessionKey: session.sessionKey, chatId: chat.id, setOutputTarget: true });
  const agent = dbGetAgent("agent-a")!;
  const responses: ResponseMessage[] = [];
  const outputs: ChannelOutputEnvelope[] = [];
  let safeEmitHook: ((topic: string, data: unknown) => Promise<void>) | undefined;
  let runtimeSinkHook:
    | ((event: Parameters<Parameters<typeof channelRuntimeEventSinks.register>[1]["emit"]>[0]) => Promise<void>)
    | undefined;
  const emit = spyOn(nats, "emit").mockImplementation(async (topic, data) => {
    if (topic === `ravi.session.${session.name}.response`) responses.push(data as ResponseMessage);
  });
  cleanups.push(() => emit.mockRestore());
  cleanups.push(
    channelRuntimeEventSinks.register(target, {
      async emit(event) {
        await runtimeSinkHook?.(event);
        if (failSink === "runtime" && event.kind === "turn.terminal_output") throw new Error("fixture runtime sink");
      },
    }),
  );
  cleanups.push(
    channelOutputSinks.register(target, {
      async emit(output) {
        if (failSink === "output") throw new Error("fixture output sink");
        if (channelKind === "slack" && senderKind === "bot") {
          const context = resolveSlackAutomaticOutputContextFromBinding(metadata.binding)!;
          const manifest = getSlackAutomaticTerminalManifest(
            slackAutomaticTerminalResponseId(context.turnId, context.target),
          );
          expect(manifest).not.toBeNull();
          expect(
            assertSlackAutomaticTerminalPart(manifest!, { type: "text", text: renderSlackBackendOutput(output) }),
          ).toBe(`${manifest!.responseId}:text`);
        }
        outputs.push(output);
      },
    }),
  );
  const streaming: RuntimeHostStreamingSession = {
    agentId: "agent-a",
    queryHandle: { provider, events: (async function* () {})(), async interrupt() {} },
    starting: false,
    abortController: new AbortController(),
    pushMessage: null,
    pendingWake: false,
    pendingMessages: [],
    currentChannelBackend: metadata,
    currentSource: {
      channel: channelKind,
      accountId: "local",
      instanceId: "local",
      chatId: "C123",
      ...(threadId ? { threadId } : {}),
      canonicalChatId: chat.id,
    },
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
  };
  const stashedMessages = new Map<string, RuntimeUserMessage[]>();
  const streamingSessions = new Map([[session.name!, streaming]]);
  const restarts: Array<{ sessionName: string; reason: string }> = [];
  const run = async (events: AsyncIterable<RuntimeEvent>, activeStreaming = streaming) => {
    const runtimeSession: RuntimeSessionHandle = { provider, events, async interrupt() {} };
    activeStreaming.queryHandle = runtimeSession;
    await runRuntimeEventLoop({
      runId: "run-a",
      sessionName: session.name!,
      session,
      agent,
      streaming: activeStreaming,
      runtimeSession,
      runtimeCapabilities: capabilities,
      model: "test",
      instanceId: "test",
      defaultRuntimeProviderId: provider,
      streamingSessions,
      stashedMessages,
      safeEmit: async (topic, data) => {
        await safeEmitHook?.(topic, data);
      },
      restartStashedSession: async (input) => {
        restarts.push(input);
      },
      drainPendingStarts() {},
    });
  };
  return {
    metadata,
    session,
    streaming,
    responses,
    outputs,
    stashedMessages,
    streamingSessions,
    restarts,
    run,
    setSafeEmitHook: (hook: typeof safeEmitHook) => {
      safeEmitHook = hook;
    },
    setRuntimeSinkHook: (hook: typeof runtimeSinkHook) => {
      runtimeSinkHook = hook;
    },
  };
}

import { processChannelOutboundJob } from "../channels/outbound-consumer.js";
import {
  buildChannelTextOutboundJob,
  buildChannelOutboundJobFromResponse,
  type ChannelOutboundJob,
} from "../channels/outbound-stream.js";
import { getChannelOutboundReceipt } from "../channels/outbound-receipts.js";
import { createChannelBackendAutomaticOutputOrigin } from "../channels/slack/automatic-output-origin.js";
import {
  getSlackAutomaticOutputDecision,
  reserveSlackAutomaticOutput,
} from "../channels/slack/automatic-output-circuit.js";
import { decodeSlackBackendConversationId } from "../channels/slack/socket-mode.js";

function final(text = "Recovered complete answer"): RuntimeEvent {
  return { type: "assistant.message", text, metadata: { item: { id: "final", phase: "final_answer" } } };
}

/** Real queue/stash handoff; only the builder's beforeTurnStart bridge is modeled. */
async function startQueuedTurn(f: Awaited<ReturnType<typeof fixture>>, restart = false) {
  if (restart) {
    f.streamingSessions.set(f.session.name!, f.streaming);
    // A restarted launcher begins with an empty pending queue and resumes the
    // stashed atoms. Do not touch backend state or the prior terminal latch.
    Object.assign(f.streaming, {
      pendingMessages: [],
      done: false,
      interrupted: false,
      turnActive: false,
      pendingAbort: false,
      abortController: new AbortController(),
    });
  }
  const generator = createRuntimeMessageGenerator({
    sessionName: f.session.name!,
    session: f.streaming,
    stashedMessages: f.stashedMessages,
    beforeTurnStart: ({ deliverableMessages }) => {
      const prompt = [...deliverableMessages].reverse().find((message) => message.launchPrompt)?.launchPrompt;
      expect(prompt).toBeDefined();
      // Matches runtime-request-builder.ts beforeTurnStart; no inference from
      // mutable latest-source state and no reconstruction of a missing binding.
      f.streaming.currentChannelBackend = prompt!._channelBackend;
      f.streaming.currentSource = prompt!.source;
      f.streaming.currentTurnAuthority = pickRuntimeTurnAuthorityEnvelope(prompt);
    },
  });
  expect((await generator.next()).done).toBe(false);
  return generator;
}

function seedCooldown(scope: string, now: number) {
  for (let i = 0; i < 5; i++)
    reserveSlackAutomaticOutput({
      idempotencyKey: `prior-${i}`,
      requestFingerprint: `fp-${i}`,
      scope,
      sourceId: `source-${i}`,
      sourceReceivedAt: now,
      now,
    });
  const decision = getSlackAutomaticOutputDecision("prior-4");
  expect(decision?.status).toBe("suppressed");
  return decision;
}

function nativeJob(output: ChannelOutputEnvelope): ChannelOutboundJob {
  const destination = decodeSlackBackendConversationId(output.target.conversationId);
  return buildChannelTextOutboundJob({
    requestId: `channel-output:${output.outputId}`,
    sessionName: output.binding.sessionId,
    emitId: output.outputId,
    idempotencyKey: output.outputId,
    target: {
      channel: "slack",
      accountId: output.target.connectionId,
      instanceId: output.target.connectionId,
      chatId: destination.channelId,
      ...(destination.threadTs ? { threadId: destination.threadTs } : {}),
      canonicalChatId: output.binding.chatId,
    },
    text: renderSlackBackendOutput(output),
    format: "markdown",
    responsePhase: output.kind === "assistant_message" ? "final_answer" : "safe_error",
    automatic: createChannelBackendAutomaticOutputOrigin(output.binding),
  });
}

async function consume(jobs: ChannelOutboundJob[], now: number, channelId = "slack") {
  const sends: string[] = [];
  const results = [];
  for (const job of jobs)
    results.push(
      await processChannelOutboundJob(job, {
        deliveries: [
          {
            channelId,
            supports: () => true,
            deliverText: async (request) => {
              sends.push(request.text);
              return { provider: channelId, platformMessageId: "1.555" };
            },
          },
        ],
        emitEvent: async () => {},
        flushNats: async () => {},
        recordDeliveryTrace: () => null,
        persistDeliveredMessage: () => ({}),
        knowledgeGuard: () => null,
        now: () => now,
      }),
    );
  return { sends, results };
}

describe("native Slack context recovery keeps logical output ownership", () => {
  for (const cooldown of [false, true]) {
    it(`preserves the recovered Claude final with ${cooldown ? "an open cooldown" : "an available allowance"}`, async () => {
      const f = await fixture("bot", undefined, "claude");
      f.streaming.toolEffectFence = resolveRuntimeToolEffectFence("claude", capabilities.tools.permissionMode);
      expect(f.streaming.toolEffectFence).toBe("host_write_ahead");
      const context = resolveSlackAutomaticOutputContextFromBinding(f.metadata.binding)!;
      const now = Date.now();
      const priorDecision = cooldown ? seedCooldown(context.scope, now) : null;
      f.streaming.pendingMessages = [
        createQueuedRuntimeUserMessage({
          prompt: "Independent bot notice",
          _channelBackend: f.metadata,
          source: f.streaming.currentSource,
        }),
      ];
      const initial = await startQueuedTurn(f);
      await f.run(
        (async function* () {
          yield { type: "turn.failed", error: "context window exhausted", recoverable: false };
        })(),
      );
      await initial.return(undefined);
      const recovered = f.stashedMessages.get(f.session.name!)?.[0];
      expect(recovered?.launchPrompt?._channelBackend).toEqual(f.metadata);
      const failedPhysicalTurn = f.streaming.currentCrashRecoveryTerminal;
      expect(failedPhysicalTurn?.status).toBe("failed");
      const responseId = slackAutomaticTerminalResponseId(context.turnId, context.target);
      const prematureManifest = getSlackAutomaticTerminalManifest(responseId);
      const prematureOutputs = f.outputs.length;
      const resumed = await startQueuedTurn(f, true);
      expect(f.streaming.currentChannelBackend).toEqual(f.metadata);
      await f.run(
        (async function* () {
          yield final();
          yield { type: "turn.complete", usage: { inputTokens: 0, outputTokens: 0 } };
        })(),
      );
      await resumed.return(undefined);
      // The production generator legitimately begins a new physical turn. The
      // old failed snapshot is unchanged; no test resets logical backend state.
      expect(failedPhysicalTurn?.status).toBe("failed");
      const manifest = getSlackAutomaticTerminalManifest(responseId);
      const delivered = await consume(f.outputs.map(nativeJob), now + 1);
      console.log(
        "RECOVERY_DESIRED_OBSERVATION",
        JSON.stringify({
          cooldown,
          bindingPreserved: !!recovered?.launchPrompt?._channelBackend,
          prematureManifest: prematureManifest?.kind ?? null,
          prematureOutputs,
          finalManifest: manifest?.kind,
          nativeKinds: f.outputs.map((output) => output.kind),
          legacyResponses: f.responses.length,
          consumerStatuses: delivered.results.map((result) => result.status),
          sends: delivered.sends.length,
        }),
      );
      expect(prematureManifest).toBeNull();
      expect(prematureOutputs).toBe(0);
      expect(f.outputs).toHaveLength(1);
      expect(f.outputs[0]?.kind).toBe("assistant_message");
      expect(renderSlackBackendOutput(f.outputs[0]!)).toBe("Recovered complete answer");
      expect(manifest?.kind).toBe("final_answer");
      expect(f.responses).toHaveLength(0);
      expect(delivered.sends).toHaveLength(cooldown ? 0 : 1);
      expect(delivered.results[0]?.status).toBe(cooldown ? "dropped" : "delivered");
      const decision = getSlackAutomaticOutputDecision(responseId);
      expect(decision?.status).toBe(cooldown ? "suppressed" : "allowed");
      if (cooldown) {
        expect(getSlackAutomaticOutputDecision("prior-4")).toEqual(priorDecision);
        const receipt = getChannelOutboundReceipt(`${responseId}:text`);
        expect(receipt?.state).toBe("suppressed");
        const replay = await consume([nativeJob(f.outputs[0]!)], now + 600_001);
        expect(replay.sends).toHaveLength(0);
        expect(replay.results[0]?.status).toBe("dropped");
        expect(getSlackAutomaticOutputDecision(responseId)).toEqual(decision);
      }
    });
  }

  it("preserves a native human final after the same context recovery", async () => {
    const f = await fixture("user", undefined, "claude");
    f.streaming.toolEffectFence = resolveRuntimeToolEffectFence("claude", capabilities.tools.permissionMode);
    f.streaming.pendingMessages = [
      createQueuedRuntimeUserMessage({
        prompt: "Human notice",
        _channelBackend: f.metadata,
        source: f.streaming.currentSource,
      }),
    ];
    const initial = await startQueuedTurn(f);
    await f.run(
      (async function* () {
        yield { type: "turn.failed", error: "context window exhausted", recoverable: false };
      })(),
    );
    await initial.return(undefined);
    expect(f.stashedMessages.get(f.session.name!)?.[0]?.launchPrompt?._channelBackend).toEqual(f.metadata);
    expect(f.outputs).toHaveLength(0);
    const resumed = await startQueuedTurn(f, true);
    await f.run(
      (async function* () {
        yield final("Recovered human answer");
        yield { type: "turn.complete", usage: { inputTokens: 0, outputTokens: 0 } };
      })(),
    );
    await resumed.return(undefined);
    expect(f.outputs).toHaveLength(1);
    expect(f.outputs[0]?.kind).toBe("assistant_message");
    expect(f.responses).toHaveLength(0);
    expect((await consume(f.outputs.map(nativeJob), Date.now())).sends).toEqual(["Recovered human answer"]);
  });

  it("preserves a non-Slack native binding and its complete recovered final", async () => {
    const f = await fixture("bot", undefined, "claude", "test-native");
    f.streaming.toolEffectFence = resolveRuntimeToolEffectFence("claude", capabilities.tools.permissionMode);
    expect(resolveSlackAutomaticOutputContextFromBinding(f.metadata.binding)).toBeNull();
    f.streaming.pendingMessages = [
      createQueuedRuntimeUserMessage({
        prompt: "Generic native notice",
        _channelBackend: f.metadata,
        source: f.streaming.currentSource,
      }),
    ];
    const initial = await startQueuedTurn(f);
    await f.run(
      (async function* () {
        yield { type: "turn.failed", error: "context window exhausted", recoverable: false };
      })(),
    );
    await initial.return(undefined);
    expect(f.stashedMessages.get(f.session.name!)?.[0]?.launchPrompt?._channelBackend).toEqual(f.metadata);
    expect(f.outputs).toHaveLength(0);
    const resumed = await startQueuedTurn(f, true);
    const answer = "Complete generic native answer after context recovery";
    await f.run(
      (async function* () {
        yield final(answer);
        yield { type: "turn.complete", usage: { inputTokens: 0, outputTokens: 0 } };
      })(),
    );
    await resumed.return(undefined);
    expect(f.outputs).toHaveLength(1);
    const output = f.outputs[0]!;
    expect(output).toMatchObject({ kind: "assistant_message", binding: f.metadata.binding, target: f.metadata.target });
    expect(output.content).toEqual([{ type: "text", text: answer }]);
    expect(dbGetChannelBackendRuntimeState(f.metadata.binding.turnId)?.state).toBe("completed");
    expect(f.responses).toHaveLength(0);
    const job = buildChannelTextOutboundJob({
      requestId: output.outputId,
      sessionName: output.binding.sessionId,
      emitId: output.outputId,
      idempotencyKey: output.outputId,
      target: {
        channel: "test-native",
        accountId: "local",
        instanceId: "local",
        chatId: "C123",
        canonicalChatId: output.binding.chatId,
      },
      text: answer,
      responsePhase: "final_answer",
      automatic: createChannelBackendAutomaticOutputOrigin(output.binding),
    });
    expect((await consume([job], Date.now(), "test-native")).sends).toEqual([answer]);
    // Reading an absent identity creates only the ledger schema, never a manifest.
    expect(getSlackAutomaticTerminalManifest("generic-native-control")).toBeNull();
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM slack_automatic_terminal_manifests").get()).toEqual({
      count: 0,
    });
  });

  it("keeps recovery without a native binding on its existing legacy path", async () => {
    const f = await fixture("user", undefined, "claude");
    f.streaming.toolEffectFence = resolveRuntimeToolEffectFence("claude", capabilities.tools.permissionMode);
    f.streaming.pendingMessages = [
      createQueuedRuntimeUserMessage({ prompt: "Legacy notice", source: f.streaming.currentSource }),
    ];
    const initial = await startQueuedTurn(f);
    await f.run(
      (async function* () {
        yield { type: "turn.failed", error: "context window exhausted", recoverable: false };
      })(),
    );
    await initial.return(undefined);
    const recovered = f.stashedMessages.get(f.session.name!)?.[0];
    expect(recovered?.launchPrompt).toBeDefined();
    expect(recovered?.launchPrompt?._channelBackend).toBeUndefined();
    const resumed = await startQueuedTurn(f, true);
    await f.run(
      (async function* () {
        yield final("Recovered legacy answer");
        yield { type: "turn.complete", usage: { inputTokens: 0, outputTokens: 0 } };
      })(),
    );
    await resumed.return(undefined);
    expect(f.outputs).toHaveLength(0);
    expect(f.responses).toHaveLength(1);
    const built = buildChannelOutboundJobFromResponse(f.session.name!, f.responses[0]!);
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error("Legacy recovery response did not build");
    expect((await consume([built.job], Date.now())).sends).toEqual(["Recovered legacy answer"]);
  });

  it("keeps Claude recovery refused after a tool has started", async () => {
    const f = await fixture("bot", undefined, "claude");
    f.streaming.toolEffectFence = resolveRuntimeToolEffectFence("claude", capabilities.tools.permissionMode);
    f.streaming.pendingMessages = [
      createQueuedRuntimeUserMessage({
        prompt: "Bot notice",
        _channelBackend: f.metadata,
        source: f.streaming.currentSource,
      }),
    ];
    const generator = await startQueuedTurn(f);
    await f.run(
      (async function* () {
        yield { type: "tool.started", toolUse: { id: "started-tool", name: "test-tool", input: {} } };
        yield { type: "turn.failed", error: "context window exhausted", recoverable: false };
      })(),
    );
    await generator.return(undefined);
    expect(f.stashedMessages.get(f.session.name!)).toBeUndefined();
    expect(f.outputs[0]?.kind).toBe("safe_error");
  }, 20_000);

  it("keeps Codex provider_event_only from entering context recovery", async () => {
    const f = await fixture("bot", undefined, "codex");
    f.streaming.toolEffectFence = resolveRuntimeToolEffectFence("codex", capabilities.tools.permissionMode);
    expect(f.streaming.toolEffectFence).toBe("provider_event_only");
    f.streaming.pendingMessages = [
      createQueuedRuntimeUserMessage({
        prompt: "Bot notice",
        _channelBackend: f.metadata,
        source: f.streaming.currentSource,
      }),
    ];
    const generator = await startQueuedTurn(f);
    await f.run(
      (async function* () {
        yield { type: "turn.failed", error: "context window exhausted", recoverable: false };
      })(),
    );
    await generator.return(undefined);
    expect(f.stashedMessages.get(f.session.name!)).toBeUndefined();
    expect(f.responses).toHaveLength(0);
    expect(f.outputs[0]?.kind).toBe("safe_error");
  });

  for (const senderKind of ["bot", "user"] as const) {
    it(`keeps fresh native ${senderKind} final output deliverable`, async () => {
      const f = await fixture(senderKind);
      f.streaming.pendingMessages = [
        createQueuedRuntimeUserMessage({
          prompt: "Fresh input",
          _channelBackend: f.metadata,
          source: f.streaming.currentSource,
        }),
      ];
      const generator = await startQueuedTurn(f);
      await f.run(
        (async function* () {
          yield final("Fresh complete answer");
          yield { type: "turn.complete", usage: { inputTokens: 0, outputTokens: 0 } };
        })(),
      );
      await generator.return(undefined);
      expect(f.outputs).toHaveLength(1);
      expect(f.responses).toHaveLength(0);
      const delivered = await consume(f.outputs.map(nativeJob), Date.now());
      expect(delivered.sends).toEqual(["Fresh complete answer"]);
    });
  }

  it("keeps an unrelated legacy response deliverable", async () => {
    const f = await fixture("user");
    const response: ResponseMessage & { _v: number } = {
      response: "Explicit unrelated answer",
      target: { channel: "slack", accountId: "local", instanceId: "local", chatId: "C123" },
      _emitId: "explicit-unrelated",
      _v: 2,
    };
    const built = buildChannelOutboundJobFromResponse(f.session.name!, response);
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error("Unrelated fixture did not build");
    expect((await consume([built.job], Date.now())).sends).toEqual(["Explicit unrelated answer"]);
  });
});
function transportFailure(): RuntimeEvent {
  return {
    type: "turn.failed",
    error: "Synthetic provider transport disconnected",
    failureKind: "transport",
    recoverable: true,
  };
}

async function prepareInterruptedReplay(f: Awaited<ReturnType<typeof fixture>>, provider = "claude") {
  f.streaming.toolEffectFence = resolveRuntimeToolEffectFence(provider, capabilities.tools.permissionMode);
  f.streaming.pendingMessages = [
    createQueuedRuntimeUserMessage({
      prompt: "Independent notice retained across transport recovery",
      _channelBackend: f.metadata,
      source: f.streaming.currentSource,
    }),
  ];
  return startQueuedTurn(f);
}

describe("native Slack interrupted transport replay keeps logical output ownership", () => {
  for (const scenario of [
    { senderKind: "bot", cooldown: false },
    { senderKind: "bot", cooldown: true },
    { senderKind: "user", cooldown: true },
  ] as const) {
    it(`completes the same native ${scenario.senderKind} binding with ${scenario.cooldown ? "an open cooldown" : "an available allowance"}`, async () => {
      const f = await fixture(scenario.senderKind);
      const first = await prepareInterruptedReplay(f);
      expect(f.streaming.toolEffectFence).toBe("host_write_ahead");
      const now = Date.now();
      const priorDecision = scenario.cooldown
        ? seedCooldown(JSON.stringify(["slack", "installation-a", "C123"]), now)
        : null;
      const responseId = slackAutomaticTerminalResponseId(f.metadata.binding.turnId, {
        channel: "slack",
        accountId: "local",
        instanceId: "local",
        chatId: "C123",
        threadId: "1.000001",
        canonicalChatId: f.metadata.binding.chatId,
      });
      await f.run(
        (async function* () {
          yield transportFailure();
        })(),
      );
      await first.return(undefined);
      const saved = f.stashedMessages.get(f.session.name!)?.[0];
      expect(saved?.launchPrompt?._channelBackend).toEqual(f.metadata);
      const interruptedPhysical = f.streaming.currentCrashRecoveryTerminal!;
      expect(interruptedPhysical.status).toBe("interrupted");
      const interruptedSnapshot = { ...interruptedPhysical };
      const logicalAfterFailure = dbGetChannelBackendRuntimeState(f.metadata.binding.turnId)?.state;
      const prematureManifest = getSlackAutomaticTerminalManifest(responseId);
      const prematureOutputs = f.outputs.length;
      const resumed = await startQueuedTurn(f, true);
      expect(f.streaming.currentChannelBackend).toEqual(f.metadata);
      const answer = `Complete ${scenario.senderKind} answer after transport recovery`;
      await f.run(
        (async function* () {
          yield final(answer);
          yield { type: "turn.complete", usage: { inputTokens: 0, outputTokens: 0 } };
        })(),
      );
      await resumed.return(undefined);
      const delivered = await consume(f.outputs.map(nativeJob), now + 1);
      const manifest = getSlackAutomaticTerminalManifest(responseId);
      const historyHasFullFinal = getRecentHistory(f.session.name!, 20).some(
        (message) => message.role === "assistant" && message.content === answer,
      );
      console.log(
        "INTERRUPTED_REPLAY_DESIRED_OBSERVATION",
        JSON.stringify({
          ...scenario,
          bindingPreserved: JSON.stringify(saved?.launchPrompt?._channelBackend) === JSON.stringify(f.metadata),
          firstPhysicalState: interruptedPhysical.status,
          secondPhysicalState: f.streaming.currentCrashRecoveryTerminal?.status,
          logicalAfterFailure,
          finalLogicalState: dbGetChannelBackendRuntimeState(f.metadata.binding.turnId)?.state,
          prematureManifest: prematureManifest?.kind ?? null,
          finalManifest: manifest?.kind ?? null,
          nativeKinds: f.outputs.map((output) => output.kind),
          consumerStatuses: delivered.results.map((result) => result.status),
          sends: delivered.sends.length,
          historyHasFullFinal,
        }),
      );
      // A new physical handoff is legitimate. It cannot rewrite the first
      // terminal snapshot, and neither handoff resets logical backend state.
      expect(interruptedPhysical).toEqual(interruptedSnapshot);
      expect(f.streaming.currentCrashRecoveryTerminal?.status).toBe("complete");
      expect(historyHasFullFinal).toBe(true);
      expect([undefined, "accepted", "running"]).toContain(logicalAfterFailure);
      expect(prematureManifest).toBeNull();
      expect(prematureOutputs).toBe(0);
      expect(dbGetChannelBackendRuntimeState(f.metadata.binding.turnId)?.state).toBe("completed");
      expect(f.outputs).toHaveLength(1);
      expect(f.outputs[0]).toMatchObject({ kind: "assistant_message", binding: f.metadata.binding });
      expect(renderSlackBackendOutput(f.outputs[0]!)).toBe(answer);
      expect(f.responses).toHaveLength(0);
      const suppressed = scenario.senderKind === "bot" && scenario.cooldown;
      expect(delivered.sends).toEqual(suppressed ? [] : [answer]);
      expect(delivered.results.map((result) => result.status)).toEqual([suppressed ? "dropped" : "delivered"]);
      const decision = getSlackAutomaticOutputDecision(responseId);
      if (scenario.senderKind === "bot") {
        expect(manifest?.kind).toBe("final_answer");
        expect(decision?.status).toBe(suppressed ? "suppressed" : "allowed");
      } else {
        expect(manifest).toBeNull();
        expect(decision).toBeNull();
      }
      if (scenario.cooldown) expect(getSlackAutomaticOutputDecision("prior-4")).toEqual(priorDecision);
      if (suppressed) {
        expect(getChannelOutboundReceipt(`${responseId}:text`)?.state).toBe("suppressed");
        const replay = await consume([nativeJob(f.outputs[0]!)], now + 600_001);
        expect(replay.sends).toEqual([]);
        expect(replay.results[0]?.status).toBe("dropped");
        expect(getSlackAutomaticOutputDecision(responseId)).toEqual(decision);
        expect(f.stashedMessages.has(f.session.name!)).toBe(false);
        expect(dbGetChannelBackendRuntimeState(f.metadata.binding.turnId)?.state).toBe("completed");
      }
    });
  }

  for (const refusal of ["codex", "started-tool", "mutated-input"] as const) {
    it(`refuses unsafe interrupted replay for ${refusal} while preserving an unrelated successor`, async () => {
      const provider = refusal === "codex" ? "codex" : "claude";
      const f = await fixture("bot", undefined, provider);
      const first = await prepareInterruptedReplay(f, provider);
      const successor = createQueuedRuntimeUserMessage({
        prompt: "Independent successor",
        source: f.streaming.currentSource,
      });
      f.streaming.pendingMessages.push(successor);
      await f.run(
        (async function* () {
          if (refusal === "started-tool") {
            yield { type: "tool.started", toolUse: { id: "side-effect-tool", name: "test-tool", input: {} } };
          }
          if (refusal === "mutated-input") f.streaming.currentTurnInputMutated = true;
          yield transportFailure();
        })(),
      );
      await first.return(undefined);
      const saved = f.stashedMessages.get(f.session.name!) ?? [];
      expect(
        saved.some((message) => message.launchPrompt?._channelBackend?.binding.turnId === f.metadata.binding.turnId),
      ).toBe(false);
      expect(
        [...saved, ...f.streaming.pendingMessages].some((message) => message.pendingId === successor.pendingId),
      ).toBe(true);
      const terminal = refusal === "started-tool" ? "failed" : "interrupted";
      expect(dbGetChannelBackendRuntimeState(f.metadata.binding.turnId)?.state).toBe(terminal);
      expect(f.streaming.currentCrashRecoveryTerminal?.status).toBe(terminal);
      expect(f.outputs.map((output) => output.kind)).toEqual(refusal === "started-tool" ? ["safe_error"] : []);
      expect(f.responses).toHaveLength(0);
    }, 20_000);
  }
});

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

function interruptedManifest(f: Awaited<ReturnType<typeof fixture>>) {
  const context = resolveSlackAutomaticOutputContextFromBinding(f.metadata.binding)!;
  return getSlackAutomaticTerminalManifest(slackAutomaticTerminalResponseId(context.turnId, context.target));
}

function replacementRuntime(
  f: Awaited<ReturnType<typeof fixture>>,
  messages: RuntimeUserMessage[],
): RuntimeHostStreamingSession {
  // A different launcher owns a fresh physical host object. Keep the accepted
  // queued envelope; do not alter the old attempt or any logical DB state.
  return {
    ...f.streaming,
    starting: true,
    done: false,
    interrupted: false,
    turnActive: false,
    pendingAbort: false,
    internalAbortReason: undefined,
    abortController: new AbortController(),
    currentChannelBackend: undefined,
    currentCrashRecoveryTerminal: undefined,
    currentCrashRecoveryAttemptId: undefined,
    currentTraceTurnId: undefined,
    currentTraceTurnTerminalRecorded: false,
    currentTurnPendingIds: undefined,
    pendingMessages: messages,
    pushMessage: null,
    onTurnComplete: null,
  };
}

describe("interrupted logical projection revalidates runtime ownership", () => {
  it("continues a physically closed handle without inventing an explicit cancellation", async () => {
    const f = await fixture();
    const first = await prepareInterruptedReplay(f);
    f.setSafeEmitHook(async (_topic, data) => {
      if ((data as { type?: string }).type !== "turn.interrupted") return;
      f.streaming.done = true;
      f.streaming.abortController.abort();
    });
    await f.run(
      (async function* () {
        yield transportFailure();
      })(),
    );
    await first.return(undefined);
    expect(f.restarts).toHaveLength(1);
    expect(f.stashedMessages.get(f.session.name!)?.[0]?.launchPrompt?._channelBackend).toEqual(f.metadata);
    expect([undefined, "accepted", "running"]).toContain(
      dbGetChannelBackendRuntimeState(f.metadata.binding.turnId)?.state,
    );
    expect(interruptedManifest(f)).toBeNull();
    const firstTerminal = f.streaming.currentCrashRecoveryTerminal!;
    expect(firstTerminal.status).toBe("interrupted");
    f.setSafeEmitHook(undefined);
    const next = await startQueuedTurn(f, true);
    const answer = "Complete final after internal physical closure\nAll detail is preserved.";
    await f.run(
      (async function* () {
        yield final(answer);
        yield { type: "turn.complete", usage: { inputTokens: 0, outputTokens: 0 } };
      })(),
    );
    await next.return(undefined);
    expect(firstTerminal.status).toBe("interrupted");
    expect(dbGetChannelBackendRuntimeState(f.metadata.binding.turnId)?.state).toBe("completed");
    expect(f.outputs).toHaveLength(1);
    expect(renderSlackBackendOutput(f.outputs[0]!)).toBe(answer);
    expect((await consume(f.outputs.map(nativeJob), Date.now())).sends).toEqual([answer]);
  });

  for (const removeSlot of [false, true]) {
    it(`settles explicit cancellation during diagnostics with slot ${removeSlot ? "removed" : "retained"}`, async () => {
      const f = await fixture();
      const first = await prepareInterruptedReplay(f);
      f.setSafeEmitHook(async (_topic, data) => {
        if ((data as { type?: string }).type !== "turn.interrupted") return;
        f.streaming.pendingAbort = true;
        f.streaming.internalAbortReason = "explicit_abort";
        f.streaming.abortController.abort();
        if (removeSlot) f.streamingSessions.delete(f.session.name!);
      });
      await f.run(
        (async function* () {
          yield transportFailure();
        })(),
      );
      await first.return(undefined);
      expect(f.restarts).toHaveLength(0);
      // PR797 may retain cancelled atoms in its dormant queue; retention does
      // not authorize a physical restart or defer this logical cancellation.
      expect(dbGetChannelBackendRuntimeState(f.metadata.binding.turnId)?.state).toBe("interrupted");
      expect(interruptedManifest(f)?.kind).toBe("cancelled");
      expect(f.outputs).toHaveLength(0);
      expect(f.responses).toHaveLength(0);
      const { countSlackAutomaticPendingReplies } = await import("../channels/slack/automatic-pending-reply.js");
      expect(countSlackAutomaticPendingReplies()).toBe(0);
    });
  }

  it("refuses the captured terminal when cancellation removes the slot and replaces the query handle", async () => {
    const f = await fixture();
    const first = await prepareInterruptedReplay(f);
    let changedHandle: RuntimeSessionHandle | undefined;
    let before: ReturnType<typeof dbGetChannelBackendRuntimeState>;
    f.setSafeEmitHook(async (_topic, data) => {
      if ((data as { type?: string }).type !== "turn.interrupted") return;
      before = dbGetChannelBackendRuntimeState(f.metadata.binding.turnId);
      f.streaming.pendingAbort = true;
      f.streaming.internalAbortReason = "explicit_abort";
      f.streaming.abortController.abort();
      f.streamingSessions.delete(f.session.name!);
      changedHandle = { ...f.streaming.queryHandle! };
      f.streaming.queryHandle = changedHandle;
    });
    await f.run(
      (async function* () {
        yield transportFailure();
      })(),
    );
    await first.return(undefined);
    expect(changedHandle).toBeDefined();
    expect(f.streaming.queryHandle).toBe(changedHandle!);
    expect(f.streamingSessions.has(f.session.name!)).toBe(false);
    expect(f.restarts).toHaveLength(0);
    expect(dbGetChannelBackendRuntimeState(f.metadata.binding.turnId)).toEqual(before!);
    expect(interruptedManifest(f)).toBeNull();
    expect(f.outputs).toHaveLength(0);
    expect(f.responses).toHaveLength(0);
    const decisions = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'slack_automatic_output_decisions'")
      .get();
    if (decisions) {
      expect(getDb().prepare("SELECT COUNT(*) AS count FROM slack_automatic_output_decisions").get()).toEqual({
        count: 0,
      });
    }
  });

  it("cannot cancel a replacement owner of the same accepted binding during diagnostics", async () => {
    const f = await fixture();
    const first = await prepareInterruptedReplay(f);
    const original = f.streaming.pendingMessages[0]!;
    const replacement = replacementRuntime(f, [{ ...original }]);
    f.setSafeEmitHook(async (_topic, data) => {
      if ((data as { type?: string }).type === "turn.interrupted") {
        f.streamingSessions.set(f.session.name!, replacement);
      }
    });
    await f.run(
      (async function* () {
        yield transportFailure();
      })(),
    );
    await first.return(undefined);
    expect(f.streamingSessions.get(f.session.name!)).toBe(replacement);
    expect(replacement.abortController.signal.aborted).toBe(false);
    expect(replacement.starting).toBe(true);
    expect(f.restarts).toHaveLength(0);
    expect(f.stashedMessages.has(f.session.name!)).toBe(false);
    expect([undefined, "accepted", "running"]).toContain(
      dbGetChannelBackendRuntimeState(f.metadata.binding.turnId)?.state,
    );
    expect(interruptedManifest(f)).toBeNull();
    const priorTerminal = f.streaming.currentCrashRecoveryTerminal!;
    expect(priorTerminal.status).toBe("interrupted");
    f.setSafeEmitHook(undefined);
    replacement.starting = false;
    const next = await startQueuedTurn({ ...f, streaming: replacement });
    expect(replacement.currentChannelBackend).toEqual(f.metadata);
    const answer = "Complete answer from the replacement owner\nSame accepted logical request.";
    await f.run(
      (async function* () {
        yield final(answer);
        yield { type: "turn.complete", usage: { inputTokens: 0, outputTokens: 0 } };
      })(),
      replacement,
    );
    await next.return(undefined);
    expect(priorTerminal.status).toBe("interrupted");
    expect(dbGetChannelBackendRuntimeState(f.metadata.binding.turnId)?.state).toBe("completed");
    expect(f.outputs).toHaveLength(1);
    expect(renderSlackBackendOutput(f.outputs[0]!)).toBe(answer);
    expect((await consume(f.outputs.map(nativeJob), Date.now())).sends).toEqual([answer]);
  });

  it("rechecks a starting replacement after the awaited running sink before terminal write or freeze", async () => {
    const f = await fixture();
    const first = await prepareInterruptedReplay(f);
    const original = f.streaming.pendingMessages[0]!;
    const replacement = replacementRuntime(f, [{ ...original }]);
    // An unrelated replay atom must not keep the old native request open by
    // itself. The owner replacement happens during the required terminal path.
    f.streaming.pendingMessages[0] = {
      ...original,
      launchPrompt: { ...original.launchPrompt!, _channelBackend: undefined },
    };
    let replaced = false;
    f.setRuntimeSinkHook(async (event) => {
      if (!replaced && event.kind === "turn.state_changed" && event.payload.state === "running") {
        await Promise.resolve();
        replaced = true;
        f.streamingSessions.set(f.session.name!, replacement);
      }
    });
    await f.run(
      (async function* () {
        yield transportFailure();
      })(),
    );
    await first.return(undefined);
    expect(replaced).toBe(true);
    expect(f.streamingSessions.get(f.session.name!)).toBe(replacement);
    expect(replacement.currentChannelBackend).toBeUndefined();
    expect(replacement.starting).toBe(true);
    expect(replacement.abortController.signal.aborted).toBe(false);
    expect(dbGetChannelBackendRuntimeState(f.metadata.binding.turnId)?.state).toBe("running");
    expect(interruptedManifest(f)).toBeNull();
    expect(f.outputs).toHaveLength(0);
    expect(f.restarts).toHaveLength(0);
    const { countSlackAutomaticPendingReplies } = await import("../channels/slack/automatic-pending-reply.js");
    expect(countSlackAutomaticPendingReplies()).toBe(1);
  });

  it("closes the logical request when physical diagnostics throw before any continuation is armed", async () => {
    const f = await fixture();
    const first = await prepareInterruptedReplay(f);
    f.setSafeEmitHook(async (_topic, data) => {
      if ((data as { type?: string }).type === "turn.interrupted")
        throw new Error("fixture physical diagnostic failure");
    });
    await expect(
      f.run(
        (async function* () {
          yield transportFailure();
        })(),
      ),
    ).rejects.toThrow("fixture physical diagnostic failure");
    await first.return(undefined);
    expect(f.restarts).toHaveLength(0);
    expect(f.stashedMessages.has(f.session.name!)).toBe(false);
    expect(f.streaming.currentCrashRecoveryTerminal?.status).toBe("interrupted");
    expect(dbGetChannelBackendRuntimeState(f.metadata.binding.turnId)?.state).toBe("interrupted");
    expect(interruptedManifest(f)?.kind).toBe("cancelled");
    expect(f.outputs).toHaveLength(0);
    expect(f.responses).toHaveLength(0);
    const { countSlackAutomaticPendingReplies } = await import("../channels/slack/automatic-pending-reply.js");
    expect(countSlackAutomaticPendingReplies()).toBe(0);
  });
});

describe("interrupted request identity and pending media", () => {
  for (const mismatch of ["message", "destination", "accepted-other-turn"] as const) {
    it(`does not defer the original logical terminal for a different ${mismatch}`, async () => {
      const f = await fixture();
      const first = await prepareInterruptedReplay(f);
      const different = structuredClone(f.metadata);
      if (mismatch === "message") different.binding.messageId = "different-message";
      if (mismatch === "destination") different.target.conversationId = "COTHER~2.000001";
      if (mismatch === "accepted-other-turn") {
        const message = dbUpsertChatMessage({
          chatId: f.metadata.binding.chatId,
          channel: "slack",
          instanceId: "local",
          providerMessageId: "2.000001",
          rawChatId: "C123",
          actorType: "unknown",
          rawProvenance: { source: "slack.socket_mode", senderKind: "bot" },
        });
        const accepted = await acceptResolvedChannelIngress({
          request: {
            protocol: "ravi.channel.backend",
            schemaVersion: 1,
            requestId: "independent-request-b",
            idempotencyKey: "independent-input-b",
            localActorId: "unknown-a",
            channelInstanceId: "local",
            agentId: "agent-a",
            external: { ...f.metadata.target, senderId: "B123", messageId: "2.000001" },
            content: [{ type: "text", text: "Independent second notice" }],
            receivedAt: "2026-11-03T12:01:00.000Z",
          },
          canonical: { chatId: f.metadata.binding.chatId, messageId: message.canonicalMessageId },
          session: { key: f.session.sessionKey, name: f.session.name! },
          prompt: { prompt: "Independent second notice", context: {}, source: { ...f.streaming.currentSource } },
        });
        expect(accepted.binding).toBeDefined();
        different.binding = accepted.binding!;
        different.ingressRequestId = "independent-request-b";
        different.correlationId = "independent-request-b";
      }
      const original = f.streaming.pendingMessages[0]!;
      f.streaming.pendingMessages[0] = {
        ...original,
        launchPrompt: { ...original.launchPrompt!, _channelBackend: different },
      };
      await f.run(
        (async function* () {
          yield transportFailure();
        })(),
      );
      await first.return(undefined);
      expect(dbGetChannelBackendRuntimeState(f.metadata.binding.turnId)?.state).toBe("interrupted");
      expect(interruptedManifest(f)?.kind).toBe("cancelled");
      expect(f.outputs).toHaveLength(0);
      expect(f.stashedMessages.get(f.session.name!)?.[0]?.launchPrompt?._channelBackend).toEqual(different);
      expect(f.restarts).toHaveLength(1);
      if (mismatch === "accepted-other-turn") {
        expect(different.binding.turnId).not.toBe(f.metadata.binding.turnId);
        expect(dbGetChannelBackendRuntimeState(different.binding.turnId)).toBeNull();
      } else {
        expect(different.binding.turnId).toBe(f.metadata.binding.turnId);
      }
    });
  }

  it("retains previously yielded generated media through a permitted physical transport replay", async () => {
    const f = await fixture();
    const first = await prepareInterruptedReplay(f);
    const original = { ...f.streaming.pendingMessages[0]! };
    const imageBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
    await f.run(
      (async function* () {
        yield { type: "tool.started", toolUse: { id: "prior-image", name: "image_gen.imagegen", input: {} } };
        yield {
          type: "tool.completed",
          toolUseId: "prior-image",
          toolName: "image_gen.imagegen",
          content: { id: "prior-image", result: imageBase64 },
          metadata: { provider: "codex", item: { id: "prior-image", type: "imageGeneration", status: "completed" } },
        };
        f.streaming.currentTurnYieldContinuationId = "authorized-prior-yield";
        yield { type: "turn.complete", usage: { inputTokens: 0, outputTokens: 0 } };
      })(),
    );
    await first.return(undefined);
    expect(f.responses).toHaveLength(0);
    expect(f.outputs).toHaveLength(0);
    const { countSlackAutomaticPendingReplies, getSlackAutomaticPendingReply } = await import(
      "../channels/slack/automatic-pending-reply.js"
    );
    expect(getSlackAutomaticPendingReply(f.metadata)?.media).toHaveLength(1);
    // The queue handoff for the proven yield is controlled; the actual host
    // generated/retained the descriptor. The next physical attempt has no effects.
    const continuation = replacementRuntime(f, [original]);
    continuation.starting = false;
    continuation.currentTurnYieldContinuationId = undefined;
    continuation.currentTurnToolStarted = false;
    continuation.currentTurnInputMutated = false;
    f.streamingSessions.set(f.session.name!, continuation);
    const nextFixture = { ...f, streaming: continuation };
    const second = await startQueuedTurn(nextFixture);
    await f.run(
      (async function* () {
        yield transportFailure();
      })(),
      continuation,
    );
    await second.return(undefined);
    expect(continuation.currentCrashRecoveryTerminal?.status).toBe("interrupted");
    expect(f.stashedMessages.get(f.session.name!)?.[0]?.launchPrompt?._channelBackend).toEqual(f.metadata);
    expect(getSlackAutomaticPendingReply(f.metadata)?.media).toHaveLength(1);
    expect(interruptedManifest(f)).toBeNull();
    expect(f.responses).toHaveLength(0);
    const resumed = await startQueuedTurn(nextFixture, true);
    const answer = "Complete answer with the previously generated attachment\nFinal detail preserved.";
    await f.run(
      (async function* () {
        yield final(answer);
        yield { type: "turn.complete", usage: { inputTokens: 0, outputTokens: 0 } };
      })(),
      continuation,
    );
    await resumed.return(undefined);
    expect(dbGetChannelBackendRuntimeState(f.metadata.binding.turnId)?.state).toBe("completed");
    expect(f.outputs).toHaveLength(1);
    expect(renderSlackBackendOutput(f.outputs[0]!)).toBe(answer);
    expect((await consume(f.outputs.map(nativeJob), Date.now())).sends).toEqual([answer]);
    expect(f.responses).toHaveLength(1);
    const mediaResponse = f.responses[0]!;
    expect(mediaResponse.target).toMatchObject({ chatId: "C123", threadId: "1.000001" });
    expect(mediaResponse._automaticOutputOrigin?.binding).toEqual(f.metadata.binding);
    expect(mediaResponse.content).toHaveLength(1);
    const member = mediaResponse.content![0]!;
    expect(member.type).toBe("media");
    const manifest = interruptedManifest(f)!;
    expect(manifest.kind).toBe("final_answer");
    expect(manifest.mediaFingerprints).toHaveLength(1);
    if (member.type !== "media") throw new Error("Missing generated member");
    expect(assertSlackAutomaticTerminalPart(manifest, { ...member, index: 0 })).toBe(`${manifest.responseId}:media:0`);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(member.media.filePath).toString("base64")).toBe(imageBase64);
    expect(countSlackAutomaticPendingReplies()).toBe(0);
  });

  it("does not freeze cancellation or clear pending media when the DB rejects the terminal write", async () => {
    const f = await fixture();
    const first = await prepareInterruptedReplay(f, "codex");
    const { getSlackAutomaticPendingReply, countSlackAutomaticPendingReplies } = await import(
      "../channels/slack/automatic-pending-reply.js"
    );
    const pending = getSlackAutomaticPendingReply(f.metadata)!;
    pending.media.push({
      type: "image",
      filePath: `${stateDir}/pending.png`,
      filename: "pending.png",
      mimeType: "image/png",
    });
    getDb().exec(`CREATE TEMP TRIGGER reject_interrupted_fixture BEFORE UPDATE ON channel_backend_runtime_state
      WHEN NEW.state = 'interrupted' BEGIN SELECT RAISE(ABORT, 'fixture rejected terminal'); END`);
    try {
      await f.run(
        (async function* () {
          yield transportFailure();
        })(),
      );
      await first.return(undefined);
      expect(f.streaming.currentCrashRecoveryTerminal?.status).toBe("interrupted");
      expect(dbGetChannelBackendRuntimeState(f.metadata.binding.turnId)?.state).toBe("running");
      expect(interruptedManifest(f)).toBeNull();
      expect(countSlackAutomaticPendingReplies()).toBe(1);
      expect(getSlackAutomaticPendingReply(f.metadata)).toBe(pending);
      expect(pending.media).toHaveLength(1);
      expect(f.outputs).toHaveLength(0);
      expect(f.responses).toHaveLength(0);
      expect(f.restarts).toHaveLength(0);
    } finally {
      getDb().exec("DROP TRIGGER reject_interrupted_fixture");
    }
  });
});
