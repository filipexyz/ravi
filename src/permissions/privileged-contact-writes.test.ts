import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { runWithContext, type ToolContext } from "../cli/context.js";
import { ContactsCommands } from "../cli/commands/contacts.js";
import { TagCommands } from "../cli/commands/tags.js";
import {
  addContactTag,
  allowContact,
  closeContacts,
  getContact,
  linkContactIdentity,
  unlinkContactIdentity,
  upsertContact,
} from "../contacts.js";
import { dmContactForChat } from "../knowledge/contacts.js";
import type { ContextCapability } from "../router/router-db.js";
import { dbUpsertChat, dbUpsertChatParticipant } from "../router/router-db.js";
import { applyContactRule } from "../tag-rules/engine.js";
import { TagRuleSchema, type TagRule } from "../tag-rules/types.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { dbCreateTagDefinition } from "../tags/index.js";
import { materializeContactPolicyCapabilities } from "./contact-policy-permissions-provider.js";

setDefaultTimeout(20_000);

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-privileged-contact-writes-");
});

afterEach(async () => {
  closeContacts();
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function ctx(capabilities: string[]): ToolContext {
  const caps: ContextCapability[] = capabilities.map((value) => {
    const [permission, objectType, objectId] = value.split(":");
    return { permission: permission!, objectType: objectType!, objectId: objectId!, source: "test" };
  });
  return {
    contextId: "ctx_crm",
    agentId: "crm",
    sessionKey: "agent:crm:main",
    sessionName: "crm-main",
    context: {
      contextId: "ctx_crm",
      contextKey: "rctx_crm",
      kind: "agent-runtime",
      agentId: "crm",
      sessionKey: "agent:crm:main",
      sessionName: "crm-main",
      capabilities: caps,
      createdAt: 0,
    },
  };
}

const CRM = ctx(["mutate:contacts:*", "write_contacts:system:*", "mutate:tags:*"]);
const ADMIN = ctx(["admin:system:*"]);

function seedContact(phone: string, name: string) {
  upsertContact(phone, name);
  allowContact(phone);
  const contact = getContact(phone);
  if (!contact) throw new Error("seed failed");
  return contact;
}

function expectDenied(fn: () => unknown): void {
  let error: unknown;
  try {
    fn();
  } catch (err) {
    error = err;
  }
  expect(error).toMatchObject({ code: "PERMISSION_DENIED" });
}

// Spec permissions/break-glass: an agent turn never confers admin:system:* or
// execute:executable:* by tagging, even when it holds admin itself.
describe("break-glass power is never conferred by an agent tag write", () => {
  function expectBreakGlassDenied(fn: () => unknown): void {
    let error: unknown;
    try {
      fn();
    } catch (err) {
      error = err;
    }
    expect(error).toMatchObject({ code: "FULL_ACCESS_APPROVAL_REQUIRED", exitCode: 3 });
  }

  it("refuses an admin agent tagging a contact with an admin profile, in any spelling", () => {
    const target = seedContact("5511900001740", "Target");
    const commands = new ContactsCommands();
    runWithContext(ADMIN, () => {
      expectBreakGlassDenied(() => commands.tag(target.id, "permission-admin", true));
      expectBreakGlassDenied(() => commands.tag(target.id, "permission.owner", true));
      expectBreakGlassDenied(() => commands.set(target.id, "tags", '["vip","Permission:Superadmin"]', true));
    });
    expect(materializeContactPolicyCapabilities(target.id)).toEqual([]);
  });

  it("refuses an admin agent tagging or attaching a stored profile that carries break-glass", () => {
    const target = seedContact("5511900001741", "Target");
    dbCreateTagDefinition({
      slug: "permission-legacy-root",
      label: "Legacy",
      kind: "system",
      source: "permissions",
      metadata: { permissions: { capabilities: ["execute:executable:*"] } },
    });
    runWithContext(ADMIN, () => {
      expectBreakGlassDenied(() => new ContactsCommands().tag(target.id, "permission-legacy-root", true));
      expectBreakGlassDenied(() =>
        new TagCommands().attach(
          "permission-legacy-root",
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          target.id,
        ),
      );
    });
    expect(getContact(target.id)?.tags ?? []).not.toContain("permission-legacy-root");
  });

  it("keeps the operator terminal owner bootstrap and lets an admin agent remove an admin tag", () => {
    const target = seedContact("5511900001742", "Owner");
    new ContactsCommands().tag(target.id, "permission-owner", true);
    expect(materializeContactPolicyCapabilities(target.id).map((c) => c.permission)).toEqual(["admin"]);
    runWithContext(ADMIN, () => new ContactsCommands().untag(target.id, "permission-owner", true));
    expect(materializeContactPolicyCapabilities(target.id)).toEqual([]);
  });

  it("refuses a permission profile definition that carries break-glass, from any caller", () => {
    const tags = new TagCommands();
    expectBreakGlassDenied(() =>
      tags.create(
        "permission-root",
        "Root",
        undefined,
        "system",
        "permissions",
        JSON.stringify({ permissions: { capabilities: ["admin:system:*"] } }),
        true,
      ),
    );
    dbCreateTagDefinition({ slug: "permission-ops", label: "Ops", kind: "system", source: "permissions" });
    expectBreakGlassDenied(() =>
      tags.set(
        "permission-ops",
        "metadata",
        JSON.stringify({ permissions: { capabilities: ["execute:executable:*"] } }),
        true,
      ),
    );
    tags.set(
      "permission-ops",
      "metadata",
      JSON.stringify({ permissions: { capabilities: ["read:skills:show"] } }),
      true,
    );
    // A plain tag carrying the same metadata is not a permission profile and confers nothing.
    tags.create(
      "notes-root",
      "Notes",
      undefined,
      "user",
      undefined,
      JSON.stringify({ permissions: { capabilities: ["admin:system:*"] } }),
      true,
    );
  });
});

describe("permission tags need admin authority", () => {
  it("refuses contacts tag/set/untag of permission tags for a contact-write context", () => {
    const target = seedContact("5511900001717", "Target");
    const commands = new ContactsCommands();

    runWithContext(CRM, () => {
      expectDenied(() => commands.tag(target.id, "permission-admin", true));
      expectDenied(() => commands.tag(target.id, "permission.owner", true));
      expectDenied(() => commands.set(target.id, "tags", '["permission:superadmin"]', true));
      commands.tag(target.id, "vip", true);
    });

    expect(materializeContactPolicyCapabilities(target.id)).toEqual([]);
    expect(getContact(target.id)?.tags).toEqual(["vip"]);
  });

  it("refuses removing the owner's permission tag without admin authority", () => {
    const owner = seedContact("5511900001718", "Owner");
    addContactTag(owner.phone, "permission-owner");
    const commands = new ContactsCommands();

    runWithContext(CRM, () => {
      expectDenied(() => commands.untag(owner.id, "permission-owner", true));
      expectDenied(() => commands.set(owner.id, "tags", '["vip"]', true));
    });
    expect(materializeContactPolicyCapabilities(owner.id).map((c) => c.permission)).toEqual(["admin"]);
  });

  it("lets an admin principal tag a contact with a narrow permission tag", () => {
    const target = seedContact("5511900001719", "Target");
    dbCreateTagDefinition({
      slug: "permission-reader",
      label: "Reader",
      kind: "system",
      source: "permissions",
      metadata: { permissions: { capabilities: ["read:skills:show"] } },
    });
    runWithContext(ADMIN, () => new ContactsCommands().tag(target.id, "permission-reader", true));
    expect(getContact(target.id)?.tags).toContain("permission-reader");
  });

  it("refuses linking identities to, or merging, a contact that holds permission authority", () => {
    const owner = seedContact("5511900001720", "Owner");
    addContactTag(owner.phone, "permission-owner");
    const other = seedContact("5511900001721", "Other");
    const commands = new ContactsCommands();

    runWithContext(CRM, () => {
      expectDenied(() => commands.link(owner.id, "whatsapp", "5511900009999", undefined, undefined, true));
      expectDenied(() => commands.merge(other.id, owner.id, true, true));
      expectDenied(() => commands.merge(owner.id, other.id, true, true));
      expectDenied(() => commands.set(owner.id, "email", "attacker@example.com", true));
    });
    expect(getContact("5511900009999")).toBeNull();
    expect(getContact(other.id)).not.toBeNull();
  });

  it("refuses generic tags commands on provider-owned permission tags", () => {
    const target = seedContact("5511900001722", "Target");
    const tags = new TagCommands();

    runWithContext(CRM, () => {
      expectDenied(() => tags.create("permission-x", undefined, undefined, "system", "permissions", undefined, true));
      expectDenied(() => tags.create("lookalike", undefined, undefined, "system", "permissions", undefined, true));
      expectDenied(
        () =>
          tags.attach("permission-owner", undefined, undefined, undefined, undefined, undefined, target.id) as unknown,
      );
    });
    expect(materializeContactPolicyCapabilities(target.id)).toEqual([]);
  });
});

describe("tag rules never write permission tags", () => {
  const rule = {
    id: "promote",
    scope: "contact",
    enabled: true,
    priority: 0,
    conditions: [],
    apply: [{ target: "contact", tag: "permission:admin", when: "matched" }],
    evaluation: { reactive: true, cron: null },
  } as unknown as TagRule;

  it("rejects the rule at validation", () => {
    expect(TagRuleSchema.safeParse(rule).success).toBe(false);
  });

  it("skips permission tags at apply time", () => {
    const target = seedContact("5511900001723", "Target");
    const result = applyContactRule({ rule, contact: target, apply: true, cause: { evaluation: "manual" } });
    expect(result.skipped).toContainEqual({
      reason: "permission-tag-forbidden",
      detail: { tag: "permission:admin", action: "add" },
    });
    expect(materializeContactPolicyCapabilities(target.id)).toEqual([]);
  });
});

describe("unlinked identities stop resolving to their former contact", () => {
  it("clears the profile phone and the DM chat binding", () => {
    const owner = seedContact("5511900001724", "Owner");
    addContactTag(owner.phone, "permission-owner");
    const linked = linkContactIdentity(owner.id, { channel: "whatsapp", platformUserId: "5511900007777" });
    const identity = linked.platformIdentities.find((pi) => pi.normalizedPlatformUserId === "5511900007777");
    if (!identity) throw new Error("missing whatsapp identity");
    const chat = dbUpsertChat({
      channel: "whatsapp",
      platformChatId: "5511900007777@s.whatsapp.net",
      normalizedChatId: `contact:${owner.id}`,
      chatType: "dm",
    });
    dbUpsertChatParticipant({
      chatId: chat.id,
      platformIdentityId: identity.id,
      contactId: owner.id,
      normalizedPlatformUserId: "5511900007777",
      role: "member",
      status: "active",
      source: "inbound_message",
    });
    expect(dmContactForChat({ chatId: chat.id, channel: "whatsapp" })).toBe(owner.id);

    unlinkContactIdentity(identity.id);
    expect(dmContactForChat({ chatId: chat.id, channel: "whatsapp" })).toBeNull();

    for (const pi of getContact(owner.id)?.identities ?? []) {
      if (pi.value === "5511900001724") unlinkContactIdentity(pi.value, null, { channel: pi.platform });
    }
    expect(getContact("5511900001724")).toBeNull();
  });
});
