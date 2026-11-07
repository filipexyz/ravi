import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
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
import {
  attachChatToSession,
  getOrCreateSession,
  resolveSession,
  updateRuntimeProviderState,
  updateSessionRuntimeProviderOverride,
} from "../router/sessions.js";
import { recordAdapterRequestTrace } from "../session-trace/runtime-trace.js";
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
  countSlackAutomaticPendingReplies,
  getSlackAutomaticPendingReply,
} from "../channels/slack/automatic-pending-reply.js";
import {
  assertSlackAutomaticTerminalPart,
  freezeSlackAutomaticTerminalManifest,
  getSlackAutomaticTerminalManifest,
  slackAutomaticTerminalResponseId,
  type SlackAutomaticTerminalManifest,
} from "../channels/slack/automatic-terminal-manifest.js";
import { renderSlackBackendOutput } from "../channels/slack/driver.js";
import { runRuntimeEventLoop } from "./host-event-loop.js";
import type { RuntimeHostStreamingSession, RuntimeUserMessage } from "./host-session.js";
import { createQueuedRuntimeUserMessage, createRuntimeMessageGenerator } from "./delivery-queue.js";
import { RuntimeCrashRecoveryCoordinator } from "./crash-recovery.js";
import { PROVIDER_CAPACITY_EXHAUSTED_MESSAGE, PROVIDER_CAPACITY_UNSAFE_MESSAGE } from "./provider-capacity-retry.js";
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

/**
 * Creates a real accepted Slack binding in the suite's isolated state and
 * captures responses and outputs while run drives the host loop with synthetic
 * provider events. Bot output must match its persisted terminal manifest.
 * The runtime sink calls onRuntimeTerminal synchronously for terminal_output
 * and completed state events, before any injected runtime failure; the hook
 * may therefore run more than once. failSink can also reject output capture.
 * afterEach restores spies, unregisters sinks, and owns test-state teardown.
 */
