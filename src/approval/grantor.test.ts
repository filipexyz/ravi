import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createContact, linkContactIdentity } from "../contacts.js";
import { dbCreateTagDefinition } from "../tags/tag-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { actorCanGrantRequestedPermission } from "./grantor.js";

let stateDir: string | null = null;

describe("approval grantor", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-approval-grantor-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("fails closed without an actor or resolvable identity", () => {
    expect(
      actorCanGrantRequestedPermission({
        channel: "whatsapp",
        senderId: "",
        permission: "execute",
        objectType: "group",
        objectId: "daemon",
      }).reason,
    ).toBe("missing_actor");
    expect(
      actorCanGrantRequestedPermission({
        channel: "slack",
        accountId: "main",
        senderId: "U-unknown",
        permission: "execute",
        objectType: "group",
        objectId: "daemon",
      }).reason,
    ).toBe("unresolved_identity");
  });

  it("allows an admin-tagged WhatsApp contact to grant any requested capability", () => {
    createContact({
      phone: "5511999990000",
      name: "Owner",
      tags: ["permission.admin"],
      status: "allowed",
    });

    expect(
      actorCanGrantRequestedPermission({
        channel: "whatsapp",
        accountId: "main",
        senderId: "5511999990000",
        permission: "execute",
        objectType: "group",
        objectId: "daemon",
      }),
    ).toMatchObject({ allowed: true, reason: "authorized_grantor", subjectType: "contact" });
  });

  it("allows a Slack-linked admin contact after identity resolution", () => {
    const contact = createContact({
      phone: "5511999990001",
      name: "Slack Owner",
      tags: ["permission.owner"],
      status: "allowed",
    });
    linkContactIdentity(contact.id, {
      channel: "slack",
      platformUserId: "U123",
      instanceId: "slack-main",
    });

    expect(
      actorCanGrantRequestedPermission({
        channel: "slack",
        accountId: "slack-main",
        instanceId: "slack-main",
        senderId: "U123",
        permission: "execute",
        objectType: "group",
        objectId: "daemon",
      }).allowed,
    ).toBe(true);
  });

  it("denies a contact who lacks the requested capability", () => {
    dbCreateTagDefinition({
      slug: "permission-family",
      label: "Family Image",
      kind: "system",
      source: "permissions",
      metadata: { permissions: { capabilities: ["mutate:image:generate"] } },
    });
    createContact({
      phone: "5511999990002",
      name: "Family",
      tags: ["permission.family"],
      status: "allowed",
    });

    expect(
      actorCanGrantRequestedPermission({
        channel: "whatsapp",
        senderId: "5511999990002",
        permission: "mutate",
        objectType: "image",
        objectId: "generate",
      }).allowed,
    ).toBe(true);
    expect(
      actorCanGrantRequestedPermission({
        channel: "whatsapp",
        senderId: "5511999990002",
        permission: "execute",
        objectType: "group",
        objectId: "daemon",
      }),
    ).toMatchObject({ allowed: false, reason: "unauthorized_grantor" });
  });

  it("requires admin system:* when no permission triple is present", () => {
    createContact({
      phone: "5511999990003",
      name: "Lead",
      tags: ["lead"],
      status: "allowed",
    });
    createContact({
      phone: "5511999990004",
      name: "Owner",
      tags: ["permission.superadmin"],
      status: "allowed",
    });

    expect(
      actorCanGrantRequestedPermission({
        channel: "whatsapp",
        senderId: "5511999990003",
      }).allowed,
    ).toBe(false);
    expect(
      actorCanGrantRequestedPermission({
        channel: "whatsapp",
        senderId: "5511999990004",
      }).allowed,
    ).toBe(true);
  });
});
