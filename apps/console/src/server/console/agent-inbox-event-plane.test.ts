import { describe, expect, test } from "bun:test";

import type { AgentInboxOutboxPublishEnvelope } from "./agent-inbox";
import {
  agentInboxNatsCliPublisherConfigFromEnv,
  agentInboxNatsCliPublishArgs,
} from "./agent-inbox-event-plane";

describe("Agent Inbox Event Plane publisher", () => {
  test("stays disabled until NATS server and bridge credentials are configured", () => {
    expect(agentInboxNatsCliPublisherConfigFromEnv({})).toBeNull();
    expect(
      agentInboxNatsCliPublisherConfigFromEnv({
        RAVI_EVENT_PLANE_NATS_SERVERS: "tls://172.16.30.2:4222",
      }),
    ).toBeNull();
  });

  test("builds durable JetStream publish args with an idempotency header", () => {
    const config = agentInboxNatsCliPublisherConfigFromEnv({
      RAVI_AGENT_INBOX_EVENT_PLANE_CREDS_FILE: "/run/secrets/org-alpha.creds",
      RAVI_EVENT_PLANE_JS_DOMAIN: "RAVI_P0",
      RAVI_EVENT_PLANE_NATS_SERVERS: "tls://172.16.30.2:4222,tls://172.16.31.2:4222",
      RAVI_EVENT_PLANE_TLS_CA_FILE: "/run/secrets/ca.crt",
    });
    if (!config) throw new Error("expected config");

    const args = agentInboxNatsCliPublishArgs(
      config,
      makeEnvelope(),
      "ravi.console.inbox.item",
      "{\"version\":1}",
    );

    expect(args).toEqual([
      "--timeout",
      "8s",
      "--server",
      "tls://172.16.30.2:4222",
      "--tlsca",
      "/run/secrets/ca.crt",
      "--creds",
      "/run/secrets/org-alpha.creds",
      "--js-domain",
      "RAVI_P0",
      "pub",
      "-J",
      "-H",
      "Nats-Msg-Id:agent-inbox:org_1:item_1",
      "ravi.console.inbox.item",
      "{\"version\":1}",
    ]);
  });
});

function makeEnvelope(): AgentInboxOutboxPublishEnvelope {
  return {
    attempt: 1,
    correlationId: "req_1",
    eventId: "item_1",
    idempotencyKey: "agent-inbox:org_1:item_1",
    inboxItemId: "item_1",
    organizationId: "org_1",
    outboxId: "out_1",
    payload: {
      version: 1,
      eventId: "item_1",
      sequence: 1,
      dedupeKey: "mail:message:org_1:msg_1:received",
      eventType: "mail.message.received",
      category: "mail",
      severity: "info",
      sensitivity: "restricted",
      title: "New email received",
      summary: null,
      organization: { id: "org_1" },
      project: null,
      source: { type: "mail_message", id: "msg_1" },
      actor: { type: "system", id: null },
      target: { type: "mailbox", id: "box_1" },
      payload: { messageId: "msg_1", hasEncryptedBody: true },
      links: {},
      delivery: { mode: "event_plane", state: "available" },
      occurredAt: "2026-07-16T00:00:00.000Z",
      createdAt: "2026-07-16T00:00:01.000Z",
    },
    subject: "ravi.console.inbox.item",
    trace: { requestId: "req_1" },
  };
}
