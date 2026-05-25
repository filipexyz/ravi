import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { addContactTag, closeContacts, getContact, removeContactTag, upsertContact } from "../contacts.js";
import { dbEnsureTagBinding } from "../tags/tag-db.js";
import {
  dbCreateChatReadingList,
  dbUpsertChat,
  dbUpsertChatParticipant,
  dbGetChatReadingCursor,
  dbMarkChatReadingCursor,
  dbAddChatToReadingList,
  getDb,
} from "../router/router-db.js";
import {
  evaluateSelectorForContact,
  evaluateSelectorForChat,
  refreshReverseIndex,
  getAffectedListIds,
  tickReadingLists,
  explainSelector,
} from "./engine.js";
import { dbUpsertSelectorMember, dbSoftRemoveSelectorMember, dbIsActiveMember } from "./db.js";
import type { DynamicListSelector } from "./types.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-reading-lists-engine-test-");
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

function makeContact(phone: string, tag?: string) {
  upsertContact(phone, "Test", "allowed", "manual");
  if (tag) addContactTag(phone, tag);
  return getContact(phone)!;
}

/** Create a DM chat and link a contact to it via chat_participants. */
function makeContactChat(phone: string, contactId: string) {
  const chat = dbUpsertChat({
    channel: "whatsapp",
    instanceId: "inst-1",
    platformChatId: `${phone}@s.whatsapp.net`,
    normalizedChatId: `${phone}@s.whatsapp.net`,
    chatType: "dm",
  });
  dbUpsertChatParticipant({ chatId: chat.id, contactId, role: "member", source: "inbound" });
  return chat;
}

// ============================================================================
// evaluateSelectorForContact
// ============================================================================

describe("evaluateSelectorForContact", () => {
  it("returns matched=true when contact has required tag", () => {
    const contact = makeContact("5511100001111", "cobranca");
    const selector: DynamicListSelector = {
      scope: "contact",
      match: "all",
      conditions: [{ kind: "has-tag", tag: "cobranca" }],
    };
    const result = evaluateSelectorForContact(selector, contact);
    expect(result.matched).toBe(true);
  });

  it("returns matched=false when contact lacks required tag", () => {
    const contact = makeContact("5511100001112");
    const selector: DynamicListSelector = {
      scope: "contact",
      match: "all",
      conditions: [{ kind: "has-tag", tag: "cobranca" }],
    };
    const result = evaluateSelectorForContact(selector, contact);
    expect(result.matched).toBe(false);
  });

  it("returns matched=false for scope-mismatch (chat selector)", () => {
    const contact = makeContact("5511100001113", "cobranca");
    const selector: DynamicListSelector = {
      scope: "chat",
      match: "all",
      conditions: [{ kind: "has-tag", tag: "cobranca" }],
    };
    const result = evaluateSelectorForContact(selector, contact);
    expect(result.matched).toBe(false);
    expect(result.trace[0]).toMatchObject({ reason: "scope-mismatch" });
  });

  it("evaluates has-any-tag: matched when contact has at least one", () => {
    const contact = makeContact("5511100001114", "vip");
    const selector: DynamicListSelector = {
      scope: "contact",
      match: "all",
      conditions: [{ kind: "has-any-tag", tags: ["vip", "premium"] }],
    };
    const result = evaluateSelectorForContact(selector, contact);
    expect(result.matched).toBe(true);
  });

  it("evaluates AND logic: all conditions must match", () => {
    // contact has "cobranca" but not "vip" — should fail
    const contact = makeContact("5511100001115", "cobranca");
    const selector: DynamicListSelector = {
      scope: "contact",
      match: "all",
      conditions: [
        { kind: "has-tag", tag: "cobranca" },
        { kind: "has-tag", tag: "vip" },
      ],
    };
    const result = evaluateSelectorForContact(selector, contact);
    expect(result.matched).toBe(false);
  });
});

// ============================================================================
// evaluateSelectorForChat
// ============================================================================

