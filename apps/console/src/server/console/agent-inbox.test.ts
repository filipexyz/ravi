import { describe, expect, test } from "bun:test";

import { schema } from "@/server/db";
import {
  AGENT_INBOX_EVENT_SUBJECT,
  AGENT_INBOX_TARGET_LOCAL_INSTALLATION,
  buildAgentInboxOutboxPayload,
  buildInboxPulseEtag,
  buildMailMessageReceivedInboxItem,
  isInboxItemVisibleToInstallation,
  nextAgentInboxOutboxAttemptAt,
  normalizeAgentInboxOutboxErrorCode,
} from "./agent-inbox";

describe("Agent Inbox", () => {
  test("builds a stable pulse etag from watermark and subscription state", () => {
    expect(
      buildInboxPulseEtag({
        cacheKey: "12:1779470000000",
        generation: 3,
        latestSequence: 12,
        subscribed: true,
        subscriptionCursor: 10,
        subscriptionId: "sub_1",
      }),
    ).toBe('W/"ravi-inbox:12:1779470000000:3:12:10:sub_1:1:"');
  });

  test("keeps unsubscribed pulse etags distinct", () => {
    expect(
      buildInboxPulseEtag({
        cacheKey: "0",
        generation: 1,
        latestSequence: 0,
        subscribed: false,
        subscriptionCursor: null,
        subscriptionId: null,
      }),
    ).toBe('W/"ravi-inbox:0:1:0:none:none:0:"');
  });

  test("builds mail.message.received items from safe encrypted-mail metadata", () => {
    const item = buildMailMessageReceivedInboxItem({
      hasEncryptedBody: true,
      hasEncryptedSubject: true,
      mailboxAddress: "nx-luis@ravi.bot",
      mailboxId: "ffd9f63b-3664-4a6f-be2b-857784beb1a3",
      messageId: "457eddba-3066-474a-ac31-58049e4c5101",
      organizationId: "359eb72d-262e-4e51-9a5d-efadd03c1ef4",
      projectId: null,
      providerAdapter: "cloudflare_email",
      receivedAt: new Date("2026-06-01T03:19:56.723Z"),
      requestId: "req_mail_ingest",
      routeId: "route_1",
      sizeBytes: 6359,
      threadId: null,
    });

    expect(item).toMatchObject({
      category: "mail",
      dedupeKey:
        "mail:message:359eb72d-262e-4e51-9a5d-efadd03c1ef4:457eddba-3066-474a-ac31-58049e4c5101:received",
      eventType: "mail.message.received",
      organizationId: "359eb72d-262e-4e51-9a5d-efadd03c1ef4",
      projectId: null,
      sensitivity: "restricted",
      severity: "info",
      sourceId: "457eddba-3066-474a-ac31-58049e4c5101",
      sourceType: "mail_message",
      targetId: "ffd9f63b-3664-4a6f-be2b-857784beb1a3",
      targetType: "mailbox",
      title: "New email received",
    });
    expect(item.payloadJson).toEqual({
      attachmentCount: 0,
      direction: "inbound",
      hasEncryptedBody: true,
      hasEncryptedSubject: true,
      hasAttachments: false,
      mailboxAddress: "nx-luis@ravi.bot",
      mailboxId: "ffd9f63b-3664-4a6f-be2b-857784beb1a3",
      messageId: "457eddba-3066-474a-ac31-58049e4c5101",
      projectId: null,
      providerAdapter: "cloudflare_email",
      receivedAt: "2026-06-01T03:19:56.723Z",
      requestId: "req_mail_ingest",
      sizeBytes: 6359,
      status: "received",
      threadId: null,
    });
    expect(JSON.stringify(item.payloadJson)).not.toContain("luisofbug@gmail.com");
  });

  test("builds the outbox envelope from the redacted inbox item contract", () => {
    const now = new Date("2026-06-01T03:20:00.000Z");
    const item = {
      ...buildMailMessageReceivedInboxItem({
        attachmentCount: 1,
        hasEncryptedBody: true,
        hasEncryptedSubject: true,
        mailboxAddress: "agent@example.com",
        mailboxId: "ffd9f63b-3664-4a6f-be2b-857784beb1a3",
        messageId: "457eddba-3066-474a-ac31-58049e4c5101",
        organizationId: "359eb72d-262e-4e51-9a5d-efadd03c1ef4",
        projectId: "7303274e-ef98-44f3-acd8-74be46860d79",
        providerAdapter: "cloudflare_email",
        receivedAt: new Date("2026-06-01T03:19:56.723Z"),
        requestId: "req_mail_ingest",
        routeId: "route_1",
        sizeBytes: 6359,
        threadId: "thread_1",
      }),
      id: "7bd07e8c-dc4e-481e-aeea-d9f247b17f5f",
      sequence: 42,
      actorId: null,
      expiresAt: null,
      createdAt: now,
    } satisfies typeof schema.agentInboxItems.$inferSelect;

    const envelope = buildAgentInboxOutboxPayload(item);

    expect(AGENT_INBOX_EVENT_SUBJECT).toBe("ravi.console.inbox.item");
    expect(envelope).toMatchObject({
      version: 1,
      eventId: "7bd07e8c-dc4e-481e-aeea-d9f247b17f5f",
      sequence: 42,
      eventType: "mail.message.received",
      category: "mail",
      severity: "info",
      sensitivity: "restricted",
      organization: { id: "359eb72d-262e-4e51-9a5d-efadd03c1ef4" },
      project: { id: "7303274e-ef98-44f3-acd8-74be46860d79" },
      source: {
        type: "mail_message",
        id: "457eddba-3066-474a-ac31-58049e4c5101",
        requestId: "req_mail_ingest",
      },
      target: {
        type: "mailbox",
        id: "ffd9f63b-3664-4a6f-be2b-857784beb1a3",
        ref: "agent@example.com",
      },
      delivery: {
        mode: "event_plane",
        state: "available",
      },
    });
    expect(envelope.payload).toMatchObject({
      hasEncryptedBody: true,
      hasEncryptedSubject: true,
      hasAttachments: true,
      mailboxAddress: "agent@example.com",
      messageId: "457eddba-3066-474a-ac31-58049e4c5101",
      status: "received",
    });
    expect(JSON.stringify(envelope)).not.toContain("Subject:");
    expect(JSON.stringify(envelope)).not.toContain("rawMime");
    expect(JSON.stringify(envelope)).not.toContain("decrypted");
  });

  test("uses bounded exponential outbox retry backoff", () => {
    const now = new Date("2026-06-01T03:20:00.000Z");

    expect(nextAgentInboxOutboxAttemptAt(1, now).toISOString()).toBe("2026-06-01T03:20:05.000Z");
    expect(nextAgentInboxOutboxAttemptAt(2, now).toISOString()).toBe("2026-06-01T03:20:10.000Z");
    expect(nextAgentInboxOutboxAttemptAt(99, now).toISOString()).toBe("2026-06-01T03:25:00.000Z");
  });

  test("normalizes publisher failures without persisting arbitrary error text", () => {
    expect(normalizeAgentInboxOutboxErrorCode({ code: "nats_timeout" })).toBe("NATS_TIMEOUT");
    expect(normalizeAgentInboxOutboxErrorCode(new Error("Bearer secret-token leaked in message"))).toBe("ERROR");
    expect(normalizeAgentInboxOutboxErrorCode({ code: "auth failed token secret" })).toBe("PUBLISH_FAILED");
  });

  test("installation-targeted items are visible only to that installation", () => {
    const targeted = {
      targetType: AGENT_INBOX_TARGET_LOCAL_INSTALLATION,
      targetId: "33333333-3333-4333-8333-333333333333",
    };
    expect(isInboxItemVisibleToInstallation(targeted, "33333333-3333-4333-8333-333333333333")).toBe(true);
    expect(isInboxItemVisibleToInstallation(targeted, "44444444-4444-4444-8444-444444444444")).toBe(false);
    expect(
      isInboxItemVisibleToInstallation(
        { targetType: "mailbox", targetId: "box_1" },
        "44444444-4444-4444-8444-444444444444",
      ),
    ).toBe(true);
  });
});
