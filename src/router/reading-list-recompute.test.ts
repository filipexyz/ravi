import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { getAllContacts, upsertContact } from "../contacts.js";
import { attachTagSlugsToAsset, dbDeleteTagBinding } from "../tags/index.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";

import { recomputeChatReadingList } from "./reading-list-recompute.js";
import {
  dbCreateChatReadingList,
  dbListChatReadingListMembers,
  dbUpsertChat,
  dbUpsertChatParticipant,
} from "./router-db.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-recompute-test-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function seedContactWithDm(phone: string, name: string, tags: string[]) {
  upsertContact(phone, name);
  const contact = getAllContacts().find((c) => c.name === name);
  if (!contact) throw new Error(`Seeded contact ${name} not found`);
  attachTagSlugsToAsset({
    assetType: "contact",
    assetId: contact.id,
    tags,
    source: "test",
  });
  const platformChatId = `${phone.replace(/\D/g, "")}@s.whatsapp.net`;
  const chat = dbUpsertChat({
    channel: "whatsapp",
    instanceId: "instance-1",
    platformChatId,
    chatType: "dm",
    rawProvenance: { provider: "test" },
  });
  dbUpsertChatParticipant({
    chatId: chat.id,
    contactId: contact.id,
    role: "member",
  });
  return { contact, chat };
}

function detachContactTag(contactId: string, slug: string) {
  dbDeleteTagBinding({ slug, assetType: "contact", assetId: contactId, source: "test" });
}

const baseSelector = {
  scope: "contact" as const,
  match: "all" as const,
  conditions: [
    { kind: "has-tag", tag: "lifecycle:lead" },
    { kind: "has-tag", tag: "perfil:cliente" },
    { kind: "not-has-tag", tag: "sinal:optout" },
  ],
};

