import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { closeContacts } from "../contacts.js";
import { dbCreateChatReadingList, dbUpsertChat, dbAddChatToReadingList, getDb } from "../router/router-db.js";
import {
  dbListDynamicReadingLists,
  dbGetListSelector,
  dbUpsertSelectorMember,
  dbSoftRemoveSelectorMember,
  dbUpdateReadingListSelector,
  dbUpdateReadingListMode,
  dbUpdateReadingListMetadata,
  dbIsActiveMember,
} from "./db.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-reading-lists-db-test-");
});

afterEach(async () => {
  closeContacts();
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function makeChat(suffix: string) {
  return dbUpsertChat({
    channel: "whatsapp",
    instanceId: "inst-1",
    platformChatId: `5511${suffix}@s.whatsapp.net`,
    normalizedChatId: `5511${suffix}@s.whatsapp.net`,
    chatType: "dm",
  });
}

describe("dbListDynamicReadingLists", () => {
  it("returns only dynamic and hybrid lists with selector set", () => {
    dbCreateChatReadingList({ name: "static-list", mode: "static" });
    dbCreateChatReadingList({
      name: "dynamic-list",
      mode: "dynamic",
      selector: { scope: "contact", match: "all", conditions: [{ kind: "has-tag", tag: "x" }] },
    });
    dbCreateChatReadingList({
      name: "hybrid-list",
      mode: "hybrid",
      selector: { scope: "contact", match: "all", conditions: [{ kind: "has-tag", tag: "y" }] },
    });
    dbCreateChatReadingList({ name: "dynamic-no-selector", mode: "dynamic" });

    const lists = dbListDynamicReadingLists();
    const names = lists.map((l) => l.name).sort();
    expect(names).toEqual(["dynamic-list", "hybrid-list"]);
  });

  it("excludes archived lists", () => {
    const list = dbCreateChatReadingList({
      name: "archived-dynamic",
      mode: "dynamic",
      selector: { scope: "contact", match: "all", conditions: [{ kind: "has-tag", tag: "x" }] },
    });
    // Archive by direct DB update (no public archive function in router-db API used externally)
    getDb().prepare("UPDATE chat_reading_lists SET archived_at = ? WHERE id = ?").run(Date.now(), list.id);

    const lists = dbListDynamicReadingLists();
    expect(lists.find((l) => l.id === list.id)).toBeUndefined();
  });
});

describe("dbGetListSelector", () => {
  it("returns parsed selector for a valid dynamic list", () => {
    const rawSelector = { scope: "contact", match: "all", conditions: [{ kind: "has-tag", tag: "cobranca" }] };
    const list = dbCreateChatReadingList({ name: "selector-list", mode: "dynamic", selector: rawSelector });
    const selector = dbGetListSelector(list);
    expect(selector).not.toBeNull();
    expect(selector?.scope).toBe("contact");
    expect(selector?.match).toBe("all");
  });

  it("returns null when selector is missing", () => {
    const list = dbCreateChatReadingList({ name: "no-selector-list", mode: "dynamic" });
    const selector = dbGetListSelector(list);
    expect(selector).toBeNull();
  });

  it("returns null when selector is invalid", () => {
    const list = dbCreateChatReadingList({
      name: "bad-selector-list",
      mode: "dynamic",
      selector: { scope: "bad-scope", conditions: [] },
    });
    const selector = dbGetListSelector(list);
    expect(selector).toBeNull();
  });
});

describe("dbUpsertSelectorMember", () => {
  it("inserts a new member and marks written=true", () => {
    const list = dbCreateChatReadingList({ name: "list-1", mode: "dynamic" });
    const chat = makeChat("99990001");
    const result = dbUpsertSelectorMember({ listId: list.id, chatId: chat.id });
    expect(result.written).toBe(true);
    expect(result.member.source).toBe("selector");
    expect(result.member.removedAt).toBeUndefined();
  });

  it("is idempotent: second call returns written=false", () => {
    const list = dbCreateChatReadingList({ name: "list-2", mode: "dynamic" });
    const chat = makeChat("99990002");
    dbUpsertSelectorMember({ listId: list.id, chatId: chat.id });
    const second = dbUpsertSelectorMember({ listId: list.id, chatId: chat.id });
    expect(second.written).toBe(false);
    expect(second.member.removedAt).toBeUndefined();
  });

  it("reactivates a soft-deleted row (re-entry preserves member id)", () => {
    const list = dbCreateChatReadingList({ name: "list-3", mode: "dynamic" });
    const chat = makeChat("99990003");
    const first = dbUpsertSelectorMember({ listId: list.id, chatId: chat.id });
    dbSoftRemoveSelectorMember({ listId: list.id, chatId: chat.id });
    const reactivated = dbUpsertSelectorMember({ listId: list.id, chatId: chat.id });
    expect(reactivated.written).toBe(true);
    expect(reactivated.member.id).toBe(first.member.id);
    expect(reactivated.member.removedAt).toBeUndefined();
  });
});

describe("dbSoftRemoveSelectorMember", () => {
  it("sets removed_at on an active selector member", () => {
    const list = dbCreateChatReadingList({ name: "remove-list-1", mode: "dynamic" });
    const chat = makeChat("99990004");
    dbUpsertSelectorMember({ listId: list.id, chatId: chat.id });
    const removed = dbSoftRemoveSelectorMember({ listId: list.id, chatId: chat.id });
    expect(removed).toBe(true);
    expect(dbIsActiveMember(list.id, chat.id)).toBe(false);
  });

  it("returns false when member is not active", () => {
    const list = dbCreateChatReadingList({ name: "remove-list-2", mode: "dynamic" });
    const chat = makeChat("99990005");
    const removed = dbSoftRemoveSelectorMember({ listId: list.id, chatId: chat.id });
    expect(removed).toBe(false);
  });

  it("does NOT remove manually-added members (source guard)", () => {
    const list = dbCreateChatReadingList({ name: "remove-list-3", mode: "hybrid" });
    const chat = makeChat("99990006");
    dbAddChatToReadingList({ listId: list.id, chatId: chat.id, source: "manual" });
    const removed = dbSoftRemoveSelectorMember({ listId: list.id, chatId: chat.id });
    expect(removed).toBe(false);
    expect(dbIsActiveMember(list.id, chat.id)).toBe(true);
  });
});

describe("dbUpdateReadingList* helpers", () => {
  it("updates selector_json", () => {
    const list = dbCreateChatReadingList({ name: "update-selector", mode: "dynamic" });
    const selector = { scope: "contact", match: "all", conditions: [{ kind: "has-tag", tag: "new" }] };
    dbUpdateReadingListSelector(list.id, selector);
    const [updated] = dbListDynamicReadingLists();
    expect(updated?.selector?.scope).toBe("contact");
  });

  it("updates mode", () => {
    const list = dbCreateChatReadingList({
      name: "update-mode",
      mode: "dynamic",
      selector: { scope: "contact", match: "all", conditions: [{ kind: "has-tag", tag: "x" }] },
    });
    dbUpdateReadingListMode(list.id, "static");
    const lists = dbListDynamicReadingLists();
    expect(lists.find((l) => l.id === list.id)).toBeUndefined();
  });

  it("updates metadata_json", () => {
    const list = dbCreateChatReadingList({
      name: "update-meta",
      mode: "dynamic",
      selector: { scope: "contact", match: "all", conditions: [{ kind: "has-tag", tag: "x" }] },
    });
    dbUpdateReadingListMetadata(list.id, { cron: "*/5 * * * *" });
    const [updated] = dbListDynamicReadingLists();
    expect((updated?.metadata as { cron: string })?.cron).toBe("*/5 * * * *");
  });
});

describe("dbIsActiveMember", () => {
  it("returns true for active member", () => {
    const list = dbCreateChatReadingList({ name: "active-member-list", mode: "dynamic" });
    const chat = makeChat("99990010");
    dbUpsertSelectorMember({ listId: list.id, chatId: chat.id });
    expect(dbIsActiveMember(list.id, chat.id)).toBe(true);
  });

  it("returns false after soft-delete", () => {
    const list = dbCreateChatReadingList({ name: "inactive-member-list", mode: "dynamic" });
    const chat = makeChat("99990011");
    dbUpsertSelectorMember({ listId: list.id, chatId: chat.id });
    dbSoftRemoveSelectorMember({ listId: list.id, chatId: chat.id });
    expect(dbIsActiveMember(list.id, chat.id)).toBe(false);
  });

  it("returns false for unknown pair", () => {
    const list = dbCreateChatReadingList({ name: "unknown-pair-list", mode: "dynamic" });
    expect(dbIsActiveMember(list.id, "chat_nonexistent")).toBe(false);
  });
});
