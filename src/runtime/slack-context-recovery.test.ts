import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { configStore } from "../config-store.js";
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
  const emit = spyOn(nats, "emit").mockImplementation(async (topic, data) => {
    if (topic === `ravi.session.${session.name}.response`) responses.push(data as ResponseMessage);
  });
  cleanups.push(() => emit.mockRestore());
  cleanups.push(
    channelRuntimeEventSinks.register(target, {
      async emit(event) {
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
  const run = async (events: AsyncIterable<RuntimeEvent>) => {
    const runtimeSession: RuntimeSessionHandle = { provider, events, async interrupt() {} };
    streaming.queryHandle = runtimeSession;
    await runRuntimeEventLoop({
      runId: "run-a",
      sessionName: session.name!,
      session,
      agent,
      streaming,
      runtimeSession,
      runtimeCapabilities: capabilities,
      model: "test",
      instanceId: "test",
      defaultRuntimeProviderId: provider,
      streamingSessions: new Map([[session.name!, streaming]]),
      stashedMessages,
      safeEmit: async () => {},
      drainPendingStarts() {},
    });
  };
  return { metadata, session, streaming, responses, outputs, stashedMessages, run };
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
