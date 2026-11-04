import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configStore } from "../config-store.js";
import { nats } from "../nats.js";
import {
  closeRouterDb,
  dbCreateAgent,
  dbGetAgent,
  dbUpsertChannel,
  dbUpsertChat,
  dbUpsertChatMessage,
  getDb,
} from "../router/router-db.js";
import {
  attachChatToSession,
  closeSessionStore,
  getOrCreateSession,
  resolveSession,
  updateSessionRuntimeProviderOverride,
} from "../router/sessions.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  acceptResolvedChannelIngress,
  channelOutputSinks,
  setChannelBackendPromptPublisherForTests,
  type ChannelOutputEnvelope,
} from "../channels/backend.js";
import { channelRuntimeEventSinks, projectChannelRuntimeEvent } from "../channels/runtime-events.js";
import { resolveSlackAutomaticOutputContextFromBinding } from "../channels/slack/automatic-output-origin.js";
import {
  assertSlackAutomaticTerminalPart,
  getSlackAutomaticTerminalManifest,
  slackAutomaticTerminalResponseId,
} from "../channels/slack/automatic-terminal-manifest.js";
import { renderSlackBackendOutput } from "../channels/slack/driver.js";
import {
  countSlackAutomaticPendingReplies,
  getSlackAutomaticPendingReply,
} from "../channels/slack/automatic-pending-reply.js";
import { runRuntimeEventLoop } from "./host-event-loop.js";
import { startRuntimeSession } from "./session-launcher.js";
import { registerRuntimeProvider, unregisterRuntimeProvider } from "./provider-registry.js";
import * as runtimeRequestBuilder from "./runtime-request-builder.js";
import type { RuntimeHostStreamingSession, RuntimeUserMessage } from "./host-session.js";
import type { ChannelBackendPromptMetadata, ResponseMessage } from "./message-types.js";
import type { RuntimeCapabilities, RuntimeEvent, RuntimeSessionHandle } from "./types.js";

const imageBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
let stateDir: string | null = null;
const cleanups: Array<() => void> = [];

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("slack-automatic-terminal-host-");
  dbCreateAgent({ id: "agent-a", name: "Agent A", cwd: stateDir });
  dbUpsertChannel({ name: "local", provider: "slack", credentialConnection: "installation-a" });
  configStore.refresh();
  setChannelBackendPromptPublisherForTests(async () => {});
  expect(countSlackAutomaticPendingReplies()).toBe(0);
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  setChannelBackendPromptPublisherForTests();
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

/**
 * Creates a real accepted Slack binding in the isolated state prepared by
 * beforeEach, with bot/user provenance and captured responses and outputs.
 * run feeds supplied events through the real host loop using a synthetic
 * provider handle; provider identifies that handle without launching a provider.
 * failSink injects terminal-runtime or output-sink failures. Bot output is
 * checked against its persisted terminal manifest before capture.
 * replaceStreaming rebuilds host state while retaining the binding and stash.
 * afterEach restores spies, unregisters sinks, and owns test-state teardown.
 */
