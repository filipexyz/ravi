import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

afterAll(() => mock.restore());
const actualCliContextModule = await import("../context.js");
const actualContactsModule = await import("../../contacts.js");
const actualRouterDbModule = await import("../../router/router-db.js");
const actualRouterSessionsModule = await import("../../router/sessions.js");

let contactRecord: Record<string, unknown> | null = null;
let sessionRecord: Record<string, unknown> | null = null;
let routeRecords: Array<{ pattern: string; agent: string }> = [];
let allContacts: Array<Record<string, unknown>> = [];
let pendingContacts: Array<Record<string, unknown>> = [];
let accountPendingEntries: Array<Record<string, unknown>> = [];
let mergeCall: { targetId: string; sourceId: string } | null = null;

function findContactRecord(ref: string): Record<string, unknown> | null {
  return (
    contactRecord ??
    allContacts.find(
      (contact) =>
        contact.id === ref ||
        contact.phone === ref ||
        ((contact.identities as Array<{ value?: string }> | undefined) ?? []).some(
          (identity) => identity.value === ref,
        ),
    ) ??
    null
  );
}

mock.module("../context.js", () => ({
  ...actualCliContextModule,
  getContext: () => undefined,
  fail: (message: string) => {
    throw new Error(message);
  },
}));

mock.module("../../nats.js", () => ({
  connectNats: mock(async () => {}),
  closeNats: mock(async () => {}),
  ensureConnected: mock(async () => ({})),
  getNats: mock(() => ({})),
  isExplicitConnect: () => false,
  publish: mock(async () => {}),
  subscribe: mock(() => (async function* () {})()),
  nats: {
    emit: mock(async () => {}),
    subscribe: mock(() => (async function* () {})()),
    close: mock(async () => {}),
  },
}));

mock.module("../../contacts.js", () => ({
  ...actualContactsModule,
  getAllContacts: () => allContacts,
  getContact: (ref: string) => findContactRecord(ref),
  getContactDetails: (ref: string) => {
    const contact = findContactRecord(ref);
    if (!contact) return null;
    return {
      contact: {
        id: contact.id,
        kind: "person",
        displayName: contact.name ?? null,
        primaryPhone: contact.phone ?? null,
        primaryEmail: contact.email ?? null,
        avatarUrl: null,
        metadata: { legacy: { sourceTable: "contacts_v2" } },
        createdAt: contact.created_at,
        updatedAt: contact.updated_at,
      },
      platformIdentities: [
        {
          id: "pi-phone",
          ownerType: "contact",
          ownerId: contact.id,
          channel: "phone",
          instanceId: "",
          platformUserId: contact.phone,
          normalizedPlatformUserId: contact.phone,
          platformDisplayName: contact.name ?? null,
          avatarUrl: null,
          profileData: null,
          isPrimary: true,
          confidence: 1,
          linkedBy: "initial",
          linkReason: "legacy_backfill",
          firstSeenAt: contact.created_at,
          lastSeenAt: contact.updated_at,
          createdAt: contact.created_at,
          updatedAt: contact.updated_at,
        },
      ],
      policy: {
        contactId: contact.id,
        status: contact.status,
        replyMode: contact.reply_mode,
        allowedAgents: contact.allowedAgents,
        optOut: contact.opt_out,
        tags: contact.tags,
        notes: contact.notes,
        source: contact.source,
        lastInboundAt: contact.last_inbound_at,
        lastOutboundAt: contact.last_outbound_at,
        interactionCount: contact.interaction_count,
        createdAt: contact.created_at,
        updatedAt: contact.updated_at,
      },
      duplicateCandidates: [],
      legacyContact: contact,
    };
  },
  getPendingContacts: () => pendingContacts,
  upsertContact: () => {},
  deleteContact: () => false,
  allowContact: () => {},
  blockContact: () => {},
  normalizePhone: (value: string) => value,
  formatPhone: (value: string) => value,
  setContactReplyMode: () => {},
  updateContact: () => {},
  findContactsByTag: () => [],
  searchContacts: () => [],
  addContactTag: () => {},
  removeContactTag: () => {},
  setOptOut: () => {},
  addContactIdentity: () => {},
  removeContactIdentity: () => {},
  linkContactIdentity: () => {},
  unlinkContactIdentity: () => null,
  mergeContacts: (targetId: string, sourceId: string) => {
    mergeCall = { targetId, sourceId };
    return { merged: 2 };
  },
  setContactKind: () => {},
  listDuplicateContacts: () => [],
  setGroupTag: () => {},
  removeGroupTag: () => {},
  listAccountPending: (account?: string) =>
    accountPendingEntries
      .filter((entry) => !account || entry.accountId === account)
      .map((entry) => ({
        ...entry,
        pendingKind: entry.isGroup ? "chat" : "contact",
        chatType: entry.isGroup ? "group" : "dm",
      })),
  listAccountPendingContacts: (account?: string) =>
    accountPendingEntries
      .filter((entry) => (!account || entry.accountId === account) && !entry.isGroup)
      .map((entry) => ({
        ...entry,
        pendingKind: "contact",
        chatType: "dm",
      })),
  listAccountPendingChats: (account?: string) =>
    accountPendingEntries
      .filter((entry) => (!account || entry.accountId === account) && entry.isGroup)
      .map((entry) => ({
        ...entry,
        pendingKind: "chat",
        chatType: "group",
      })),
}));

mock.module("../../router/router-db.js", () => ({
  ...actualRouterDbModule,
  dbListRoutes: () => routeRecords,
}));