describe("evaluateSelectorForChat", () => {
  it("returns matched=true when chat has required tag", () => {
    const chat = makeChat("20000001");
    dbEnsureTagBinding({ slug: "chat-cobranca", assetType: "chat", assetId: chat.id, source: "test" });
    const selector: DynamicListSelector = {
      scope: "chat",
      match: "all",
      conditions: [{ kind: "has-tag", tag: "chat-cobranca" }],
    };
    const result = evaluateSelectorForChat(selector, chat.id);
    expect(result.matched).toBe(true);
  });

  it("returns matched=false when chat lacks required tag", () => {
    const chat = makeChat("20000002");
    const selector: DynamicListSelector = {
      scope: "chat",
      match: "all",
      conditions: [{ kind: "has-tag", tag: "chat-cobranca" }],
    };
    const result = evaluateSelectorForChat(selector, chat.id);
    expect(result.matched).toBe(false);
  });

  it("returns matched=false for scope-mismatch (contact selector)", () => {
    const chat = makeChat("20000003");
    const selector: DynamicListSelector = {
      scope: "contact",
      match: "all",
      conditions: [{ kind: "has-tag", tag: "cobranca" }],
    };
    const result = evaluateSelectorForChat(selector, chat.id);
    expect(result.matched).toBe(false);
    expect(result.trace[0]).toMatchObject({ reason: "scope-mismatch" });
  });
});

// ============================================================================
// tickReadingLists — state machine (AC-1, AC-2, AC-5, AC-7, AC-8)
// ============================================================================

