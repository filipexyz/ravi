import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { explainSessionTrace } from "./explain.js";
import { recordSessionBlob, recordSessionEvent, sha256Text, upsertSessionTurn } from "./session-trace-db.js";
import { parseSessionTraceTime, querySessionTrace } from "./query.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-session-trace-query-test-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function seedCompleteTrace() {
  const systemPrompt = recordSessionBlob({
    kind: "system_prompt",
    contentText: "# Identity\nRavi system prompt",
    createdAt: 1000,
  });
  const userPrompt = recordSessionBlob({
    kind: "user_prompt",
    contentText: "Please inspect the trace",
    createdAt: 1000,
  });
  const request = recordSessionBlob({
    kind: "adapter_request",
    contentJson: { request: "adapter payload", safe: true },
    createdAt: 1000,
  });

  upsertSessionTurn({
    turnId: "turn-1",
    sessionKey: "agent:main:trace-session",
    sessionName: "trace-session",
    runId: "run-1",
    agentId: "main",
    provider: "codex",
    model: "gpt-5.4",
    cwd: "/repo",
    status: "complete",
    resume: true,
    userPromptSha256: userPrompt.sha256,
    systemPromptSha256: systemPrompt.sha256,
    requestBlobSha256: request.sha256,
    inputTokens: 11,
    outputTokens: 7,
    startedAt: 1200,
    completedAt: 1600,
    updatedAt: 1600,
  });

  recordSessionEvent({
    sessionKey: "agent:main:trace-session",
    sessionName: "trace-session",
    agentId: "main",
    eventType: "channel.message.received",
    eventGroup: "channel",
    status: "received",
    timestamp: 1000,
    createdAt: 1000,
    sourceChannel: "whatsapp",
    sourceAccountId: "main",
    sourceChatId: "chat-1",
    messageId: "msg-1",
    preview: "Please inspect the trace",
  });
  recordSessionEvent({
    sessionKey: "agent:main:trace-session",
    sessionName: "trace-session",
    agentId: "main",
    eventType: "prompt.published",
    eventGroup: "prompt",
    status: "published",
    timestamp: 1100,
    createdAt: 1100,
    messageId: "msg-1",
    payloadJson: {
      correlationId: "corr-1",
      taskBarrierTaskId: "task-1",
    },
    preview: "Please inspect the trace",
  });
  recordSessionEvent({
    sessionKey: "agent:main:trace-session",
    sessionName: "trace-session",
    agentId: "main",
    runId: "run-1",
    turnId: "turn-1",
    eventType: "adapter.request",
    eventGroup: "adapter",
    status: "built",
    timestamp: 1200,
    createdAt: 1200,
    provider: "codex",
    model: "gpt-5.4",
    payloadJson: {
      cwd: "/repo",
      resume: true,
      fork: false,
      request_blob_sha256: request.sha256,
      system_prompt_sha256: systemPrompt.sha256,
      system_prompt_chars: 29,
      system_prompt_sections: ["Identity"],
      user_prompt_sha256: userPrompt.sha256,
      user_prompt_chars: 24,
      queued_message_count: 2,
      pending_ids: ["msg-1", "msg-2"],
    },
    preview: "Please inspect the trace",
  });
  recordSessionEvent({
    sessionKey: "agent:main:trace-session",
    sessionName: "trace-session",
    agentId: "main",
    runId: "run-1",
    turnId: "turn-1",
    eventType: "adapter.raw",
    eventGroup: "adapter",
    timestamp: 1210,
    createdAt: 1210,
    payloadJson: { delta: "streamed text" },
  });
  recordSessionEvent({
    sessionKey: "agent:main:trace-session",
    sessionName: "trace-session",
    agentId: "main",
    runId: "run-1",
    turnId: "turn-1",
    eventType: "tool.start",
    eventGroup: "tool",
    timestamp: 1300,
    createdAt: 1300,
    payloadJson: { toolCallId: "tool-1", toolName: "Bash" },
    preview: "Bash rg trace",
  });
  recordSessionEvent({
    sessionKey: "agent:main:trace-session",
    sessionName: "trace-session",
    agentId: "main",
    runId: "run-1",
    turnId: "turn-1",
    eventType: "tool.end",
    eventGroup: "tool",
    timestamp: 1350,
    createdAt: 1350,
    durationMs: 50,
    payloadJson: { toolCallId: "tool-1", toolName: "Bash" },
    preview: "Bash ok",
  });
  recordSessionEvent({
    sessionKey: "agent:main:trace-session",
    sessionName: "trace-session",
    agentId: "main",
    runId: "run-1",
    turnId: "turn-1",
    eventType: "response.emitted",
    eventGroup: "response",
    timestamp: 1400,
    createdAt: 1400,
    payloadJson: { emitId: "emit-1", textLen: 42 },
    preview: "Trace complete",
  });
  recordSessionEvent({
    sessionKey: "agent:main:trace-session",
    sessionName: "trace-session",
    agentId: "main",
    eventType: "delivery.delivered",
    eventGroup: "delivery",
    timestamp: 1500,
    createdAt: 1500,
    payloadJson: { emitId: "emit-1", deliveryMessageId: "out-1" },
    preview: "out-1",
  });
  recordSessionEvent({
    sessionKey: "agent:main:trace-session",
    sessionName: "trace-session",
    agentId: "main",
    runId: "run-1",
    turnId: "turn-1",
    eventType: "turn.complete",
    eventGroup: "runtime",
    timestamp: 1600,
    createdAt: 1600,
    provider: "codex",
    model: "gpt-5.4",
    payloadJson: { status: "complete" },
  });

  return { systemPrompt, userPrompt, request };
}

