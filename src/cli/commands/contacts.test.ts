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
  getContact: (ref: string) =>
    contactRecord ??
    allContacts.find(
      (contact) =>
        contact.id === ref ||
        contact.phone === ref ||
        ((contact.identities as Array<{ value?: string }> | undefined) ?? []).some(
          (identity) => identity.value === ref,
        ),
    ) ??
    null,
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
  mergeContacts: () => ({}),
  setGroupTag: () => {},
  removeGroupTag: () => {},
  listAccountPending: (account?: string) =>
    accountPendingEntries.filter((entry) => !account || entry.accountId === account),
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
    expect((payload.contact as Record<string, unknown>).routeAgent).toBe("sales");
    expect((payload.contact as Record<string, unknown>).sessionName).toBe("wa-support");
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

  it("prints global and account pending approvals in --json mode", () => {
    pendingContacts = [{ ...contactRecord!, status: "pending" }];
    accountPendingEntries = [
      {
        accountId: "main",
        phone: "group:123",
        name: "Launch Group",
        chatId: "group:123",
        isGroup: true,
        createdAt: 1,
        updatedAt: 2,
      },
    ];
    contactRecord = null;

    const payload = captureJson(() => {
      new ContactsCommands().pending("main", true);
    });

    expect(payload.total).toBe(2);
    expect(payload.pendingContacts).toHaveLength(1);
    const accountPending = payload.accountPending as Array<Record<string, unknown>>;
    expect(accountPending[0].type).toBe("group");
    expect(accountPending[0].accountId).toBe("main");
  });
});
