import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentsCommands } from "../cli/commands/agents.js";
import { ContactsCommands } from "../cli/commands/contacts.js";
import { InstancesCommands, InstancesPendingCommands } from "../cli/commands/instances.js";
import { executeLibraryAgentInstall, executeLibraryAgentUpdate } from "../library/agent-definitions.js";
import { runWithContext, type ToolContext } from "../cli/context.js";
import {
  addContactTag,
  allowContact,
  closeContacts,
  createContact,
  ensureContactFromInbound,
  getContact,
  setOptOut,
  updateContact,
  upsertContact,
} from "../contacts.js";
import { runApprovedBreakGlassGrant } from "./break-glass.js";
import type { ContextCapability } from "../router/router-db.js";
import { dbCreateAgent, dbGetAgent, dbUpdateAgent, dbUpsertChat, dbUpsertInstance } from "../router/router-db.js";
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

describe("every writer of agent runtime permissions keeps the rule", () => {
  it("refuses agents set defaults that carries full-access or break-glass capabilities for another agent", async () => {
    dbCreateAgent({ id: "victim", cwd: "/tmp" });
    const commands = new AgentsCommands();
    // agents set defaults never writes runtimePermissions (27/11 fix): refused before the break-glass check.
    const denied = { code: "AGENT_DEFAULTS_PERMISSIONS_READ_ONLY" };
    await runWithContext(ADMIN_AGENT, async () => {
      await expect(
        commands.set("victim", "defaults", JSON.stringify({ runtimePermissions: { profile: "full-access" } })),
      ).rejects.toMatchObject(denied);
      await expect(
        commands.set(
          "victim",
          "defaults",
          JSON.stringify({ runtimePermissions: { profile: "explicit-only", capabilities: ["admin:system:*"] } }),
        ),
      ).rejects.toMatchObject(denied);
      await commands.set("victim", "defaults", JSON.stringify({ tts_voice: "abc" }), true);
    });
    expect(JSON.stringify(dbGetAgent("victim")?.defaults ?? {})).not.toContain("full-access");
    expect(JSON.stringify(dbGetAgent("victim")?.defaults ?? {})).toContain("tts_voice");
    // The operator terminal raises through agents permissions, the one writer of runtimePermissions.
    new AgentsCommands().permissions("victim", "full-access", undefined, true, undefined, true);
    expect(JSON.stringify(dbGetAgent("victim")?.defaults ?? {})).toContain("full-access");
    expect(JSON.stringify(dbGetAgent("victim")?.defaults ?? {})).toContain("tts_voice");
  });

  it("refuses planting dormant break-glass by agents set defaults, and waking it by agents permissions", async () => {
    dbCreateAgent({ id: "plant-victim", cwd: "/tmp" });
    const commands = new AgentsCommands();
    const denied = { code: "AGENT_DEFAULTS_PERMISSIONS_READ_ONLY" };
    const dormantConfig = { profile: "chat-only", capabilities: ["admin:system:*"] };
    const dormant = JSON.stringify({ runtimePermissions: dormantConfig });
    await runWithContext(ADMIN_AGENT, async () => {
      await expect(commands.set("plant-victim", "defaults", dormant)).rejects.toMatchObject(denied);
    });
    expect(JSON.stringify(dbGetAgent("plant-victim")?.defaults ?? {})).not.toContain("admin");

    // Legacy state: the operator stored it before agents set defaults stopped writing permissions.
    dbUpdateAgent("plant-victim", { defaults: { runtimePermissions: dormantConfig } });
    // An agent asking for "bootstrap" must not wake it.
    runWithContext(ADMIN_AGENT, () =>
      expectBreakGlassDenied(() => commands.permissions("plant-victim", "bootstrap", undefined, true, undefined, true)),
    );
    expect(JSON.stringify(dbGetAgent("plant-victim")?.defaults ?? {})).toContain("chat-only");
  });

  it("warns the operator once, on the real write, not on the dry run", async () => {
    dbCreateAgent({ id: "dormant-terminal", cwd: "/tmp" });
    const commands = new AgentsCommands();
    // Legacy dormant break-glass, stored before agents set defaults stopped writing permissions.
    dbUpdateAgent("dormant-terminal", {
      defaults: { runtimePermissions: { profile: "chat-only", capabilities: ["admin:system:*"] } },
    });
    const stderr: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      try {
        commands.permissions("dormant-terminal", "bootstrap", undefined, true, undefined, false);
      } catch {
        // dry run exits with a contract error; nothing written
      }
      const afterDryRun = stderr.join("");
      expect(afterDryRun).not.toContain("waking dormant");
      commands.permissions("dormant-terminal", "bootstrap", undefined, true, undefined, true);
    } finally {
      process.stderr.write = original;
    }
    expect(stderr.join("").split("waking dormant break-glass on agent dormant-terminal").length - 1).toBe(1);
  });

  it("refuses a Library install or update with a full-access profile, before any write", () => {
    const install = {
      plan: { agent: { id: "library-new", cwd: "/tmp/library-new-never" }, profile: { apply: "full-access" } },
      definition: {},
    } as unknown as Parameters<typeof executeLibraryAgentInstall>[0];
    runWithContext(ADMIN_AGENT, () => expectBreakGlassDenied(() => executeLibraryAgentInstall(install)));
    expect(dbGetAgent("library-new")).toBeNull();

    const updateDir = mkdtempSync(join(tmpdir(), "break-glass-library-update-"));
    dbCreateAgent({ id: "library-old", cwd: updateDir });
    const update = {
      plan: {
        agent: "library-old",
        files: [{ file: "HEARTBEAT.md", action: "write" }],
        skills: [],
        profile: { apply: "full-access" },
      },
      definition: { instructions: "x", heartbeat: "written-before-the-guard" },
      state: { origin: {} },
      cwd: updateDir,
    } as unknown as Parameters<typeof executeLibraryAgentUpdate>[0];
    runWithContext(ADMIN_AGENT, () => expectBreakGlassDenied(() => executeLibraryAgentUpdate(update)));
    expect(JSON.stringify(dbGetAgent("library-old")?.defaults ?? {})).not.toContain("full-access");
    // Refused before any write: no file of the update landed.
    expect(existsSync(join(updateDir, "HEARTBEAT.md"))).toBe(false);

    // The operator terminal gets past the guard (the partial fixture then fails on its own, not on break-glass).
    let terminalError: unknown;
    try {
      executeLibraryAgentUpdate(update);
    } catch (error) {
      terminalError = error;
    }
    expect((terminalError as { code?: string } | undefined)?.code).not.toBe("FULL_ACCESS_APPROVAL_REQUIRED");
  });

  it("refuses instances pending approve of a dormant admin", () => {
    dbUpsertInstance({ name: "wa-test", channel: "whatsapp" });
    upsertContact("5511900007008", "Pending admin", "pending");
    addContactTag("5511900007008", "permission-admin");
    const dormant = getContact("5511900007008")!;
    runWithContext(ADMIN_AGENT, () => {
      expectBreakGlassDenied(() => new InstancesPendingCommands().approve("wa-test", "5511900007008", undefined, true));
    });
    expect(materializeContactPolicyCapabilities(dormant.id)).toEqual([]);
  });
});

