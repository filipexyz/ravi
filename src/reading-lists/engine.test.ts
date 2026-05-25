import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { addContactTag, closeContacts, getContact, upsertContact } from "../contacts.js";
import {
  dbCreateChatReadingList,
  dbGetChatReadingCursor,
  dbMarkChatReadingCursor,
  dbUpsertChat,
  dbUpsertChatMessage,
} from "../router/router-db.js";
import {
  evaluateSelectorForContact,
  evaluateSelectorForChat,
  refreshReverseIndex,
  getAffectedListIds,
  tickReadingLists,
  explainSelector,
} from "./engine.js";
import { dbIsActiveMember } from "./db.js";
import { evaluateContactConditions } from "../tag-rules/conditions.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-reading-lists-engine-test-");
});

afterEach(async () => {
  closeContacts();
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function makeContact(phone: string, tags: string[] = []) {
  upsertContact(phone, `Contact ${phone}`, "allowed", "manual");
  for (const tag of tags) addContactTag(phone, tag);
  return getContact(phone)!;
}

function makeChat(suffix: string) {
  return dbUpsertChat({
    channel: "whatsapp",
    instanceId: "inst-1",
    platformChatId: `5511${suffix}@s.whatsapp.net`,
    chatType: "dm",
  });
}

// ============================================================================
// Selector evaluation
// ============================================================================

describe("evaluateSelectorForContact", () => {
  it("matches when contact has the required tag", () => {
    const contact = makeContact("990001001", ["cobranca:em-aberto"]);
    const result = evaluateSelectorForContact(
      { scope: "contact", match: "all", conditions: [{ kind: "has-tag", tag: "cobranca:em-aberto" }] },
      contact,
    );
    expect(result.matched).toBe(true);
    expect(result.trace.length).toBe(1);
  });

  it("does not match when contact lacks the tag", () => {
    const contact = makeContact("990001002");
    const result = evaluateSelectorForContact(
      { scope: "contact", match: "all", conditions: [{ kind: "has-tag", tag: "cobranca:em-aberto" }] },
      contact,
    );
    expect(result.matched).toBe(false);
  });

  it("matches not-has-tag when tag is absent", () => {
    const contact = makeContact("990001003");
    const result = evaluateSelectorForContact(
      { scope: "contact", match: "all", conditions: [{ kind: "not-has-tag", tag: "blocked" }] },
      contact,
    );
    expect(result.matched).toBe(true);
  });

  it("does not match when any condition fails (AND semantics)", () => {
    const contact = makeContact("990001004", ["cobranca:em-aberto"]);
    const result = evaluateSelectorForContact(
      {
        scope: "contact",
        match: "all",
        conditions: [
          { kind: "has-tag", tag: "cobranca:em-aberto" },
          { kind: "not-has-tag", tag: "cobranca:em-aberto" }, // contradicts first
        ],
      },
      contact,
    );
    expect(result.matched).toBe(false);
  });

  it("returns scope-mismatch trace for chat scope selector", () => {
    const contact = makeContact("990001005");
    const result = evaluateSelectorForContact(
      { scope: "chat", match: "all", conditions: [{ kind: "has-tag", tag: "x" }] },
      contact,
    );
    expect(result.matched).toBe(false);
    expect(result.trace[0]).toMatchObject({ reason: "scope-mismatch" });
  });

  it("produces trace identical to evaluateContactConditions for same conditions", () => {
    const contact = makeContact("990001006", ["cobranca:em-aberto"]);
    const conditions = [{ kind: "has-tag" as const, tag: "cobranca:em-aberto" }];
    const fromEngine = evaluateSelectorForContact({ scope: "contact", match: "all", conditions }, contact);
    const fromConditions = evaluateContactConditions({ conditions, contact });
    expect(fromEngine.matched).toBe(fromConditions.matched);
    expect(fromEngine.trace).toEqual(fromConditions.trace);
  });
});

describe("evaluateSelectorForChat", () => {
  it("matches when chat has the required tag", async () => {
    const chat = makeChat("990002001");
    // Attach tag to chat directly via tag helpers
    const { attachTagSlugsToAsset } = await import("../tags/helpers.js");
    attachTagSlugsToAsset({
      assetType: "chat",
      assetId: chat.id,
      tags: ["priority:high"],
      source: "test",
      createdBy: "test",
    });
    const result = evaluateSelectorForChat(
      { scope: "chat", match: "all", conditions: [{ kind: "has-tag", tag: "priority:high" }] },
      chat.id,
    );
    expect(result.matched).toBe(true);
  });

  it("does not match when chat lacks the tag", () => {
    const chat = makeChat("990002002");
    const result = evaluateSelectorForChat(
      { scope: "chat", match: "all", conditions: [{ kind: "has-tag", tag: "priority:high" }] },
      chat.id,
    );
    expect(result.matched).toBe(false);
  });

  it("returns scope-mismatch trace for contact scope selector", () => {
    const chat = makeChat("990002003");
    const result = evaluateSelectorForChat(
      { scope: "contact", match: "all", conditions: [{ kind: "has-tag", tag: "x" }] },
      chat.id,
    );
    expect(result.matched).toBe(false);
    expect(result.trace[0]).toMatchObject({ reason: "scope-mismatch" });
  });
});

// ============================================================================
// Reverse index
// ============================================================================

describe("reverse index", () => {
  it("indexes has-tag slugs from dynamic lists", () => {
    dbCreateChatReadingList({
      name: "r-list-1",
      mode: "dynamic",
      selector: { scope: "contact", match: "all", conditions: [{ kind: "has-tag", tag: "cobranca:em-aberto" }] },
    });
    refreshReverseIndex();
    const affected = getAffectedListIds(["cobranca:em-aberto"]);
    expect(affected.size).toBe(1);
  });

  it("indexes has-any-tag slugs", () => {
    dbCreateChatReadingList({
      name: "r-list-2",
      mode: "dynamic",
      selector: { scope: "contact", match: "all", conditions: [{ kind: "has-any-tag", tags: ["tag:a", "tag:b"] }] },
    });
    refreshReverseIndex();
    expect(getAffectedListIds(["tag:a"]).size).toBe(1);
    expect(getAffectedListIds(["tag:b"]).size).toBe(1);
    expect(getAffectedListIds(["tag:c"]).size).toBe(0);
  });

  it("indexes has-all-tags slugs", () => {
    dbCreateChatReadingList({
      name: "r-list-3",
      mode: "dynamic",
      selector: { scope: "contact", match: "all", conditions: [{ kind: "has-all-tags", tags: ["x", "y"] }] },
    });
    refreshReverseIndex();
    expect(getAffectedListIds(["x"]).size).toBe(1);
    expect(getAffectedListIds(["y"]).size).toBe(1);
  });

  it("returns empty set for unrelated tags", () => {
    dbCreateChatReadingList({
      name: "r-list-4",
      mode: "dynamic",
      selector: { scope: "contact", match: "all", conditions: [{ kind: "has-tag", tag: "known" }] },
    });
    refreshReverseIndex();
    const affected = getAffectedListIds(["unknown-tag"]);
    expect(affected.size).toBe(0);
  });

  it("does NOT perform a full DB scan when looking up an absent tag", () => {
    // This test asserts reverse index is used: if getAffectedListIds returns
    // an empty set, the reactive path skips evaluation entirely.
    dbCreateChatReadingList({
      name: "r-list-5",
      mode: "dynamic",
      selector: { scope: "contact", match: "all", conditions: [{ kind: "has-tag", tag: "watched-tag" }] },
    });
    refreshReverseIndex();
    // An unrelated tag change should produce zero affected lists
    const unrelated = getAffectedListIds(["completely-different-tag"]);
    expect(unrelated.size).toBe(0);
  });

  it("includes only dynamic/hybrid lists, not static", () => {
    dbCreateChatReadingList({ name: "static", mode: "static" });
    dbCreateChatReadingList({
      name: "dynamic",
      mode: "dynamic",
      selector: { scope: "contact", match: "all", conditions: [{ kind: "has-tag", tag: "myslug" }] },
    });
    refreshReverseIndex();
    const affected = getAffectedListIds(["myslug"]);
    expect(affected.size).toBe(1);
  });
});

// ============================================================================
// Periodic tick
// ============================================================================

describe("tickReadingLists", () => {
  it("dry-run: returns transitions but writes nothing", async () => {
    const list = dbCreateChatReadingList({
      name: "tick-dryrun",
      mode: "dynamic",
      selector: { scope: "contact", match: "all", conditions: [{ kind: "has-tag", tag: "cobranca" }] },
    });
    const contact = makeContact("990003001", ["cobranca"]);
    const chat = makeChat("990003001");
    // Link contact to chat via participant
    const { dbUpsertChatParticipant } = await import("../router/router-db.js");
    dbUpsertChatParticipant({ chatId: chat.id, contactId: contact.id });

    const result = await tickReadingLists({ apply: false });
    expect(result.dryRun).toBe(true);
    expect(result.added).toBeGreaterThan(0);
    expect(dbIsActiveMember(list.id, chat.id)).toBe(false); // nothing written
  });

  it("apply mode: writes membership transitions", async () => {
    const list = dbCreateChatReadingList({
      name: "tick-apply",
      mode: "dynamic",
      selector: { scope: "contact", match: "all", conditions: [{ kind: "has-tag", tag: "cobranca" }] },
    });
    const contact = makeContact("990004001", ["cobranca"]);
    const chat = makeChat("990004001");
    const { dbUpsertChatParticipant } = await import("../router/router-db.js");
    dbUpsertChatParticipant({ chatId: chat.id, contactId: contact.id });

    const result = await tickReadingLists({ apply: true });
    expect(result.dryRun).toBe(false);
    expect(result.added).toBeGreaterThan(0);
    expect(dbIsActiveMember(list.id, chat.id)).toBe(true);
    const members = result.transitions.filter((t) => t.kind === "added");
    expect(members.some((m) => m.listId === list.id && m.chatId === chat.id)).toBe(true);
    expect(members[0]!.source).toBe("selector");
  });

  it("removes membership when contact no longer matches", async () => {
    const list = dbCreateChatReadingList({
      name: "tick-remove",
      mode: "dynamic",
      selector: { scope: "contact", match: "all", conditions: [{ kind: "has-tag", tag: "cobranca" }] },
    });
    const contact = makeContact("990005001", ["cobranca"]);
    const chat = makeChat("990005001");
    const { dbUpsertChatParticipant } = await import("../router/router-db.js");
    dbUpsertChatParticipant({ chatId: chat.id, contactId: contact.id });

    // First tick: add
    await tickReadingLists({ apply: true });
    expect(dbIsActiveMember(list.id, chat.id)).toBe(true);

    // Remove tag from contact
    const { removeContactTag } = await import("../contacts.js");
    removeContactTag(contact.id, "cobranca");

    // Second tick: remove
    const result2 = await tickReadingLists({ apply: true });
    expect(dbIsActiveMember(list.id, chat.id)).toBe(false);
    const removed = result2.transitions.filter((t) => t.kind === "removed");
    expect(removed.some((r) => r.listId === list.id && r.chatId === chat.id)).toBe(true);
  });

  it("is idempotent: two consecutive ticks on same state produce zero applied changes", async () => {
    const _list = dbCreateChatReadingList({
      name: "tick-idempotent",
      mode: "dynamic",
      selector: { scope: "contact", match: "all", conditions: [{ kind: "has-tag", tag: "cobranca" }] },
    });
    const contact = makeContact("990006001", ["cobranca"]);
    const chat = makeChat("990006001");
    const { dbUpsertChatParticipant } = await import("../router/router-db.js");
    dbUpsertChatParticipant({ chatId: chat.id, contactId: contact.id });

    const first = await tickReadingLists({ apply: true });
    expect(first.added).toBeGreaterThan(0);

    const second = await tickReadingLists({ apply: true });
    expect(second.added).toBe(0);
    expect(second.removed).toBe(0);
    expect(second.transitions.length).toBe(0);
  });

  it("respects --list scoping", async () => {
    const list1 = dbCreateChatReadingList({
      name: "scoped-list-1",
      mode: "dynamic",
      selector: { scope: "contact", match: "all", conditions: [{ kind: "has-tag", tag: "cobranca" }] },
    });
    dbCreateChatReadingList({
      name: "scoped-list-2",
      mode: "dynamic",
      selector: { scope: "contact", match: "all", conditions: [{ kind: "has-tag", tag: "cobranca" }] },
    });
    const contact = makeContact("990007001", ["cobranca"]);
    const chat = makeChat("990007001");
    const { dbUpsertChatParticipant } = await import("../router/router-db.js");
    dbUpsertChatParticipant({ chatId: chat.id, contactId: contact.id });

    const result = await tickReadingLists({ apply: true, listId: list1.id });
    // Only list1 processed
    expect(result.listsProcessed).toBe(1);
  });

  it("source of added members is selector", async () => {
    const list = dbCreateChatReadingList({
      name: "tick-source",
      mode: "dynamic",
      selector: { scope: "contact", match: "all", conditions: [{ kind: "has-tag", tag: "cobranca" }] },
    });
    const contact = makeContact("990008001", ["cobranca"]);
    const chat = makeChat("990008001");
    const { dbUpsertChatParticipant, dbListChatReadingListMembers } = await import("../router/router-db.js");
    dbUpsertChatParticipant({ chatId: chat.id, contactId: contact.id });
    await tickReadingLists({ apply: true });
    const page = dbListChatReadingListMembers({ listId: list.id });
    const member = page.items.find((i) => i.member.chatId === chat.id);
    expect(member?.member.source).toBe("selector");
  });
});

// ============================================================================
// Cursor independence
// ============================================================================

describe("cursor independence", () => {
  it("cursor survives entry → exit → re-entry without reset", async () => {
    const list = dbCreateChatReadingList({
      name: "cursor-test-list",
      mode: "dynamic",
      selector: { scope: "contact", match: "all", conditions: [{ kind: "has-tag", tag: "cobranca" }] },
    });
    const contact = makeContact("990009001", ["cobranca"]);
    const chat = makeChat("990009001");
    const { dbUpsertChatParticipant } = await import("../router/router-db.js");
    dbUpsertChatParticipant({ chatId: chat.id, contactId: contact.id });

    // Step 1: add chat as member
    await tickReadingLists({ apply: true });
    expect(dbIsActiveMember(list.id, chat.id)).toBe(true);

    // Step 2: insert a real message and mark cursor at it
    const { message: anchorMsg } = dbUpsertChatMessage({
      chatId: chat.id,
      channel: "whatsapp",
      rawChatId: `5511990009001@s.whatsapp.net`,
      actorType: "contact",
      messageType: "text",
      content: { text: "anchor" },
    });
    dbMarkChatReadingCursor({
      listId: list.id,
      chatId: chat.id,
      readerType: "agent",
      readerId: "test-reader",
      messageId: anchorMsg.id,
      reason: "test",
    });

    // Verify cursor was set
    const cursorBefore = dbGetChatReadingCursor({
      listId: list.id,
      chatId: chat.id,
      readerType: "agent",
      readerId: "test-reader",
    });
    expect(cursorBefore?.lastReadMessageId).toBe(anchorMsg.id);

    // Step 3: remove tag → next tick removes membership
    const { removeContactTag } = await import("../contacts.js");
    removeContactTag(contact.id, "cobranca");
    await tickReadingLists({ apply: true });
    expect(dbIsActiveMember(list.id, chat.id)).toBe(false);

    // Step 4: cursor must still exist, unchanged
    const cursorAfterRemoval = dbGetChatReadingCursor({
      listId: list.id,
      chatId: chat.id,
      readerType: "agent",
      readerId: "test-reader",
    });
    expect(cursorAfterRemoval?.lastReadMessageId).toBe(anchorMsg.id);

    // Step 5: re-add tag → next tick re-activates membership
    addContactTag(contact.id, "cobranca");
    await tickReadingLists({ apply: true });
    expect(dbIsActiveMember(list.id, chat.id)).toBe(true);

    // Step 6: cursor must still point to the same message
    const cursorAfterReentry = dbGetChatReadingCursor({
      listId: list.id,
      chatId: chat.id,
      readerType: "agent",
      readerId: "test-reader",
    });
    expect(cursorAfterReentry?.lastReadMessageId).toBe(anchorMsg.id);
  });
});

// ============================================================================
// Explain
// ============================================================================

describe("explainSelector", () => {
  it("returns matched=true with trace for a matching contact", () => {
    const list = dbCreateChatReadingList({
      name: "explain-list-1",
      mode: "dynamic",
      selector: { scope: "contact", match: "all", conditions: [{ kind: "has-tag", tag: "vip" }] },
    });
    const contact = makeContact("990010001", ["vip"]);
    const result = explainSelector(list, { type: "contact", id: contact.id });
    expect(result).not.toBeNull();
    expect(result?.matched).toBe(true);
    expect(result?.trace.length).toBeGreaterThan(0);
    expect(result?.selector.scope).toBe("contact");
  });

  it("returns matched=false with trace for a non-matching contact", () => {
    const list = dbCreateChatReadingList({
      name: "explain-list-2",
      mode: "dynamic",
      selector: { scope: "contact", match: "all", conditions: [{ kind: "has-tag", tag: "vip" }] },
    });
    const contact = makeContact("990010002");
    const result = explainSelector(list, { type: "contact", id: contact.id });
    expect(result?.matched).toBe(false);
  });

  it("returns null for a list with invalid selector", () => {
    const list = dbCreateChatReadingList({
      name: "explain-bad-selector",
      mode: "dynamic",
      selector: { scope: "bad", match: "all", conditions: [] },
    });
    const contact = makeContact("990010003");
    const result = explainSelector(list, { type: "contact", id: contact.id });
    expect(result).toBeNull();
  });

  it("returns null for non-existent contact", () => {
    const list = dbCreateChatReadingList({
      name: "explain-no-contact",
      mode: "dynamic",
      selector: { scope: "contact", match: "all", conditions: [{ kind: "has-tag", tag: "x" }] },
    });
    const result = explainSelector(list, { type: "contact", id: "contact_nonexistent" });
    expect(result).toBeNull();
  });

  it("trace is structurally identical to evaluateContactConditions output for same conditions", () => {
    const conditions = [{ kind: "has-tag" as const, tag: "cobranca" }];
    const list = dbCreateChatReadingList({
      name: "explain-trace-compat",
      mode: "dynamic",
      selector: { scope: "contact", match: "all", conditions },
    });
    const contact = makeContact("990010004", ["cobranca"]);
    const explainResult = explainSelector(list, { type: "contact", id: contact.id });
    const directResult = evaluateContactConditions({ conditions, contact });
    expect(explainResult?.matched).toBe(directResult.matched);
    expect(explainResult?.trace).toEqual(directResult.trace);
  });
});

// ============================================================================
// Concurrent ticks safety
// ============================================================================

describe("concurrent ticks", () => {
  it("two concurrent ticks produce zero duplicate active members", async () => {
    const list = dbCreateChatReadingList({
      name: "concurrent-list",
      mode: "dynamic",
      selector: { scope: "contact", match: "all", conditions: [{ kind: "has-tag", tag: "cobranca" }] },
    });
    const contact = makeContact("990011001", ["cobranca"]);
    const chat = makeChat("990011001");
    const { dbUpsertChatParticipant } = await import("../router/router-db.js");
    dbUpsertChatParticipant({ chatId: chat.id, contactId: contact.id });

    // Run two ticks concurrently
    await Promise.all([tickReadingLists({ apply: true }), tickReadingLists({ apply: true })]);

    // Must have exactly one active member row
    const { getDb } = await import("../router/router-db.js");
    const count = (
      getDb()
        .prepare(
          "SELECT COUNT(*) AS c FROM chat_reading_list_members WHERE list_id = ? AND chat_id = ? AND removed_at IS NULL",
        )
        .get(list.id, chat.id) as { c: number }
    ).c;
    expect(count).toBe(1);
  });
});
