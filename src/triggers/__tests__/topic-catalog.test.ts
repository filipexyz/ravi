import { describe, expect, it } from "bun:test";
import { findTriggerTopicCatalogEntry, getTriggerTopicCatalog, getTriggerTopicDiagnostic } from "../topic-catalog.js";

describe("trigger topic catalog", () => {
  it("registers the canonical inbound reaction subject", () => {
    expect(getTriggerTopicCatalog()).toContainEqual(
      expect.objectContaining({
        pattern: "ravi.inbound.reaction",
        payload: "{ targetMessageId, emoji, senderId }",
      }),
    );
  });

  it("warns about inferred channel reaction aliases", () => {
    expect(getTriggerTopicDiagnostic("whatsapp.*.reaction")).toMatchObject({
      level: "warning",
      suggestedPattern: "ravi.inbound.reaction",
    });
  });

  it("warns about inferred channel inbound aliases", () => {
    expect(getTriggerTopicDiagnostic("whatsapp.*.inbound")).toMatchObject({
      level: "warning",
    });
  });

  it("warns but allows custom publisher subjects", () => {
    expect(getTriggerTopicDiagnostic("doma.rdp.>")).toMatchObject({
      level: "warning",
      message: expect.stringContaining("custom NATS subject"),
    });
  });

  it("allows session CLI command subjects", () => {
    expect(getTriggerTopicDiagnostic("ravi.*.cli.contacts.*")).toBeUndefined();
  });

  it("documents the native mail inbox schema and default trigger message", () => {
    const entry = findTriggerTopicCatalogEntry("ravi.inbox.mail.received");

    expect(entry).toMatchObject({
      id: "inbox.mail.received",
      schema: {
        version: 1,
        fields: expect.arrayContaining([
          expect.objectContaining({ path: "inboxItemId", required: true }),
          expect.objectContaining({ path: "mail.messageId", required: true }),
          expect.objectContaining({ path: "mail.subject" }),
        ]),
      },
      messageTemplate: {
        id: "mail-inbox-default",
        template: expect.stringContaining("ravi mail messages read {{data.mail.messageId}}"),
      },
    });
  });

  it("exposes schemas for built-in trigger-ready topics", () => {
    for (const entry of getTriggerTopicCatalog()) {
      expect(entry.schema?.fields.length).toBeGreaterThan(0);
    }
  });
});