describe("instance default tags never carry permissions", () => {
  it("refuses permission tags in defaultContactTags from any caller, and drops them on read", () => {
    dbUpsertInstance({ name: "wa-defaults", channel: "whatsapp" });
    const instances = new InstancesCommands();
    runWithContext(ADMIN_AGENT, () =>
      expectBreakGlassDenied(() => instances.set("wa-defaults", "defaultContactTags", '["permission-owner"]', true)),
    );
    expectBreakGlassDenied(() => instances.set("wa-defaults", "defaultContactTags", "vip,Permission.Admin", true));

    // A value that reached storage another way (config import, older build) is dropped on read.
    const created = ensureContactFromInbound({
      channel: "whatsapp",
      instanceId: "wa-defaults",
      platformSenderId: "5511977770001",
      intakeMode: "pending",
      defaultTags: ["permission-owner", "vip"],
    });
    const contactId = created.contact!.id;
    expect(getContact(contactId)?.tags).toContain("vip");
    expect(getContact(contactId)?.tags ?? []).not.toContain("permission-owner");
    allowContact("5511977770001");
    expect(materializeContactPolicyCapabilities(contactId)).toEqual([]);
  });
});

// The storage sinks are what hold: a new code path that writes a contact tag,
// a contact chat grant or agent defaults straight to storage, from an agent
// turn, is refused unless an operator approval is running.
describe("storage sinks refuse break-glass from any new writer", () => {
  it("refuses a hypothetical writer calling the contact tag, policy and grant sinks directly", () => {
    upsertContact("5511900007010", "Target");
    allowContact("5511900007010");
    const target = getContact("5511900007010")!;
    dbCreateTagDefinition({
      slug: "permission-sink-root",
      label: "Root",
      kind: "system",
      source: "permissions",
      metadata: { permissions: { capabilities: ["execute:executable:*"] } },
    });
    const chat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "main",
      platformChatId: "break-glass-sink-chat",
      chatType: "group",
      title: "sink",
    });
    runWithContext(ADMIN_AGENT, () => {
      expectBreakGlassDenied(() => addContactTag("5511900007010", "permission-owner"));
      expectBreakGlassDenied(() => updateContact("5511900007010", { tags: ["vip", "permission-admin"] }));
      expectBreakGlassDenied(() =>
        dbEnsureContactChatGrant({
          contactId: target.id,
          profileSlug: "permission-sink-root",
          scopeType: "chat",
          scopeId: chat.id,
        }),
      );
      addContactTag("5511900007010", "vip");
    });
    expect(materializeContactPolicyCapabilities(target.id)).toEqual([]);
  });

  it("judges a dotted spelling by the definition the provider reads", () => {
    upsertContact("5511900007013", "Dotted");
    allowContact("5511900007013");
    const dotted = getContact("5511900007013")!;
    dbCreateTagDefinition({
      slug: "permission-legacy-root",
      label: "Legacy",
      kind: "system",
      source: "permissions",
      metadata: { permissions: { capabilities: ["admin:system:*"] } },
    });
    runWithContext(ADMIN_AGENT, () => {
      expectBreakGlassDenied(() => addContactTag("5511900007013", "permission.legacy.root"));
      expectBreakGlassDenied(() => updateContact("5511900007013", { tags: ["permission.legacy.root"] }));
    });
    expect(materializeContactPolicyCapabilities(dotted.id)).toEqual([]);
  });

  it("refuses activating a dormant admin by any path, including the library calls", () => {
    upsertContact("5511900007014", "Dormant", "pending");
    addContactTag("5511900007014", "permission-admin");
    const dormant = getContact("5511900007014")!;
    runWithContext(ADMIN_AGENT, () => {
      expectBreakGlassDenied(() => allowContact(dormant.id));
      expectBreakGlassDenied(() => allowContact("5511900007014"));
    });
    expect(materializeContactPolicyCapabilities(dormant.id)).toEqual([]);
  });

  it("lets the operator terminal activate a dormant admin, with a warning on stderr", () => {
    upsertContact("5511900007016", "Dormant terminal", "pending");
    addContactTag("5511900007016", "permission-admin");
    const dormant = getContact("5511900007016")!;
    const stderr: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      allowContact(dormant.id);
    } finally {
      process.stderr.write = original;
    }
    expect(materializeContactPolicyCapabilities(dormant.id).map((cap) => cap.permission)).toEqual(["admin"]);
    expect(stderr.join("")).toContain(`activating contact:${dormant.id} gives break-glass power`);
  });

  it("refuses activating a dormant contact whose break-glass comes only from a chat grant", () => {
    upsertContact("5511900007017", "Grant only", "pending");
    const holder = getContact("5511900007017")!;
    dbCreateTagDefinition({
      slug: "permission-grant-root",
      label: "Root",
      kind: "system",
      source: "permissions",
      metadata: { permissions: { capabilities: ["admin:system:*"] } },
    });
    const chat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "main",
      platformChatId: "break-glass-grant-only",
      chatType: "group",
      title: "grant only",
    });
    dbEnsureContactChatGrant({
      contactId: holder.id,
      profileSlug: "permission-grant-root",
      scopeType: "chat",
      scopeId: chat.id,
    });
    runWithContext(ADMIN_AGENT, () => expectBreakGlassDenied(() => allowContact(holder.id)));
    expect(getContact(holder.id)?.status).not.toBe("allowed");
  });

  it("refuses a new contact created with a break-glass tag and leaves nothing behind", () => {
    runWithContext(ADMIN_AGENT, () => {
      expectBreakGlassDenied(() => createContact({ phone: "5511900007015", tags: ["permission-owner"] }));
    });
    expect(getContact("5511900007015")).toBeNull();
  });

  it("opens the sinks only for the operator terminal and an approved grant", () => {
    upsertContact("5511900007011", "Approved");
    allowContact("5511900007011");
    const approved = getContact("5511900007011")!;
    runWithContext(ADMIN_AGENT, () =>
      runApprovedBreakGlassGrant("request-test", () => addContactTag("5511900007011", "permission-admin")),
    );
    expect(materializeContactPolicyCapabilities(approved.id).map((cap) => cap.permission)).toEqual(["admin"]);

    upsertContact("5511900007012", "Terminal owner");
    allowContact("5511900007012");
    addContactTag("5511900007012", "permission-owner");
    expect(materializeContactPolicyCapabilities(getContact("5511900007012")!.id).map((cap) => cap.permission)).toEqual([
      "admin",
    ]);
  });
});
