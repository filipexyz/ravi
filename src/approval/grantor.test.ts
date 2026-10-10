import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { dbCreateTagDefinition } from "../tags/tag-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { actorCanGrantRequestedPermission, setApprovalGrantorRouterConfigForTest } from "./grantor.js";
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
    setApprovalGrantorRouterConfigForTest(() => ({ instances: {}, instanceToAccount: {} }));
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
    setApprovalGrantorRouterConfigForTest();
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

  it("does not resolve a Slack clicker linked only under another instance", () => {
    // The turn resolves a Slack author only within the receiving instance, so the
    // grantor must not find an owner the turn would call unknown.
    seedApprovalContact({
      phone: APPROVAL_TEST_SLACK_OWNER_PHONE,
      name: "Slack Owner",
      tags: ["permission.owner"],
      slack: { userId: APPROVAL_TEST_SLACK_OWNER_USER, instanceId: "old-slack" },
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
      }),
    ).toMatchObject({ allowed: false, reason: "unresolved_identity" });
  });

  it("resolves a Slack clicker through the instance's configured slug/UUID alias", () => {
    const uuid = "6f9619ff-8b86-d011-b42d-00c04fc964ff";
    setApprovalGrantorRouterConfigForTest(() => ({
      instances: { "slack-main": { instanceId: uuid } as never },
      instanceToAccount: { [uuid]: "slack-main" },
    }));
    seedApprovalContact({
      phone: APPROVAL_TEST_SLACK_OWNER_PHONE,
      name: "Slack Owner",
      tags: ["permission.owner"],
      slack: { userId: APPROVAL_TEST_SLACK_OWNER_USER, instanceId: uuid },
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
      }),
    ).toMatchObject({ allowed: true, reason: "authorized_grantor" });
  });

  it("does not fall back to the account's workspace when the stored Slack instance is unmapped", () => {
    // A stale account id can name another workspace; the request's instance is
    // the only scope searched.
    const uuid = "6f9619ff-8b86-d011-b42d-00c04fc964ff";
    setApprovalGrantorRouterConfigForTest(() => ({
      instances: { "slack-other": { instanceId: uuid } as never },
      instanceToAccount: { [uuid]: "slack-other" },
    }));
    seedApprovalContact({
      phone: APPROVAL_TEST_SLACK_OWNER_PHONE,
      name: "Slack Owner",
      tags: ["permission.owner"],
      slack: { userId: APPROVAL_TEST_SLACK_OWNER_USER, instanceId: uuid },
    });

    expect(
      actorCanGrantRequestedPermission({
        channel: "slack",
        accountId: "slack-other",
        instanceId: "unmapped-instance",
        senderId: APPROVAL_TEST_SLACK_OWNER_USER,
        permission: "execute",
        objectType: "group",
        objectId: "daemon",
      }),
    ).toMatchObject({ allowed: false, reason: "unresolved_identity" });
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
