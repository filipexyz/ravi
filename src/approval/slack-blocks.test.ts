import { describe, expect, it } from "bun:test";
import {
  SLACK_APPROVAL_ACTION_APPROVE,
  SLACK_APPROVAL_ACTION_REJECT,
  SLACK_PERMISSION_GRANT_ACTION_EXACT,
  SLACK_PERMISSION_GRANT_ACTION_FULL_ACCESS,
  SLACK_PERMISSION_GRANT_ACTION_IGNORE,
  SLACK_PERMISSION_GRANT_ACTION_SCOPE,
  buildSlackApprovalFinalMessage,
  buildSlackApprovalRequestMessage,
  buildSlackPermissionGrantMessage,
  parseSlackGrantActionValue,
  slackApprovalDecisionFromActionId,
  slackPermissionGrantClickFromActionId,
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

  it("renders the grant card with every allowed grant and the chat scope", () => {
    const payload = buildSlackPermissionGrantMessage({
      requestId: "req_grant",
      requesterUserId: "UREQUEST1",
      capabilityText: "use tool:Bash",
      reason: "Permission denied: agent:dev requires use on tool:Bash",
      agentId: "dev",
      sessionName: "dev-main",
      adminUserIds: ["UADMIN1"],
      allowed: ["full-access", "exact"],
      scopes: ["chat", "contact", "chat-tag:ops"],
    });

    const actions = payload.blocks.find((block) => block.type === "actions") as
      | { elements?: Array<Record<string, unknown>> }
      | undefined;
    expect(actions?.elements?.map((element) => element.action_id)).toEqual([
      SLACK_PERMISSION_GRANT_ACTION_FULL_ACCESS,
      SLACK_PERMISSION_GRANT_ACTION_EXACT,
      SLACK_PERMISSION_GRANT_ACTION_SCOPE,
      SLACK_PERMISSION_GRANT_ACTION_IGNORE,
    ]);
    const select = actions?.elements?.find((element) => element.action_id === SLACK_PERMISSION_GRANT_ACTION_SCOPE) as {
      options?: Array<{ text: { text: string }; value: string }>;
      initial_option?: { value: string };
    };
    expect(select.options?.map((option) => option.value)).toEqual([
      "req_grant|chat",
      "req_grant|contact",
      "req_grant|chat-tag:ops",
    ]);
    expect(select.initial_option?.value).toBe("req_grant|chat");
    expect(JSON.stringify(payload.blocks)).toContain("<@UADMIN1>");
    expect(JSON.stringify(payload.blocks)).toContain("<@UREQUEST1>");
    expect(JSON.stringify(payload.blocks)).toContain("use tool:Bash");
    // No legacy Approve/Reject on a grant card.
    expect(JSON.stringify(payload.blocks)).not.toContain(SLACK_APPROVAL_ACTION_APPROVE);
  });

  it("hides Full access and the scope selector when they are not allowed", () => {
    const payload = buildSlackPermissionGrantMessage({
      requestId: "req_agent_only",
      capabilityText: "use tool:Bash",
      adminUserIds: [],
      allowed: ["exact"],
      scopes: [],
    });

    const serialized = JSON.stringify(payload.blocks);
    expect(serialized).not.toContain(SLACK_PERMISSION_GRANT_ACTION_FULL_ACCESS);
    expect(serialized).not.toContain(SLACK_PERMISSION_GRANT_ACTION_SCOPE);
    expect(serialized).toContain(SLACK_PERMISSION_GRANT_ACTION_EXACT);
    expect(serialized).toContain("agent ceiling only");
  });

  it("keeps the selected scope in the grant button values", () => {
    const payload = buildSlackPermissionGrantMessage({
      requestId: "req_scope",
      capabilityText: "use tool:Bash",
      adminUserIds: ["UADMIN1"],
      allowed: ["full-access", "exact"],
      scopes: ["chat", "chat-tag:ops"],
      selectedScope: "chat-tag:ops",
    });

    const actions = payload.blocks.find((block) => block.type === "actions") as
      | { elements?: Array<{ action_id?: string; value?: string }> }
      | undefined;
    const fullAccess = actions?.elements?.find(
      (element) => element.action_id === SLACK_PERMISSION_GRANT_ACTION_FULL_ACCESS,
    );
    expect(fullAccess?.value).toBe("req_scope|chat-tag:ops");
    expect(parseSlackGrantActionValue(fullAccess?.value)).toEqual({
      requestId: "req_scope",
      scope: "chat-tag:ops",
    });
  });

  it("maps grant action ids to clicks", () => {
    expect(slackPermissionGrantClickFromActionId(SLACK_PERMISSION_GRANT_ACTION_FULL_ACCESS)).toBe("full-access");
    expect(slackPermissionGrantClickFromActionId(SLACK_PERMISSION_GRANT_ACTION_EXACT)).toBe("exact");
    expect(slackPermissionGrantClickFromActionId(SLACK_PERMISSION_GRANT_ACTION_IGNORE)).toBe("ignore");
    expect(slackPermissionGrantClickFromActionId(SLACK_PERMISSION_GRANT_ACTION_SCOPE)).toBe("scope");
    expect(slackPermissionGrantClickFromActionId(SLACK_APPROVAL_ACTION_APPROVE)).toBeNull();
  });

  it("shows what was granted in the final state", () => {
    const approved = buildSlackApprovalFinalMessage({
      type: "permission",
      outcome: "approved",
      decidedBy: "UADMIN1",
      detail: "Granted use tool:Bash in this chat",
    });

    expect(approved.text).toContain("Approved by <@UADMIN1>");
    expect(approved.text).toContain("Granted use tool:Bash in this chat");
    expect(JSON.stringify(approved.blocks)).not.toContain('"type":"actions"');
  });
});