describe("querySessionTrace", () => {
  it("filters timeline rows and loads requested blobs from session_events/session_turns/session_trace_blobs", () => {
    const blobs = seedCompleteTrace();

    const trace = querySessionTrace({
      session: "trace-session",
      since: 1050,
      until: 1550,
      raw: true,
      showSystemPrompt: true,
      showUserPrompt: true,
    });

    expect(trace.events.map((event) => event.eventType)).toEqual([
      "prompt.published",
      "adapter.request",
      "tool.start",
      "tool.end",
      "response.emitted",
      "delivery.delivered",
    ]);
    expect(trace.turns.map((turn) => turn.turnId)).toEqual(["turn-1"]);
    expect(Object.keys(trace.blobsBySha256).sort()).toEqual(
      [blobs.request.sha256, blobs.systemPrompt.sha256, blobs.userPrompt.sha256].sort(),
    );
    expect(trace.blobsBySha256[blobs.systemPrompt.sha256]?.contentText).toBe("# Identity\nRavi system prompt");
    expect(trace.blobsBySha256[blobs.userPrompt.sha256]?.contentText).toBe("Please inspect the trace");
    expect(trace.blobsBySha256[blobs.request.sha256]?.contentJson).toEqual({
      request: "adapter payload",
      safe: true,
    });
  });

  it("suppresses stream events by default, supports includeStream, only, message, and correlation filters", () => {
    seedCompleteTrace();

    expect(querySessionTrace({ session: "trace-session" }).events.map((event) => event.eventType)).not.toContain(
      "adapter.raw",
    );
    expect(
      querySessionTrace({ session: "trace-session", includeStream: true }).events.map((event) => event.eventType),
    ).toContain("adapter.raw");

    const onlyDelivery = querySessionTrace({ session: "trace-session", only: "delivery" });
    expect(onlyDelivery.events.map((event) => event.eventType)).toEqual(["delivery.delivered"]);
    expect(onlyDelivery.turns).toEqual([]);

    const byMessage = querySessionTrace({ session: "trace-session", messageId: "msg-1" });
    expect(byMessage.events.map((event) => event.eventType)).toEqual(["channel.message.received", "prompt.published"]);

    const byCorrelation = querySessionTrace({ session: "trace-session", correlationId: "corr-1" });
    expect(byCorrelation.events.map((event) => event.eventType)).toEqual(["prompt.published"]);

    const onlyStream = querySessionTrace({ session: "trace-session", only: "stream", includeStream: true });
    expect(onlyStream.events.map((event) => event.eventType)).toEqual(["adapter.raw"]);
    expect(onlyStream.events.map((event) => event.eventGroup)).toEqual(["stream"]);

    const onlyAdapterWithStream = querySessionTrace({ session: "trace-session", only: "adapter", includeStream: true });
    expect(onlyAdapterWithStream.events.map((event) => event.eventType)).toEqual(["adapter.request"]);
  });

  it("limits the latest visible timeline rows after filters", () => {
    seedCompleteTrace();

    const trace = querySessionTrace({ session: "trace-session", limit: 2 });
    expect(trace.events.map((event) => event.eventType)).toEqual(["delivery.delivered", "turn.complete"]);
    expect(trace.turns).toEqual([]);
  });

  it("loads the latest session system prompt without requiring the turn in the visible timeline", () => {
    const blobs = seedCompleteTrace();

    const trace = querySessionTrace({
      session: "trace-session",
      limit: 2,
      showSystemPrompt: true,
    });

    expect(trace.events.map((event) => event.eventType)).toEqual(["delivery.delivered", "turn.complete"]);
    expect(trace.turns).toEqual([]);
    expect(trace.systemPrompt?.sha256).toBe(blobs.systemPrompt.sha256);
    expect(trace.systemPrompt?.turnId).toBe("turn-1");
    expect(trace.blobsBySha256[blobs.systemPrompt.sha256]?.contentText).toBe("# Identity\nRavi system prompt");
  });

  it("parses trace times from durations, epoch ms, and ISO timestamps", () => {
    const now = Date.UTC(2026, 3, 19, 12, 0, 0);
    expect(parseSessionTraceTime("2h", now)).toBe(now - 7_200_000);
    expect(parseSessionTraceTime("1234", now)).toBe(1234);
    expect(parseSessionTraceTime("2026-04-19T12:00:00.000Z", now)).toBe(now);
  });
});

