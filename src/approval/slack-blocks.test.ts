import { describe, expect, it } from "bun:test";
import {
  SLACK_APPROVAL_ACTION_APPROVE,
  SLACK_APPROVAL_ACTION_REJECT,
  buildSlackApprovalFinalMessage,
  buildSlackApprovalRequestMessage,
  slackApprovalDecisionFromActionId,
} from "./slack-blocks.js";

describe("slack approval blocks", () => {
  it("builds a versioned Approve/Reject message with an opaque request id only", () => {
    const payload = buildSlackApprovalRequestMessage({
      requestId: "req_opaque",
      type: "permission",
      text: "Sessão: dev-main\nCapability: execute:group:daemon",
      agentId: "dev",
      sessionName: "dev-main",
    });

    expect(payload.text).toBe("Permission requested");
    expect(JSON.stringify(payload)).toContain(SLACK_APPROVAL_ACTION_APPROVE);
    expect(JSON.stringify(payload)).toContain(SLACK_APPROVAL_ACTION_REJECT);
    expect(JSON.stringify(payload)).toContain("req_opaque");
    expect(JSON.stringify(payload.blocks)).toContain("execute:group:daemon");
    expect(payload.blocks.some((block) => JSON.stringify(block).includes('"value":"req_opaque"'))).toBe(true);
    expect(JSON.stringify(payload.blocks)).not.toContain("Reaja com");
    expect(JSON.stringify(payload.blocks)).not.toContain("react with");
    expect(JSON.stringify(payload.blocks)).toContain("Agent: dev");
    expect(JSON.stringify(payload.blocks)).toContain("Session: dev-main");
    expect(slackApprovalDecisionFromActionId(SLACK_APPROVAL_ACTION_APPROVE)).toBe("approved");
    expect(slackApprovalDecisionFromActionId(SLACK_APPROVAL_ACTION_REJECT)).toBe("rejected");
    expect(slackApprovalDecisionFromActionId("ravi_blockkit_approve")).toBeNull();
  });

  it("does not put the requested capability in the button value", () => {
    const payload = buildSlackApprovalRequestMessage({
      requestId: "req_only",
      type: "permission",
      text: "Capability: execute:group:daemon",
    });
    const actions = payload.blocks.find((block) => block.type === "actions") as
      | { elements?: Array<{ value?: string; action_id?: string }> }
      | undefined;
    expect(actions?.elements?.map((element) => element.value)).toEqual(["req_only", "req_only"]);
    expect(actions?.elements?.every((element) => element.value === "req_only")).toBe(true);
  });

  it("builds a compact final state without buttons", () => {
    const approved = buildSlackApprovalFinalMessage({ type: "permission", outcome: "approved" });
    const expired = buildSlackApprovalFinalMessage({ type: "permission", outcome: "expired" });

    expect(approved.text).toContain("Approved");
    expect(JSON.stringify(approved.blocks)).not.toContain("actions");
    expect(expired.text).toContain("Expired");
  });
});
