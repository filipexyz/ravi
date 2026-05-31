import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { dbPruneStaleRows } from "../router/router-db.js";
import type { CloudCredentials } from "../cloud-auth/types.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { getOutboxById, getSyncCursor, inspectSyncRecord } from "../sync/db.js";
import { ConsoleSyncBridge } from "../sync/console-bridge.js";
import { recordSessionBlob, recordSessionEvent, upsertSessionTurn } from "./session-trace-db.js";
import { enqueueTraceExportBatch, pushTraceExportBatch } from "./cloud-trace-export.js";

let stateDir: string;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-trace-export-test-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
});

describe("cloud trace export", () => {
  it("coalesces assistant deltas into one exported assistant message", () => {
    recordSessionEvent({
      sessionKey: "agent:dev",
      eventType: "assistant.delta",
      eventGroup: "response",
      preview: "hel",
      timestamp: 10,
    });
    recordSessionEvent({
      sessionKey: "agent:dev",
      eventType: "assistant.delta",
      eventGroup: "response",
      preview: "lo",
      timestamp: 11,
    });
    recordSessionEvent({
      sessionKey: "agent:dev",
      eventType: "turn.complete",
      eventGroup: "runtime",
      turnId: "turn_1",
      timestamp: 12,
    });

    const result = enqueueTraceExportBatch({ now: 20 });
    expect(result.enqueued).toBe(true);
    expect(result.sourceEvents).toBe(3);
    expect(result.exportedEvents).toBe(2);
    const outbox = getOutboxById(result.outboxId!)!;
    const payload = outbox.payload as Record<string, unknown>;
    expect(payload.session).toMatchObject({ sessionKey: "agent:dev", runtimeProvider: "claude", provider: "claude" });
    expect(Array.isArray(payload.turns)).toBe(true);
    expect(Array.isArray(payload.toolCalls)).toBe(true);
    expect(Array.isArray(payload.blobs)).toBe(true);
    const events = (payload.events ?? []) as Array<Record<string, unknown>>;
    expect(events.map((event) => event.eventType)).toEqual(["message.assistant", "turn.complete"]);
    expect(events[0]?.safePreview).toBe("hello");
  });

  it("exports terminal usage facts without blocking terminal events", () => {
    upsertSessionTurn({
      turnId: "turn_1",
      sessionKey: "agent:dev",
      status: "complete",
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.01,
      startedAt: 1,
      completedAt: 2,
      updatedAt: 2,
    });
    recordSessionEvent({
      sessionKey: "agent:dev",
      turnId: "turn_1",
      eventType: "turn.complete",
      eventGroup: "runtime",
      timestamp: 2,
    });

    const result = enqueueTraceExportBatch();
    const outbox = getOutboxById(result.outboxId!)!;
    const events = ((outbox.payload as Record<string, unknown>).events ?? []) as Array<Record<string, unknown>>;
    expect(events[0]?.usage).toMatchObject({ inputTokens: 10, outputTokens: 5, costUsd: 0.01 });
  });

  it("builds the Console runtime trace contract with runtimeProvider and turn sequence", () => {
    upsertSessionTurn({
      turnId: "turn_1",
      sessionKey: "agent:dev",
      sessionName: "dev",
      runId: "run_1",
      agentId: "dev",
      provider: "codex",
      model: "gpt-5.4",
      status: "complete",
      startedAt: 1,
      completedAt: 3,
      updatedAt: 3,
    });
    recordSessionEvent({
      sessionKey: "agent:dev",
      sessionName: "dev",
      agentId: "dev",
      runId: "run_1",
      turnId: "turn_1",
      eventType: "turn.complete",
      eventGroup: "runtime",
      provider: "codex",
      model: "gpt-5.4",
      timestamp: 3,
    });

    const result = enqueueTraceExportBatch();
    const payload = getOutboxById(result.outboxId!)!.payload as Record<string, unknown>;
    expect(payload.session).toMatchObject({
      externalTraceId: expect.stringContaining("local_session_"),
      sessionKey: "agent:dev",
      sessionName: "dev",
      runtimeProvider: "codex",
      provider: "codex",
    });
    const turns = payload.turns as Array<Record<string, unknown>>;
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      turnId: "turn_1",
      sourceTurnId: "turn_1",
      sequence: 1,
      provider: "codex",
      model: "gpt-5.4",
    });
  });

  it("uses one stable Console trace id for every batch of the same local session", () => {
    recordSessionEvent({
      sessionKey: "agent:ravi-console:whatsapp:main:group:120363425574381266",
      sessionName: "ravi-console",
      eventType: "turn.complete",
      eventGroup: "runtime",
      provider: "codex",
      timestamp: 1,
    });
    const first = enqueueTraceExportBatch();

    recordSessionEvent({
      sessionKey: "agent:ravi-console:whatsapp:main:group:120363425574381266",
      sessionName: "ravi-console",
      eventType: "assistant.message",
      eventGroup: "response",
      provider: "codex",
      preview: "next batch",
      timestamp: 2,
    });
    const second = enqueueTraceExportBatch();

    const firstPayload = getOutboxById(first.outboxId!)!.payload as Record<string, unknown>;
    const secondPayload = getOutboxById(second.outboxId!)!.payload as Record<string, unknown>;
    expect((firstPayload.session as Record<string, unknown>).externalTraceId).toBe(
      (secondPayload.session as Record<string, unknown>).externalTraceId,
    );
  });

  it("preserves channel source metadata and useful tool previews in exported payloads", () => {
    recordSessionEvent({
      sessionKey: "agent:ravi-console:whatsapp:main:group:120363425574381266",
      sessionName: "ravi-console",
      eventType: "tool.start",
      eventGroup: "tool",
      provider: "codex",
      sourceChannel: "whatsapp-baileys",
      sourceAccountId: "main",
      sourceChatId: "120363425574381266@g.us",
      canonicalChatId: "chat_f297eee6a82fbd07632d251a",
      payloadJson: {
        input: { command: "git status --short" },
        metadata: { item: { id: "call_1" } },
        toolName: "shell",
      },
      timestamp: 1,
    });
    recordSessionEvent({
      sessionKey: "agent:ravi-console:whatsapp:main:group:120363425574381266",
      sessionName: "ravi-console",
      eventType: "tool.end",
      eventGroup: "tool",
      provider: "codex",
      sourceChannel: "whatsapp-baileys",
      sourceAccountId: "main",
      sourceChatId: "120363425574381266@g.us",
      canonicalChatId: "chat_f297eee6a82fbd07632d251a",
      payloadJson: {
        isError: false,
        metadata: { item: { id: "call_1" } },
        output: "M src/session-trace/cloud-trace-export.ts",
      },
      timestamp: 2,
      durationMs: 15,
    });

    const result = enqueueTraceExportBatch();
    const payload = getOutboxById(result.outboxId!)!.payload as Record<string, unknown>;
    expect(payload.session).toMatchObject({
      source: {
        accountId: "main",
        canonicalChatId: "chat_f297eee6a82fbd07632d251a",
        channel: "whatsapp-baileys",
        chatId: "120363425574381266@g.us",
      },
    });
    const calls = payload.toolCalls as Array<Record<string, unknown>>;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      id: "call_1",
      inputPreview: "git status --short",
      outputPreview: "M src/session-trace/cloud-trace-export.ts",
      status: "completed",
      toolName: "shell",
    });
  });

  it("skips non-canonical trace rows instead of creating empty Console runs", () => {
    recordSessionEvent({
      sessionKey: "generic",
      sessionName: "generic",
      eventType: "runtime.status",
      eventGroup: "runtime",
      provider: "claude",
      timestamp: 1,
    });

    const skipped = enqueueTraceExportBatch({ now: 2 });
    expect(skipped).toMatchObject({
      enqueued: false,
      sourceEvents: 1,
      exportedEvents: 0,
      firstEventId: 1,
      lastEventId: 1,
      outboxId: null,
    });
    expect(getSyncCursor("runtime_trace", "session_events_enqueued")?.cursorValue).toBe("1");

    recordSessionEvent({
      sessionKey: "agent:main:main",
      sessionName: "main",
      eventType: "turn.complete",
      eventGroup: "runtime",
      provider: "codex",
      timestamp: 3,
    });

    const exported = enqueueTraceExportBatch({ now: 4 });
    expect(exported.enqueued).toBe(true);
    expect(exported.firstEventId).toBe(2);
  });

  it("baselines severely stale historical backlog to the recent window", () => {
    recordSessionEvent({
      sessionKey: "agent:old",
      sessionName: "old",
      eventType: "turn.complete",
      eventGroup: "runtime",
      provider: "codex",
      timestamp: 10,
    });
    recordSessionEvent({
      sessionKey: "agent:old",
      sessionName: "old",
      eventType: "turn.complete",
      eventGroup: "runtime",
      provider: "codex",
      timestamp: 20,
    });
    recordSessionEvent({
      sessionKey: "agent:ravi-console:whatsapp:main:group:120363425574381266",
      sessionName: "ravi-console",
      eventType: "turn.complete",
      eventGroup: "runtime",
      provider: "codex",
      sourceChannel: "whatsapp-baileys",
      sourceAccountId: "main",
      sourceChatId: "120363425574381266@g.us",
      canonicalChatId: "chat_f297eee6a82fbd07632d251a",
      timestamp: 950,
    });

    const result = enqueueTraceExportBatch({
      now: 1_000,
      recentBaselineWindowMs: 100,
      staleBacklogEvents: 1,
    });

    expect(result).toMatchObject({
      enqueued: true,
      sourceEvents: 1,
      exportedEvents: 1,
      skippedEvents: 2,
      firstEventId: 3,
      lastEventId: 3,
    });
    const cursor = getSyncCursor("runtime_trace", "session_events_enqueued");
    expect(cursor?.cursorValue).toBe("3");
    expect(cursor?.meta).toMatchObject({
      baseline: {
        reason: "historical_backlog_baseline",
        previousCursor: 0,
        baselineEventId: 2,
        skippedEvents: 2,
      },
    });
    const payload = getOutboxById(result.outboxId!)!.payload as Record<string, unknown>;
    const events = (payload.events ?? []) as Array<Record<string, unknown>>;
    expect(events.map((event) => event.localEventId)).toEqual([3]);
    expect(payload.session).toMatchObject({
      sessionKey: "agent:ravi-console:whatsapp:main:group:120363425574381266",
      sessionName: "ravi-console",
      source: {
        chatId: "120363425574381266@g.us",
        canonicalChatId: "chat_f297eee6a82fbd07632d251a",
      },
    });
  });

  it("exports routed channel messages as user chat messages without exporting generic mirrors", () => {
    recordSessionEvent({
      sessionKey: "agent:ravi-console:whatsapp:main:group:120363425574381266",
      eventType: "channel.message.received",
      eventGroup: "channel",
      sourceChannel: "whatsapp",
      sourceAccountId: "main",
      sourceChatId: "120363425574381266@g.us",
      canonicalChatId: "chat_f297eee6a82fbd07632d251a",
      preview: "as mensagens que eu mando n tao aparecendo la",
      payloadJson: {
        channelType: "whatsapp-baileys",
        chatName: "ravi - console",
        contentType: "text",
        eventId: "evt_1",
        isGroup: true,
        resolvedSenderPhone: "5511999999999",
      },
      timestamp: 1,
    });
    recordSessionEvent({
      sessionKey: "agent:generic:whatsapp:luis:group:120363425574381266",
      eventType: "channel.message.received",
      eventGroup: "channel",
      sourceChannel: "whatsapp",
      sourceAccountId: "luis",
      sourceChatId: "120363425574381266@g.us",
      preview: "generic mirror must not export",
      timestamp: 2,
    });

    const routed = enqueueTraceExportBatch();
    const generic = enqueueTraceExportBatch();

    expect(routed).toMatchObject({ enqueued: true, exportedEvents: 1, firstEventId: 1, lastEventId: 1 });
    expect(generic).toMatchObject({ enqueued: false, exportedEvents: 0, firstEventId: 2, lastEventId: 2 });
    const payload = getOutboxById(routed.outboxId!)!.payload as Record<string, unknown>;
    const events = (payload.events ?? []) as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventGroup: "message",
      eventType: "message.user",
      safePayload: {
        channelType: "whatsapp-baileys",
        chatName: "ravi - console",
        contentType: "text",
        eventId: "evt_1",
        isGroup: true,
        role: "user",
      },
      safePreview: "as mensagens que eu mando n tao aparecendo la",
    });
    expect(JSON.stringify(events[0]?.safePayload)).not.toContain("5511999999999");
  });

  it("does not export generic placeholder names as the Console display name", () => {
    recordSessionEvent({
      sessionKey: "agent:khal-desktop:main",
      sessionName: "generic",
      eventType: "turn.complete",
      eventGroup: "runtime",
      provider: "codex",
      timestamp: 3,
    });

    const result = enqueueTraceExportBatch();
    const payload = getOutboxById(result.outboxId!)!.payload as Record<string, unknown>;
    expect(payload.session).toMatchObject({
      sessionKey: "agent:khal-desktop:main",
      sessionName: "khal-desktop",
    });
  });

  it("keeps local blob hashes on turns but omits blobs without remote r2Key/blobRef", () => {
    const requestBlob = recordSessionBlob({
      kind: "adapter_request",
      contentJson: { prompt: "secret prompt must stay local" },
    });
    const userPromptSha256 = "b".repeat(64);
    const systemPromptSha256 = "c".repeat(64);
    upsertSessionTurn({
      turnId: "turn_1",
      sessionKey: "agent:dev",
      provider: "codex",
      model: "gpt-5.4",
      status: "complete",
      userPromptSha256,
      systemPromptSha256,
      requestBlobSha256: requestBlob.sha256,
      startedAt: 1,
      completedAt: 2,
      updatedAt: 2,
    });
    recordSessionEvent({
      sessionKey: "agent:dev",
      turnId: "turn_1",
      eventType: "turn.complete",
      eventGroup: "runtime",
      provider: "codex",
      timestamp: 2,
    });

    const result = enqueueTraceExportBatch();
    const payload = getOutboxById(result.outboxId!)!.payload as Record<string, unknown>;
    const turns = payload.turns as Array<Record<string, unknown>>;
    expect(turns[0]?.userPromptSha256).toBe(userPromptSha256);
    expect(turns[0]?.systemPromptSha256).toBe(systemPromptSha256);
    expect(turns[0]?.requestBlobSha256).toBe(requestBlob.sha256);
    expect(payload.blobs).toEqual([]);
  });

  it("uploads trace outbox rows through the dedicated runtime traces endpoint", async () => {
    recordSessionEvent({
      sessionKey: "agent:dev",
      eventType: "turn.complete",
      eventGroup: "runtime",
      provider: "codex",
      timestamp: 2,
    });
    const enqueued = enqueueTraceExportBatch();
    const credentials = fakeCredentials();
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const bridge = new ConsoleSyncBridge({
      readCredentials: () => credentials,
      createClient: () =>
        ({
          consoleUrl: credentials.consoleUrl,
          requestJson: async (method: string, path: string, body: unknown) => {
            calls.push({ method, path, body });
            expect(path).toBe("/api/cli/runtime-traces/events");
            expect(body).toMatchObject({
              session: { sessionKey: "agent:dev", runtimeProvider: "codex", provider: "codex" },
              turns: [],
              toolCalls: [],
              blobs: [],
            });
            return { ok: true };
          },
        }) as never,
    });

    await expect(pushTraceExportBatch({ bridge })).resolves.toMatchObject({ status: "uploaded", acked: 1 });
    expect(calls).toHaveLength(1);
    expect(inspectSyncRecord(enqueued.outboxId!)?.record.status).toBe("acked");
  });

  it("uploads every pending trace row in the requested batch", async () => {
    recordSessionEvent({
      sessionKey: "agent:one",
      eventType: "turn.complete",
      eventGroup: "runtime",
      provider: "codex",
      timestamp: 2,
    });
    const first = enqueueTraceExportBatch();
    recordSessionEvent({
      sessionKey: "agent:two",
      eventType: "turn.complete",
      eventGroup: "runtime",
      provider: "codex",
      timestamp: 3,
    });
    const second = enqueueTraceExportBatch();
    const credentials = fakeCredentials();
    const calls: unknown[] = [];
    const bridge = new ConsoleSyncBridge({
      readCredentials: () => credentials,
      createClient: () =>
        ({
          consoleUrl: credentials.consoleUrl,
          requestJson: async (_method: string, path: string, body: unknown) => {
            expect(path).toBe("/api/cli/runtime-traces/events");
            calls.push(body);
            return { ok: true };
          },
        }) as never,
    });

    await expect(pushTraceExportBatch({ bridge, limit: 2 })).resolves.toMatchObject({
      status: "uploaded",
      attempted: 2,
      acked: 2,
      failed: 0,
    });
    expect(calls).toHaveLength(2);
    expect(inspectSyncRecord(first.outboxId!)?.record.status).toBe("acked");
    expect(inspectSyncRecord(second.outboxId!)?.record.status).toBe("acked");
  });

  it("moves the export cursor before TTL pruning can delete exported event rows", () => {
    recordSessionEvent({
      sessionKey: "agent:dev",
      eventType: "turn.complete",
      eventGroup: "runtime",
      timestamp: 1,
    });
    recordSessionEvent({
      sessionKey: "agent:dev",
      eventType: "turn.complete",
      eventGroup: "runtime",
      timestamp: 2,
    });
    enqueueTraceExportBatch({ limit: 1, now: 3 });
    expect(getSyncCursor("runtime_trace", "session_events_enqueued")?.cursorValue).toBe("1");
    const prune = dbPruneStaleRows({ dryRun: true, now: 10 * 24 * 60 * 60 * 1000 });
    expect(prune.sessionEvents).toBe(1);
  });
});

function fakeCredentials(): CloudCredentials {
  return {
    version: 1,
    consoleUrl: "https://console.test",
    installationId: "install_1",
    accessToken: "access",
    refreshToken: "refresh",
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
    scopes: [],
    user: null,
    organization: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}
