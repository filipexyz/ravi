import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { dbCreateTagDefinition } from "../tags/tag-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { actorCanGrantRequestedPermission } from "./grantor.js";
import {
  APPROVAL_TEST_FAMILY_PHONE,
  APPROVAL_TEST_LEAD_PHONE,
  APPROVAL_TEST_SLACK_OWNER_PHONE,
  APPROVAL_TEST_SLACK_OWNER_USER,
  APPROVAL_TEST_SUPERADMIN_PHONE,
  APPROVAL_TEST_WA_OWNER_PHONE,
  seedApprovalContact,
} from "./test-support.js";

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
    seedApprovalContact({
      phone: APPROVAL_TEST_WA_OWNER_PHONE,
      name: "Owner",
      tags: ["permission.admin"],
    });

    expect(
      actorCanGrantRequestedPermission({
        channel: "whatsapp",
        accountId: "main",
        senderId: APPROVAL_TEST_WA_OWNER_PHONE,
        permission: "execute",
        objectType: "group",
        objectId: "daemon",
      }),
    ).toMatchObject({ allowed: true, reason: "authorized_grantor", subjectType: "contact" });
  });

  it("allows a Slack-linked admin contact after identity resolution", () => {
    seedApprovalContact({
      phone: APPROVAL_TEST_SLACK_OWNER_PHONE,
      name: "Slack Owner",
      tags: ["permission.owner"],
      slack: { userId: APPROVAL_TEST_SLACK_OWNER_USER, instanceId: "slack-main" },
    });

    expect(
      actorCanGrantRequestedPermission({
        channel: "slack",
        accountId: "slack-main",
        instanceId: "slack-main",
        senderId: APPROVAL_TEST_SLACK_OWNER_USER,
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
    seedApprovalContact({
      phone: APPROVAL_TEST_FAMILY_PHONE,
      name: "Family",
      tags: ["permission.family"],
    });

    expect(
      actorCanGrantRequestedPermission({
        channel: "whatsapp",
        senderId: APPROVAL_TEST_FAMILY_PHONE,
        permission: "mutate",
        objectType: "image",
        objectId: "generate",
      }).allowed,
    ).toBe(true);
    expect(
      actorCanGrantRequestedPermission({
        channel: "whatsapp",
        senderId: APPROVAL_TEST_FAMILY_PHONE,
        permission: "execute",
        objectType: "group",
        objectId: "daemon",
      }),
    ).toMatchObject({ allowed: false, reason: "unauthorized_grantor" });
  });

  it("requires admin system:* when no permission triple is present", () => {
    seedApprovalContact({
      phone: APPROVAL_TEST_LEAD_PHONE,
      name: "Lead",
      tags: ["lead"],
    });
    seedApprovalContact({
      phone: APPROVAL_TEST_SUPERADMIN_PHONE,
      name: "Owner",
      tags: ["permission.superadmin"],
    });

    expect(
      actorCanGrantRequestedPermission({
        channel: "whatsapp",
        senderId: APPROVAL_TEST_LEAD_PHONE,
      }).allowed,
    ).toBe(false);
    expect(
      actorCanGrantRequestedPermission({
        channel: "whatsapp",
        senderId: APPROVAL_TEST_SUPERADMIN_PHONE,
      }).allowed,
    ).toBe(true);
  });
});
