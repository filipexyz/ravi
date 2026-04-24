import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getDb } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  getSessionTraceBlob,
  getSessionTurn,
  listSessionEvents,
  recordSessionBlob,
  recordSessionEvent,
  redactJson,
  redactText,
  sha256Text,
  upsertSessionTurn,
} from "./session-trace-db.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-session-trace-test-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

describe("session trace db", () => {
  it("creates the session trace tables and indexes in ravi.db", () => {
    const db = getDb();

    const tables = db
      .prepare(
        `
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN ('session_events', 'session_trace_blobs', 'session_turns')
        ORDER BY name
      `,
      )
      .all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toEqual(["session_events", "session_trace_blobs", "session_turns"]);

    const eventIndexes = db.prepare("PRAGMA index_list(session_events)").all() as Array<{ name: string }>;
    expect(eventIndexes.map((row) => row.name)).toContain("idx_session_events_turn_seq");

    const blobIndexes = db.prepare("PRAGMA index_list(session_trace_blobs)").all() as Array<{ name: string }>;
    expect(blobIndexes.map((row) => row.name)).toContain("idx_session_trace_blobs_kind");
  });

  it("records events append-only and redacts payload, preview, and error fields", () => {
    const first = recordSessionEvent({
      sessionKey: "agent:main:main",
      sessionName: "main",
      runId: "run-1",
      turnId: "turn-1",
      eventType: "adapter.request",
      eventGroup: "adapter",
      payloadJson: {
        env: {
          OPENAI_API_KEY: "sk-test-secret",
          RAVI_STATE_DIR: "/tmp/ravi-test",
          RAVI_CONTEXT_KEY: "ctx-secret",
        },
        headers: {
          authorization: "Bearer provider-token",
        },
      },
      preview: "Authorization: Bearer preview-token",
      error: "OPENAI_API_KEY=sk-error-secret",
      timestamp: 10,
      createdAt: 10,
    });

    const second = recordSessionEvent({
      sessionKey: "agent:main:main",
      runId: "run-1",
      turnId: "turn-1",
      eventType: "adapter.request",
      eventGroup: "adapter",
      payloadJson: { ok: true },
      timestamp: 11,
      createdAt: 11,
    });

    expect(first.id).not.toBe(second.id);
    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(first.preview).toBe(`Authorization: Bearer [REDACTED]`);
    expect(first.error).toBe(`OPENAI_API_KEY=[REDACTED]`);
    expect(first.payloadJson).toEqual({
      env: {
        OPENAI_API_KEY: "[REDACTED]",
        RAVI_CONTEXT_KEY: "[REDACTED]",
        RAVI_STATE_DIR: "/tmp/ravi-test",
      },
      headers: {
        authorization: "[REDACTED]",
      },
    });

    expect(listSessionEvents("agent:main:main")).toHaveLength(2);
  });

  it("records canonical chat and actor metadata on session events", () => {
    const event = recordSessionEvent({
      sessionKey: "agent:main:main",
      sessionName: "main",
      eventType: "channel.message.received",
      eventGroup: "channel",
      sourceChannel: "whatsapp",
      sourceAccountId: "main",
      sourceChatId: "5511999999999@s.whatsapp.net",
      canonicalChatId: "chat_1",
      actorType: "contact",
      contactId: "contact_1",
      platformIdentityId: "pi_1",
      rawSenderId: "5511999999999@s.whatsapp.net",
      normalizedSenderId: "5511999999999",
      identityConfidence: 0.9,
      identityProvenance: {
        source: "test",
        token: "secret-value",
      },
    });

    expect(event.canonicalChatId).toBe("chat_1");
    expect(event.actorType).toBe("contact");
    expect(event.contactId).toBe("contact_1");
    expect(event.platformIdentityId).toBe("pi_1");
    expect(event.rawSenderId).toBe("5511999999999@s.whatsapp.net");
    expect(event.normalizedSenderId).toBe("5511999999999");
    expect(event.identityConfidence).toBe(0.9);
    expect(event.identityProvenance).toEqual({
      source: "test",
      token: "[REDACTED]",
    });
  });

  it("keeps absent identity provenance as null instead of stringifying undefined", () => {
    const event = recordSessionEvent({
      sessionKey: "agent:main:main",
      sessionName: "main",
      eventType: "runtime.start",
      eventGroup: "runtime",
      identityProvenance: undefined,
    });

    expect(event.identityProvenance).toBeNull();
  });

  it("stores blobs content-addressed with INSERT OR IGNORE after redaction", () => {
    const first = recordSessionBlob({
      kind: "system_prompt",
      contentText: "System prompt\nOPENAI_API_KEY=sk-system-secret",
      createdAt: 10,
    });
    const second = recordSessionBlob({
      kind: "system_prompt",
      contentText: "System prompt\nOPENAI_API_KEY=sk-system-secret",
      createdAt: 20,
    });

    expect(second.sha256).toBe(first.sha256);
    expect(first.contentText).toBe("System prompt\nOPENAI_API_KEY=[REDACTED]");
    expect(first.redacted).toBe(true);
    expect(first.createdAt).toBe(10);
    expect(second.createdAt).toBe(10);

    const count = (getDb().prepare("SELECT COUNT(*) AS count FROM session_trace_blobs").get() as { count: number })
      .count;
    expect(count).toBe(1);
    expect(getSessionTraceBlob(first.sha256)?.contentText).toBe(first.contentText);
  });

  it("deduplicates system prompts by sha256 and links turns to prompt blobs", () => {
    const prompt = "Ravi system prompt";
    const systemPrompt = recordSessionBlob({ kind: "system_prompt", contentText: prompt });
    const sameSystemPrompt = recordSessionBlob({ kind: "system_prompt", contentText: prompt });
    const request = recordSessionBlob({ kind: "adapter_request", contentJson: { prompt: "hello" } });

    expect(systemPrompt.sha256).toBe(sha256Text(prompt));
    expect(sameSystemPrompt.sha256).toBe(systemPrompt.sha256);

    const created = upsertSessionTurn({
      turnId: "turn-1",
      sessionKey: "agent:main:main",
      sessionName: "main",
      runId: "run-1",
      agentId: "main",
      provider: "codex",
      model: "gpt-5.4",
      status: "running",
      resume: true,
      systemPromptSha256: systemPrompt.sha256,
      requestBlobSha256: request.sha256,
      startedAt: 100,
      updatedAt: 100,
    });
    expect(created.systemPromptSha256).toBe(systemPrompt.sha256);
    expect(created.requestBlobSha256).toBe(request.sha256);
    expect(created.resume).toBe(true);

    const completed = upsertSessionTurn({
      turnId: "turn-1",
      sessionKey: "agent:main:main",
      status: "complete",
      inputTokens: 10,
      outputTokens: 4,
      completedAt: 150,
      updatedAt: 150,
    });

    expect(completed.systemPromptSha256).toBe(systemPrompt.sha256);
    expect(completed.requestBlobSha256).toBe(request.sha256);
    expect(completed.model).toBe("gpt-5.4");
    expect(completed.status).toBe("complete");
    expect(completed.inputTokens).toBe(10);
    expect(completed.outputTokens).toBe(4);
    expect(completed.startedAt).toBe(100);
    expect(completed.completedAt).toBe(150);
    expect(getSessionTurn("turn-1")?.status).toBe("complete");
  });

  it("redacts nested secret values without dropping allowed operational values", () => {
    expect(redactText("Bearer abcdefghijklmnop")).toEqual({
      value: "Bearer [REDACTED]",
      redacted: true,
    });

    expect(
      redactJson({
        env: {
          ANTHROPIC_AUTH_TOKEN: "token-value",
          RAVI_STATE_DIR: "/tmp/ravi",
        },
        nested: [{ clientSecret: "client-secret" }, { cwd: "/repo" }],
      }),
    ).toEqual({
      value: {
        env: {
          ANTHROPIC_AUTH_TOKEN: "[REDACTED]",
          RAVI_STATE_DIR: "/tmp/ravi",
        },
        nested: [{ clientSecret: "[REDACTED]" }, { cwd: "/repo" }],
      },
      redacted: true,
    });
  });
});
