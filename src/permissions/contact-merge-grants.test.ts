import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { closeContacts, contactExists, createContact, mergeContacts, resolveMergedContactId } from "../contacts.js";
import { dbCreateTagDefinition } from "../tags/tag-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { dbEnsureContactChatGrant, dbListContactChatGrants } from "./contact-chat-grants.js";
import { profileCarriesBreakGlass, repairOrphanContactChatGrants } from "./contact-merge-grants.js";

setDefaultTimeout(20_000);

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-contact-merge-grants-");
  dbCreateTagDefinition({
    slug: "permission-chat-reader",
    label: "chat reader",
    kind: "system",
    source: "permissions",
    metadata: { permissions: { capabilities: ["view:chat:*"] } },
  });
  dbCreateTagDefinition({
    slug: "permission-sneaky-full",
    label: "sneaky full",
    kind: "system",
    source: "permissions",
    metadata: { permissions: { capabilities: ["admin:system:*", "execute:executable:*"] } },
  });
  dbCreateTagDefinition({
    slug: "permission-exec-all",
    label: "exec all",
    kind: "system",
    source: "permissions",
    metadata: { permissions: { capabilities: ["execute:executable:*"] } },
  });
  dbCreateTagDefinition({
    slug: "permission-system-narrow",
    label: "system narrow",
    kind: "system",
    source: "permissions",
    metadata: { permissions: { capabilities: ["admin:system:contacts"] } },
  });
});

afterEach(async () => {
  closeContacts();
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function grant(contactId: string, profileSlug: string, scopeId = "chat_room") {
  dbEnsureContactChatGrant({ contactId, profileSlug, scopeType: "chat", scopeId });
}

function grantsOf(contactId: string) {
  return dbListContactChatGrants({ contactId })
    .map((g) => `${g.profileSlug}@${g.scopeId}`)
    .sort();
}

describe("chat grants follow a contact merge", () => {
  it("knows which profiles carry break-glass power", () => {
    expect(profileCarriesBreakGlass("permission-sneaky-full")).toBe(true);
    expect(profileCarriesBreakGlass("permission-admin")).toBe(true);
    expect(profileCarriesBreakGlass("permission-exec-all")).toBe(true);
    expect(profileCarriesBreakGlass("permission-system-narrow")).toBe(true);
    expect(profileCarriesBreakGlass("permission-chat-reader")).toBe(false);
  });

  it("moves ordinary grants to the target and drops break-glass ones", () => {
    const target = createContact({ phone: "5511900000001", name: "Target" });
    const source = createContact({ phone: "5511900000002", name: "Source" });
    grant(source.id, "permission-chat-reader");
    grant(source.id, "permission-sneaky-full");

    mergeContacts(target.id, source.id);

    expect(grantsOf(source.id)).toEqual([]);
    // break-glass is never inherited by a merge; only an approved request grants it
    expect(grantsOf(target.id)).toEqual(["permission-chat-reader@chat_room"]);
  });

  it("keeps a grant the target already had once", () => {
    const target = createContact({ phone: "5511900000003" });
    const source = createContact({ phone: "5511900000004" });
    grant(target.id, "permission-chat-reader");
    grant(source.id, "permission-chat-reader");

    mergeContacts(target.id, source.id);

    expect(grantsOf(target.id)).toEqual(["permission-chat-reader@chat_room"]);
    expect(grantsOf(source.id)).toEqual([]);
  });
});

describe("boot repair of grants left on merged contacts", () => {
  it("follows the merge chain and applies the same rule", () => {
    const target = createContact({ phone: "5511900000005" });
    const source = createContact({ phone: "5511900000006" });
    mergeContacts(target.id, source.id);
    // a grant written on the deleted id, as merges did before this fix
    grant(source.id, "permission-chat-reader", "chat_old");
    grant(source.id, "permission-sneaky-full", "chat_old");

    expect(contactExists(source.id)).toBe(false);
    expect(resolveMergedContactId(source.id)).toBe(target.id);

    const results = repairOrphanContactChatGrants();

    expect(results).toHaveLength(1);
    expect(results[0]?.targetContactId).toBe(target.id);
    expect(results[0]?.grants.map((g) => g.outcome).sort()).toEqual(["dropped_break_glass", "moved"]);
    expect(grantsOf(source.id)).toEqual([]);
    expect(grantsOf(target.id)).toEqual(["permission-chat-reader@chat_old"]);
    // idempotent
    expect(repairOrphanContactChatGrants()).toEqual([]);
  });

  it("removes a grant whose contact never existed and was never merged", () => {
    grant("ghost0000000", "permission-sneaky-full", "chat_ghost");

    const results = repairOrphanContactChatGrants();

    expect(results[0]?.targetContactId).toBeNull();
    expect(results[0]?.grants[0]?.outcome).toBe("dropped_no_target");
    expect(dbListContactChatGrants({ contactId: "ghost0000000" })).toEqual([]);
  });

  it("leaves grants of live contacts alone", () => {
    const live = createContact({ phone: "5511900000007" });
    grant(live.id, "permission-sneaky-full");

    expect(repairOrphanContactChatGrants()).toEqual([]);
    expect(grantsOf(live.id)).toEqual(["permission-sneaky-full@chat_room"]);
  });
});
