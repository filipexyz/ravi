import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { setApprovalGrantorRouterConfigForTest } from "./grantor.js";
import { answerSlackApprovalClick } from "./slack-click-feedback.js";
import { SLACK_APPROVAL_ACTION_APPROVE } from "./slack-blocks.js";
import {
  attachApprovalRequestMessageId,
  claimApprovalDecision,
  createApprovalRequest,
  expireApprovalRequest,
  recordApprovalDeliveries,
} from "./store.js";
import {
  APPROVAL_TEST_NOW_MS,
  APPROVAL_TEST_SLACK_OWNER_PHONE,
  APPROVAL_TEST_SLACK_OWNER_USER,
  APPROVAL_TEST_SLACK_STRANGER_USER,
  APPROVAL_TEST_STRANGER_PHONE,
  seedApprovalContact,
} from "./test-support.js";

let stateDir: string | null = null;
let responses: Array<{ responseUrlId: string; payload: Record<string, unknown> }> = [];
const now = APPROVAL_TEST_NOW_MS + 1_000;

const dependencies = {
  now: () => now,
  respond: async (input: { responseUrlId: string; payload: Record<string, unknown> }) => {
    responses.push(input);
  },
};

function click(userId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: "slack",
    accountId: "main",
    instanceId: "main",
    channelId: "C123",
    messageTs: "eph_1",
    userId,
    actionId: SLACK_APPROVAL_ACTION_APPROVE,
    value: "req_1",
    responseUrlId: "resp_1",
    ...overrides,
  };
}

describe("Slack approval click feedback", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-approval-click-feedback-");
    setApprovalGrantorRouterConfigForTest(() => ({ instances: {}, instanceToAccount: {} }));
    responses = [];
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
    createApprovalRequest({
      id: "req_1",
      type: "permission",
      channel: "slack",
      accountId: "main",
      chatId: "C123",
      instanceId: "main",
      permission: "execute",
      objectType: "executable",
      objectId: "curl",
      createdAt: APPROVAL_TEST_NOW_MS,
      expiresAt: APPROVAL_TEST_NOW_MS + 9_000,
    });
    attachApprovalRequestMessageId("req_1", "eph_1");
    recordApprovalDeliveries("req_1", [
      { userId: APPROVAL_TEST_SLACK_OWNER_USER, kind: "ephemeral", chatId: "C123", messageId: "eph_1", createdAt: 1 },
      { userId: "UOTHERADM", kind: "ephemeral", chatId: "C123", messageId: "eph_2", createdAt: 1 },
    ]);
  });

  afterEach(async () => {
    setApprovalGrantorRouterConfigForTest();
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("leaves a deciding click to the waiter", async () => {
    expect(await answerSlackApprovalClick(click(APPROVAL_TEST_SLACK_OWNER_USER), dependencies)).toBeNull();
    expect(responses).toEqual([]);
  });

  it("tells someone without the permission, privately, and keeps their card", async () => {
    expect(await answerSlackApprovalClick(click(APPROVAL_TEST_SLACK_STRANGER_USER), dependencies)).toBe("unauthorized");
    expect(responses).toHaveLength(1);
    expect(responses[0]?.payload).toMatchObject({ response_type: "ephemeral", replace_original: false });
    expect(String(responses[0]?.payload.text)).toContain("don't have the permission");
  });

  it("replaces a card whose request expired", async () => {
    expireApprovalRequest("req_1", now);
    expect(await answerSlackApprovalClick(click(APPROVAL_TEST_SLACK_OWNER_USER), dependencies)).toBe("expired");
    expect(responses[0]?.payload).toMatchObject({ replace_original: true });
    expect(String(responses[0]?.payload.text)).toContain("expired");
  });

  it("tells the other grantors who already decided", async () => {
    claimApprovalDecision({ id: "req_1", decision: "approved", decidedBy: APPROVAL_TEST_SLACK_OWNER_USER, now });
    expect(await answerSlackApprovalClick(click("UOTHERADM"), dependencies)).toBe("already_decided");
    expect(String(responses[0]?.payload.text)).toBe(
      `This request was already approved by <@${APPROVAL_TEST_SLACK_OWNER_USER}>.`,
    );
  });

  it("stays quiet on a second click from whoever decided", async () => {
    claimApprovalDecision({ id: "req_1", decision: "approved", decidedBy: APPROVAL_TEST_SLACK_OWNER_USER, now });
    expect(await answerSlackApprovalClick(click(APPROVAL_TEST_SLACK_OWNER_USER), dependencies)).toBeNull();
    expect(responses).toEqual([]);
  });

  it("ignores interactions that are not approval buttons", async () => {
    expect(
      await answerSlackApprovalClick(click(APPROVAL_TEST_SLACK_STRANGER_USER, { actionId: "other" }), dependencies),
    ).toBeNull();
    expect(responses).toEqual([]);
  });
});
