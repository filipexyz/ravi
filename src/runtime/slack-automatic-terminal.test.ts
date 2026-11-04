import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configStore } from "../config-store.js";
import { nats } from "../nats.js";
import { dbCreateAgent, dbGetAgent, dbUpsertChannel, dbUpsertChat, dbUpsertChatMessage } from "../router/router-db.js";
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
  freezeSlackAutomaticTerminalManifest,
  getSlackAutomaticTerminalManifest,
  slackAutomaticTerminalResponseId,
} from "../channels/slack/automatic-terminal-manifest.js";
import { renderSlackBackendOutput } from "../channels/slack/driver.js";
import { runRuntimeEventLoop } from "./host-event-loop.js";
import type { RuntimeHostStreamingSession, RuntimeUserMessage } from "./host-session.js";
import { createQueuedRuntimeUserMessage } from "./delivery-queue.js";
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
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  setChannelBackendPromptPublisherForTests();
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

async function fixture(senderKind: "bot" | "user" = "bot", failSink?: "runtime" | "output") {
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
  const streaming: RuntimeHostStreamingSession = {
    agentId: "agent-a",
    queryHandle: { provider: "test-provider", events: (async function* () {})(), async interrupt() {} },
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
  const stashedMessages = new Map<string, RuntimeUserMessage[]>();
  const run = async (events: AsyncIterable<RuntimeEvent>) => {
    const runtimeSession: RuntimeSessionHandle = { provider: "test-provider", events, async interrupt() {} };
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
      defaultRuntimeProviderId: "test-provider",
      streamingSessions: new Map([[session.name!, streaming]]),
      stashedMessages,
      safeEmit: async () => {},
      drainPendingStarts() {},
    });
  };
  return { metadata, session, streaming, responses, outputs, stashedMessages, run };
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