describe("tickReadingLists", () => {
  it("AC-1: adds chat to list when contact has matching tag (apply=true)", async () => {
    const contact = makeContact("5511200000001", "cobranca");
    const chat = makeContactChat("5511200000001", contact.id);
    const list = dbCreateChatReadingList({
      name: "sde-cobranca",
      mode: "dynamic",
      selector: { scope: "contact", match: "all", conditions: [{ kind: "has-tag", tag: "cobranca" }] },
    });

    const result = await tickReadingLists({ apply: true, listId: list.id });

    expect(result.added).toBe(1);
    expect(result.removed).toBe(0);
    expect(dbIsActiveMember(list.id, chat.id)).toBe(true);
  });

  it("AC-5: dry-run does not modify membership", async () => {
    const contact = makeContact("5511200000002", "cobranca");
    const chatDry = makeContactChat("5511200000002", contact.id);
    const list = dbCreateChatReadingList({
      name: "dry-run-list",
      mode: "dynamic",
      selector: { scope: "contact", match: "all", conditions: [{ kind: "has-tag", tag: "cobranca" }] },
    });

    const result = await tickReadingLists({ apply: false, listId: list.id });

    expect(result.dryRun).toBe(true);
    expect(result.transitions).toHaveLength(1);
    expect(result.transitions[0]?.kind).toBe("added");
    // No DB write happened
    expect(dbIsActiveMember(list.id, chatDry.id)).toBe(false);
  });

  it("AC-2: soft-removes chat when contact loses matching tag", async () => {
    const contact = makeContact("5511200000003", "cobranca");
    const chat = makeContactChat("5511200000003", contact.id);
    const list = dbCreateChatReadingList({
      name: "remove-list",
      mode: "dynamic",
      selector: { scope: "contact", match: "all", conditions: [{ kind: "has-tag", tag: "cobranca" }] },
    });

    // Add member manually (simulate prior tick)
    dbUpsertSelectorMember({ listId: list.id, chatId: chat.id });
    expect(dbIsActiveMember(list.id, chat.id)).toBe(true);

    // Remove the tag from contact — now tick should remove the member
    removeContactTag("5511200000003", "cobranca");
    const freshContact = getContact("5511200000003")!;
    expect(freshContact.tags.some((t) => t.includes("cobranca"))).toBe(false);

    const result = await tickReadingLists({ apply: true, listId: list.id });

    expect(result.removed).toBe(1);
    expect(dbIsActiveMember(list.id, chat.id)).toBe(false);
  });

  it("AC-9: concurrent ticks produce zero duplicate active members", async () => {
    const contact = makeContact("5511200000020", "cobranca");
    const chat = makeContactChat("5511200000020", contact.id);
    const list = dbCreateChatReadingList({
      name: "concurrent-tick-list",
      mode: "dynamic",
      selector: { scope: "contact", match: "all", conditions: [{ kind: "has-tag", tag: "cobranca" }] },
    });

    // Run two ticks in parallel against the same state
    await Promise.all([
      tickReadingLists({ apply: true, listId: list.id }),
      tickReadingLists({ apply: true, listId: list.id }),
    ]);

    const count = getDb()
      .prepare(
        "SELECT COUNT(*) AS n FROM chat_reading_list_members WHERE list_id = ? AND chat_id = ? AND removed_at IS NULL",
      )
      .get(list.id, chat.id) as { n: number };
    expect(count.n).toBe(1);
  });

  it("AC-8: idempotent — re-tick on matched contact does not duplicate member", async () => {
    const contact = makeContact("5511200000004", "cobranca");
    const chat = makeContactChat("5511200000004", contact.id);
    const list = dbCreateChatReadingList({
      name: "idempotent-list",
      mode: "dynamic",
      selector: { scope: "contact", match: "all", conditions: [{ kind: "has-tag", tag: "cobranca" }] },
    });

    await tickReadingLists({ apply: true, listId: list.id });
    await tickReadingLists({ apply: true, listId: list.id });

    const count = getDb()
      .prepare(
        "SELECT COUNT(*) AS n FROM chat_reading_list_members WHERE list_id = ? AND chat_id = ? AND removed_at IS NULL",
      )
      .get(list.id, chat.id) as { n: number };
    expect(count.n).toBe(1);
  });

  it("scopes tick to specific list when listId option is set", async () => {
    const contact = makeContact("5511200000005", "cobranca");
    const chatScoped = makeContactChat("5511200000005", contact.id);
    const list1 = dbCreateChatReadingList({
      name: "scoped-list-1",
      mode: "dynamic",
      selector: { scope: "contact", match: "all", conditions: [{ kind: "has-tag", tag: "cobranca" }] },
    });
    const list2 = dbCreateChatReadingList({
      name: "scoped-list-2",
      mode: "dynamic",
      selector: { scope: "contact", match: "all", conditions: [{ kind: "has-tag", tag: "cobranca" }] },
    });

    const result = await tickReadingLists({ apply: true, listId: list1.id });

    expect(result.listsProcessed).toBe(1);
    expect(dbIsActiveMember(list2.id, chatScoped.id)).toBe(false);
  });

  it("H-1a: adds member when list owner is participant in the chat (permission granted)", async () => {
    const agentId = "test-agent-h1";
    const contact = makeContact("5511200000010", "cobranca");
    const chat = makeContactChat("5511200000010", contact.id);
    // Add agent as participant → permission granted
    dbUpsertChatParticipant({ chatId: chat.id, contactId: null, agentId, role: "agent", source: "inbound" });
    const list = dbCreateChatReadingList({
      name: "h1-allowed-list",
      mode: "dynamic",
      ownerType: "agent",
      ownerId: agentId,
      selector: { scope: "contact", match: "all", conditions: [{ kind: "has-tag", tag: "cobranca" }] },
    });

    const result = await tickReadingLists({ apply: true, listId: list.id });

    expect(result.added).toBe(1);
    expect(result.permissionDenied).toBe(0);
    expect(dbIsActiveMember(list.id, chat.id)).toBe(true);
  });

  it("H-1b: skips chat and increments permissionDenied when owner is not a participant", async () => {
    const agentId = "test-agent-h1-denied";
    const contact = makeContact("5511200000011", "cobranca");
    const chat = makeContactChat("5511200000011", contact.id);
    // Agent is NOT added as participant → permission denied
    const list = dbCreateChatReadingList({
      name: "h1-denied-list",
      mode: "dynamic",
      ownerType: "agent",
      ownerId: agentId,
      selector: { scope: "contact", match: "all", conditions: [{ kind: "has-tag", tag: "cobranca" }] },
    });

    const result = await tickReadingLists({ apply: true, listId: list.id });

    expect(result.added).toBe(0);
    expect(result.permissionDenied).toBeGreaterThanOrEqual(1);
    expect(dbIsActiveMember(list.id, chat.id)).toBe(false);
  });

  it("increments errors counter when selector is invalid (fails Zod)", async () => {
    // Create list with a non-null but invalid selector (passes NOT NULL filter but fails safeParse)
    const list = dbCreateChatReadingList({
      name: "invalid-selector",
      mode: "dynamic",
      selector: { scope: "contact", match: "all", conditions: [{ kind: "has-tag", tag: "x" }] },
    });
    // Overwrite with an invalid selector JSON directly
    getDb()
      .prepare("UPDATE chat_reading_lists SET selector_json = ? WHERE id = ?")
      .run(JSON.stringify({ scope: "bad-scope", conditions: [] }), list.id);

    const result = await tickReadingLists({ apply: true, listId: list.id });
    expect(result.errors).toBeGreaterThan(0);
  });
});