describe("explainSessionTrace", () => {
  it("derives common incident patterns from the read model", () => {
    recordSessionEvent({
      sessionKey: "agent:main:bad-trace",
      sessionName: "bad-trace",
      eventType: "prompt.published",
      eventGroup: "prompt",
      timestamp: 10,
      createdAt: 10,
      preview: "stuck prompt",
    });
    recordSessionEvent({
      sessionKey: "agent:main:bad-trace",
      sessionName: "bad-trace",
      runId: "run-2",
      turnId: "turn-2",
      eventType: "adapter.request",
      eventGroup: "adapter",
      timestamp: 20,
      createdAt: 20,
      provider: "codex",
      model: "gpt-5.4",
      payloadJson: {
        resume: false,
        provider_session_id_before: "resp_existing",
      },
    });
    upsertSessionTurn({
      turnId: "turn-2",
      sessionKey: "agent:main:bad-trace",
      sessionName: "bad-trace",
      runId: "run-2",
      provider: "codex",
      model: "gpt-5.4",
      status: "running",
      resume: false,
      providerSessionIdBefore: "resp_existing",
      startedAt: 20,
      updatedAt: 20,
    });
    recordSessionEvent({
      sessionKey: "agent:main:bad-trace",
      sessionName: "bad-trace",
      runId: "run-2",
      turnId: "turn-2",
      eventType: "tool.start",
      eventGroup: "tool",
      timestamp: 30,
      createdAt: 30,
      payloadJson: { toolCallId: "tool-lost", toolName: "Bash" },
    });
    recordSessionEvent({
      sessionKey: "agent:main:bad-trace",
      sessionName: "bad-trace",
      runId: "run-2",
      turnId: "turn-2",
      eventType: "response.emitted",
      eventGroup: "response",
      timestamp: 40,
      createdAt: 40,
      payloadJson: { emitId: "emit-lost" },
    });
    recordSessionEvent({
      sessionKey: "agent:main:bad-trace",
      sessionName: "bad-trace",
      eventType: "delivery.failed",
      eventGroup: "delivery",
      timestamp: 50,
      createdAt: 50,
      payloadJson: { emitId: "emit-other" },
      error: "channel rejected message",
    });

    const explanation = explainSessionTrace(querySessionTrace({ session: "bad-trace" }));
    const codes = explanation.findings.map((finding) => finding.code);

    expect(explanation.status).toBe("attention");
    expect(codes).toContain("adapter-request-without-terminal-turn");
    expect(codes).toContain("response-without-delivery");
    expect(codes).toContain("delivery-failed");
    expect(codes).toContain("resume-disabled-with-provider-session");
    expect(codes).toContain("tool-start-without-end");
  });

  it("reports only informational findings for a completed trace with task barrier and debounce metadata", () => {
    const blobs = seedCompleteTrace();
    expect(blobs.systemPrompt.sha256).toBe(sha256Text("# Identity\nRavi system prompt"));

    const explanation = explainSessionTrace(querySessionTrace({ session: "trace-session" }));

    expect(explanation.findings.every((finding) => finding.severity === "info")).toBe(true);
    expect(explanation.findings.map((finding) => finding.code)).toContain("prompt-held-by-task-barrier");
    expect(explanation.findings.map((finding) => finding.code)).toContain("debounce-merged-messages");
  });

  it("uses concrete emit and tool ids instead of matching unrelated empty targets", () => {
    recordSessionEvent({
      sessionKey: "agent:main:edge-trace",
      sessionName: "edge-trace",
      runId: "run-edge",
      turnId: "turn-edge",
      eventType: "tool.start",
      eventGroup: "tool",
      timestamp: 10,
      createdAt: 10,
      payloadJson: { toolId: "tool-real", toolName: "Bash" },
    });
    recordSessionEvent({
      sessionKey: "agent:main:edge-trace",
      sessionName: "edge-trace",
      runId: "run-edge",
      turnId: "turn-edge",
      eventType: "tool.end",
      eventGroup: "tool",
      timestamp: 20,
      createdAt: 20,
      payloadJson: { toolId: "tool-real", toolName: "Bash" },
    });
    recordSessionEvent({
      sessionKey: "agent:main:edge-trace",
      sessionName: "edge-trace",
      runId: "run-edge",
      turnId: "turn-edge",
      eventType: "response.emitted",
      eventGroup: "response",
      timestamp: 30,
      createdAt: 30,
      payloadJson: {},
    });
    recordSessionEvent({
      sessionKey: "agent:main:edge-trace",
      sessionName: "edge-trace",
      eventType: "delivery.delivered",
      eventGroup: "delivery",
      timestamp: 40,
      createdAt: 40,
      payloadJson: { emitId: "other-emit" },
    });

    const codes = explainSessionTrace(querySessionTrace({ session: "edge-trace" })).findings.map(
      (finding) => finding.code,
    );

    expect(codes).not.toContain("tool-start-without-end");
    expect(codes).toContain("response-without-delivery");
  });
});
