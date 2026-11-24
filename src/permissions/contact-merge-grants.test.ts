import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { closeContacts, contactExists, createContact, mergeContacts, resolveMergedContactId } from "../contacts.js";
import { dbCreateTagDefinition } from "../tags/tag-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { dbEnsureContactChatGrant, dbListContactChatGrants } from "./contact-chat-grants.js";
import {
  profileCarriesBreakGlass,
  reassignContactChatGrantsOnMerge,
  repairOrphanContactChatGrants,
} from "./contact-merge-grants.js";

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

  it("never ungoverns a chat: the last covering grant stays", () => {
    const target = createContact({ phone: "5511900000011" });
    const source = createContact({ phone: "5511900000012" });
    grant(source.id, "permission-sneaky-full", "chat_locked");

    mergeContacts(target.id, source.id);

    // nothing else covers chat_locked: dropping would hand it to the agent identity
    expect(dbListContactChatGrants({ scopeId: "chat_locked" }).map((g) => g.contactId)).toEqual([source.id]);
    expect(grantsOf(target.id)).toEqual([]);
  });

  it("a self-merge moves and drops nothing", () => {
    const only = createContact({ phone: "5511900000013" });
    grant(only.id, "permission-chat-reader");
    grant(only.id, "permission-sneaky-full", "chat_other");

    expect(reassignContactChatGrantsOnMerge(only.id, only.id).grants).toEqual([]);
    expect(grantsOf(only.id)).toEqual(["permission-chat-reader@chat_room", "permission-sneaky-full@chat_other"]);
  });
});

describe("boot repair of grants left on merged contacts", () => {
  it("removes dead rows without moving them, and audits on the survivor", () => {
    const target = createContact({ phone: "5511900000005" });
    const source = createContact({ phone: "5511900000006" });
    const keeper = createContact({ phone: "5511900000008" });
    mergeContacts(target.id, source.id);
    grant(keeper.id, "permission-chat-reader", "chat_old");
    // rows written on the deleted id, as merges did before this fix
    grant(source.id, "permission-chat-reader", "chat_old");
    grant(source.id, "permission-sneaky-full", "chat_old");

    expect(contactExists(source.id)).toBe(false);
    expect(resolveMergedContactId(source.id)).toBe(target.id);

    const results = repairOrphanContactChatGrants();

    expect(results).toHaveLength(1);
    expect(results[0]?.targetContactId).toBe(target.id);
    expect(results[0]?.grants.map((g) => g.outcome).sort()).toEqual(["dropped_no_target", "dropped_no_target"]);
    expect(grantsOf(source.id)).toEqual([]);
    // the survivor gets nothing: the repair never adds effective permissions
    expect(grantsOf(target.id)).toEqual([]);
    expect(grantsOf(keeper.id)).toEqual(["permission-chat-reader@chat_old"]);
    expect(repairOrphanContactChatGrants()).toEqual([]);
  });

  it("keeps the only row governing a chat and reports nothing", () => {
    grant("ghost0000000", "permission-sneaky-full", "chat_ghost");

    expect(repairOrphanContactChatGrants()).toEqual([]);
    expect(dbListContactChatGrants({ contactId: "ghost0000000" })).toHaveLength(1);
  });

  it("removes a never-merged orphan when the chat stays governed", () => {
    const live = createContact({ phone: "5511900000009" });
    grant(live.id, "permission-chat-reader", "chat_ghost2");
    grant("ghost0000001", "permission-sneaky-full", "chat_ghost2");

    const results = repairOrphanContactChatGrants();

    expect(results[0]?.targetContactId).toBeNull();
    expect(results[0]?.grants[0]?.outcome).toBe("dropped_no_target");
    expect(dbListContactChatGrants({ contactId: "ghost0000001" })).toEqual([]);
  });

  it("follows a merge chain longer than 16 hops", () => {
    const contacts = Array.from({ length: 20 }, (_, i) =>
      createContact({ phone: `55119100000${String(i).padStart(2, "0")}` }),
    );
    for (let i = 0; i < contacts.length - 1; i += 1) mergeContacts(contacts[i + 1]!.id, contacts[i]!.id);

    expect(resolveMergedContactId(contacts[0]!.id)).toBe(contacts[contacts.length - 1]!.id);
  });

  it("leaves grants of live contacts alone", () => {
    const live = createContact({ phone: "5511900000007" });
    grant(live.id, "permission-sneaky-full");

    expect(repairOrphanContactChatGrants()).toEqual([]);
    expect(grantsOf(live.id)).toEqual(["permission-sneaky-full@chat_room"]);
  });
});