async function fixture(
  senderKind: "bot" | "user" = "bot",
  failSink?: "runtime" | "output",
  provider = "test-provider",
) {
  const chat = dbUpsertChat({ channel: "slack", instanceId: "local", platformChatId: "C123", chatType: "group" });
  const message = dbUpsertChatMessage({
    chatId: chat.id,
    channel: "slack",
    instanceId: "local",
    providerMessageId: "1.000001",
    rawChatId: "C123",
    actorType: "unknown",
    rawProvenance: { source: "slack.socket_mode", senderKind },
  });
  const target = { channelKind: "slack", connectionId: "local", conversationId: "C123~1.000001" };
  getOrCreateSession("agent:agent-a:slack:local:group:C123", "agent-a", stateDir!, {
    name: "terminal-session",
    channel: "slack",
    accountId: "local",
    chatType: "group",
    lastChannel: "slack",
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
      content: [{ type: "text", text: "Generate two images" }],
      receivedAt: "2026-11-03T12:00:00.000Z",
    },
    canonical: { chatId: chat.id, messageId: message.canonicalMessageId },
    session: { key: "agent:agent-a:slack:local:group:C123", name: "terminal-session" },
    prompt: {
      prompt: "Generate two images",
      context: {},
      source: {
        channel: "slack",
        accountId: "local",
        instanceId: "local",
        chatId: "C123",
        threadId: "1.000001",
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
        if (senderKind === "bot") {
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
  let streaming: RuntimeHostStreamingSession = {
    agentId: "agent-a",
    queryHandle: { provider, events: (async function* () {})(), async interrupt() {} },
    starting: false,
    abortController: new AbortController(),
    pushMessage: null,
    pendingWake: false,
    pendingMessages: [],
    currentChannelBackend: metadata,
    currentSource: {
      channel: "slack",
      accountId: "local",
      instanceId: "local",
      chatId: "C123",
      threadId: "1.000001",
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
  const initialStreaming = { ...streaming, currentSource: { ...streaming.currentSource! } };
  const replaceStreaming = () => {
    streaming = { ...initialStreaming, pendingMessages: [], abortController: new AbortController() };
    return streaming;
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
  return {
    metadata,
    session,
    get streaming() {
      return streaming;
    },
    replaceStreaming,
    responses,
    outputs,
    stashedMessages,
    run,
  };
}

async function* imageEvents(id: string): AsyncGenerator<RuntimeEvent> {
  yield { type: "tool.started", toolUse: { id, name: "image_gen.imagegen", input: {} } };
  yield {
    type: "tool.completed",
    toolUseId: id,
    toolName: "image_gen.imagegen",
    content: { id, result: imageBase64 },
    metadata: { provider: "codex", item: { id, type: "imageGeneration", status: "completed" } },
  };
}
function final(text = "Complete answer"): RuntimeEvent {
  return { type: "assistant.message", text, metadata: { item: { id: "final", phase: "final_answer" } } };
}

describe("automatic media across logical turn continuations", () => {
  it("keeps identical bindings in different database files separate while reopening the original retains its draft", async () => {
    const f = await fixture();
    const original = getSlackAutomaticPendingReply(f.metadata)!;
    original.media.push({ type: "image", filePath: "unused-fixture-file", filename: "original.png" });
    const originalState = process.env.RAVI_STATE_DIR!;
    const otherState = mkdtempSync(join(tmpdir(), "slack-media-other-state-"));
    writeFileSync(join(otherState, "ravi.db"), getDb().serialize());
    try {
      closeSessionStore();
      closeRouterDb();
      process.env.RAVI_STATE_DIR = otherState;
      const other = getSlackAutomaticPendingReply(f.metadata)!;
      expect(other).not.toBe(original);
      expect(other.media).toEqual([]);
      expect(countSlackAutomaticPendingReplies()).toBe(1);
      await projectChannelRuntimeEvent({ metadata: f.metadata, event: { type: "turn.interrupted" } });
      expect(countSlackAutomaticPendingReplies()).toBe(0);
      closeSessionStore();
      closeRouterDb();
      process.env.RAVI_STATE_DIR = originalState;
      expect(getSlackAutomaticPendingReply(f.metadata)).toBe(original);
      expect(original.media).toHaveLength(1);
      await projectChannelRuntimeEvent({ metadata: f.metadata, event: { type: "turn.interrupted" } });
      expect(countSlackAutomaticPendingReplies()).toBe(0);
    } finally {
      closeSessionStore();
      closeRouterDb();
      process.env.RAVI_STATE_DIR = originalState;
      rmSync(otherState, { recursive: true, force: true });
    }
  });

  it("isolates two logical requests in the same session and cancels only the selected one", async () => {
    const f = await fixture();
    const message = dbUpsertChatMessage({
      chatId: f.metadata.binding.chatId,
      channel: "slack",
      instanceId: "local",
      providerMessageId: "1.000002",
      rawChatId: "C123",
      actorType: "unknown",
      rawProvenance: { source: "slack.socket_mode", senderKind: "bot" },
    });
    const second = await acceptResolvedChannelIngress({
      request: {
        protocol: "ravi.channel.backend",
        schemaVersion: 1,
        requestId: "request-b",
        idempotencyKey: "input-b",
        localActorId: "unknown-a",
        channelInstanceId: "local",
        agentId: "agent-a",
        external: { ...f.metadata.target, senderId: "B123", messageId: "1.000002" },
        content: [{ type: "text", text: "Separate logical request" }],
        receivedAt: "2026-11-03T12:00:01.000Z",
      },
      canonical: { chatId: f.metadata.binding.chatId, messageId: message.canonicalMessageId },
      session: { key: f.session.sessionKey, name: f.session.name! },
      prompt: { prompt: "Separate logical request", context: {}, source: { ...f.streaming.currentSource! } },
    });
    const metadata = {
      ...f.metadata,
      binding: second.binding!,
      ingressRequestId: "request-b",
      correlationId: "request-b",
    };
    const original = getSlackAutomaticPendingReply(f.metadata)!;
    const successor = getSlackAutomaticPendingReply(metadata)!;
    original.media.push({
      type: "image",
      filePath: "unused-fixture-file",
      filename: "original.png",
      idempotencyKey: "original-part",
    });
    expect(successor).not.toBe(original);
    expect(successor.media).toEqual([]);
    expect(countSlackAutomaticPendingReplies()).toBe(2);
    await projectChannelRuntimeEvent({ metadata: f.metadata, event: { type: "turn.interrupted" } });
    expect(countSlackAutomaticPendingReplies()).toBe(1);
    expect(getSlackAutomaticPendingReply(metadata)).toBe(successor);
    expect(() => getSlackAutomaticPendingReply(f.metadata)).toThrow("already terminal");
    await projectChannelRuntimeEvent({ metadata, event: { type: "turn.interrupted" } });
    expect(countSlackAutomaticPendingReplies()).toBe(0);
  });

  it("keeps generated-media idempotency and original destination across a replacement", async () => {
    const f = await fixture();
    await f.run(
      (async function* () {
        yield* imageEvents("same-item");
        f.streaming.currentTurnYieldContinuationId = "continuation";
        yield { type: "turn.complete", usage: { inputTokens: 0, outputTokens: 0 } };
      })(),
    );
    f.replaceStreaming();
    f.streaming.currentSource = { channel: "slack", accountId: "local", chatId: "COTHER" };
    await f.run(
      (async function* () {
        yield* imageEvents("same-item");
        yield* imageEvents("different-item");
        yield final("Both distinct images are retained");
        yield { type: "turn.complete", usage: { inputTokens: 0, outputTokens: 0 } };
      })(),
    );
    expect(f.responses).toHaveLength(1);
    expect(f.responses[0]!.target).toMatchObject({ chatId: "C123", threadId: "1.000001" });
    const parts = f.responses[0]!.content!;
    expect(parts).toHaveLength(2);
    const ids = parts.flatMap((part) => (part.type === "media" ? [part.media.idempotencyKey] : []));
    expect(ids[0]).toContain(":same-item:");
    expect(ids[1]).toContain(":different-item:");
    expect(countSlackAutomaticPendingReplies()).toBe(0);
  });

  it("preserves membership through two actual launcher allocations without regenerating media", async () => {
    const f = await fixture();
    const provider = "media-continuation-launcher";
    updateSessionRuntimeProviderOverride(f.session.sessionKey, provider);
    const streams: RuntimeHostStreamingSession[] = [];
    const build = spyOn(runtimeRequestBuilder, "buildRuntimeStartRequest").mockImplementation(async (options) => {
      streams.push(options.streamingSession);
      // Controlled provider preparation, keeping the launcher's real allocation
      // and the real event-loop lifecycle under test.
      options.streamingSession.currentChannelBackend = options.prompt._channelBackend;
      options.streamingSession.currentSource = options.prompt.source;
      options.streamingSession.turnActive = true;
      return { runtimeRequest: {} as never, toolContext: {} };
    });
    let starts = 0;
    registerRuntimeProvider(provider, () => ({
      id: provider,
      getCapabilities: () => capabilities,
      startSession() {
        const first = starts++ === 0;
        const active = streams.at(-1)!;
        return {
          provider,
          async interrupt() {},
          events: (async function* (): AsyncGenerator<RuntimeEvent> {
            if (first) {
              yield* imageEvents("launcher-image");
              yield final("Image ready; continuing the logical request");
              active.currentTurnYieldContinuationId = "launcher-continuation";
            } else {
              yield final("Full final after the real launcher replacement");
            }
            yield { type: "turn.complete", usage: { inputTokens: 0, outputTokens: 0 } };
          })(),
        };
      },
    }));
    try {
      const live = new Map<string, RuntimeHostStreamingSession>();
      for (const index of [0, 1]) {
        let finished!: () => void;
        const completion = new Promise<void>((resolve) => {
          finished = resolve;
        });
        await startRuntimeSession({
          sessionName: f.session.name!,
          prompt: {
            prompt: "Continue logical request",
            _channelBackend: f.metadata,
            source: f.streaming.currentSource,
          },
          configModel: "test",
          instanceId: "test",
          streamingSessions: live,
          stashedMessages: f.stashedMessages,
          safeEmit: async () => {},
          drainPendingStarts: finished,
          crashRecovery: undefined as never,
        });
        await completion;
        expect(live.size).toBe(0);
        if (index === 0) {
          expect(f.responses).toHaveLength(0);
          expect(f.outputs).toHaveLength(0);
          expect(countSlackAutomaticPendingReplies()).toBe(1);
        }
      }
      expect(streams).toHaveLength(2);
      expect(streams[0]).not.toBe(streams[1]);
      expect(f.responses).toHaveLength(1);
      expect(f.responses[0]!.content).toHaveLength(1);
      expect(f.outputs).toHaveLength(1);
      expect(renderSlackBackendOutput(f.outputs[0]!)).toBe("Full final after the real launcher replacement");
      expect(
        getSlackAutomaticTerminalManifest(f.responses[0]!._automaticTerminalResponseId!)!.mediaFingerprints,
      ).toHaveLength(1);
      expect(countSlackAutomaticPendingReplies()).toBe(0);
    } finally {
      build.mockRestore();
      unregisterRuntimeProvider(provider);
    }
  }, 20_000);

  it("clears pending ownership on accepted queued cancellation and cannot revive it", async () => {
    const f = await fixture();
    await f.run(
      (async function* () {
        yield* imageEvents("cancelled-continuation");
        f.streaming.currentTurnYieldContinuationId = "continuation";
        yield { type: "turn.complete", usage: { inputTokens: 0, outputTokens: 0 } };
      })(),
    );
    expect(countSlackAutomaticPendingReplies()).toBe(1);
    await projectChannelRuntimeEvent({ metadata: f.metadata, event: { type: "turn.interrupted" } });
    expect(countSlackAutomaticPendingReplies()).toBe(0);
    expect(() => getSlackAutomaticPendingReply(f.metadata)).toThrow("already terminal");
    f.replaceStreaming();
    await f.run(
      (async function* () {
        yield final("A cancelled turn cannot return");
        yield { type: "turn.complete", usage: { inputTokens: 0, outputTokens: 0 } };
      })(),
    );
    expect(f.responses).toHaveLength(0);
    expect(f.outputs).toHaveLength(0);
  });

  it("rejected terminal events cannot discard pending membership", async () => {
    const f = await fixture();
    const pending = getSlackAutomaticPendingReply(f.metadata)!;
    await expect(
      projectChannelRuntimeEvent({
        metadata: { ...f.metadata, binding: { ...f.metadata.binding, turnId: "nonexistent-turn" } },
        event: { type: "turn.interrupted" },
      }),
    ).rejects.toThrow();
    expect(getSlackAutomaticPendingReply(f.metadata)).toBe(pending);
    expect(countSlackAutomaticPendingReplies()).toBe(1);
    await projectChannelRuntimeEvent({ metadata: f.metadata, event: { type: "turn.interrupted" } });
    expect(countSlackAutomaticPendingReplies()).toBe(0);
  });

  for (const reopenDatabase of [false, true]) {
    it(`retains media across new host objects (database reopen=${reopenDatabase})`, async () => {
      const f = await fixture();
      await f.run(
        (async function* () {
          yield* imageEvents("before-restart");
          yield final("Image generated; continuing work");
          f.streaming.currentTurnYieldContinuationId = "logical-continuation";
          yield { type: "turn.complete", usage: { inputTokens: 0, outputTokens: 0 } };
        })(),
      );
      const before = f.responses.length;
      if (reopenDatabase) {
        closeSessionStore();
        closeRouterDb();
      }
      const originalStreaming = f.streaming;
      f.replaceStreaming();
      expect(f.streaming).not.toBe(originalStreaming);
      await f.run(
        (async function* () {
          yield final("Completed the same request after a runtime restart");
          yield { type: "turn.complete", usage: { inputTokens: 0, outputTokens: 0 } };
        })(),
      );
      const context = resolveSlackAutomaticOutputContextFromBinding(f.metadata.binding)!;
      const manifest = getSlackAutomaticTerminalManifest(
        slackAutomaticTerminalResponseId(context.turnId, context.target),
      );
      expect(f.outputs).toHaveLength(1);
      expect(before).toBe(0);
      expect(f.responses).toHaveLength(1);
      expect(manifest?.mediaFingerprints).toHaveLength(1);
      expect(renderSlackBackendOutput(f.outputs[0]!)).toBe("Completed the same request after a runtime restart");
      expect(countSlackAutomaticPendingReplies()).toBe(0);
      expect(() => getSlackAutomaticPendingReply(f.metadata)).toThrow("already terminal");
    });
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
