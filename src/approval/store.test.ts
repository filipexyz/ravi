import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  attachApprovalRequestMessageId,
  claimApprovalDecision,
  createApprovalRequest,
  expireApprovalRequest,
  getApprovalRequest,
  isApprovalRequestOpen,
  recordApprovalGrantOutcome,
  settleElicitationApprovalRequest,
  type CreateApprovalRequestInput,
} from "./store.js";
import { evaluateApprovalInboundEvent } from "./decision.js";
import { getDb } from "../router/router-db.js";

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

  it("records the grant application result only once after approval, separately from the human decision", () => {
    createApprovalRequest({
      id: "req_grant_result",
      type: "permission",
      channel: "slack",
      accountId: "main",
      chatId: "C123",
      grant: {
        capability: { permission: "use", objectType: "tool", objectId: "Bash" },
        targets: { agentId: "dev", chatId: "C123", chatTags: [] },
        adminUserIds: ["U_OWNER"],
        allowed: ["exact"],
        scopes: [],
      },
      createdAt: 1000,
      expiresAt: 5000,
    });
    expect(recordApprovalGrantOutcome("req_grant_result", "applied")).toBeNull();
    claimApprovalDecision({ id: "req_grant_result", decision: "approved", decidedBy: "U_OWNER", now: 2000 });
    expect(recordApprovalGrantOutcome("req_grant_result", "failed")).toMatchObject({
      decision: "approved",
      grantOutcome: "failed",
    });
    expect(recordApprovalGrantOutcome("req_grant_result", "applied")).toBeNull();
    expect(getApprovalRequest("req_grant_result")?.grantOutcome).toBe("failed");
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

  describe("elicitation rows", () => {
    const base: CreateApprovalRequestInput = {
      id: "req_elicit",
      type: "elicitation",
      channel: "whatsapp",
      accountId: "main",
      chatId: "5511987009601@s.whatsapp.net",
      sessionName: "dev-main",
      agentId: "dev",
      elicitation: { server: "ravi-console", tool: "ravi_pages_ship", mode: "form", fields: ["confirm", "title"] },
      createdAt: 1000,
      expiresAt: 9000,
    };

    it("needs the detail, and only an elicitation row may carry one", () => {
      const { elicitation: _detail, ...withoutDetail } = base;
      expect(() => createApprovalRequest(withoutDetail)).toThrow();
      expect(() => createApprovalRequest({ ...base, id: "req_perm", type: "permission" })).toThrow();
      expect(() =>
        createApprovalRequest({
          ...base,
          id: "req_url_fields",
          elicitation: { server: "a", tool: "b", mode: "url", fields: ["link"] },
        }),
      ).toThrow();
      expect(() =>
        createApprovalRequest({
          ...base,
          id: "req_value_as_name",
          elicitation: { server: "a", tool: "b", mode: "form", fields: ["my password is hunter2"] },
        }),
      ).toThrow();
      expect(() =>
        createApprovalRequest({
          ...base,
          id: "req_early_action",
          elicitation: { ...base.elicitation!, action: "accept" },
        }),
      ).toThrow();
      expect(getApprovalRequest("req_perm")).toBeNull();
    });

    it("stores server, tool, mode and field names only, never values", () => {
      createApprovalRequest({
        ...base,
        elicitation: {
          ...base.elicitation!,
          // A caller that slips other keys in: they never reach the row.
          ...({ values: { title: "Launch plan" }, message: "Confirm the ship?", url: "https://x" } as object),
        },
      });

      const row = getDb().prepare("SELECT elicitation_json FROM approval_requests WHERE id = ?").get("req_elicit") as {
        elicitation_json: string;
      };
      expect(JSON.parse(row.elicitation_json)).toEqual({
        server: "ravi-console",
        tool: "ravi_pages_ship",
        mode: "form",
        fields: ["confirm", "title"],
      });
      expect(row.elicitation_json).not.toContain("Launch plan");
      expect(getApprovalRequest("req_elicit")).toMatchObject({
        type: "elicitation",
        status: "pending",
        elicitation: { server: "ravi-console", tool: "ravi_pages_ship", mode: "form", fields: ["confirm", "title"] },
      });
    });

    it("is settled with the action alone, and never through the approval decision path", () => {
      createApprovalRequest({ ...base, messageId: "q_1" });
      expect(
        evaluateApprovalInboundEvent(
          {
            topic: "ravi.inbound.reply",
            data: { targetMessageId: "q_1", text: "sim", senderId: "5511987009601" },
          },
          2000,
        ),
      ).toEqual({ kind: "ignore", reason: "not_an_approval" });
      expect(claimApprovalDecision({ id: "req_elicit", decision: "approved", decidedBy: "x", now: 2000 })).toBeNull();

      expect(
        settleElicitationApprovalRequest({ id: "req_elicit", action: "accept", decidedBy: "contact_1", now: 3000 }),
      ).toMatchObject({
        status: "decided",
        decision: "approved",
        decidedBy: "contact_1",
        reason: null,
        decidedAt: 3000,
        elicitation: { action: "accept", fields: ["confirm", "title"] },
      });
      expect(settleElicitationApprovalRequest({ id: "req_elicit", action: "decline", now: 3100 })).toBeNull();

      createApprovalRequest({ ...base, id: "req_elicit_cancel" });
      expect(
        settleElicitationApprovalRequest({
          id: "req_elicit_cancel",
          action: "cancel",
          decidedBy: "contact_1",
          now: 4000,
        }),
      ).toMatchObject({ status: "expired", decision: null, decidedBy: null, elicitation: { action: "cancel" } });

      createApprovalRequest({ ...base, id: "req_elicit_decline" });
      expect(
        settleElicitationApprovalRequest({
          id: "req_elicit_decline",
          action: "decline",
          decidedBy: "contact_1",
          now: 4000,
        }),
      ).toMatchObject({ status: "decided", decision: "rejected", elicitation: { action: "decline" } });

      createApprovalRequest({
        id: "req_plan",
        type: "plan",
        channel: "slack",
        accountId: "main",
        chatId: "C1",
        createdAt: 1000,
        expiresAt: 9000,
      });
      expect(settleElicitationApprovalRequest({ id: "req_plan", action: "accept", now: 2000 })).toBeNull();
      expect(getApprovalRequest("req_plan")?.status).toBe("pending");
    });
  });
});
