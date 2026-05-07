import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import {
  addContactTag,
  addContactIdentity,
  closeContacts,
  createContactEvent,
  deleteContact,
  findContactsByTag,
  getContact,
  getContactDetails,
  getAgentPlatformIdentity,
  listContactEvents,
  listContactMetadata,
  linkContactIdentity,
  mergeContacts,
  removeContactMetadata,
  resolvePlatformIdentity,
  setContactMetadata,
  unlinkContactIdentity,
  upsertAgentPlatformIdentity,
  upsertContact,
} from "./contacts.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "./test/ravi-state.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-contacts-identity-test-");
});

afterEach(async () => {
  closeContacts();
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

describe("contacts identity graph schema", () => {
  it("projects legacy contact rows into canonical contacts, policies, and platform identities", () => {
    upsertContact("5511999999999", "Alice", "allowed", "manual");
    const contact = getContact("5511999999999");
    expect(contact).not.toBeNull();
    addContactIdentity(contact!.id, "whatsapp_lid", "lid:63295117615153");

    const db = new Database(join(stateDir!, "chat.db"));
    const canonical = db.prepare("SELECT * FROM contacts WHERE id = ?").get(contact!.id) as {
      id: string;
      display_name: string;
      primary_phone: string;
    } | null;
    const policy = db.prepare("SELECT * FROM contact_policies WHERE contact_id = ?").get(contact!.id) as {
      status: string;
      reply_mode: string;
    } | null;
    const identities = db
      .prepare(
        "SELECT channel, normalized_platform_user_id FROM platform_identities WHERE owner_id = ? ORDER BY channel",
      )
      .all(contact!.id) as Array<{ channel: string; normalized_platform_user_id: string }>;
    const linkEvents = (db.prepare("SELECT COUNT(*) AS count FROM identity_link_events").get() as { count: number })
      .count;
    db.close();

    expect(canonical).toMatchObject({
      display_name: "Alice",
      primary_phone: "5511999999999",
    });
    expect(policy).toMatchObject({ status: "allowed", reply_mode: "auto" });
    expect(identities).toEqual([
      { channel: "phone", normalized_platform_user_id: "5511999999999" },
      { channel: "whatsapp", normalized_platform_user_id: "lid:63295117615153" },
    ]);
    expect(linkEvents).toBeGreaterThanOrEqual(2);
  });

  it("mirrors contact tags into canonical tag bindings while keeping legacy reads working", () => {
    upsertContact("5511999911111", "Tagged", "allowed", "manual");
    const contact = getContact("5511999911111");
    expect(contact).not.toBeNull();

    addContactTag(contact!.id, "VIP Contact");

    const updated = getContact(contact!.id);
    expect(updated?.tags).toContain("vip-contact");
    expect(getContactDetails(contact!.id)?.policy?.tags).toContain("vip-contact");
    expect(findContactsByTag("VIP Contact").map((item) => item.id)).toContain(contact!.id);

    const db = new Database(join(stateDir!, "ravi.db"));
    const binding = db
      .prepare(
        `
        SELECT t.slug, b.asset_type, b.asset_id, b.metadata_json
        FROM tag_bindings b
        JOIN tag_definitions t ON t.id = b.tag_id
        WHERE t.slug = 'vip-contact' AND b.asset_type = 'contact' AND b.asset_id = ?
      `,
      )
      .get(contact!.id) as { slug: string; asset_type: string; asset_id: string; metadata_json: string } | null;
    db.close();

    expect(binding).toMatchObject({
      slug: "vip-contact",
      asset_type: "contact",
      asset_id: contact!.id,
    });
    expect(JSON.parse(binding!.metadata_json)).toMatchObject({
      mirroredFrom: "contacts_v2.tags",
    });
  });

  it("records contact timeline events for profile, policy, tag, and identity changes", () => {
    upsertContact("5511999912222", "Timeline", "pending", "manual");
    const contact = getContact("5511999912222");
    expect(contact).not.toBeNull();

    addContactTag(contact!.id, "VIP Contact");
    linkContactIdentity(contact!.id, {
      channel: "email",
      platformUserId: "timeline@example.com",
      reason: "operator confirmed",
    });

    const eventTypes = listContactEvents(contact!.id, { limit: 20 }).items.map((event) => event.eventType);
    expect(eventTypes).toContain("profile.created");
    expect(eventTypes).toContain("policy.status_changed");
    expect(eventTypes).toContain("profile.tag_added");
    expect(eventTypes).toContain("identity.linked");
  });

  it("stores scoped contact metadata as current context and append-only timeline events", () => {
    upsertContact("5511999913333", "Scoped", "allowed", "manual");
    const contact = getContact("5511999913333");
    expect(contact).not.toBeNull();

    const entry = setContactMetadata(contact!.id, "crm.status", "lead", {
      scopeType: "domain",
      scopeId: "crm",
      source: "test",
      actorType: "agent",
      actorId: "dev",
      confidence: 0.8,
    });

    expect(entry).toMatchObject({
      contactId: contact!.id,
      scopeType: "domain",
      scopeId: "crm",
      key: "crm.status",
      value: "lead",
      source: "test",
      confidence: 0.8,
      updatedByType: "agent",
      updatedById: "dev",
    });
    expect(listContactMetadata(contact!.id, { scopeType: "domain", scopeId: "crm" })).toHaveLength(1);

    const removed = removeContactMetadata(contact!.id, "crm.status", {
      scopeType: "domain",
      scopeId: "crm",
      source: "test",
    });
    expect(removed.removed).toBe(true);
    expect(listContactMetadata(contact!.id, { scopeType: "domain", scopeId: "crm" })).toHaveLength(0);

    const events = listContactEvents(contact!.id, { scopeType: "domain", scopeId: "crm", limit: 10 }).items;
    expect(events.map((event) => event.eventType)).toContain("profile.metadata_set");
    expect(events.map((event) => event.eventType)).toContain("profile.metadata_removed");
  });

  it("filters scoped contact timeline events without leaking across contexts", () => {
    upsertContact("5511999914444", "Scoped Events", "allowed", "manual");
    const contact = getContact("5511999914444");
    expect(contact).not.toBeNull();

    createContactEvent({
      contactRef: contact!.id,
      eventType: "context.fact_proposed",
      scopeType: "chat",
      scopeId: "chat-a",
      source: "agent",
      actorType: "agent",
      actorId: "dev",
      confidence: 0.5,
      payload: { fact: "admin in this group" },
    });
    createContactEvent({
      contactRef: contact!.id,
      eventType: "context.fact_proposed",
      scopeType: "project",
      scopeId: "ravi-web",
      source: "agent",
      actorType: "agent",
      actorId: "dev",
      confidence: 0.5,
      payload: { fact: "stakeholder in this project" },
    });

    const chatEvents = listContactEvents(contact!.id, { scopeType: "chat", scopeId: "chat-a" });
    expect(chatEvents.total).toBe(1);
    expect(chatEvents.items[0]?.scopeType).toBe("chat");
    expect(chatEvents.items[0]?.scopeId).toBe("chat-a");
  });

  it("keeps legacy group contacts out of canonical contacts", () => {
    upsertContact("5511000000000", "Schema Seed", "allowed", "manual");
    let db = new Database(join(stateDir!, "chat.db"));
    db.prepare(
      `
      INSERT INTO contacts_v2 (id, name, status, source, updated_at)
      VALUES ('legacy-group-contact', 'Ravi Dev', 'allowed', 'legacy_test', datetime('now'))
    `,
    ).run();
    db.prepare(
      `
      INSERT INTO contact_identities (contact_id, platform, identity_value, is_primary)
      VALUES ('legacy-group-contact', 'whatsapp_group', 'group:120363424772797713', 1)
    `,
    ).run();
    db.close();

    expect(getContact("group:120363424772797713")).not.toBeNull();
    expect(getContactDetails("group:120363424772797713")).toBeNull();

    db = new Database(join(stateDir!, "chat.db"));
    const legacy = db.prepare("SELECT * FROM contacts_v2 WHERE name = ?").get("Ravi Dev");
    const canonical = db.prepare("SELECT * FROM contacts WHERE display_name = ?").get("Ravi Dev");
    const platformIdentity = db
      .prepare("SELECT * FROM platform_identities WHERE normalized_platform_user_id = ?")
      .get("group:120363424772797713");
    db.close();

    expect(legacy).not.toBeNull();
    expect(canonical).toBeNull();
    expect(platformIdentity).toBeNull();
  });

  it("preserves manually linked instance-specific platform identities across projection syncs", () => {
    upsertContact("5511888888888", "Bob", "allowed", "manual");
    const contact = getContact("5511888888888");
    expect(contact).not.toBeNull();

    linkContactIdentity(contact!.id, {
      channel: "telegram",
      platformUserId: "bob_telegram",
      instanceId: "tg-main",
      reason: "operator confirmed",
    });
    upsertContact("5511888888888", "Bob Updated", "allowed", "manual");

    const db = new Database(join(stateDir!, "chat.db"));
    const manual = db
      .prepare(
        `
        SELECT * FROM platform_identities
        WHERE owner_id = ? AND channel = 'telegram' AND instance_id = 'tg-main'
      `,
      )
      .get(contact!.id) as { normalized_platform_user_id: string; linked_by: string; link_reason: string } | null;
    db.close();

    expect(manual).toMatchObject({
      normalized_platform_user_id: "bob_telegram",
      linked_by: "manual",
      link_reason: "operator confirmed",
    });
    expect(getContactDetails("bob_telegram")?.contact.id).toBe(contact!.id);
  });

  it("removes canonical projections when deleting a contact", () => {
    upsertContact("5511777777777", "Carol", "allowed", "manual");
    const contact = getContact("5511777777777");
    expect(contact).not.toBeNull();
    linkContactIdentity(contact!.id, {
      channel: "email",
      platformUserId: "carol@example.com",
      reason: "operator confirmed",
    });
    setContactMetadata(contact!.id, "crm.lifecycle", "customer", {
      scopeType: "domain",
      scopeId: "crm",
      source: "test",
    });

    expect(deleteContact(contact!.id)).toBe(true);

    const db = new Database(join(stateDir!, "chat.db"));
    const canonical = db.prepare("SELECT * FROM contacts WHERE id = ?").get(contact!.id);
    const platformIdentity = db.prepare("SELECT * FROM platform_identities WHERE owner_id = ?").get(contact!.id);
    const policy = db.prepare("SELECT * FROM contact_policies WHERE contact_id = ?").get(contact!.id);
    const context = db.prepare("SELECT * FROM contact_contexts WHERE contact_id = ?").get(contact!.id);
    const tombstone = db
      .prepare("SELECT * FROM contact_events WHERE contact_id = ? AND event_type = 'profile.deleted'")
      .get(contact!.id);
    db.close();

    expect(canonical).toBeNull();
    expect(platformIdentity).toBeNull();
    expect(policy).toBeNull();
    expect(context).toBeNull();
    expect(tombstone).not.toBeNull();
  });

  it("moves manual canonical platform identities when merging contacts", () => {
    upsertContact("5511666666666", "Source", "allowed", "manual");
    upsertContact("5511555555555", "Target", "allowed", "manual");
    const source = getContact("5511666666666");
    const target = getContact("5511555555555");
    expect(source).not.toBeNull();
    expect(target).not.toBeNull();
    linkContactIdentity(source!.id, {
      channel: "email",
      platformUserId: "person@example.com",
      reason: "operator confirmed",
    });
    createContactEvent({
      contactRef: source!.id,
      eventType: "context.fact_confirmed",
      scopeType: "project",
      scopeId: "ravi-web",
      source: "test",
      actorType: "agent",
      actorId: "dev",
      confidence: 1,
      payload: { fact: "source history survives merge" },
    });

    mergeContacts(target!.id, source!.id);

    const details = getContactDetails("person@example.com");
    expect(details?.contact.id).toBe(target!.id);
    expect(getContact(source!.id)).toBeNull();
    const targetEvents = listContactEvents(target!.id, { limit: 50 }).items;
    expect(
      targetEvents.some((event) => event.contactId === source!.id && event.eventType === "context.fact_confirmed"),
    ).toBe(true);
  });

  it("stores agent-owned platform identities without creating contacts", () => {
    const identity = upsertAgentPlatformIdentity({
      agentId: "dev",
      channel: "whatsapp-baileys",
      instanceId: "instance-1",
      platformUserId: "5511999990000@s.whatsapp.net",
      platformDisplayName: "Ravi Dev",
      linkedBy: "auto",
      linkReason: "test_agent_account",
    });

    expect(identity).toMatchObject({
      ownerType: "agent",
      ownerId: "dev",
      channel: "whatsapp",
      instanceId: "instance-1",
      normalizedPlatformUserId: "5511999990000",
      platformDisplayName: "Ravi Dev",
    });
    expect(getAgentPlatformIdentity({ agentId: "dev", channel: "whatsapp", instanceId: "instance-1" })?.id).toBe(
      identity.id,
    );
    expect(
      resolvePlatformIdentity({ channel: "whatsapp", instanceId: "instance-1", platformUserId: "5511999990000" }),
    ).toMatchObject({ ownerType: "agent", ownerId: "dev" });
    expect(getContact("5511999990000")).toBeNull();
    expect(getContactDetails("5511999990000")).toBeNull();
  });

  it("does not reassign a contact-owned platform identity to an agent", () => {
    upsertContact("5511444444444", "Human", "allowed", "manual");

    expect(() =>
      upsertAgentPlatformIdentity({
        agentId: "dev",
        channel: "phone",
        platformUserId: "5511444444444",
      }),
    ).toThrow(/owned by contact/);

    const db = new Database(join(stateDir!, "chat.db"));
    const row = db
      .prepare("SELECT owner_type FROM platform_identities WHERE normalized_platform_user_id = ?")
      .get("5511444444444") as { owner_type: string } | null;
    db.close();

    expect(row?.owner_type).toBe("contact");
  });

  it("does not reassign an agent-owned platform identity during contact projection syncs", () => {
    const identity = upsertAgentPlatformIdentity({
      agentId: "dev",
      channel: "phone",
      platformUserId: "5511444444444",
    });

    expect(resolvePlatformIdentity({ channel: "phone", platformUserId: "5511444444444" })).toMatchObject({
      ownerType: "agent",
      ownerId: "dev",
    });

    upsertContact("5511444444444", "Human", "allowed", "manual");

    expect(resolvePlatformIdentity({ channel: "phone", platformUserId: "5511444444444" })).toMatchObject({
      id: identity.id,
      ownerType: "agent",
      ownerId: "dev",
    });

    const contact = getContact("5511444444444");
    expect(contact).not.toBeNull();
    const details = getContactDetails(contact!.id);
    expect(
      details?.platformIdentities.some(
        (platformIdentity) => platformIdentity.normalizedPlatformUserId === "5511444444444",
      ),
    ).toBe(false);
  });

  it("rejects explicit contact links to agent-owned platform identities", () => {
    upsertAgentPlatformIdentity({
      agentId: "dev",
      channel: "whatsapp",
      instanceId: "inst1",
      platformUserId: "lid:123",
      linkedBy: "auto",
    });
    upsertContact("5511222222222", "Human", "allowed", "manual");
    const contact = getContact("5511222222222");
    expect(contact).not.toBeNull();

    expect(() =>
      linkContactIdentity(contact!.id, {
        channel: "whatsapp",
        instanceId: "inst1",
        platformUserId: "lid:123",
        reason: "test",
      }),
    ).toThrow(/owned by agent dev/);
    expect(
      resolvePlatformIdentity({ channel: "whatsapp", instanceId: "inst1", platformUserId: "lid:123" }),
    ).toMatchObject({
      ownerType: "agent",
      ownerId: "dev",
    });
    expect(
      getContactDetails(contact!.id)?.platformIdentities.some(
        (identity) => identity.normalizedPlatformUserId === "lid:123",
      ),
    ).toBe(false);
  });

  it("does not reassign another contact's canonical platform identity through contact linking", () => {
    upsertContact("5511333333333", "Owner", "allowed", "manual");
    upsertContact("5511222222222", "Target", "allowed", "manual");
    const owner = getContact("5511333333333");
    const target = getContact("5511222222222");
    expect(owner).not.toBeNull();
    expect(target).not.toBeNull();

    const db = new Database(join(stateDir!, "chat.db"));
    db.prepare(
      `
      INSERT INTO platform_identities (
        id, owner_type, owner_id, channel, instance_id, platform_user_id,
        normalized_platform_user_id, linked_by, link_reason
      )
      VALUES ('pi_other_contact_owned', 'contact', ?, 'telegram', 'tg-main', 'shared_user', 'shared_user', 'manual', 'seed')
    `,
    ).run(owner!.id);
    db.close();

    expect(() =>
      linkContactIdentity(target!.id, {
        channel: "telegram",
        instanceId: "tg-main",
        platformUserId: "shared_user",
        reason: "test",
      }),
    ).toThrow(/owned by contact/);
    expect(
      resolvePlatformIdentity({ channel: "telegram", instanceId: "tg-main", platformUserId: "shared_user" }),
    ).toMatchObject({ ownerType: "contact", ownerId: owner!.id });
  });

  it("requires channel or instance disambiguation when unlinking a repeated platform identity value", () => {
    upsertAgentPlatformIdentity({
      agentId: "dev",
      channel: "whatsapp",
      instanceId: "inst-agent",
      platformUserId: "lid:123",
      linkedBy: "auto",
    });
    upsertContact("5511222222222", "Human", "allowed", "manual");
    const contact = getContact("5511222222222");
    expect(contact).not.toBeNull();
    linkContactIdentity(contact!.id, {
      channel: "whatsapp",
      instanceId: "inst-contact",
      platformUserId: "lid:123",
      reason: "test",
    });

    expect(() => unlinkContactIdentity("lid:123", "test")).toThrow(/ambiguous/);

    const details = unlinkContactIdentity("lid:123", "test", { channel: "whatsapp", instanceId: "inst-contact" });
    expect(details?.contact.id).toBe(contact!.id);
    expect(
      resolvePlatformIdentity({ channel: "whatsapp", instanceId: "inst-contact", platformUserId: "lid:123" }),
    ).toBeNull();
    expect(
      resolvePlatformIdentity({ channel: "whatsapp", instanceId: "inst-agent", platformUserId: "lid:123" }),
    ).toMatchObject({ ownerType: "agent", ownerId: "dev" });
  });

  it("does not let legacy backfill steal an agent-owned platform identity", () => {
    const identity = upsertAgentPlatformIdentity({
      agentId: "dev",
      channel: "phone",
      platformUserId: "5511666600000",
      linkedBy: "auto",
    });
    closeContacts();

    const db = new Database(join(stateDir!, "chat.db"));
    db.prepare(
      `
      INSERT INTO contacts_v2 (id, name, status, source, updated_at)
      VALUES ('legacy-agent-conflict', 'Legacy Human', 'allowed', 'legacy_test', datetime('now'))
    `,
    ).run();
    db.prepare(
      `
      INSERT INTO contact_identities (contact_id, platform, identity_value, is_primary)
      VALUES ('legacy-agent-conflict', 'phone', '5511666600000', 1)
    `,
    ).run();
    db.close();

    expect(getContact("5511666600000")?.id).toBe("legacy-agent-conflict");
    expect(resolvePlatformIdentity({ channel: "phone", platformUserId: "5511666600000" })).toMatchObject({
      id: identity.id,
      ownerType: "agent",
      ownerId: "dev",
    });
    expect(
      getContactDetails("legacy-agent-conflict")?.platformIdentities.some(
        (platformIdentity) => platformIdentity.normalizedPlatformUserId === "5511666600000",
      ),
    ).toBe(false);
  });
});