mock.module("../../router/sessions.js", () => ({
  ...actualRouterSessionsModule,
  findSessionByChatId: () => sessionRecord,
}));

mock.module("../../permissions/scope.js", () => ({
  getScopeContext: () => undefined,
  isScopeEnforced: () => false,
  canAccessSession: () => true,
  canModifySession: () => true,
  canAccessContact: () => true,
  canAccessResource: () => true,
  canViewAgent: () => true,
  canWriteContacts: () => true,
  filterAccessibleSessions: <T>(_: unknown, sessions: T[]) => sessions,
  filterVisibleAgents: <T>(_: unknown, agents: T[]) => agents,
}));

const { ContactsCommands } = await import("./contacts.js");

function captureLogs(run: () => void): string {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };

  try {
    run();
  } finally {
    console.log = originalLog;
  }

  return lines.join("\n");
}

function captureJson(run: () => void): Record<string, unknown> {
  return JSON.parse(captureLogs(run)) as Record<string, unknown>;
}

describe("ContactsCommands info", () => {
  beforeEach(() => {
    contactRecord = {
      id: "contact-1",
      phone: "5511999999999",
      name: "Alice",
      email: "alice@example.com",
      status: "allowed",
      allowedAgents: ["main"],
      reply_mode: "mention",
      tags: ["vip"],
      notes: { company: "Acme" },
      opt_out: false,
      source: "manual",
      interaction_count: 3,
      last_inbound_at: "2026-04-11 12:00:00",
      last_outbound_at: "2026-04-11 12:05:00",
      created_at: "2026-04-10 10:00:00",
      updated_at: "2026-04-11 12:05:00",
      identities: [{ platform: "phone", value: "5511999999999", isPrimary: true }],
    };
    allContacts = [contactRecord];
    pendingContacts = [];
    accountPendingEntries = [];
    mergeCall = null;
    sessionRecord = { name: "wa-support" };
    routeRecords = [{ pattern: "5511999999999", agent: "sales" }];
  });

  it("labels persisted contact fields plus resolver and session lookups", () => {
    const output = captureLogs(() => {
      new ContactsCommands().info("contact-1");
    });

    expect(output).toContain("source=contact-db freshness=persisted");
    expect(output).toContain("source=resolver freshness=derived-now via=route-lookup");
    expect(output).toContain("source=session-db freshness=derived-now via=identity-lookup");
    expect(output).toContain("Identities (1):[source=contact-db freshness=persisted]");
  });

  it("prints typed contact details in --json mode", () => {
    const payload = captureJson(() => {
      new ContactsCommands().info("contact-1", true);
    });

    expect(payload.found).toBe(true);
    expect(payload.target).toBe("contact-1");
    expect((payload.contact as Record<string, unknown>).id).toBe("contact-1");
    expect((payload.legacyContact as Record<string, unknown>).id).toBe("contact-1");
    expect(payload.routeAgent).toBe("sales");
    expect(payload.sessionName).toBe("wa-support");
    expect(payload.platformIdentities).toHaveLength(1);
  });

  it("prints contact lists with counts and enriched entities in --json mode", () => {
    const payload = captureJson(() => {
      new ContactsCommands().list(undefined, true);
    });

    expect((payload.counts as Record<string, unknown>).total).toBe(1);
    const contacts = payload.contacts as Array<Record<string, unknown>>;
    expect(contacts).toHaveLength(1);
    expect(contacts[0].routeAgent).toBe("sales");
  });

  it("splits pending contacts from pending chats in --json mode", () => {
    pendingContacts = [{ ...contactRecord!, status: "pending" }];
    accountPendingEntries = [
      {
        accountId: "main",
        phone: "5511888888888",
        name: "Bob",
        chatId: "5511888888888@s.whatsapp.net",
        isGroup: false,
        createdAt: 1,
        updatedAt: 2,
      },
      {
        accountId: "main",
        phone: "group:123",
        name: "Launch Group",
        chatId: "123@g.us",
        isGroup: true,
        createdAt: 3,
        updatedAt: 4,
      },
    ];
    contactRecord = null;

    const payload = captureJson(() => {
      new ContactsCommands().pending("main", true);
    });

    expect(payload.total).toBe(2);
    expect(payload.totalContacts).toBe(2);
    expect(payload.totalChats).toBe(1);
    expect(payload.pendingContacts).toHaveLength(1);
    expect(payload.accountPendingContacts).toHaveLength(1);
    const pendingChats = payload.pendingChats as Array<Record<string, unknown>>;
    expect(pendingChats[0].pendingKind).toBe("chat");
    expect(pendingChats[0].type).toBe("group");
  });

  it("rejects group identities on contact approval", () => {
    contactRecord = null;

    expect(() => {
      new ContactsCommands().approve("group:123");
    }).toThrow("Groups/chats are not contacts");
  });

  it("merges contacts using source then target argument order", () => {
    contactRecord = null;
    allContacts = [
      {
        id: "source-contact",
        phone: "5511111111111",
        name: "Source",
        status: "allowed",
        identities: [{ platform: "phone", value: "5511111111111", isPrimary: true }],
      },
      {
        id: "target-contact",
        phone: "5522222222222",
        name: "Target",
        status: "allowed",
        identities: [{ platform: "phone", value: "5522222222222", isPrimary: true }],
      },
    ];

    const payload = captureJson(() => {
      new ContactsCommands().merge("source-contact", "target-contact", true);
    });

    expect(mergeCall).toEqual({ targetId: "target-contact", sourceId: "source-contact" });
    expect(payload.source).toBe("source-contact");
    expect(payload.target).toBe("target-contact");
  });
});
