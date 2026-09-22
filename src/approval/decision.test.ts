import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { evaluateApprovalInboundEvent } from "./decision.js";
import { SLACK_APPROVAL_ACTION_APPROVE } from "./slack-blocks.js";
import { attachApprovalRequestMessageId, createApprovalRequest } from "./store.js";
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