async function fixture(
  senderKind: "bot" | "user" = "bot",
  failSink?: "runtime" | "output",
  onRuntimeTerminal?: (metadata: ChannelBackendPromptMetadata) => void,
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
        if (
          event.kind === "turn.terminal_output" ||
          (event.kind === "turn.state_changed" && event.payload.state === "completed")
        ) {
          onRuntimeTerminal?.(metadata);
        }
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
  const run = async (
    events: AsyncIterable<RuntimeEvent>,
    overrides: Partial<Parameters<typeof runRuntimeEventLoop>[0]> = {},
  ) => {
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
      ...overrides,
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
  for (const effects of [false, true]) {
    it(`freezes the normalized capacity terminal only after retries and preserves next-provider state (effects=${effects})`, async () => {
      const f = await fixture();
      const context = resolveSlackAutomaticOutputContextFromBinding(f.metadata.binding)!;
      const responseId = slackAutomaticTerminalResponseId(context.turnId, context.target);
      const recovery = new RuntimeCrashRecoveryCoordinator({ instanceId: "capacity-manifest-test" });
      recovery.start();
      cleanups.push(() => recovery.stopGracefully());
      f.streaming.toolEffectFence = "provider_event_only";
      f.streaming.turnActive = false;
      f.streaming.pendingMessages = [
        createQueuedRuntimeUserMessage({
          prompt: "Original capacity request",
          _agentId: f.streaming.agentId,
          _channelBackend: f.metadata,
          source: f.streaming.currentSource,
        }),
      ];
      let now = 1_000;
      let attempts = 0;
      const waits: number[] = [];
      const inputs: string[] = [];
      const generator = createRuntimeMessageGenerator({
        sessionName: f.session.name!,
        session: f.streaming,
        stashedMessages: f.stashedMessages,
        capacityRetryRuntime: { now: () => now },
        traceTurnStart: ({ combinedPrompt, deliverableMessages }) => {
          const trace = recordAdapterRequestTrace({
            sessionKey: f.session.sessionKey,
            sessionName: f.session.name!,
            agentId: f.streaming.agentId!,
            turnId: `capacity-manifest-${attempts + 1}`,
            runId: "run-a",
            provider: "test-provider",
            model: "test",
            prompt: combinedPrompt,
            systemPrompt: "Fixture",
            cwd: stateDir!,
            resume: false,
            fork: false,
            source: f.streaming.currentSource,
            deliveryBarrier: "after_response",
            hasHooks: false,
            pluginNames: [],
            mcpServerNames: [],
            hasRemoteSpawn: false,
            toolAccessMode: "restricted",
            capabilitySummary: { ...capabilities },
          });
          if (!trace) throw new Error("Missing capacity fixture trace");
          const attempt = recovery.startTurnAttempt({
            turnId: trace.turnId,
            runId: "run-a",
            sessionKey: f.session.sessionKey,
            sessionName: f.session.name!,
            agentId: f.streaming.agentId!,
            provider: "test-provider",
            model: "test",
            startedAt: trace.startedAt,
            requestBlobSha256: trace.requestBlobSha256,
            userPromptSha256: trace.userPromptSha256,
            systemPromptSha256: trace.systemPromptSha256,
            originKind: "human",
            source: f.streaming.currentSource,
            deliveryBarrier: "after_response",
            pendingIds: deliverableMessages.map((message) => message.pendingId!),
          });
          return { ...trace, crashRecoveryAttemptId: attempt.attemptId };
        },
      });
      const failures: Record<string, unknown>[] = [];
      await f.run(
        (async function* () {
          for await (const input of generator) {
            attempts++;
            inputs.push(String(input.message.content));
            if (attempts === 4) {
              if (effects) {
                yield { type: "tool.started", toolUse: { id: "capacity-effect", name: "Bash", input: {} } };
                yield { type: "tool.completed", toolUseId: "capacity-effect", toolName: "Bash", content: "Done" };
              }
              updateSessionRuntimeProviderOverride(f.session.sessionKey, "codex");
              updateRuntimeProviderState(f.session.sessionKey, "codex", { providerSessionId: "successor-native" });
            }
            yield {
              type: "turn.failed",
              error: "Selected model is at capacity. Please try a different model.",
              preExecutionRejected: true,
              rawEvent: { status: 503 },
              providerSessionId: "old-capacity-native",
            };
            if (!f.streaming.interrupted) break;
          }
        })(),
        {
          crashRecovery: recovery,
          capacityRetryRuntime: {
            now: () => now,
            random: () => 0,
            wait: async (delayMs) => {
              waits.push(delayMs);
              now += delayMs;
              expect(getSlackAutomaticTerminalManifest(responseId)).toBeNull();
              expect(f.outputs).toEqual([]);
              expect(dbGetChannelBackendRuntimeState(f.metadata.binding.turnId)?.state).not.toBe("failed");
            },
          },
          safeEmit: async (_topic, data) => {
            if (data.type === "turn.failed") failures.push(data);
          },
        },
      );
      expect(attempts).toBe(4);
      expect(waits).toEqual([500, 1_000, 2_000]);
      expect(inputs).toEqual(Array(4).fill("Original capacity request"));
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({
        failureKind: effects ? "provider_capacity_retry_unsafe" : "provider_capacity_exhausted",
        error: effects ? PROVIDER_CAPACITY_UNSAFE_MESSAGE : PROVIDER_CAPACITY_EXHAUSTED_MESSAGE,
      });
      expect(f.outputs).toHaveLength(1);
      expect(f.outputs[0]!.error).toMatchObject({ code: "OVERLOADED", retryable: !effects });
      const text = renderSlackBackendOutput(f.outputs[0]!);
      if (effects) {
        expect(text).toContain("Your session and completed work are preserved");
        expect(text).toContain("avoid duplicate actions");
        expect(text).not.toContain("Please try again shortly");
      }
      const manifest = getSlackAutomaticTerminalManifest(responseId)!;
      expect(manifest.kind).toBe("safe_error");
      expect(assertSlackAutomaticTerminalPart(manifest, { type: "text", text })).toBe(`${responseId}:text`);
      expect(dbGetChannelBackendRuntimeState(f.metadata.binding.turnId)?.state).toBe("failed");
      expect(resolveSession(f.session.sessionKey)).toMatchObject({
        runtimeProviderOverride: "codex",
        runtimeProvider: "codex",
        providerSessionId: "successor-native",
      });
    });
  }

  it("preserves terminal text and all media ordinals when one file disappears before freeze", async () => {
    const f = await fixture();
    await f.run(
      (async function* () {
        yield* imageEvents("missing-file");
        yield* imageEvents("valid-file");
        const missingPath = getSlackAutomaticPendingReply(f.metadata)!.media[0]!.filePath;
        const openSync = fs.openSync;
        const unavailable = spyOn(fs, "openSync").mockImplementation((...args: Parameters<typeof fs.openSync>) => {
          if (args[0] === missingPath) throw Object.assign(new Error("fixture unavailable media"), { code: "ENOENT" });
          return openSync(...args);
        });
        cleanups.push(() => unavailable.mockRestore());
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

describe("native bot terminal atomic persistence", () => {
  const terminalText = "Complete visible final\n1. Alpha\n2. Beta\nFINAL_MARKER";
  const terminalCases = [
    { name: "text and media", state: "completed", kind: "final_answer", hasText: true },
    { name: "media only", state: "completed", kind: "final_answer", hasText: false },
    { name: "safe error", state: "failed", kind: "safe_error", hasText: true },
    { name: "cancellation", state: "interrupted", kind: "cancelled", hasText: true },
  ] as const;

  function terminalEvent(state: (typeof terminalCases)[number]["state"]): RuntimeEvent {
    if (state === "completed") return { type: "turn.complete", usage: { inputTokens: 0, outputTokens: 0 } };
    if (state === "failed") {
      return { type: "turn.failed", error: "private_failure_marker", recoverable: false };
    }
    return { type: "turn.interrupted" };
  }

  for (const terminal of terminalCases) {
    it(`commits ${terminal.name} before a real SQLite writer enters the terminal sink`, async () => {
      let writer: Database | undefined;
      const observed: Array<{
        state: string;
        sequence: number;
        manifest: SlackAutomaticTerminalManifest | null;
        assistantContent: unknown;
        pendingReplies: number;
      }> = [];
      const f = await fixture("bot", undefined, (metadata) => {
        // A genuinely independent writer wins this seam. The whole terminal
        // must already be visible from its connection before notification.
        writer!.exec("BEGIN IMMEDIATE");
        try {
          const runtime = writer!
            .query(
              "SELECT state, last_sequence, assistant_message_id FROM channel_backend_runtime_state WHERE turn_id = ?",
            )
            .get(metadata.binding.turnId) as {
            state: string;
            last_sequence: number;
            assistant_message_id: string | null;
          };
          const manifestRow = writer!
            .query("SELECT manifest_json FROM slack_automatic_terminal_manifests WHERE response_id = ?")
            .get(responseId) as { manifest_json: string } | null;
          const assistantRow = runtime.assistant_message_id
            ? (writer!
                .query("SELECT content_json FROM chat_messages WHERE id = ?")
                .get(runtime.assistant_message_id) as { content_json: string } | null)
            : null;
          observed.push({
            state: runtime.state,
            sequence: runtime.last_sequence,
            manifest: manifestRow ? JSON.parse(manifestRow.manifest_json) : null,
            assistantContent: assistantRow ? JSON.parse(assistantRow.content_json) : null,
            pendingReplies: countSlackAutomaticPendingReplies(),
          });
        } finally {
          writer!.exec("ROLLBACK");
        }
      });
      const context = resolveSlackAutomaticOutputContextFromBinding(f.metadata.binding)!;
      const responseId = slackAutomaticTerminalResponseId(context.turnId, context.target);
      expect(getSlackAutomaticTerminalManifest(responseId)).toBeNull();
      writer = new Database(getDb().filename, { create: false, readwrite: true });
      writer.exec("PRAGMA busy_timeout = 1");
      try {
        await f.run(
          (async function* () {
            yield* imageEvents("atomic-visible-A");
            yield* imageEvents("atomic-visible-B");
            if (terminal.hasText) yield final(terminalText);
            yield terminalEvent(terminal.state);
          })(),
        );
      } finally {
        writer.close();
      }

      expect(observed).toHaveLength(1);
      expect(observed[0]).toMatchObject({
        state: terminal.state,
        pendingReplies: 0,
        manifest: {
          responseId,
          kind: terminal.kind,
          turnId: context.turnId,
          target: context.target,
        },
      });
      expect(observed[0]!.sequence).toBe(dbGetChannelBackendRuntimeState(context.turnId)!.lastSequence);
      expect(observed[0]!.manifest).toEqual(getSlackAutomaticTerminalManifest(responseId));
      expect(observed[0]!.manifest!.mediaFingerprints).toHaveLength(terminal.state === "completed" ? 2 : 0);
      expect(observed[0]!.assistantContent).toEqual(
        terminal.state === "completed" && terminal.hasText ? { blocks: [{ type: "text", text: terminalText }] } : null,
      );
      expect(f.responses).toHaveLength(terminal.state === "completed" ? 1 : 0);
      if (terminal.state === "completed") {
        expect(f.responses[0]!._automaticTerminalResponseId).toBe(responseId);
        expect(f.responses[0]!.content).toHaveLength(2);
        for (const [index, part] of f.responses[0]!.content!.entries()) {
          if (part.type === "media") {
            expect(assertSlackAutomaticTerminalPart(observed[0]!.manifest!, { ...part, index })).toContain(":media:");
          }
        }
      }
      expect(f.outputs).toHaveLength(
        terminal.state === "failed" || (terminal.state === "completed" && terminal.hasText) ? 1 : 0,
      );
      if (terminal.state === "completed" && terminal.hasText) {
        expect(renderSlackBackendOutput(f.outputs[0]!)).toBe(terminalText);
      } else if (terminal.state === "failed") {
        expect(f.outputs[0]!.kind).toBe("safe_error");
        expect(renderSlackBackendOutput(f.outputs[0]!)).not.toContain("private_failure_marker");
      }
    });

    it(`rolls back ${terminal.name} and retains its collector when SQLite aborts the manifest insert`, async () => {
      let terminalNotifications = 0;
      const f = await fixture("bot", undefined, () => terminalNotifications++);
      const context = resolveSlackAutomaticOutputContextFromBinding(f.metadata.binding)!;
      const responseId = slackAutomaticTerminalResponseId(context.turnId, context.target);
      expect(getSlackAutomaticTerminalManifest(responseId)).toBeNull();
      const database = getDb();
      // Exercise the real SQLite transaction boundary, including preceding
      // assistant/state writes. No persistence helper is mocked.
      database.exec(`CREATE TRIGGER abort_terminal_manifest_insert
        BEFORE INSERT ON slack_automatic_terminal_manifests
        BEGIN SELECT RAISE(ABORT, 'fixture manifest insert aborted'); END`);
      let before: ReturnType<typeof dbGetChannelBackendRuntimeState> = null;
      let collector: ReturnType<typeof getSlackAutomaticPendingReply>;
      try {
        await f.run(
          (async function* () {
            yield* imageEvents("atomic-rollback-A");
            yield* imageEvents("atomic-rollback-B");
            if (terminal.hasText) yield final(terminalText);
            before = dbGetChannelBackendRuntimeState(context.turnId);
            collector = getSlackAutomaticPendingReply(f.metadata);
            expect(before?.state).toBe("running");
            expect(collector?.media).toHaveLength(2);
            yield terminalEvent(terminal.state);
          })(),
        );
      } finally {
        database.exec("DROP TRIGGER abort_terminal_manifest_insert");
      }

      const pendingReplies = countSlackAutomaticPendingReplies();
      const retained = pendingReplies === 1 ? getSlackAutomaticPendingReply(f.metadata) : undefined;
      const assistantRows = database
        .query("SELECT COUNT(*) AS count FROM chat_messages WHERE actor_type = 'agent' AND origin_session_key = ?")
        .get(f.session.sessionKey) as { count: number };
      // One assertion reports all partial-commit symptoms on the old code;
      // lastSequence and the assistant id are included in the runtime object.
      expect({
        runtime: dbGetChannelBackendRuntimeState(context.turnId),
        assistantRows: assistantRows.count,
        manifest: getSlackAutomaticTerminalManifest(responseId),
        pendingReplies,
        pendingMedia: retained?.media.length ?? 0,
        terminalNotifications,
        outputs: f.outputs.length,
        mediaReleases: f.responses.length,
      }).toEqual({
        runtime: before,
        assistantRows: 0,
        manifest: null,
        pendingReplies: 1,
        pendingMedia: 2,
        terminalNotifications: 0,
        outputs: 0,
        mediaReleases: 0,
      });
      expect(retained).toBe(collector);
      expect(retained!.manifest).toBeUndefined();
      expect(retained!.mediaReleased).toBeUndefined();
      expect(retained!.mediaKeys.size).toBe(2);
    });
  }
  it("retains media-only output when SQLite refuses the runtime transition", async () => {
    const f = await fixture();
    const context = resolveSlackAutomaticOutputContextFromBinding(f.metadata.binding)!;
    const responseId = slackAutomaticTerminalResponseId(context.turnId, context.target);
    const database = getDb();
    let before: ReturnType<typeof dbGetChannelBackendRuntimeState> = null;
    let collector: ReturnType<typeof getSlackAutomaticPendingReply>;
    database.exec(`CREATE TRIGGER refuse_media_only_transition
      BEFORE UPDATE ON channel_backend_runtime_state WHEN NEW.state = 'completed'
      BEGIN SELECT RAISE(ABORT, 'fixture terminal transition refused'); END`);
    try {
      await f.run(
        (async function* () {
          yield* imageEvents("transition-refusal-A");
          before = dbGetChannelBackendRuntimeState(context.turnId);
          collector = getSlackAutomaticPendingReply(f.metadata);
          yield { type: "turn.complete", usage: { inputTokens: 0, outputTokens: 0 } } as RuntimeEvent;
        })(),
      );
    } finally {
      database.exec("DROP TRIGGER refuse_media_only_transition");
    }
    expect(dbGetChannelBackendRuntimeState(context.turnId)).toEqual(before);
    expect(getSlackAutomaticTerminalManifest(responseId)).toBeNull();
    expect(countSlackAutomaticPendingReplies()).toBe(1);
    expect(getSlackAutomaticPendingReply(f.metadata)).toBe(collector);
    expect(collector!.manifest).toBeUndefined();
    expect(collector!.media).toHaveLength(1);
    expect(collector!.mediaKeys.size).toBe(1);
    expect(collector!.mediaReleased).toBeUndefined();
    expect(f.outputs).toEqual([]);
    expect(f.responses).toEqual([]);
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
