import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { addContactTag, closeContacts, getContact, getContactById, upsertContact } from "../contacts.js";
import { dbUpsertChat, dbUpsertChatMessage } from "../router/router-db.js";
import { loadTagRulesFromDirectory, runTagRulesForContact, type TagRule } from "./index.js";
import { evaluateContactConditions } from "./conditions.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-tag-rules-test-");
});

afterEach(async () => {
  closeContacts();
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function writeRule(rule: TagRule, name: string = `${rule.id}.json`): void {
  if (!stateDir) throw new Error("missing state dir");
  const dir = join(stateDir, "tag-rules");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(rule), "utf8");
}

describe("tag-rules loader", () => {
  it("loads json rules ordered by priority then id", () => {
    writeRule(
      {
        id: "beta",
        scope: "contact",
        enabled: true,
        priority: 5,
        conditions: [],
        apply: [{ target: "contact", tag: "x", when: "matched" }],
        evaluation: { reactive: true, cron: null },
      } as TagRule,
      "beta.json",
    );
    writeRule(
      {
        id: "alpha",
        scope: "contact",
        enabled: true,
        priority: 5,
        conditions: [],
        apply: [{ target: "contact", tag: "y", when: "matched" }],
        evaluation: { reactive: true, cron: null },
      } as TagRule,
      "alpha.json",
    );
    writeRule(
      {
        id: "first",
        scope: "contact",
        enabled: true,
        priority: 1,
        conditions: [],
        apply: [{ target: "contact", tag: "z", when: "matched" }],
        evaluation: { reactive: true, cron: null },
      } as TagRule,
      "first.json",
    );

    const result = loadTagRulesFromDirectory();
    expect(result.errors).toEqual([]);
    expect(result.rules.map((entry) => entry.rule.id)).toEqual(["first", "alpha", "beta"]);
  });

  it("rejects duplicate ids and reports errors without breaking other rules", () => {
    writeRule(
      {
        id: "dup",
        scope: "contact",
        enabled: true,
        priority: 0,
        conditions: [],
        apply: [{ target: "contact", tag: "a", when: "matched" }],
        evaluation: { reactive: true, cron: null },
      } as TagRule,
      "dup-a.json",
    );
    writeRule(
      {
        id: "dup",
        scope: "contact",
        enabled: true,
        priority: 0,
        conditions: [],
        apply: [{ target: "contact", tag: "b", when: "matched" }],
        evaluation: { reactive: true, cron: null },
      } as TagRule,
      "dup-b.json",
    );
    writeRule(
      {
        id: "ok",
        scope: "contact",
        enabled: true,
        priority: 0,
        conditions: [],
        apply: [{ target: "contact", tag: "c", when: "matched" }],
        evaluation: { reactive: true, cron: null },
      } as TagRule,
      "ok.json",
    );

    const result = loadTagRulesFromDirectory();
    expect(result.rules.map((entry) => entry.rule.id)).toEqual(["dup", "ok"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.error).toContain("Duplicate rule id");
  });
});

describe("tag-rules condition evaluation", () => {
  it("matches has-tag and not-has-tag against canonical contact tags", () => {
    upsertContact("5511999999999", "Lead", "allowed", "manual");
    addContactTag("5511999999999", "lifecycle:active");
    const contact = getContact("5511999999999")!;

    const matched = evaluateContactConditions({
      conditions: [
        { kind: "has-tag", tag: "lifecycle:active" },
        { kind: "not-has-tag", tag: "lifecycle:churned" },
      ],
      contact,
    });
    expect(matched.matched).toBe(true);

    const negative = evaluateContactConditions({
      conditions: [{ kind: "has-tag", tag: "lifecycle:churned" }],
      contact,
    });
    expect(negative.matched).toBe(false);
  });

  it("matches has-chat-with using message text regex", () => {
    upsertContact("5511991122334", "Buyer", "discovered", "inbound");
    const contact = getContact("5511991122334")!;
    const chat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "sde",
      platformChatId: "5511991122334@s.whatsapp.net",
      chatType: "dm",
      title: "Buyer",
      rawProvenance: { source: "test" },
    });
    dbUpsertChatMessage({
      chatId: chat.id,
      channel: "whatsapp",
      instanceId: "sde",
      providerMessageId: "wamid-engine-2",
      rawChatId: "5511991122334@s.whatsapp.net",
      rawSenderId: "5511991122334",
      normalizedSenderId: "5511991122334",
      actorType: "contact",
      contactId: contact.id,
      messageType: "text",
      content: { type: "text", text: "queria saber o preço" },
      providerTimestamp: Date.now(),
      ingestedAt: Date.now(),
    });

    const refreshed = getContactById(contact.id)!;
    const result = evaluateContactConditions({
      conditions: [
        {
          kind: "has-chat-with",
          conditions: [
            { kind: "any-message-text-matches", pattern: "(preço|comprar)" },
            { kind: "message-count", operator: ">=", value: 1 },
          ],
        },
      ],
      contact: refreshed,
    });
    expect(result.matched).toBe(true);
  });
});

