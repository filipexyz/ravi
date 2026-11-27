import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { linkContactIdentity } from "../contacts.js";
import { dbCreateTagDefinition } from "../tags/tag-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { listSlackApprovalGrantorUserIds, setApprovalGrantorRouterConfigForTest } from "../channels/slack/grantors.js";
import {
  actorCanGrantRequestedPermission,
  resolveVerifiedSenderOwner,
  registerGrantorIdentityResolver,
  unregisterGrantorIdentityResolver,
} from "./grantor.js";
import {
  APPROVAL_TEST_FAMILY_PHONE,
  APPROVAL_TEST_LEAD_PHONE,
  APPROVAL_TEST_SLACK_OWNER_PHONE,
  APPROVAL_TEST_SLACK_OWNER_USER,
  APPROVAL_TEST_SLACK_STRANGER_USER,
  APPROVAL_TEST_STRANGER_PHONE,
  APPROVAL_TEST_SUPERADMIN_PHONE,
  APPROVAL_TEST_WA_OWNER_PHONE,
  seedApprovalContact,
} from "./test-support.js";
import { registerVoiceGrantorResolver } from "../voice/approvals.js";
import { insertVoiceDevice, markVoiceDeviceRevoked } from "../voice/store.js";

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

  it("resolves a verified sender to its owner without a permission check, and nothing else", () => {
    registerGrantorIdentityResolver("fixture-channel", ({ senderId }) =>
      senderId === "U-person"
        ? { ownerType: "contact", ownerId: "contact-person" }
        : senderId === "U-bot"
          ? { ownerType: "agent", ownerId: "agent-x" }
          : null,
    );
    try {
      expect(resolveVerifiedSenderOwner({ channel: "fixture-channel", senderId: "U-person" })).toEqual({
        ownerType: "contact",
        ownerId: "contact-person",
      });
      expect(resolveVerifiedSenderOwner({ channel: "fixture-channel", senderId: "U-bot" })?.ownerType).toBe("agent");
      expect(resolveVerifiedSenderOwner({ channel: "fixture-channel", senderId: "U-nobody" })).toBeNull();
      expect(resolveVerifiedSenderOwner({ channel: "fixture-channel", senderId: "  " })).toBeNull();
    } finally {
      unregisterGrantorIdentityResolver("fixture-channel");
    }
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

  it("lists only the Slack people of the instance who can grant the request", () => {
    seedApprovalContact({
      phone: APPROVAL_TEST_SLACK_OWNER_PHONE,
      name: "Slack Owner",
      tags: ["permission.admin"],
      slack: { userId: APPROVAL_TEST_SLACK_OWNER_USER, instanceId: "main" },
    });
    seedApprovalContact({
      phone: APPROVAL_TEST_STRANGER_PHONE,
      name: "Stranger",
      tags: ["lead"],
      slack: { userId: APPROVAL_TEST_SLACK_STRANGER_USER, instanceId: "main" },
    });
    seedApprovalContact({
      phone: APPROVAL_TEST_SUPERADMIN_PHONE,
      name: "Other workspace admin",
      tags: ["permission.admin"],
      slack: { userId: "UOTHERWS1", instanceId: "other" },
    });

    const request = { permission: "execute", objectType: "executable", objectId: "curl" };
    expect(listSlackApprovalGrantorUserIds({ instanceId: "main", ...request })).toEqual([
      APPROVAL_TEST_SLACK_OWNER_USER,
    ]);
    expect(listSlackApprovalGrantorUserIds({ instanceId: "other", ...request })).toEqual(["UOTHERWS1"]);
    expect(listSlackApprovalGrantorUserIds({ instanceId: "nobody", ...request })).toEqual([]);
  });
});

