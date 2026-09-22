import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createContact, linkContactIdentity } from "../contacts.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { evaluateApprovalInboundEvent } from "./decision.js";
import { SLACK_APPROVAL_ACTION_APPROVE } from "./slack-blocks.js";
import { attachApprovalRequestMessageId, createApprovalRequest } from "./store.js";

let stateDir: string | null = null;

describe("approval inbound decision", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-approval-decision-");
    const owner = createContact({
      phone: "5511999990000",
      name: "Owner",
      tags: ["permission.admin"],
      status: "allowed",
    });
    linkContactIdentity(owner.id, { channel: "slack", platformUserId: "U123", instanceId: "main" });
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
      createdAt: 1000,
      expiresAt: 10_000,
    });
    attachApprovalRequestMessageId("req_slack", "msg_1");
    createApprovalRequest({
      id: "req_wa",
      type: "permission",
      channel: "whatsapp",
      accountId: "main",
      chatId: "5511999990000",
      permission: "execute",
      objectType: "group",
      objectId: "daemon",
      createdAt: 1000,
      expiresAt: 10_000,
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
            userId: "U123",
            actionId: SLACK_APPROVAL_ACTION_APPROVE,
            value: "req_slack",
          },
        },
        2000,
      ),
    ).toMatchObject({ kind: "decide", decision: "approved", actorId: "U123" });
  });

  it("ignores Slack reactions for a Slack approval request", () => {
    expect(
      evaluateApprovalInboundEvent(
        {
          topic: "ravi.inbound.reaction",
          data: { targetMessageId: "msg_1", emoji: "👍", senderId: "U123" },
        },
        2000,
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
            userId: "U999",
            actionId: SLACK_APPROVAL_ACTION_APPROVE,
            value: "req_slack",
          },
        },
        2000,
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
            userId: "U123",
            actionId: SLACK_APPROVAL_ACTION_APPROVE,
            value: "req_slack",
          },
        },
        2000,
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
            userId: "U123",
            actionId: SLACK_APPROVAL_ACTION_APPROVE,
            value: "req_slack",
          },
        },
        10_000,
      ),
    ).toMatchObject({ kind: "ignore", reason: "not_open" });
  });

  it("accepts an authorized WhatsApp emoji and ignores an unauthorized one", () => {
    expect(
      evaluateApprovalInboundEvent(
        {
          topic: "ravi.inbound.reaction",
          data: { targetMessageId: "wa_msg_1", emoji: "👍", senderId: "5511999990000" },
        },
        2000,
      ),
    ).toMatchObject({ kind: "decide", decision: "approved" });

    createContact({
      phone: "5511999990099",
      name: "Stranger",
      tags: ["lead"],
      status: "allowed",
    });
    expect(
      evaluateApprovalInboundEvent(
        {
          topic: "ravi.inbound.reaction",
          data: { targetMessageId: "wa_msg_1", emoji: "👍", senderId: "5511999990099" },
        },
        2000,
      ),
    ).toMatchObject({ kind: "ignore", reason: "unauthorized_grantor" });
  });
});
