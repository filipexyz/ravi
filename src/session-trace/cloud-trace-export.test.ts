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
