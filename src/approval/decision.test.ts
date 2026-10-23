import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { evaluateApprovalInboundEvent } from "./decision.js";
import type { PermissionGrantMetadata } from "./grant-metadata.js";
import {
  SLACK_APPROVAL_ACTION_APPROVE,
  SLACK_PERMISSION_GRANT_ACTION_EXACT,
  SLACK_PERMISSION_GRANT_ACTION_FULL_ACCESS,
  SLACK_PERMISSION_GRANT_ACTION_IGNORE,
  SLACK_PERMISSION_GRANT_ACTION_SCOPE,
} from "./slack-blocks.js";
import { attachApprovalRequestMessageId, createApprovalRequest, recordApprovalDeliveries } from "./store.js";
import { dbCreateTagDefinition } from "../tags/index.js";
import {
  APPROVAL_TEST_NOW_MS,
  APPROVAL_TEST_SLACK_OWNER_USER,
  APPROVAL_TEST_SLACK_STRANGER_USER,
  APPROVAL_TEST_STRANGER_PHONE,
  APPROVAL_TEST_WA_OWNER_PHONE,
  seedApprovalContact,
} from "./test-support.js";

let stateDir: string | null = null;

describe("approval inbound decision", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-approval-decision-");
    seedApprovalContact({
      phone: APPROVAL_TEST_WA_OWNER_PHONE,
      name: "Owner",
      tags: ["permission.admin"],
      slack: { userId: APPROVAL_TEST_SLACK_OWNER_USER, instanceId: "main" },
    });
    createApprovalRequest({
      id: "req_slack",
      type: "permission",
      channel: "slack",
      accountId: "main",
      chatId: "C123",
      instanceId: "main",
      permission: "execute",
      objectType: "group",
      objectId: "daemon",
      createdAt: APPROVAL_TEST_NOW_MS,
      expiresAt: APPROVAL_TEST_NOW_MS + 9_000,
    });
    attachApprovalRequestMessageId("req_slack", "msg_1");
    createApprovalRequest({
      id: "req_wa",
      type: "permission",
      channel: "whatsapp",
      accountId: "main",
      chatId: APPROVAL_TEST_WA_OWNER_PHONE,
      permission: "execute",
      objectType: "group",
      objectId: "daemon",
      createdAt: APPROVAL_TEST_NOW_MS,
      expiresAt: APPROVAL_TEST_NOW_MS + 9_000,
    });
    attachApprovalRequestMessageId("req_wa", "wa_msg_1");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("accepts an authorized Slack button click", () => {
    expect(
      evaluateApprovalInboundEvent(
        {
          topic: "ravi.inbound.interaction",
          data: {
            accountId: "main",
            channelId: "C123",
            messageTs: "msg_1",
            userId: APPROVAL_TEST_SLACK_OWNER_USER,
            actionId: SLACK_APPROVAL_ACTION_APPROVE,
            value: "req_slack",
          },
        },
        APPROVAL_TEST_NOW_MS + 1_000,
      ),
    ).toMatchObject({ kind: "decide", decision: "approved", actorId: APPROVAL_TEST_SLACK_OWNER_USER });
  });

  it("ignores Slack reactions for a Slack approval request", () => {
    expect(
      evaluateApprovalInboundEvent(
        {
          topic: "ravi.inbound.reaction",
          data: { targetMessageId: "msg_1", emoji: "👍", senderId: APPROVAL_TEST_SLACK_OWNER_USER },
        },
        APPROVAL_TEST_NOW_MS + 1_000,
      ),
    ).toMatchObject({ kind: "ignore", reason: "wrong_channel" });
  });

  it("ignores unauthorized, stale, and wrong-message Slack clicks", () => {
    expect(
      evaluateApprovalInboundEvent(
        {
          topic: "ravi.inbound.interaction",
          data: {
            accountId: "main",
            channelId: "C123",
            messageTs: "msg_1",
            userId: APPROVAL_TEST_SLACK_STRANGER_USER,
            actionId: SLACK_APPROVAL_ACTION_APPROVE,
            value: "req_slack",
          },
        },
        APPROVAL_TEST_NOW_MS + 1_000,
      ),
    ).toMatchObject({ kind: "ignore", reason: "unauthorized_grantor" });

    expect(
      evaluateApprovalInboundEvent(
        {
          topic: "ravi.inbound.interaction",
          data: {
            accountId: "main",
            channelId: "C123",
            messageTs: "msg_other",
            userId: APPROVAL_TEST_SLACK_OWNER_USER,
            actionId: SLACK_APPROVAL_ACTION_APPROVE,
            value: "req_slack",
          },
        },
        APPROVAL_TEST_NOW_MS + 1_000,
      ),
    ).toMatchObject({ kind: "ignore", reason: "wrong_message" });

    expect(
      evaluateApprovalInboundEvent(
        {
          topic: "ravi.inbound.interaction",
          data: {
            accountId: "main",
            channelId: "C123",
            messageTs: "msg_1",
            userId: APPROVAL_TEST_SLACK_OWNER_USER,
            actionId: SLACK_APPROVAL_ACTION_APPROVE,
            value: "req_slack",
          },
        },
        APPROVAL_TEST_NOW_MS + 9_000,
      ),
    ).toMatchObject({ kind: "ignore", reason: "not_open" });
  });

  it("accepts an authorized WhatsApp emoji and ignores an unauthorized one", () => {
    expect(
      evaluateApprovalInboundEvent(
        {
          topic: "ravi.inbound.reaction",
          data: { targetMessageId: "wa_msg_1", emoji: "👍", senderId: APPROVAL_TEST_WA_OWNER_PHONE },
        },
        APPROVAL_TEST_NOW_MS + 1_000,
      ),
    ).toMatchObject({ kind: "decide", decision: "approved" });

    seedApprovalContact({
      phone: APPROVAL_TEST_STRANGER_PHONE,
      name: "Stranger",
      tags: ["lead"],
    });
    expect(
      evaluateApprovalInboundEvent(
        {
          topic: "ravi.inbound.reaction",
          data: { targetMessageId: "wa_msg_1", emoji: "👍", senderId: APPROVAL_TEST_STRANGER_PHONE },
        },
        APPROVAL_TEST_NOW_MS + 1_000,
      ),
    ).toMatchObject({ kind: "ignore", reason: "unauthorized_grantor" });
  });
});

