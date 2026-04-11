import { beforeEach, describe, expect, it, mock } from "bun:test";

let contactRecord: Record<string, unknown> | null = null;
let sessionRecord: Record<string, unknown> | null = null;
let routeRecords: Array<{ pattern: string; agent: string }> = [];

mock.module("../context.js", () => ({
  fail: (message: string) => {
    throw new Error(message);
  },
}));

mock.module("../../nats.js", () => ({
  nats: {
    emit: mock(async () => {}),
  },
}));

mock.module("../../contacts.js", () => ({
  getAllContacts: () => [],
  getContact: () => contactRecord,
  getPendingContacts: () => [],
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
  listAccountPending: () => [],
}));

mock.module("../../router/router-db.js", () => ({
  dbListRoutes: () => routeRecords,
}));

mock.module("../../router/sessions.js", () => ({
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
});
