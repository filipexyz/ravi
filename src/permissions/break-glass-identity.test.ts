import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { AgentsCommands } from "../cli/commands/agents.js";
import { ContactsCommands } from "../cli/commands/contacts.js";
import { runWithContext, type ToolContext } from "../cli/context.js";
import { addContactTag, allowContact, closeContacts, getContact, setOptOut, upsertContact } from "../contacts.js";
import type { ContextCapability } from "../router/router-db.js";
import { dbCreateAgent, dbGetAgent, dbUpsertChat } from "../router/router-db.js";
import { dbCreateTagDefinition } from "../tags/index.js";
import { dbEnsureContactChatGrant } from "./contact-chat-grants.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { materializeContactPolicyCapabilities } from "./contact-policy-permissions-provider.js";

setDefaultTimeout(20_000);

// Spec permissions/break-glass: an agent turn, even holding admin, never makes
// an identity resolve to a contact holding break-glass power, never activates
// such a contact, and never raises another agent to break-glass. These are the
// paths the independent review of #950 proved open (B1, N1).

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-break-glass-identity-");
});

afterEach(async () => {
  closeContacts();
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function agentCtx(agentId: string, capabilities: string[]): ToolContext {
  const caps: ContextCapability[] = capabilities.map((value) => {
    const [permission, objectType, objectId] = value.split(":");
    return { permission: permission!, objectType: objectType!, objectId: objectId!, source: "test" };
  });
  return {
    contextId: `ctx_${agentId}`,
    agentId,
    sessionKey: `agent:${agentId}:main`,
    sessionName: `${agentId}-main`,
    context: {
      contextId: `ctx_${agentId}`,
      contextKey: `rctx_${agentId}`,
      kind: "agent-runtime",
      agentId,
      sessionKey: `agent:${agentId}:main`,
      sessionName: `${agentId}-main`,
      capabilities: caps,
      createdAt: 0,
    },
  };
}

const ADMIN_AGENT = agentCtx("xone-like", ["admin:system:*"]);

function seedOwner(phone: string) {
  upsertContact(phone, "Owner");
  allowContact(phone);
  addContactTag(phone, "permission-owner");
  const owner = getContact(phone);
  if (!owner) throw new Error("seed failed");
  return owner;
}

function expectBreakGlassDenied(fn: () => unknown): void {
  let error: unknown;
  try {
    fn();
  } catch (err) {
    error = err;
  }
  expect(error).toMatchObject({ code: "FULL_ACCESS_APPROVAL_REQUIRED", exitCode: 3 });
}

describe("an admin agent cannot point an identity at a break-glass contact", () => {
  it("refuses link, merge and set email onto the owner, and the stranger gets nothing", () => {
    const owner = seedOwner("5511900007001");
    upsertContact("5511900007002", "Stranger");
    allowContact("5511900007002");
    const stranger = getContact("5511900007002")!;
    const commands = new ContactsCommands();

    runWithContext(ADMIN_AGENT, () => {
      expectBreakGlassDenied(() => commands.link(owner.id, "whatsapp", "5511900009999", undefined, undefined, true));
      expectBreakGlassDenied(() => commands.merge(stranger.id, owner.id, true, true));
      expectBreakGlassDenied(() => commands.merge(owner.id, stranger.id, true, true));
      expectBreakGlassDenied(() => commands.set(owner.id, "email", "attacker@example.com", true));
    });

    expect(getContact("5511900009999")?.id).not.toBe(owner.id);
    expect(getContact("attacker@example.com")?.id).not.toBe(owner.id);
    expect(getContact(stranger.id)?.id).toBe(stranger.id);
    expect(materializeContactPolicyCapabilities(stranger.id)).toEqual([]);
  });

  it("refuses activating a dormant admin by allow, approve, add or clearing opt-out", () => {
    upsertContact("5511900007003", "Dormant admin", "pending");
    addContactTag("5511900007003", "permission-admin");
    const dormant = getContact("5511900007003")!;
    const commands = new ContactsCommands();

    runWithContext(ADMIN_AGENT, () => {
      expectBreakGlassDenied(() => commands.allow(dormant.id, true));
      expectBreakGlassDenied(() => commands.approve(dormant.id, undefined, undefined, true));
      expectBreakGlassDenied(() =>
        commands.add("5511900007003", undefined, undefined, undefined, undefined, undefined, true),
      );
    });
    expect(materializeContactPolicyCapabilities(dormant.id)).toEqual([]);

    allowContact("5511900007003");
    setOptOut("5511900007003", true);
    runWithContext(ADMIN_AGENT, () => {
      expectBreakGlassDenied(() => commands.set(dormant.id, "opt-out", "false", true));
    });
    expect(materializeContactPolicyCapabilities(dormant.id)).toEqual([]);
  });

  it("refuses linking to a contact whose break-glass comes only from a chat grant", () => {
    upsertContact("5511900007006", "Chat root");
    allowContact("5511900007006");
    const holder = getContact("5511900007006")!;
    dbCreateTagDefinition({
      slug: "permission-legacy-root",
      label: "Legacy",
      kind: "system",
      source: "permissions",
      metadata: { permissions: { capabilities: ["admin:system:*"] } },
    });
    const chat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "main",
      platformChatId: "break-glass-grant-chat",
      chatType: "group",
      title: "grant",
    });
    dbEnsureContactChatGrant({
      contactId: holder.id,
      profileSlug: "permission-legacy-root",
      scopeType: "chat",
      scopeId: chat.id,
    });
    runWithContext(ADMIN_AGENT, () => {
      expectBreakGlassDenied(() =>
        new ContactsCommands().link(holder.id, "whatsapp", "5511900009998", undefined, undefined, true),
      );
    });
    expect(getContact("5511900009998")?.id).not.toBe(holder.id);
  });

  it("refuses add of a dormant admin written in another phone format", () => {
    upsertContact("5511900007007", "Formatted dormant", "pending");
    addContactTag("5511900007007", "permission-admin");
    const dormant = getContact("5511900007007")!;
    runWithContext(ADMIN_AGENT, () => {
      expectBreakGlassDenied(() =>
        new ContactsCommands().add("+55 (11) 90000-7007", undefined, undefined, undefined, undefined, undefined, true),
      );
    });
    expect(materializeContactPolicyCapabilities(dormant.id)).toEqual([]);
  });

  it("keeps the operator terminal free and ordinary contacts linkable by an admin agent", () => {
    const owner = seedOwner("5511900007004");
    new ContactsCommands().link(owner.id, "email", "owner@example.com", undefined, undefined, true);
    expect(getContact("owner@example.com")?.id).toBe(owner.id);

    upsertContact("5511900007005", "Plain");
    allowContact("5511900007005");
    const plain = getContact("5511900007005")!;
    runWithContext(ADMIN_AGENT, () =>
      new ContactsCommands().link(plain.id, "email", "plain@example.com", undefined, undefined, true),
    );
    expect(getContact("plain@example.com")?.id).toBe(plain.id);
  });
});