describe("recomputeChatReadingList", () => {
  it("dry-run reports diff without writing, apply persists members idempotently", () => {
    const eligible1 = seedContactWithDm("+5511999900001", "Lead Eligible 1", ["lifecycle:lead", "perfil:cliente"]);
    const eligible2 = seedContactWithDm("+5511999900002", "Lead Eligible 2", ["lifecycle:lead", "perfil:cliente"]);
    seedContactWithDm("+5511999900003", "Not Eligible", ["lifecycle:lead"]);
    seedContactWithDm("+5511999900004", "Opted Out", ["lifecycle:lead", "perfil:cliente", "sinal:optout"]);

    const list = dbCreateChatReadingList({
      name: "sde-novo-contato-test",
      mode: "dynamic",
      selector: baseSelector,
    });

    const dryRun = recomputeChatReadingList({ listRef: list.id });
    expect(dryRun.apply).toBe(false);
    expect(dryRun.totals.contactsEligible).toBe(2);
    expect(dryRun.totals.added).toBe(2);
    expect(dryRun.totals.removed).toBe(0);
    expect(dryRun.totals.unchanged).toBe(0);
    expect(dbListChatReadingListMembers({ listId: list.id }).total).toBe(0);

    const applied = recomputeChatReadingList({ listRef: list.id, apply: true });
    expect(applied.apply).toBe(true);
    expect(applied.totals.added).toBe(2);
    const members = dbListChatReadingListMembers({ listId: list.id });
    expect(members.total).toBe(2);
    const chatIds = members.items.map((item) => item.member.chatId).sort();
    expect(chatIds).toEqual([eligible1.chat.id, eligible2.chat.id].sort());

    const reapplied = recomputeChatReadingList({ listRef: list.id, apply: true });
    expect(reapplied.totals.added).toBe(0);
    expect(reapplied.totals.removed).toBe(0);
    expect(reapplied.totals.unchanged).toBe(2);
  });

  it("removes members whose contact no longer matches the selector", () => {
    const matching = seedContactWithDm("+5511999910001", "Will Stay", ["lifecycle:lead", "perfil:cliente"]);
    const losing = seedContactWithDm("+5511999910002", "Will Lose Tag", ["lifecycle:lead", "perfil:cliente"]);

    const list = dbCreateChatReadingList({
      name: "sde-recompute-removal-test",
      mode: "dynamic",
      selector: baseSelector,
    });

    recomputeChatReadingList({ listRef: list.id, apply: true });
    expect(dbListChatReadingListMembers({ listId: list.id }).total).toBe(2);

    detachContactTag(losing.contact.id, "perfil:cliente");

    const after = recomputeChatReadingList({ listRef: list.id, apply: true });
    expect(after.totals.removed).toBe(1);
    expect(after.totals.unchanged).toBe(1);
    const members = dbListChatReadingListMembers({ listId: list.id });
    expect(members.total).toBe(1);
    expect(members.items[0]?.member.chatId).toBe(matching.chat.id);
  });

  it("supports 'any' match semantics", () => {
    seedContactWithDm("+5511999920001", "Only Lead", ["lifecycle:lead"]);
    seedContactWithDm("+5511999920002", "Only Cliente", ["perfil:cliente"]);
    seedContactWithDm("+5511999920003", "Neither", ["other:tag"]);

    const list = dbCreateChatReadingList({
      name: "sde-any-match-test",
      mode: "dynamic",
      selector: {
        scope: "contact",
        match: "any",
        conditions: [
          { kind: "has-tag", tag: "lifecycle:lead" },
          { kind: "has-tag", tag: "perfil:cliente" },
        ],
      },
    });

    const result = recomputeChatReadingList({ listRef: list.id, apply: true });
    expect(result.totals.contactsEligible).toBe(2);
    expect(result.totals.added).toBe(2);
  });

  it("refuses non-dynamic lists", () => {
    const list = dbCreateChatReadingList({
      name: "static-list",
      mode: "static",
    });
    expect(() => recomputeChatReadingList({ listRef: list.id })).toThrow(/cannot be recomputed/);
  });

  it("refuses dynamic lists without selector_json", () => {
    const list = dbCreateChatReadingList({
      name: "dynamic-no-selector",
      mode: "dynamic",
    });
    expect(() => recomputeChatReadingList({ listRef: list.id })).toThrow(/no selector_json/);
  });

  it("refuses unsupported selector scope", () => {
    const list = dbCreateChatReadingList({
      name: "chat-scope-list",
      mode: "dynamic",
      selector: {
        scope: "chat",
        match: "all",
        conditions: [{ kind: "chat-type", value: "dm" }],
      },
    });
    expect(() => recomputeChatReadingList({ listRef: list.id })).toThrow(/scope 'chat'/);
  });

  it("excludes group chats by default and includes them with --include-group-chats", () => {
    upsertContact("+5511999930001", "Group Lead");
    const contact = getAllContacts().find((c) => c.name === "Group Lead");
    if (!contact) throw new Error("Group Lead not found");
    attachTagSlugsToAsset({
      assetType: "contact",
      assetId: contact.id,
      tags: ["lifecycle:lead", "perfil:cliente"],
      source: "test",
    });
    const dmChat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "instance-1",
      platformChatId: "5511999930001@s.whatsapp.net",
      chatType: "dm",
      rawProvenance: { provider: "test" },
    });
    dbUpsertChatParticipant({
      chatId: dmChat.id,
      contactId: contact.id,
      role: "member",
    });
    const groupChat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "instance-1",
      platformChatId: "120363001234567890@g.us",
      chatType: "group",
      rawProvenance: { provider: "test" },
    });
    dbUpsertChatParticipant({
      chatId: groupChat.id,
      contactId: contact.id,
      role: "member",
    });

    const list = dbCreateChatReadingList({
      name: "sde-group-filter-test",
      mode: "dynamic",
      selector: baseSelector,
    });

    const dmOnly = recomputeChatReadingList({ listRef: list.id });
    expect(dmOnly.totals.chatsConsidered).toBe(1);

    const withGroups = recomputeChatReadingList({ listRef: list.id, includeGroupChats: true });
    expect(withGroups.totals.chatsConsidered).toBe(2);
  });
});