describe("approval grant card clicks", () => {
  const OTHER_GRANTOR_USER = "UGRANTO9R";

  const grant: PermissionGrantMetadata = {
    capability: { permission: "use", objectType: "tool", objectId: "Bash" },
    targets: { contactId: "con_requester", chatId: "cht_ops", chatTags: ["ops"], agentId: "dev" },
    adminUserIds: [APPROVAL_TEST_SLACK_OWNER_USER],
    allowed: ["full-access", "exact"],
    scopes: ["chat", "contact", "chat-tag:ops"],
    reason: "Permission denied: use tool:Bash",
  };

  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-approval-grant-decision-");
    seedApprovalContact({
      phone: APPROVAL_TEST_WA_OWNER_PHONE,
      name: "Admin",
      tags: ["permission.admin"],
      slack: { userId: APPROVAL_TEST_SLACK_OWNER_USER, instanceId: "main" },
    });
    // A grantor of the exact capability that is not an admin.
    dbCreateTagDefinition({
      slug: "permission-use-tool-bash",
      label: "Use Bash",
      kind: "system",
      source: "permissions",
      metadata: { permissions: { capabilities: ["use:tool:Bash"] } },
    });
    seedApprovalContact({
      phone: APPROVAL_TEST_STRANGER_PHONE,
      name: "Exact grantor",
      tags: ["lead", "permission.use-tool-bash"],
      slack: { userId: OTHER_GRANTOR_USER, instanceId: "main" },
    });

    createApprovalRequest({
      id: "req_grant",
      type: "permission",
      channel: "slack",
      accountId: "main",
      chatId: "C123",
      instanceId: "main",
      permission: "use",
      objectType: "tool",
      objectId: "Bash",
      grant,
      createdAt: APPROVAL_TEST_NOW_MS,
      expiresAt: APPROVAL_TEST_NOW_MS + 9_000,
    });
    attachApprovalRequestMessageId("req_grant", "msg_grant");
    recordApprovalDeliveries("req_grant", [
      {
        userId: APPROVAL_TEST_SLACK_OWNER_USER,
        kind: "ephemeral",
        chatId: "C123",
        messageId: "eph_admin",
        createdAt: APPROVAL_TEST_NOW_MS,
      },
      {
        userId: OTHER_GRANTOR_USER,
        kind: "ephemeral",
        chatId: "C123",
        messageId: "eph_grantor",
        createdAt: APPROVAL_TEST_NOW_MS,
      },
    ]);
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  function grantClick(input: {
    userId: string;
    actionId: string;
    value?: string;
    selectedOption?: string;
  }): ReturnType<typeof evaluateApprovalInboundEvent> {
    return evaluateApprovalInboundEvent(
      {
        topic: "ravi.inbound.interaction",
        data: {
          accountId: "main",
          channelId: "C123",
          messageTs: "eph_seen_by_slack",
          responseUrlId: "resp_grant",
          ...input,
        },
      },
      APPROVAL_TEST_NOW_MS + 1_000,
    );
  }

  it("accepts Full access from an admin of the instance", () => {
    expect(
      grantClick({
        userId: APPROVAL_TEST_SLACK_OWNER_USER,
        actionId: SLACK_PERMISSION_GRANT_ACTION_FULL_ACCESS,
        value: "req_grant|chat",
      }),
    ).toMatchObject({
      kind: "decide",
      decision: "approved",
      actorId: APPROVAL_TEST_SLACK_OWNER_USER,
      grant: { intent: "full-access", scope: "chat" },
    });
  });

  it("refuses Full access from a grantor that is not an admin", () => {
    expect(
      grantClick({
        userId: OTHER_GRANTOR_USER,
        actionId: SLACK_PERMISSION_GRANT_ACTION_FULL_ACCESS,
        value: "req_grant|chat",
      }),
    ).toMatchObject({ kind: "ignore", reason: "unauthorized_grantor" });
  });

  it("refuses a forged scope that the request did not record", () => {
    expect(
      grantClick({
        userId: APPROVAL_TEST_SLACK_OWNER_USER,
        actionId: SLACK_PERMISSION_GRANT_ACTION_EXACT,
        value: "req_grant|chat-tag:forged",
      }),
    ).toMatchObject({ kind: "ignore", reason: "scope_not_allowed" });
  });

  it("accepts Only what is needed with a recorded scope", () => {
    expect(
      grantClick({
        userId: OTHER_GRANTOR_USER,
        actionId: SLACK_PERMISSION_GRANT_ACTION_EXACT,
        value: "req_grant|chat-tag:ops",
      }),
    ).toMatchObject({
      kind: "decide",
      decision: "approved",
      grant: { intent: "exact", scope: "chat-tag:ops" },
    });
  });

  it("records a scope selection without deciding", () => {
    expect(
      grantClick({
        userId: APPROVAL_TEST_SLACK_OWNER_USER,
        actionId: SLACK_PERMISSION_GRANT_ACTION_SCOPE,
        selectedOption: "req_grant|contact",
      }),
    ).toMatchObject({
      kind: "scope",
      actorId: APPROVAL_TEST_SLACK_OWNER_USER,
      scope: "contact",
    });
  });

  it("turns Ignore into a rejection without a grant", () => {
    const evaluation = grantClick({
      userId: APPROVAL_TEST_SLACK_OWNER_USER,
      actionId: SLACK_PERMISSION_GRANT_ACTION_IGNORE,
      value: "req_grant",
    });
    expect(evaluation).toMatchObject({ kind: "decide", decision: "rejected", reason: "ignored" });
    expect(evaluation.kind === "decide" ? evaluation.grant : undefined).toBeUndefined();
  });

  it("refuses a grant click on a request that has no grant metadata", () => {
    createApprovalRequest({
      id: "req_legacy",
      type: "permission",
      channel: "slack",
      accountId: "main",
      chatId: "C123",
      instanceId: "main",
      permission: "use",
      objectType: "tool",
      objectId: "Bash",
      createdAt: APPROVAL_TEST_NOW_MS,
      expiresAt: APPROVAL_TEST_NOW_MS + 9_000,
    });
    attachApprovalRequestMessageId("req_legacy", "msg_legacy");
    recordApprovalDeliveries("req_legacy", [
      {
        userId: APPROVAL_TEST_SLACK_OWNER_USER,
        kind: "ephemeral",
        chatId: "C123",
        messageId: "eph_legacy",
        createdAt: APPROVAL_TEST_NOW_MS,
      },
    ]);

    expect(
      grantClick({
        userId: APPROVAL_TEST_SLACK_OWNER_USER,
        actionId: SLACK_PERMISSION_GRANT_ACTION_EXACT,
        value: "req_legacy|chat",
      }),
    ).toMatchObject({ kind: "ignore", reason: "grant_not_allowed" });
  });
});
