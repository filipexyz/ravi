import {
  validateSlackBlockKitMessage,
  type SlackBlockKitBlock,
  type SlackBlockKitMessagePayload,
} from "../channels/slack/block-kit.js";
import type { ApprovalDecisionValue, ApprovalRequestType } from "./store.js";

export const SLACK_APPROVAL_ACTION_APPROVE = "ravi.approval.v1.approve";
export const SLACK_APPROVAL_ACTION_REJECT = "ravi.approval.v1.reject";
export const SLACK_APPROVAL_ACTIONS_BLOCK_ID = "ravi.approval.v1.actions";
export const SLACK_APPROVAL_HEADER_BLOCK_ID = "ravi.approval.v1.header";
export const SLACK_APPROVAL_BODY_BLOCK_ID = "ravi.approval.v1.body";
export const SLACK_APPROVAL_CONTEXT_BLOCK_ID = "ravi.approval.v1.context";
export const SLACK_APPROVAL_STATUS_BLOCK_ID = "ravi.approval.v1.status";

export interface SlackApprovalMessageInput {
  readonly requestId: string;
  readonly type: ApprovalRequestType;
  readonly text: string;
  readonly agentId?: string;
  readonly sessionName?: string;
  readonly delegated?: boolean;
}

export interface SlackApprovalFinalMessageInput {
  readonly type: ApprovalRequestType;
  readonly outcome: ApprovalDecisionValue | "expired";
  readonly reason?: string;
}

const TITLE_BY_TYPE: Record<ApprovalRequestType, string> = {
  permission: "Permission requested",
  plan: "Plan pending",
  spec: "Spec pending",
};

export function isSlackApprovalActionId(
  actionId: string | undefined,
): actionId is typeof SLACK_APPROVAL_ACTION_APPROVE | typeof SLACK_APPROVAL_ACTION_REJECT {
  return actionId === SLACK_APPROVAL_ACTION_APPROVE || actionId === SLACK_APPROVAL_ACTION_REJECT;
}

export function slackApprovalDecisionFromActionId(actionId: string | undefined): ApprovalDecisionValue | null {
  if (actionId === SLACK_APPROVAL_ACTION_APPROVE) return "approved";
  if (actionId === SLACK_APPROVAL_ACTION_REJECT) return "rejected";
  return null;
}

export function buildSlackApprovalRequestMessage(input: SlackApprovalMessageInput): SlackBlockKitMessagePayload {
  const title = TITLE_BY_TYPE[input.type];
  const request = input.text.trim() || title;
  const contextLine = buildApprovalContextLine(input);
  const blocks: SlackBlockKitBlock[] = [
    {
      type: "header",
      block_id: SLACK_APPROVAL_HEADER_BLOCK_ID,
      text: { type: "plain_text", text: title, emoji: true },
    },
    {
      type: "section",
      block_id: SLACK_APPROVAL_BODY_BLOCK_ID,
      text: { type: "mrkdwn", text: request },
    },
  ];
  if (contextLine) {
    blocks.push({
      type: "context",
      block_id: SLACK_APPROVAL_CONTEXT_BLOCK_ID,
      elements: [{ type: "mrkdwn", text: contextLine }],
    });
  }
  blocks.push({
    type: "actions",
    block_id: SLACK_APPROVAL_ACTIONS_BLOCK_ID,
    elements: [
      {
        type: "button",
        action_id: SLACK_APPROVAL_ACTION_APPROVE,
        text: { type: "plain_text", text: "Approve", emoji: true },
        style: "primary",
        value: input.requestId,
      },
      {
        type: "button",
        action_id: SLACK_APPROVAL_ACTION_REJECT,
        text: { type: "plain_text", text: "Reject", emoji: true },
        style: "danger",
        value: input.requestId,
      },
    ],
  });

  const payload = { text: title, blocks };
  validateSlackBlockKitMessage(payload);
  return payload;
}

export function buildSlackApprovalFinalMessage(input: SlackApprovalFinalMessageInput): SlackBlockKitMessagePayload {
  const title = TITLE_BY_TYPE[input.type];
  const status = compactApprovalStatus(input.outcome, input.reason);
  const payload = {
    text: `${title}: ${status}`,
    blocks: [
      {
        type: "section",
        block_id: SLACK_APPROVAL_STATUS_BLOCK_ID,
        text: { type: "mrkdwn", text: `*${title}*\n${status}` },
      },
    ] satisfies SlackBlockKitBlock[],
  };
  validateSlackBlockKitMessage(payload);
  return payload;
}

function buildApprovalContextLine(input: SlackApprovalMessageInput): string | undefined {
  const parts: string[] = [];
  if (input.agentId?.trim()) {
    parts.push(input.delegated ? `Agent: _${input.agentId.trim()}_` : `Agent: ${input.agentId.trim()}`);
  }
  if (input.sessionName?.trim()) {
    parts.push(`Session: ${input.sessionName.trim()}`);
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function compactApprovalStatus(outcome: ApprovalDecisionValue | "expired", reason?: string): string {
  if (outcome === "approved") return "Approved";
  if (outcome === "expired") return "Expired — no decision in 5 minutes.";
  const detail = reason?.trim();
  return detail && detail !== "rejected" ? `Rejected: ${detail}` : "Rejected";
}
