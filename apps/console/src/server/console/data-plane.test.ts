import { describe, expect, test } from "bun:test";

import { CliApiError } from "@/server/cli/errors";

import {
  cloudSyncRequestHash,
  collectTraceSourceTurnIds,
  normalizeCloudSyncEvents,
  normalizeRuntimeTraceBatch,
} from "./data-plane";

const sha = "a".repeat(64);

describe("console data plane normalization", () => {
  test("normalizes local-first sync upload events", () => {
    const events = normalizeCloudSyncEvents({
      events: [
        {
          eventId: "evt_1",
          domain: "crm",
          eventType: "crm.activity.logged",
          entityType: "activity",
          entityId: "activity_1",
          entityRevision: 3,
          idempotencyKey: "crm:activity_1:3",
          payload: {
            title: "Follow up",
          },
          evidenceRefs: ["trace:run_1"],
          occurredAt: "2026-05-31T13:00:00.000Z",
          schemaVersion: 1,
        },
      ],
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      domain: "crm",
      entityId: "activity_1",
      entityRevision: 3,
      eventId: "evt_1",
      eventType: "crm.activity.logged",
      idempotencyKey: "crm:activity_1:3",
      occurredAtProvided: true,
      payload: { title: "Follow up" },
      schemaVersion: 1,
    });
    expect(events[0]?.evidenceRefs).toEqual([{ ref: "trace:run_1" }]);
  });

  test("hashes sync retries without server-generated timestamps", () => {
    const payload = {
      events: [
        {
          eventId: "evt_1",
          domain: "crm",
          eventType: "crm.activity.logged",
          entityType: "activity",
          entityId: "activity_1",
          payload: {
            title: "Follow up",
          },
        },
      ],
    };

    const [first] = normalizeCloudSyncEvents(payload);
    const [second] = normalizeCloudSyncEvents(payload);
    const [changed] = normalizeCloudSyncEvents({
      events: [
        {
          ...payload.events[0],
          payload: {
            title: "Different",
          },
        },
      ],
    });

    expect(first?.occurredAtProvided).toBe(false);
    expect(second?.occurredAtProvided).toBe(false);
    expect(changed).toBeDefined();
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(cloudSyncRequestHash(first!, null)).toBe(cloudSyncRequestHash(second!, null));
    expect(cloudSyncRequestHash(first!, null)).not.toBe(cloudSyncRequestHash(changed!, null));
  });

  test("rejects secret-shaped sync payloads", () => {
    expect(() =>
      normalizeCloudSyncEvents({
        events: [
          {
            eventId: "evt_1",
            domain: "crm",
            eventType: "crm.activity.logged",
            entityType: "activity",
            entityId: "activity_1",
            payload: {
              authorization: "Bearer secret",
            },
          },
        ],
      }),
    ).toThrow(CliApiError);
  });

  test("coalesces assistant delta trace events before storage", () => {
    const batch = normalizeRuntimeTraceBatch({
      session: {
        externalTraceId: "trace_1",
        sessionKey: "agent:dev:main",
        runtimeProvider: "codex",
        runtimeModel: "gpt-5.4",
      },
      turns: [
        {
          sequence: 1,
          sourceTurnId: "turn_1",
          status: "running",
        },
      ],
      events: [
        {
          eventId: "evt_1",
          sourceTurnId: "turn_1",
          sequence: 1,
          eventType: "assistant.delta",
          safePreview: "hel",
        },
        {
          eventId: "evt_2",
          sourceTurnId: "turn_1",
          sequence: 2,
          eventType: "assistant.delta",
          safePreview: "lo",
        },
        {
          eventId: "evt_3",
          sourceTurnId: "turn_1",
          sequence: 3,
          eventType: "turn.complete",
          eventGroup: "turn",
        },
      ],
      toolCalls: [],
      blobs: [],
    }, "req_1");

    expect(batch.events).toHaveLength(2);
    expect(batch.events[0]).toMatchObject({
      eventType: "assistant.delta.coalesced",
      safePreview: "hello",
      safePayload: {
        coalesced: true,
        count: 2,
      },
    });
    expect(batch.events[1]).toMatchObject({ eventType: "turn.complete" });
  });

  test("normalizes generic trace session display names to null", () => {
    const batch = normalizeRuntimeTraceBatch({
      session: {
        externalTraceId: "trace_1",
        sessionKey: "agent:khal-desktop:main",
        sessionName: "generic",
        runtimeProvider: "claude",
      },
      events: [
        {
          eventId: "evt_1",
          sequence: 1,
          eventType: "turn.complete",
        },
      ],
    }, "req_generic");

    expect(batch.session.sessionName).toBeNull();
  });

  test("uses stable session trace ids and preserves source metadata", () => {
    const first = normalizeRuntimeTraceBatch({
      session: {
        sessionKey: "agent:ravi-console:whatsapp:main:group:120363425574381266",
        runtimeProvider: "codex",
        source: {
          accountId: "main",
          canonicalChatId: "chat_f297eee6a82fbd07632d251a",
          channel: "whatsapp-baileys",
          chatId: "120363425574381266@g.us",
        },
      },
      events: [
        {
          eventId: "evt_1",
          sequence: 1,
          eventType: "message.assistant",
          safePreview: "ok",
          source: {
            accountId: "main",
            canonicalChatId: "chat_f297eee6a82fbd07632d251a",
            channel: "whatsapp-baileys",
            chatId: "120363425574381266@g.us",
          },
        },
      ],
    }, "req_first");
    const second = normalizeRuntimeTraceBatch({
      session: {
        sessionKey: "agent:ravi-console:whatsapp:main:group:120363425574381266",
        runtimeProvider: "codex",
      },
      events: [
        {
          eventId: "evt_2",
          sequence: 2,
          eventType: "turn.complete",
        },
      ],
    }, "req_second");

    expect(first.session.externalTraceId).toBe(second.session.externalTraceId);
    expect(first.session.source).toEqual({
      accountId: "main",
      canonicalChatId: "chat_f297eee6a82fbd07632d251a",
      channel: "whatsapp-baileys",
      chatId: "120363425574381266@g.us",
      threadId: null,
    });
    expect(second.session.source).toMatchObject({
      accountId: "main",
      channel: "whatsapp",
      chatId: "120363425574381266@g.us",
    });
    expect(first.session.safeMetadata.source).toEqual({
      accountId: "main",
      canonicalChatId: "chat_f297eee6a82fbd07632d251a",
      channel: "whatsapp-baileys",
      chatId: "120363425574381266@g.us",
      threadId: null,
    });
    expect(first.events[0]?.safePayload.source).toMatchObject({
      channel: "whatsapp-baileys",
      chatId: "120363425574381266@g.us",
    });
  });

  test("promotes event source ids into the session identity when session source is missing", () => {
    const batch = normalizeRuntimeTraceBatch({
      session: {
        sessionKey: "agent:khal:whatsapp:main:group:120363425670861593",
        runtimeProvider: "codex",
      },
      events: [
        {
          eventId: "evt_1",
          sequence: 1,
          eventType: "message.assistant",
          safePreview: "ok",
          source: {
            accountId: "main",
            canonicalChatId: "chat_abc123",
            channel: "whatsapp-baileys",
            chatId: "120363425670861593@g.us",
          },
        },
      ],
    }, "req_source");

    expect(batch.session.source).toEqual({
      accountId: "main",
      canonicalChatId: "chat_abc123",
      channel: "whatsapp-baileys",
      chatId: "120363425670861593@g.us",
      threadId: null,
    });
    expect(batch.session.safeMetadata.source).toMatchObject({
      canonicalChatId: "chat_abc123",
      chatId: "120363425670861593@g.us",
    });
  });

  test("rejects empty runtime trace batches before creating empty sessions", () => {
    expect(() =>
      normalizeRuntimeTraceBatch({
        session: {
          externalTraceId: "trace_1",
          sessionKey: "generic",
          sessionName: "generic",
          runtimeProvider: "claude",
        },
      }, "req_empty"),
    ).toThrow(CliApiError);
  });

  test("normalizes trace blobs as references only", () => {
    const batch = normalizeRuntimeTraceBatch({
      session: {
        externalTraceId: "trace_1",
        sessionKey: "agent:dev:main",
        runtimeProvider: "codex",
      },
      events: [],
      blobs: [
        {
          kind: "tool_output",
          r2Key: "org/trace/blob",
          sha256: sha,
          sizeBytes: 123,
          sensitivity: "content",
          encryption: {
            keyVersion: 1,
          },
        },
      ],
    }, "req_2");

    expect(batch.blobs).toEqual([
      {
        encryption: { keyVersion: 1 },
        kind: "tool_output",
        r2Key: "org/trace/blob",
        retentionClass: "default",
        runtimeLeaseId: null,
        sandboxId: null,
        sensitivity: "content",
        sha256: sha,
        sizeBytes: 123,
        sourceTurnId: null,
      },
    ]);
  });

  test("preserves local turn hash metadata without requiring remote blobs", () => {
    const userPromptSha256 = "b".repeat(64);
    const systemPromptSha256 = "c".repeat(64);
    const requestBlobSha256 = "d".repeat(64);

    const batch = normalizeRuntimeTraceBatch({
      session: {
        externalTraceId: "trace_1",
        sessionKey: "agent:dev:main",
        runtimeProvider: "codex",
      },
      turns: [
        {
          sequence: 1,
          sourceTurnId: "turn_1",
          userPromptSha256,
          systemPromptSha256,
          requestBlobSha256,
        },
      ],
      events: [
        {
          eventId: "evt_1",
          sourceTurnId: "turn_1",
          sequence: 1,
          eventType: "turn.complete",
        },
      ],
      blobs: [],
    }, "req_hashes");

    expect(batch.turns[0]).toMatchObject({
      promptSha256: userPromptSha256,
      requestBlobSha256,
      requestBlobRef: null,
      systemPromptSha256,
      userPromptSha256,
    });
    expect(batch.blobs).toEqual([]);
  });

  test("redacts inline secrets and private paths from trace safe fields", () => {
    const batch = normalizeRuntimeTraceBatch({
      session: {
        sessionKey: "agent:dev:main",
        runtimeProvider: "codex",
        safeMetadata: {
          note: "Bearer abcdefghijklmnop",
          cwd: "/Users/luis/private/project",
        },
      },
      events: [
        {
          eventId: "evt_secret",
          sequence: 1,
          eventType: "message.assistant",
          safePreview: "token=abcdefghijklmnop sk-abcdefghijklmnop",
          safePayload: {
            message: "Bearer secret-token-value",
            rawOutput: "should not persist",
            workspacePath: "/Users/luis/dev/private",
          },
        },
      ],
      toolCalls: [
        {
          toolCallId: "tool_secret",
          toolName: "shell",
          inputPreview: "Bearer abcdefghijklmnop",
          outputPreview: "refreshToken abcdefghijklmnop",
          approval: {
            message: "password abcdefghijklmnop",
          },
        },
      ],
    }, "req_secret");

    expect(batch.session.safeMetadata).toMatchObject({
      cwd: "[REDACTED]",
      note: "Bearer [REDACTED]",
    });
    expect(batch.events[0]?.safePreview).toBe("token=[REDACTED] sk-[REDACTED]");
    expect(batch.events[0]?.safePayload).toMatchObject({
      message: "Bearer [REDACTED]",
      rawOutput: "[REDACTED]",
      workspacePath: "[REDACTED]",
    });
    expect(batch.toolCalls[0]).toMatchObject({
      inputPreview: "Bearer [REDACTED]",
      outputPreview: "refreshToken=[REDACTED]",
      approval: {
        message: "password=[REDACTED]",
      },
    });
  });

  test("rejects weak runtime trace ordering and timestamp values", () => {
    expect(() =>
      normalizeRuntimeTraceBatch({
        session: {
          sessionKey: "agent:dev:main",
          runtimeProvider: "codex",
        },
        events: [
          {
            eventId: "evt_zero",
            sequence: 0,
            eventType: "turn.complete",
          },
        ],
      }, "req_zero"),
    ).toThrow(CliApiError);

    expect(() =>
      normalizeRuntimeTraceBatch({
        session: {
          sessionKey: "agent:dev:main",
          runtimeProvider: "codex",
        },
        turns: [
          {
            sequence: 1,
            sourceTurnId: "turn_negative",
            inputTokens: -1,
          },
        ],
      }, "req_negative"),
    ).toThrow(CliApiError);

    expect(() =>
      normalizeRuntimeTraceBatch({
        session: {
          sessionKey: "agent:dev:main",
          runtimeProvider: "codex",
        },
        events: [
          {
            eventId: "evt_future",
            sequence: 1,
            eventType: "turn.complete",
            occurredAt: new Date(Date.now() + 11 * 60 * 1000).toISOString(),
          },
        ],
      }, "req_future"),
    ).toThrow(CliApiError);
  });

  test("rejects deeply nested trace safe json", () => {
    let nested: Record<string, unknown> = { value: "ok" };
    for (let index = 0; index < 40; index += 1) {
      nested = { child: nested };
    }

    expect(() =>
      normalizeRuntimeTraceBatch({
        session: {
          sessionKey: "agent:dev:main",
          runtimeProvider: "codex",
        },
        events: [
          {
            eventId: "evt_deep",
            sequence: 1,
            eventType: "message.assistant",
            safePayload: nested,
          },
        ],
      }, "req_deep"),
    ).toThrow(CliApiError);
  });

  test("collects trace turn references that were not in the current batch", () => {
    const batch = normalizeRuntimeTraceBatch({
      session: {
        externalTraceId: "trace_1",
        sessionKey: "agent:dev:main",
        runtimeProvider: "codex",
      },
      turns: [
        {
          sequence: 1,
          sourceTurnId: "turn_1",
        },
      ],
      events: [
        {
          eventId: "evt_1",
          sourceTurnId: "turn_1",
          sequence: 1,
          eventType: "turn.complete",
        },
        {
          eventId: "evt_2",
          sourceTurnId: "turn_2",
          sequence: 2,
          eventType: "tool.completed",
        },
      ],
      toolCalls: [
        {
          toolCallId: "tool_1",
          toolName: "crm_create_contact",
          sourceTurnId: "turn_3",
        },
      ],
      blobs: [
        {
          kind: "tool_output",
          r2Key: "org/trace/blob",
          sha256: sha,
          sizeBytes: 123,
          sourceTurnId: "turn_2",
        },
      ],
    }, "req_3");

    expect(collectTraceSourceTurnIds({
      blobs: batch.blobs,
      events: batch.events,
      toolCalls: batch.toolCalls,
      turnIdBySource: new Map([["turn_1", "db_turn_1"]]),
    })).toEqual(["turn_2", "turn_3"]);
  });
});
