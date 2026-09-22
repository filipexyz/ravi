import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  attachApprovalRequestMessageId,
  claimApprovalDecision,
  createApprovalRequest,
  expireApprovalRequest,
  getApprovalRequest,
  isApprovalRequestOpen,
} from "./store.js";

let stateDir: string | null = null;

describe("approval request store", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-approval-store-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("persists a pending request and attaches the outbound message id", () => {
    createApprovalRequest({
      id: "req_1",
      type: "permission",
      channel: "slack",
      accountId: "main",
      chatId: "C123",
      permission: "execute",
      objectType: "group",
      objectId: "daemon",
      createdAt: 1000,
      expiresAt: 4000,
    });

    expect(getApprovalRequest("req_1")).toMatchObject({
      status: "pending",
      messageId: null,
      permission: "execute",
    });
    expect(attachApprovalRequestMessageId("req_1", "1713000000.000100")?.messageId).toBe("1713000000.000100");
    expect(isApprovalRequestOpen(getApprovalRequest("req_1")!, 2000)).toBe(true);
  });

  it("claims the first valid decision and rejects a second claim", () => {
    createApprovalRequest({
      id: "req_2",
      type: "permission",
      channel: "whatsapp",
      accountId: "main",
      chatId: "5511",
      messageId: "msg_1",
      createdAt: 1000,
      expiresAt: 5000,
    });

    const first = claimApprovalDecision({
      id: "req_2",
      decision: "approved",
      decidedBy: "5511999",
      now: 2000,
    });
    const second = claimApprovalDecision({
      id: "req_2",
      decision: "rejected",
      decidedBy: "5511888",
      now: 2100,
    });

    expect(first).toMatchObject({ status: "decided", decision: "approved", decidedBy: "5511999" });
    expect(second).toBeNull();
    expect(getApprovalRequest("req_2")?.decision).toBe("approved");
  });

  it("does not claim an expired request", () => {
    createApprovalRequest({
      id: "req_3",
      type: "plan",
      channel: "slack",
      accountId: "main",
      chatId: "C123",
      messageId: "msg_3",
      createdAt: 1000,
      expiresAt: 1500,
    });

    expect(
      claimApprovalDecision({
        id: "req_3",
        decision: "approved",
        decidedBy: "U123",
        now: 1500,
      }),
    ).toBeNull();
    expect(expireApprovalRequest("req_3", 1600)?.status).toBe("expired");
    expect(isApprovalRequestOpen(getApprovalRequest("req_3")!, 1600)).toBe(false);
  });
});