// ============================================================================
// AC-3: Cursor independence — member lifecycle does NOT touch cursors
// ============================================================================

describe("cursor independence (AC-3)", () => {
  it("cursor survives member add → remove → re-add lifecycle", async () => {
    const contact = makeContact("5511300000001", "cobranca");
    const chat = makeContactChat("5511300000001", contact.id);
    const list = dbCreateChatReadingList({
      name: "cursor-test-list",
      mode: "dynamic",
      selector: { scope: "contact", match: "all", conditions: [{ kind: "has-tag", tag: "cobranca" }] },
    });

    // Step 1: add member
    dbUpsertSelectorMember({ listId: list.id, chatId: chat.id });

    // Step 2: mark cursor (requires active membership)
    const cursor = dbMarkChatReadingCursor({
      listId: list.id,
      chatId: chat.id,
      readerType: "agent",
      readerId: "agent-test",
      reason: "test",
    });
    expect(cursor).not.toBeNull();
    const cursorId = cursor.id;

    // Step 3: soft-remove member (simulates tag removal)
    dbSoftRemoveSelectorMember({ listId: list.id, chatId: chat.id });
    expect(dbIsActiveMember(list.id, chat.id)).toBe(false);

    // Cursor must still exist
    const cursorAfterRemove = dbGetChatReadingCursor({
      listId: list.id,
      chatId: chat.id,
      readerType: "agent",
      readerId: "agent-test",
    });
    expect(cursorAfterRemove).not.toBeNull();
    expect(cursorAfterRemove?.id).toBe(cursorId);

    // Step 4: re-entry (tag re-applied)
    const { member } = dbUpsertSelectorMember({ listId: list.id, chatId: chat.id });
    expect(member.removedAt).toBeUndefined();

    // Cursor still present with same id
    const cursorAfterReentry = dbGetChatReadingCursor({
      listId: list.id,
      chatId: chat.id,
      readerType: "agent",
      readerId: "agent-test",
    });
    expect(cursorAfterReentry?.id).toBe(cursorId);
  });
});

// ============================================================================
// Reverse index
// ============================================================================

describe("reverse index", () => {
  it("maps tag slug to affected list ids after refresh", () => {
    dbCreateChatReadingList({
      name: "ri-list-1",
      mode: "dynamic",
      selector: { scope: "contact", match: "all", conditions: [{ kind: "has-tag", tag: "cobranca" }] },
    });

    refreshReverseIndex();

    const affected = getAffectedListIds(["cobranca"]);
    expect(affected.size).toBe(1);
  });

  it("returns empty set for unknown tag slug", () => {
    refreshReverseIndex();
    const affected = getAffectedListIds(["nonexistent-tag"]);
    expect(affected.size).toBe(0);
  });

  it("indexes has-any-tag and has-all-tags slugs", () => {
    dbCreateChatReadingList({
      name: "ri-list-any",
      mode: "dynamic",
      selector: {
        scope: "contact",
        match: "all",
        conditions: [{ kind: "has-any-tag", tags: ["vip", "premium"] }],
      },
    });
    dbCreateChatReadingList({
      name: "ri-list-all",
      mode: "dynamic",
      selector: {
        scope: "contact",
        match: "all",
        conditions: [{ kind: "has-all-tags", tags: ["vip", "enterprise"] }],
      },
    });

    refreshReverseIndex();

    expect(getAffectedListIds(["vip"]).size).toBeGreaterThanOrEqual(2);
    expect(getAffectedListIds(["premium"]).size).toBeGreaterThanOrEqual(1);
    expect(getAffectedListIds(["enterprise"]).size).toBeGreaterThanOrEqual(1);
  });

  it("does not index conditions without tag slugs (e.g. message-count)", () => {
    dbCreateChatReadingList({
      name: "ri-list-chat",
      mode: "dynamic",
      selector: {
        scope: "chat",
        match: "all",
        conditions: [{ kind: "message-count", operator: ">=", value: 1 }],
      },
    });

    refreshReverseIndex();

    // "message-count" has no tag slug to index
    const affected = getAffectedListIds(["message-count"]);
    expect(affected.size).toBe(0);
  });
});