describe("an agent never raises another agent to break-glass", () => {
  it("refuses full-access and break-glass capabilities for another agent, before any write", () => {
    dbCreateAgent({ id: "xone-like", cwd: "/tmp" });
    dbCreateAgent({ id: "victim", cwd: "/tmp" });
    const commands = new AgentsCommands();
    runWithContext(ADMIN_AGENT, () => {
      expectBreakGlassDenied(() => commands.permissions("victim", "full-access", undefined, true, undefined, true));
      expectBreakGlassDenied(() =>
        commands.permissions("victim", "explicit-only", "admin:system:*", true, undefined, true),
      );
      expectBreakGlassDenied(() =>
        commands.permissions("victim", "explicit-only", "execute:executable:*", true, undefined, true),
      );
    });
    expect(JSON.stringify(dbGetAgent("victim")?.defaults ?? {})).not.toContain("full-access");
  });

  it("lets the operator terminal raise an agent and an agent narrow another", () => {
    dbCreateAgent({ id: "xone-like", cwd: "/tmp" });
    dbCreateAgent({ id: "victim", cwd: "/tmp" });
    const commands = new AgentsCommands();
    commands.permissions("victim", "full-access", undefined, true, undefined, true);
    expect(JSON.stringify(dbGetAgent("victim")?.defaults ?? {})).toContain("full-access");
    dbCreateAgent({ id: "narrow", cwd: "/tmp" });
    runWithContext(ADMIN_AGENT, () =>
      commands.permissions("narrow", "explicit-only", "execute:executable:git", true, undefined, true),
    );
  });
});