describe("tag-rules ordering predicates", () => {
  it("any-message-text-matches with lastN inspects the most recent messages", () => {
    upsertContact("5511990005555", "Recent", "discovered", "inbound");
    const contact = getContact("5511990005555")!;
    const chat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "sde",
      platformChatId: "5511990005555@s.whatsapp.net",
      chatType: "dm",
      title: "Recent",
      rawProvenance: { source: "test" },
    });

    const base = Date.now() - 10 * 60 * 1000;
    dbUpsertChatMessage({
      chatId: chat.id,
      channel: "whatsapp",
      instanceId: "sde",
      providerMessageId: "wamid-recent-1",
      rawChatId: "5511990005555@s.whatsapp.net",
      rawSenderId: "5511990005555",
      normalizedSenderId: "5511990005555",
      actorType: "contact",
      contactId: contact.id,
      messageType: "text",
      content: { type: "text", text: "queria saber o preço" },
      providerTimestamp: base,
      ingestedAt: base,
    });
    dbUpsertChatMessage({
      chatId: chat.id,
      channel: "whatsapp",
      instanceId: "sde",
      providerMessageId: "wamid-recent-2",
      rawChatId: "5511990005555@s.whatsapp.net",
      rawSenderId: "5511990005555",
      normalizedSenderId: "5511990005555",
      actorType: "contact",
      contactId: contact.id,
      messageType: "text",
      content: { type: "text", text: "obrigado, depois decido" },
      providerTimestamp: base + 60_000,
      ingestedAt: base + 60_000,
    });

    const refreshed = getContactById(contact.id)!;
    const result = evaluateContactConditions({
      conditions: [
        {
          kind: "has-chat-with",
          conditions: [{ kind: "any-message-text-matches", pattern: "preço", lastN: 1 }],
        },
      ],
      contact: refreshed,
    });
    expect(result.matched).toBe(false);

    const broader = evaluateContactConditions({
      conditions: [
        {
          kind: "has-chat-with",
          conditions: [{ kind: "any-message-text-matches", pattern: "preço", lastN: 2 }],
        },
      ],
      contact: refreshed,
    });
    expect(broader.matched).toBe(true);
  });

  it("last-inbound-age finds the most recent inbound even past 200 msgs", () => {
    upsertContact("5511990006666", "Aged", "discovered", "inbound");
    const contact = getContact("5511990006666")!;
    const chat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "sde",
      platformChatId: "5511990006666@s.whatsapp.net",
      chatType: "dm",
      title: "Aged",
      rawProvenance: { source: "test" },
    });

    const now = Date.now();
    const oneHour = 60 * 60 * 1000;
    dbUpsertChatMessage({
      chatId: chat.id,
      channel: "whatsapp",
      instanceId: "sde",
      providerMessageId: "wamid-old",
      rawChatId: "5511990006666@s.whatsapp.net",
      rawSenderId: "5511990006666",
      normalizedSenderId: "5511990006666",
      actorType: "contact",
      contactId: contact.id,
      messageType: "text",
      content: { type: "text", text: "old" },
      providerTimestamp: now - 10 * 24 * oneHour,
      ingestedAt: now - 10 * 24 * oneHour,
    });
    dbUpsertChatMessage({
      chatId: chat.id,
      channel: "whatsapp",
      instanceId: "sde",
      providerMessageId: "wamid-recent",
      rawChatId: "5511990006666@s.whatsapp.net",
      rawSenderId: "5511990006666",
      normalizedSenderId: "5511990006666",
      actorType: "contact",
      contactId: contact.id,
      messageType: "text",
      content: { type: "text", text: "fresh" },
      providerTimestamp: now - 30 * 60 * 1000,
      ingestedAt: now - 30 * 60 * 1000,
    });

    const refreshed = getContactById(contact.id)!;
    const result = evaluateContactConditions({
      conditions: [
        {
          kind: "has-chat-with",
          conditions: [{ kind: "last-inbound-age", operator: "<", duration: "2h" }],
        },
      ],
      contact: refreshed,
    });
    expect(result.matched).toBe(true);
  });

  it("message-count uses count(*) and reflects the total message rows", () => {
    upsertContact("5511990007777", "Counter", "discovered", "inbound");
    const contact = getContact("5511990007777")!;
    const chat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "sde",
      platformChatId: "5511990007777@s.whatsapp.net",
      chatType: "dm",
      title: "Counter",
      rawProvenance: { source: "test" },
    });

    const base = Date.now();
    for (let index = 0; index < 5; index += 1) {
      dbUpsertChatMessage({
        chatId: chat.id,
        channel: "whatsapp",
        instanceId: "sde",
        providerMessageId: `wamid-count-${index}`,
        rawChatId: "5511990007777@s.whatsapp.net",
        rawSenderId: "5511990007777",
        normalizedSenderId: "5511990007777",
        actorType: "contact",
        contactId: contact.id,
        messageType: "text",
        content: { type: "text", text: `msg ${index}` },
        providerTimestamp: base + index,
        ingestedAt: base + index,
      });
    }

    const refreshed = getContactById(contact.id)!;
    const result = evaluateContactConditions({
      conditions: [
        {
          kind: "has-chat-with",
          conditions: [{ kind: "message-count", operator: ">=", value: 5 }],
        },
      ],
      contact: refreshed,
    });
    expect(result.matched).toBe(true);

    const tooMany = evaluateContactConditions({
      conditions: [
        {
          kind: "has-chat-with",
          conditions: [{ kind: "message-count", operator: ">", value: 5 }],
        },
      ],
      contact: refreshed,
    });
    expect(tooMany.matched).toBe(false);
  });
});