describe("native bot terminal grouping in the host", () => {
  it("preserves terminal text and all media ordinals when one file disappears before freeze", async () => {
    const f = await fixture();
    await f.run(
      (async function* () {
        yield* imageEvents("missing-file");
        yield* imageEvents("valid-file");
        const hash = createHash("sha256").update(Buffer.from(imageBase64, "base64")).digest("hex").slice(0, 16);
        unlinkSync(join(tmpdir(), `ravi-generated-media-terminal-session-missing-file-${hash}.png`));
        yield final();
        yield { type: "turn.complete", usage: { inputTokens: 0, outputTokens: 0 } };
      })(),
    );
    expect(f.outputs).toHaveLength(1);
    expect(f.responses).toHaveLength(1);
    expect(f.responses[0]!.content).toHaveLength(2);
    const manifest = getSlackAutomaticTerminalManifest(f.responses[0]!._automaticTerminalResponseId!)!;
    expect(manifest.mediaAvailabilityErrors).toEqual(["file_unavailable", null]);
  });

  for (const sink of ["runtime", "output"] as const) {
    it(`releases frozen media independently of a failed ${sink} projection sink`, async () => {
      const f = await fixture("bot", sink);
      await f.run(
        (async function* () {
          yield* imageEvents("independent-media");
          yield final();
          yield { type: "turn.complete", usage: { inputTokens: 0, outputTokens: 0 } };
        })(),
      );
      expect(f.responses).toHaveLength(1);
      const manifest = getSlackAutomaticTerminalManifest(f.responses[0]!._automaticTerminalResponseId!)!;
      expect(manifest.kind).toBe("final_answer");
      expect(manifest.mediaFingerprints).toHaveLength(1);
      expect(f.outputs).toHaveLength(sink === "runtime" ? 1 : 0);
    });
  }

  it("does not freeze a cancelled reply when the existing recovery decision replays the same input", async () => {
    const f = await fixture();
    const queued = createQueuedRuntimeUserMessage({ prompt: "Generate two images", _channelBackend: f.metadata });
    f.streaming.toolEffectFence = "host_write_ahead";
    f.streaming.pendingMessages = [queued];
    f.streaming.currentTurnPendingIds = [queued.pendingId!];
    await f.run(
      (async function* () {
        yield { type: "turn.failed", error: "fixture transport failed", failureKind: "transport", recoverable: true };
      })(),
    );
    const context = resolveSlackAutomaticOutputContextFromBinding(f.metadata.binding)!;
    expect(f.stashedMessages.get(f.session.name!)?.[0]?.launchPrompt?._channelBackend).toEqual(f.metadata);
    expect(
      getSlackAutomaticTerminalManifest(slackAutomaticTerminalResponseId(context.turnId, context.target)),
    ).toBeNull();
    // Proves only that admission has no premature cancellation tombstone. The
    // existing interrupted channel runtime event remains owned by recovery.
    expect(
      freezeSlackAutomaticTerminalManifest({ ...context, kind: "final_answer", text: "Recovered", media: [] }).kind,
    ).toBe("final_answer");
  });

  it("defers all attachments until completion and ignores a later attach/source change", async () => {
    const f = await fixture();
    const longText = "A complete paragraph. ".repeat(3_000) + "FINAL_MARKER";
    await f.run(
      (async function* () {
        yield* imageEvents("image-1");
        yield* imageEvents("image-2");
        expect(f.responses).toHaveLength(0);
        const otherChat = dbUpsertChat({
          channel: "slack",
          instanceId: "local",
          platformChatId: "COTHER",
          chatType: "group",
        });
        attachChatToSession({ sessionKey: f.session.sessionKey, chatId: otherChat.id, setOutputTarget: true });
        f.streaming.currentSource = { channel: "slack", accountId: "local", chatId: "COTHER", actorType: "contact" };
        yield final(longText);
        expect(f.responses).toHaveLength(0);
        expect(f.outputs).toHaveLength(0);
        yield { type: "turn.complete", usage: { inputTokens: 0, outputTokens: 0 } };
      })(),
    );
    expect(f.outputs).toHaveLength(1);
    expect(renderSlackBackendOutput(f.outputs[0]!)).toContain("FINAL_MARKER");
    expect(f.responses).toHaveLength(1);
    expect(f.responses[0]?.content).toHaveLength(2);
    expect(f.responses[0]?.target).toMatchObject({ chatId: "C123", threadId: "1.000001" });
    expect(f.responses[0]?._automaticOutputOrigin?.binding).toEqual(f.metadata.binding);
    const manifest = getSlackAutomaticTerminalManifest(f.responses[0]!._automaticTerminalResponseId!)!;
    for (const [index, part] of f.responses[0]!.content!.entries()) {
      if (part.type === "media")
        expect(assertSlackAutomaticTerminalPart(manifest, { ...part, index })).toContain(":media:");
    }
  });

  it("retains deferred attachments across a physical yield and releases only the real terminal", async () => {
    const f = await fixture();
    await f.run(
      (async function* () {
        yield* imageEvents("first-physical-turn");
        yield final("The first attachment is ready; work continues.");
        f.streaming.currentTurnYieldContinuationId = "continuation";
        yield { type: "turn.complete", usage: { inputTokens: 0, outputTokens: 0 } };
        expect(f.responses).toHaveLength(0);
        expect(f.outputs).toHaveLength(0);
        f.streaming.currentChannelBackend = f.metadata;
        f.streaming.currentTurnYieldContinuationId = undefined;
        f.streaming.turnActive = true;
        yield* imageEvents("second-physical-turn");
        yield final("Both attachments are ready.");
        yield { type: "turn.complete", usage: { inputTokens: 0, outputTokens: 0 } };
      })(),
    );
    expect(f.outputs).toHaveLength(1);
    expect(f.responses).toHaveLength(1);
    expect(f.responses[0]?.content).toHaveLength(2);
  });

  for (const failure of ["turn.failed", "turn.interrupted"] as const) {
    it(`discards deferred attachments on ${failure} without a pending media replay`, async () => {
      const f = await fixture();
      await f.run(
        (async function* () {
          yield* imageEvents("discarded");
          yield failure === "turn.failed"
            ? { type: "turn.failed", error: "terminal failure", recoverable: false }
            : { type: "turn.interrupted" };
        })(),
      );
      expect(f.responses).toHaveLength(0);
      expect(f.outputs).toHaveLength(failure === "turn.failed" ? 1 : 0);
      const context = resolveSlackAutomaticOutputContextFromBinding(f.metadata.binding)!;
      const manifest = getSlackAutomaticTerminalManifest(
        slackAutomaticTerminalResponseId(context.turnId, context.target),
      )!;
      expect(manifest.kind).toBe(failure === "turn.failed" ? "safe_error" : "cancelled");
      expect(manifest.mediaFingerprints).toEqual([]);
    });
  }

  it("preserves the existing human media timing", async () => {
    const f = await fixture("user");
    await f.run(
      (async function* () {
        yield* imageEvents("human-image");
        yield final();
        expect(f.responses).toHaveLength(1);
        expect(f.responses[0]?._automaticTerminalResponseId).toBeUndefined();
        yield { type: "turn.complete", usage: { inputTokens: 0, outputTokens: 0 } };
      })(),
    );
    expect(f.responses).toHaveLength(1);
    expect(f.outputs).toHaveLength(1);
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
