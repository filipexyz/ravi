import { describe, expect, it } from "bun:test";
import { findTriggerTopicCatalogEntry } from "../topic-catalog.js";
import { buildTriggerPrompt, usesCatalogMessageTemplate } from "../prompt.js";

describe("buildTriggerPrompt", () => {
  it("renders catalog-template triggers as standardized trigger messages without raw JSON", () => {
    const template = findTriggerTopicCatalogEntry("ravi.inbox.mail.received")?.messageTemplate?.template;
    expect(template).toBeDefined();

    const prompt = buildTriggerPrompt(
      {
        name: "Novo email local",
        topic: "ravi.inbox.mail.received",
        message: template as string,
        messageSource: "catalog",
        messageTemplateId: "mail-inbox-default",
      },
      {
        topic: "ravi.inbox.mail.received",
        data: {
          mail: {
            messageId: "mail_msg_123",
            fromText: "Alice <alice@example.com>",
            toText: "nx-luis@ravi.bot",
            subject: "Contrato assinado",
          },
        },
      },
    );

    expect(
      usesCatalogMessageTemplate({
        topic: "ravi.inbox.mail.received",
        message: template as string,
        messageSource: "catalog",
      }),
    ).toBe(true);
    expect(prompt).toBe(
      [
        "[Trigger: Novo email local]",
        "Event: ravi.inbox.mail.received",
        "",
        "[ravi mail] novo email no inbox: mail_msg_123. De: Alice <alice@example.com>. Para: nx-luis@ravi.bot. Assunto: Contrato assinado. Use ravi mail messages read mail_msg_123 para ler.",
      ].join("\n"),
    );
    expect(prompt).not.toContain("Data:");
    expect(prompt).not.toContain('"mail"');
  });

  it("keeps raw event data for manual trigger messages", () => {
    const prompt = buildTriggerPrompt(
      {
        name: "Debug permission",
        topic: "ravi.audit.denied",
        message: "Analise {{data.reason}}",
        messageSource: "manual",
      },
      {
        topic: "ravi.audit.denied",
        data: {
          reason: "missing_permission",
          denied: { action: "write" },
        },
      },
    );

    expect(prompt).toContain("[Trigger: Debug permission]");
    expect(prompt).toContain("Event: ravi.audit.denied");
    expect(prompt).toContain("Data:");
    expect(prompt).toContain('"reason": "missing_permission"');
    expect(prompt).toContain("Analise missing_permission");
  });
});

describe("buildTriggerPrompt with a debounced batch", () => {
  const trigger = { name: "burst", topic: "x.y", message: "Process {{data.n}}", messageSource: "manual" as const };

  it("lists every event of the burst and resolves the message against the last one", () => {
    const events = [1, 2, 3].map((n) => ({ topic: "x.y", data: { n } }));
    const prompt = buildTriggerPrompt(trigger, events[2], { events, omitted: 0 });
    expect(prompt).toContain("Batch: 3 events debounced into this fire");
    expect(prompt).toContain('"n": 1');
    expect(prompt).toContain('"n": 2');
    expect(prompt).toContain("Process 3");
    expect(prompt).not.toContain("Data:");
  });

  it("keeps the single-event shape for a batch of one", () => {
    const only = { topic: "x.y", data: { n: 7 } };
    const prompt = buildTriggerPrompt(trigger, only, { events: [only], omitted: 0 });
    expect(prompt).not.toContain("Batch:");
    expect(prompt).toContain("Data:");
  });
});