describe("tag-rules apply", () => {
  it("dry-run reports intended adds/removes without mutating state", () => {
    upsertContact("5511990001111", "Dry Run", "allowed", "manual");
    addContactTag("5511990001111", "lifecycle:new");

    writeRule({
      id: "qualify",
      scope: "contact",
      enabled: true,
      priority: 0,
      conditions: [{ kind: "has-tag", tag: "lifecycle:new" }],
      apply: [
        {
          target: "contact",
          tag: "lifecycle:qualified",
          removeTag: "lifecycle:new",
          when: "matched",
        },
      ],
      evaluation: { reactive: true, cron: null },
    } as TagRule);

    const result = runTagRulesForContact({
      contactRef: getContactById(getContact("5511990001111")!.id)!.id,
      cause: { evaluation: "manual" },
      apply: false,
    });
    expect(result.rules.matched).toBe(1);
    expect(result.outcomes[0]!.applied[0]!.added).toEqual(["lifecycle:qualified"]);
    expect(result.outcomes[0]!.applied[0]!.removed).toEqual(["lifecycle:new"]);

    const refreshed = getContact("5511990001111")!;
    expect(refreshed.tags).toContain("lifecycle:new");
    expect(refreshed.tags).not.toContain("lifecycle:qualified");
  });

  it("apply=true transitions tags and emits timeline events", () => {
    upsertContact("5511990002222", "Apply", "allowed", "manual");
    addContactTag("5511990002222", "lifecycle:new");

    writeRule({
      id: "qualify-apply",
      scope: "contact",
      enabled: true,
      priority: 0,
      conditions: [{ kind: "has-tag", tag: "lifecycle:new" }],
      apply: [
        {
          target: "contact",
          tag: "lifecycle:qualified",
          removeTag: "lifecycle:new",
          when: "matched",
        },
      ],
      evaluation: { reactive: true, cron: null },
    } as TagRule);

    const result = runTagRulesForContact({
      contactRef: getContact("5511990002222")!.id,
      cause: { evaluation: "manual" },
      apply: true,
    });
    expect(result.rules.appliedActions).toBe(1);

    const refreshed = getContact("5511990002222")!;
    expect(refreshed.tags).toContain("lifecycle:qualified");
    expect(refreshed.tags).not.toContain("lifecycle:new");
  });

  it("cycle guard blocks repeated apply of the same tag within a pass", () => {
    upsertContact("5511990003333", "Cycle", "allowed", "manual");

    const rule: TagRule = {
      id: "cycle-add",
      scope: "contact",
      enabled: true,
      priority: 0,
      conditions: [],
      apply: [
        { target: "contact", tag: "loop:tag", when: "matched" },
        { target: "contact", tag: "loop:tag", when: "matched" },
      ],
      evaluation: { reactive: true, cron: null },
      description: undefined,
    } as TagRule;
    writeRule(rule);

    const result = runTagRulesForContact({
      contactRef: getContact("5511990003333")!.id,
      cause: { evaluation: "manual" },
      apply: true,
    });
    const skippedReasons = result.outcomes[0]!.skipped.map((entry) => entry.reason);
    expect(skippedReasons).toContain("cascade-cycle-skipped");

    const refreshed = getContact("5511990003333")!;
    expect(refreshed.tags.filter((tag) => tag === "loop:tag")).toHaveLength(1);
  });

  it("when:not-matched applies removals when conditions fail", () => {
    upsertContact("5511990004444", "Reverse", "allowed", "manual");
    addContactTag("5511990004444", "temperature:hot");

    writeRule({
      id: "cool-down",
      scope: "contact",
      enabled: true,
      priority: 0,
      conditions: [{ kind: "has-tag", tag: "lifecycle:active" }],
      apply: [
        {
          target: "contact",
          removeTag: "temperature:hot",
          when: "not-matched",
        },
      ],
      evaluation: { reactive: true, cron: null },
    } as TagRule);

    const result = runTagRulesForContact({
      contactRef: getContact("5511990004444")!.id,
      cause: { evaluation: "manual" },
      apply: true,
    });
    expect(result.rules.appliedActions).toBe(1);
    expect(getContact("5511990004444")!.tags).not.toContain("temperature:hot");
  });
});
