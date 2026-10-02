import { describe, expect, it } from "bun:test";
import { findTriggerTopicCatalogEntry, getTriggerTopicCatalog, getTriggerTopicDiagnostic } from "../topic-catalog.js";
import { getTriggerTopicWarnings, isBlockedTriggerTopic } from "../topic-policy.js";

describe("trigger topic catalog", () => {
  it("registers the canonical inbound reaction subject", () => {
    expect(getTriggerTopicCatalog()).toContainEqual(
      expect.objectContaining({
        pattern: "ravi.inbound.reaction",
        payload: "{ targetMessageId, emoji, senderId }",
      }),
    );
  });

  it("names the WhatsApp runner and the legacy bridge as reaction producers", () => {
    const notes = findTriggerTopicCatalogEntry("ravi.inbound.reaction")?.notes ?? [];

    expect(notes).toContain(
      "Producers: the inbound pipeline for WhatsApp (ravi channels runner) and the legacy Omni bridge (Telegram/Discord), and native Slack `reaction_added`.",
    );
    expect(notes.some((note) => note.startsWith("Producers: Omni"))).toBe(false);
  });

  it("moves Omni WhatsApp message triggers to the runner's message subject, not to lifecycle subjects", () => {
    const notes = findTriggerTopicCatalogEntry("ravi.inbound.reaction")?.notes ?? [];
    const migration = notes.find((note) => note.includes("message.received.whatsapp-baileys"));

    expect(migration).toContain("Move message triggers to `ravi.channel.inbound.whatsapp.message.>`");
    expect(migration).toContain("WhatsAppInboundEvent");
    expect(migration).toContain('data.ingestMode == "realtime"');
    expect(migration).toContain("reaction triggers to `ravi.inbound.reaction`");
    expect(migration).toContain("instance lifecycle triggers to `ravi.instances.>`");
    expect(migration).toContain("`ravi.whatsapp.>`");
  });

  it("accepts the WhatsApp message subject as a custom subject with a warning only", () => {
    const topic = "ravi.channel.inbound.whatsapp.message.>";

    expect(isBlockedTriggerTopic(topic)).toBe(false);
    expect(getTriggerTopicDiagnostic(topic)).toMatchObject({
      level: "warning",
      message: expect.stringContaining("custom NATS subject"),
    });
    expect(getTriggerTopicWarnings(topic)).toHaveLength(1);
  });

  it("describes unregistered instances without assuming Omni", () => {
    const entry = findTriggerTopicCatalogEntry("ravi.instances.unregistered");

    expect(entry?.description).not.toContain("Omni");
    expect(entry?.schema?.fields.find((field) => field.path === "instanceId")?.description).toBe(
      "Transport instance id that emitted the inbound event.",
    );
  });

  it("registers native interactive component events", () => {
    expect(findTriggerTopicCatalogEntry("ravi.inbound.interaction")).toMatchObject({
      id: "inbound.interaction",
      schema: {
        version: 1,
        fields: expect.arrayContaining([
          expect.objectContaining({ path: "provider", required: true }),
          expect.objectContaining({ path: "interactionType", required: true }),
          expect.objectContaining({ path: "userId", required: true }),
          expect.objectContaining({ path: "actionId" }),
          expect.objectContaining({ path: "blockId" }),
        ]),
      },
    });
  });

  it("registers native thread creation events", () => {
    expect(findTriggerTopicCatalogEntry("ravi.inbound.thread.created")).toMatchObject({
      id: "inbound.thread.created",
      schema: {
        version: 1,
        fields: expect.arrayContaining([
          expect.objectContaining({ path: "provider", required: true }),
          expect.objectContaining({ path: "eventType", required: true }),
          expect.objectContaining({ path: "channelId", required: true }),
          expect.objectContaining({ path: "threadTs", required: true }),
          expect.objectContaining({ path: "sessionName", required: true }),
          expect.objectContaining({ path: "agentId", required: true }),
        ]),
      },
    });
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
          expect.objectContaining({ path: "mail.from", required: true }),
          expect.objectContaining({ path: "mail.fromText", required: true }),
          expect.objectContaining({ path: "mail.to", required: true }),
          expect.objectContaining({ path: "mail.toText", required: true }),
          expect.objectContaining({ path: "mail.subject" }),
          expect.objectContaining({ path: "mail.attachments" }),
        ]),
      },
      messageTemplate: {
        id: "mail-inbox-default",
      },
    });
    expect(entry?.messageTemplate?.template).toContain("De: {{data.mail.fromText}}. Para: {{data.mail.toText}}.");
    expect(entry?.messageTemplate?.template).toContain("ravi mail messages read {{data.mail.messageId}}");
  });

  it("documents the Console bug-status watch subject and per-bugId filter", () => {
    expect(findTriggerTopicCatalogEntry("ravi.watch.console.bug.status")).toMatchObject({
      id: "watch.console.bug.status",
      pattern: "ravi.watch.console.bug.status",
      filters: expect.arrayContaining([
        expect.stringContaining("data.payload.bugId"),
        expect.stringContaining("data.bugId"),
      ]),
    });
  });

  it("exposes schemas for built-in trigger-ready topics", () => {
    for (const entry of getTriggerTopicCatalog()) {
      expect(entry.schema?.fields.length).toBeGreaterThan(0);
    }
  });
});
