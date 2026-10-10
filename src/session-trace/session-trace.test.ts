import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { attachChatToSession, getOrCreateSession, updateSessionName } from "../router/sessions.js";
import { dbUpsertChat } from "../router/router-db.js";
import {
  PROMPT_TRACE_TEXT_MAX_CHARS,
  recordDeliveryTrace,
  recordPromptPublishedTrace,
  recordResponseEmittedTrace,
} from "./channel-trace.js";
import { querySessionTrace } from "./query.js";
import { recordAdapterRequestTrace } from "./runtime-trace.js";
import {
  getSessionTraceBlob,
  listRecentSessionEventsByType,
  listSessionEvents,
  recordSessionEvent,
} from "./session-trace-db.js";

let stateDir: string | null = null;

function recordTraceEvent(eventType: string, eventGroup: string, timestamp: number) {
  recordSessionEvent({
    sessionKey: "agent:main:trace-limit",
    sessionName: "trace-limit",
    agentId: "main",
    eventType,
    eventGroup,
    timestamp,
    createdAt: timestamp,
  });
}

describe("session trace query", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-session-trace-limit-test-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("applies stream suppression before the bounded timeline limit", () => {
    recordTraceEvent("channel.message.received", "channel", 1000);
    recordTraceEvent("adapter.raw", "adapter", 1100);
    recordTraceEvent("tool.start", "tool", 1200);
    recordTraceEvent("response.emitted", "response", 1300);

    expect(querySessionTrace({ session: "trace-limit", limit: 2 }).events.map((event) => event.eventType)).toEqual([
      "tool.start",
      "response.emitted",
    ]);

    expect(
      querySessionTrace({ session: "trace-limit", only: "stream", includeStream: true }).events.map(
        (event) => event.eventType,
      ),
    ).toEqual(["adapter.raw"]);
  });

  it("lists recent events by type using newest event ids first", () => {
    recordSessionEvent({
      sessionKey: "agent:main:trace-limit",
      sessionName: "trace-limit",
      agentId: "main",
      eventType: "turn.complete",
      eventGroup: "turn",
      timestamp: 1000,
      createdAt: 1000,
      preview: "old complete",
    });
    recordSessionEvent({
      sessionKey: "agent:main:trace-limit",
      sessionName: "trace-limit",
      agentId: "main",
      eventType: "tool.start",
      eventGroup: "tool",
      timestamp: 1100,
      createdAt: 1100,
      preview: "tool event",
    });
    recordSessionEvent({
      sessionKey: "agent:main:trace-limit",
      sessionName: "trace-limit",
      agentId: "main",
      eventType: "turn.complete",
      eventGroup: "turn",
      timestamp: 1200,
      createdAt: 1200,
      preview: "newer complete",
    });

    expect(
      listRecentSessionEventsByType("agent:main:trace-limit", "turn.complete", { limit: 2 }).map(
        (event) => event.preview,
      ),
    ).toEqual(["newer complete", "old complete"]);
  });

  it("records runtime option sources in the adapter request payload", () => {
    const trace = recordAdapterRequestTrace({
      sessionKey: "agent:main:trace-limit",
      sessionName: "trace-limit",
      agentId: "main",
      runId: "run-runtime-options",
      turnId: "turn-runtime-options",
      provider: "codex",
      model: "gpt-5",
      effort: "high",
      thinking: "normal",
      modelSource: "session_override",
      effortSource: "agent_default",
      thinkingSource: "runtime_default",
      prompt: "hello",
      systemPrompt: "system",
      cwd: "/tmp/main",
      resume: false,
      fork: false,
      hasHooks: false,
      pluginNames: [],
      mcpServerNames: [],
      hasRemoteSpawn: false,
      turnProvenance: {
        origin: "cron",
        background: true,
        automationOriginated: true,
        automationId: "cron:job-1",
        reason: "prompt._cron",
      },
    });

    expect(trace).not.toBeNull();
    expect(getSessionTraceBlob(trace!.requestBlobSha256)?.contentJson).toMatchObject({
      model_source: "session_override",
      effort_source: "agent_default",
      thinking_source: "runtime_default",
      turn_provenance: { origin: "cron", background: true, automationId: "cron:job-1" },
    });
  });

  it("records canonical and provider delivery receipt identity", () => {
    const sessionKey = "agent:main:delivery-receipt";
    const sessionName = "main-delivery-receipt";
    getOrCreateSession(sessionKey, "main", "/tmp/ravi-agent");
    updateSessionName(sessionKey, sessionName);

    recordDeliveryTrace({
      sessionName,
      timestamp: 1_713_000_000_100,
      delivery: {
        status: "delivered",
        messageId: "slack:C123:1713000000.000100",
        canonicalMessageId: "cm_123",
        platformMessageId: "1713000000.000100",
        providerMessageId: "1713000000.000100",
        providerTimestamp: 1_713_000_000_000,
        responsePhase: "commentary",
        idempotencyKey: "runtime:main:emit-1:slack:T1:C123:thread",
        target: { channel: "slack", accountId: "T1", chatId: "C123" },
        emitId: "emit-1",
      },
    });

    expect(listSessionEvents(sessionKey)[0]?.payloadJson).toMatchObject({
      deliveryMessageId: "slack:C123:1713000000.000100",
      canonicalMessageId: "cm_123",
      platformMessageId: "1713000000.000100",
      providerMessageId: "1713000000.000100",
      providerTimestamp: 1_713_000_000_000,
      responsePhase: "commentary",
      idempotencyKey: "runtime:main:emit-1:slack:T1:C123:thread",
    });
  });

  it("resolves response trace canonical chat from session subscription default chat", () => {
    const sessionKey = "agent:main:subscription-target";
    const sessionName = "main-subscription-target";
    getOrCreateSession(sessionKey, "main", "/tmp/ravi-agent");
    updateSessionName(sessionKey, sessionName);
    const chat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "11111111-1111-1111-1111-111111111111",
      platformChatId: "5511999999999@s.whatsapp.net",
      chatType: "dm",
    });
    attachChatToSession({
      sessionKey,
      chatId: chat.id,
      attachedByType: "system",
      attachedReason: "test_subscription_trace_fallback",
      setOutputTarget: true,
    });

    recordResponseEmittedTrace({
      sessionName,
      response: {
        response: "hi",
        target: {
          channel: "whatsapp-baileys",
          accountId: "main",
          chatId: "5511999999999@s.whatsapp.net",
        },
        _emitId: "emit-subscription",
      },
      timestamp: 30,
    });

    const event = listSessionEvents(sessionKey)[0];
    expect(event).toMatchObject({
      eventType: "response.emitted",
      sourceChatId: "5511999999999@s.whatsapp.net",
      canonicalChatId: chat.id,
      actorType: "agent",
      actorAgentId: "main",
    });
  });

  it("stores the full published prompt text instead of a 500-char preview", () => {
    const sessionKey = "agent:main:prompt-full-text";
    const sessionName = "main-prompt-full-text";
    getOrCreateSession(sessionKey, "main", "/tmp/ravi-agent");
    updateSessionName(sessionKey, sessionName);

    const prompt = `${"a".repeat(590)} final words`;
    recordPromptPublishedTrace({ sessionName, timestamp: 40, payload: { prompt } });

    const event = listSessionEvents(sessionKey)[0];
    expect(event?.eventType).toBe("prompt.published");
    expect(event?.preview).toBe(prompt);
    expect(event?.payloadJson).toMatchObject({ promptChars: prompt.length, previewTruncated: false });
  });

  it("caps oversized published prompts and flags the truncation", () => {
    const sessionKey = "agent:main:prompt-capped";
    const sessionName = "main-prompt-capped";
    getOrCreateSession(sessionKey, "main", "/tmp/ravi-agent");
    updateSessionName(sessionKey, sessionName);

    const prompt = "b".repeat(PROMPT_TRACE_TEXT_MAX_CHARS + 10);
    recordPromptPublishedTrace({ sessionName, timestamp: 41, payload: { prompt } });

    const event = listSessionEvents(sessionKey)[0];
    expect(event?.preview).toBe(`${"b".repeat(PROMPT_TRACE_TEXT_MAX_CHARS)}...`);
    expect(event?.payloadJson).toMatchObject({ promptChars: prompt.length, previewTruncated: true });
  });
});