describe("approval grantor identity resolvers", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-approval-grantor-resolvers-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("asks the resolver registered for the channel, and the generic lookup for every other one", () => {
    const owner = seedApprovalContact({
      phone: APPROVAL_TEST_SLACK_OWNER_PHONE,
      name: "Owner",
      tags: ["permission.admin"],
    });
    const asked: string[] = [];
    registerGrantorIdentityResolver("test-channel", (input) => {
      asked.push(input.senderId);
      return input.senderId === "sender-1" ? { ownerType: "contact", ownerId: owner.id } : null;
    });

    expect(actorCanGrantRequestedPermission({ channel: "test-channel", senderId: "sender-1" })).toMatchObject({
      allowed: true,
      reason: "authorized_grantor",
      subjectId: owner.id,
    });
    expect(actorCanGrantRequestedPermission({ channel: "test-channel", senderId: "sender-2" })).toMatchObject({
      allowed: false,
      reason: "unresolved_identity",
    });
    expect(asked).toEqual(["sender-1", "sender-2"]);
    // A channel with no resolver of its own still resolves a contact by the generic lookup.
    expect(
      actorCanGrantRequestedPermission({ channel: "whatsapp", senderId: APPROVAL_TEST_SLACK_OWNER_PHONE }),
    ).toMatchObject({ allowed: true, subjectId: owner.id });
  });

  it("hands the aliases of a verified sender to the channel resolver, and resolves them in the generic lookup", () => {
    const owner = seedApprovalContact({
      phone: APPROVAL_TEST_SLACK_OWNER_PHONE,
      name: "Owner",
      tags: ["permission.admin"],
    });
    linkContactIdentity(owner.id, { channel: "whatsapp", platformUserId: "lid:4242424242", instanceId: "inst-1" });
    const seen: Array<{ senderId: string; senderAliases?: readonly string[]; instanceId?: string | null }> = [];
    registerGrantorIdentityResolver("alias-channel", (input) => {
      seen.push({ senderId: input.senderId, senderAliases: input.senderAliases, instanceId: input.instanceId });
      return { ownerType: "contact", ownerId: owner.id };
    });
    try {
      actorCanGrantRequestedPermission({
        channel: "alias-channel",
        senderId: "4242424242",
        senderAliases: ["lid:4242424242"],
        instanceId: "inst-1",
      });
      expect(seen).toEqual([{ senderId: "4242424242", senderAliases: ["lid:4242424242"], instanceId: "inst-1" }]);
    } finally {
      unregisterGrantorIdentityResolver("alias-channel");
    }
    // Without a resolver of its own the generic lookup tries the exact namespaced identity too.
    expect(
      actorCanGrantRequestedPermission({
        channel: "whatsapp",
        senderId: "4242424242",
        senderAliases: ["lid:4242424242"],
        instanceId: "inst-1",
      }),
    ).toMatchObject({ allowed: true, subjectId: owner.id });
  });
  it("never resolves an unlinked lid: sender through its digits as a phone number", () => {
    // The LID digits equal the admin's stored phone: only a linked `lid:` identity may stand for them.
    seedApprovalContact({ phone: APPROVAL_TEST_SLACK_OWNER_PHONE, name: "Owner", tags: ["permission.admin"] });

    expect(
      actorCanGrantRequestedPermission({
        channel: "whatsapp",
        senderId: APPROVAL_TEST_SLACK_OWNER_PHONE,
        senderAliases: [`lid:${APPROVAL_TEST_SLACK_OWNER_PHONE}`],
        instanceId: "inst-1",
      }),
    ).toMatchObject({ allowed: false, reason: "unresolved_identity" });
  });

  it("resolves a lid: sender as its linked owner, never as the admin whose phone has the same digits", () => {
    seedApprovalContact({ phone: APPROVAL_TEST_SLACK_OWNER_PHONE, name: "Admin", tags: ["permission.admin"] });
    const other = seedApprovalContact({ phone: APPROVAL_TEST_SUPERADMIN_PHONE, name: "Other", tags: [] });
    linkContactIdentity(other.id, {
      channel: "whatsapp",
      platformUserId: `lid:${APPROVAL_TEST_SLACK_OWNER_PHONE}`,
      instanceId: "inst-1",
    });

    expect(
      actorCanGrantRequestedPermission({
        channel: "whatsapp",
        senderId: APPROVAL_TEST_SLACK_OWNER_PHONE,
        senderAliases: [`lid:${APPROVAL_TEST_SLACK_OWNER_PHONE}`],
        instanceId: "inst-1",
      }),
    ).toMatchObject({ allowed: false, reason: "unauthorized_grantor", subjectId: other.id });
  });

  it("refuses a sender whose identity resolves to different owners on different instance scopes", () => {
    const admin = seedApprovalContact({
      phone: APPROVAL_TEST_SLACK_OWNER_PHONE,
      name: "Admin",
      tags: ["permission.admin"],
    });
    const other = seedApprovalContact({ phone: APPROVAL_TEST_SUPERADMIN_PHONE, name: "Other", tags: [] });
    linkContactIdentity(admin.id, { channel: "whatsapp", platformUserId: "lid:4242424242", instanceId: "" });
    linkContactIdentity(other.id, { channel: "whatsapp", platformUserId: "lid:4242424242", instanceId: "inst-1" });

    expect(
      actorCanGrantRequestedPermission({
        channel: "whatsapp",
        senderId: "4242424242",
        senderAliases: ["lid:4242424242"],
        instanceId: "inst-1",
      }),
    ).toMatchObject({ allowed: false, reason: "unresolved_identity" });
  });

  it("never looks a lid: sender up through its bare digits, even when those digits are a linked identity", () => {
    const admin = seedApprovalContact({
      phone: APPROVAL_TEST_SLACK_OWNER_PHONE,
      name: "Admin",
      tags: ["permission.admin"],
    });
    const stranger = "4242424242";
    for (const channel of ["whatsapp", "phone"]) {
      linkContactIdentity(admin.id, { channel, platformUserId: stranger, instanceId: "inst-1" });
    }

    expect(
      actorCanGrantRequestedPermission({
        channel: "whatsapp",
        senderId: stranger,
        senderAliases: [`lid:${stranger}`],
        instanceId: "inst-1",
      }),
    ).toMatchObject({ allowed: false, reason: "unresolved_identity" });
    // The same digits as a plain phone sender still resolve.
    expect(
      actorCanGrantRequestedPermission({ channel: "whatsapp", senderId: APPROVAL_TEST_SLACK_OWNER_PHONE }),
    ).toMatchObject({ allowed: true, subjectId: admin.id });
  });

  it("voice: a paired device grants as its contact; unknown or revoked devices fail closed", () => {
    registerVoiceGrantorResolver();
    const admin = seedApprovalContact({
      phone: APPROVAL_TEST_WA_OWNER_PHONE,
      name: "Owner",
      tags: ["permission.admin"],
    });
    const now = Date.now();
    insertVoiceDevice({
      id: "vd_grantor",
      label: "phone",
      contactId: admin.id,
      sessions: ["main"],
      contextId: "ctx_vd_grantor",
      createdAt: now,
      expiresAt: now + 60_000,
    });
    const voiceGrant = (senderId: string) =>
      actorCanGrantRequestedPermission({
        channel: "voice",
        accountId: "voice",
        senderId,
        permission: "execute",
        objectType: "group",
        objectId: "daemon",
      });
    expect(voiceGrant("vd_grantor")).toMatchObject({ allowed: true, subjectType: "contact", subjectId: admin.id });
    expect(voiceGrant("vd_unknown").reason).toBe("unresolved_identity");
    markVoiceDeviceRevoked("vd_grantor");
    expect(voiceGrant("vd_grantor").reason).toBe("unresolved_identity");
  });
});