// ============================================================================
// explainSelector
// ============================================================================

describe("explainSelector", () => {
  it("returns matched=true for a contact that qualifies", () => {
    makeContact("5511400000001", "cobranca");
    const contact = getContact("5511400000001")!;
    const list = dbCreateChatReadingList({
      name: "explain-list-1",
      mode: "dynamic",
      selector: { scope: "contact", match: "all", conditions: [{ kind: "has-tag", tag: "cobranca" }] },
    });

    const result = explainSelector(list, { type: "contact", id: contact.id });
    expect(result).not.toBeNull();
    expect(result?.matched).toBe(true);
    expect(result?.listId).toBe(list.id);
  });

  it("returns matched=false for a contact that does not qualify", () => {
    makeContact("5511400000002");
    const contact = getContact("5511400000002")!;
    const list = dbCreateChatReadingList({
      name: "explain-list-2",
      mode: "dynamic",
      selector: { scope: "contact", match: "all", conditions: [{ kind: "has-tag", tag: "cobranca" }] },
    });

    const result = explainSelector(list, { type: "contact", id: contact.id });
    expect(result?.matched).toBe(false);
  });

  it("returns null when list has no selector", () => {
    const list = dbCreateChatReadingList({ name: "explain-noselector", mode: "dynamic" });

    const result = explainSelector(list, { type: "contact", id: "contact_fake" });
    expect(result).toBeNull();
  });

  it("returns null when contact does not exist", () => {
    const list = dbCreateChatReadingList({
      name: "explain-list-4",
      mode: "dynamic",
      selector: { scope: "contact", match: "all", conditions: [{ kind: "has-tag", tag: "cobranca" }] },
    });

    const result = explainSelector(list, { type: "contact", id: "contact_nonexistent" });
    expect(result).toBeNull();
  });
});

// ============================================================================
// Membership state machine — additional invariants
// ============================================================================

describe("membership state machine", () => {
  it("re-entry preserves member id (AC-6)", async () => {
    const contact = makeContact("5511500000001", "cobranca");
    const chat = makeContactChat("5511500000001", contact.id);
    const list = dbCreateChatReadingList({
      name: "reentry-list",
      mode: "dynamic",
      selector: { scope: "contact", match: "all", conditions: [{ kind: "has-tag", tag: "cobranca" }] },
    });

    const { member: first } = dbUpsertSelectorMember({ listId: list.id, chatId: chat.id });
    dbSoftRemoveSelectorMember({ listId: list.id, chatId: chat.id });
    const { member: reactivated } = dbUpsertSelectorMember({ listId: list.id, chatId: chat.id });

    expect(reactivated.id).toBe(first.id);
  });

  it("source is always 'selector' for engine-managed members", async () => {
    const contact = makeContact("5511500000002", "cobranca");
    const chat = makeContactChat("5511500000002", contact.id);
    const list = dbCreateChatReadingList({
      name: "source-test-list",
      mode: "dynamic",
      selector: { scope: "contact", match: "all", conditions: [{ kind: "has-tag", tag: "cobranca" }] },
    });

    await tickReadingLists({ apply: true, listId: list.id });

    const row = getDb()
      .prepare("SELECT source FROM chat_reading_list_members WHERE list_id = ? AND chat_id = ? AND removed_at IS NULL")
      .get(list.id, chat.id) as { source: string } | null;
    expect(row?.source).toBe("selector");
  });

  it("hybrid list: selector does NOT remove manually-added members (source guard)", () => {
    const chat = makeChat("60000001");
    const list = dbCreateChatReadingList({
      name: "hybrid-guard-list",
      mode: "hybrid",
      selector: { scope: "contact", match: "all", conditions: [{ kind: "has-tag", tag: "cobranca" }] },
    });

    // Add member manually (different source)
    dbAddChatToReadingList({ listId: list.id, chatId: chat.id, source: "manual" });
    expect(dbIsActiveMember(list.id, chat.id)).toBe(true);

    // Soft-remove for selector should NOT remove it (source guard)
    const removed = dbSoftRemoveSelectorMember({ listId: list.id, chatId: chat.id });
    expect(removed).toBe(false);
    expect(dbIsActiveMember(list.id, chat.id)).toBe(true);
  });
});
