import {
  validateSlackBlockKitMessage,
  type SlackBlockKitBlock,
  type SlackBlockKitMessagePayload,
} from "../channels/slack/block-kit.js";
import type { PermissionGrantIntent, PermissionGrantScopeValue } from "../permissions/apply-grant.js";
import type { ApprovalDecisionValue, ApprovalRequestType } from "./store.js";

export const SLACK_APPROVAL_ACTION_APPROVE = "ravi.approval.v1.approve";
export const SLACK_APPROVAL_ACTION_REJECT = "ravi.approval.v1.reject";
export const SLACK_PERMISSION_GRANT_ACTION_FULL_ACCESS = "ravi.grant.v1.full-access";
export const SLACK_PERMISSION_GRANT_ACTION_EXACT = "ravi.grant.v1.exact";
export const SLACK_PERMISSION_GRANT_ACTION_SCOPE = "ravi.grant.v1.scope";
export const SLACK_PERMISSION_GRANT_ACTION_IGNORE = "ravi.grant.v1.ignore";
export const SLACK_APPROVAL_ACTIONS_BLOCK_ID = "ravi.approval.v1.actions";
export const SLACK_APPROVAL_HEADER_BLOCK_ID = "ravi.approval.v1.header";
export const SLACK_APPROVAL_BODY_BLOCK_ID = "ravi.approval.v1.body";
export const SLACK_APPROVAL_CONTEXT_BLOCK_ID = "ravi.approval.v1.context";
export const SLACK_APPROVAL_STATUS_BLOCK_ID = "ravi.approval.v1.status";
export const SLACK_APPROVAL_SCOPE_BLOCK_ID = "ravi.approval.v1.scope";

/** How a grant card click is read. `scope` is a select change, not a decision. */
export type SlackPermissionGrantClick = PermissionGrantIntent | "ignore" | "scope";

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
  /** Slack user id of who decided, shown as a mention. */
  readonly decidedBy?: string;
  /** What actually happened, appended to the approved headline (e.g. the granted scope). */
  readonly detail?: string;
}

/** Why a click did not decide anything, told privately to whoever clicked. */
export type SlackApprovalClickNotice = "unauthorized" | "expired" | "already_decided" | "unknown";

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

export function isSlackPermissionGrantActionId(actionId: string | undefined): boolean {
  return slackPermissionGrantClickFromActionId(actionId) !== null;
}

export function slackPermissionGrantClickFromActionId(actionId: string | undefined): SlackPermissionGrantClick | null {
  if (actionId === SLACK_PERMISSION_GRANT_ACTION_FULL_ACCESS) return "full-access";
  if (actionId === SLACK_PERMISSION_GRANT_ACTION_EXACT) return "exact";
  if (actionId === SLACK_PERMISSION_GRANT_ACTION_IGNORE) return "ignore";
  if (actionId === SLACK_PERMISSION_GRANT_ACTION_SCOPE) return "scope";
  return null;
}

/**
 * Grant buttons carry `<requestId>|<scope>` so the selected scope survives the
 * click; the value is still only a hint and is validated against the request.
 */
export function buildSlackGrantActionValue(requestId: string, scope?: string): string {
  return scope ? `${requestId}|${scope}` : requestId;
}

export function parseSlackGrantActionValue(value: string | undefined): {
  readonly requestId: string;
  readonly scope?: string;
} {
  const raw = value?.trim() ?? "";
  const separator = raw.indexOf("|");
  if (separator < 0) return { requestId: raw };
  const requestId = raw.slice(0, separator).trim();
  const scope = raw.slice(separator + 1).trim();
  return scope ? { requestId, scope } : { requestId };
}

export function slackApprovalDecisionFromActionId(actionId: string | undefined): ApprovalDecisionValue | null {
  if (actionId === SLACK_APPROVAL_ACTION_APPROVE) return "approved";
  if (actionId === SLACK_APPROVAL_ACTION_REJECT) return "rejected";
  return null;
}

export interface SlackPermissionGrantMessageInput {
  readonly requestId: string;
  /** Slack user id of the person who hit the denial, mentioned in the body. */
  readonly requesterUserId?: string;
  readonly capabilityText: string;
  readonly reason?: string;
  readonly agentId?: string;
  readonly sessionName?: string;
  /** Admins who received the card; mentioned so they know it is for them. */
  readonly adminUserIds: readonly string[];
  readonly allowed: readonly PermissionGrantIntent[];
  readonly scopes: readonly PermissionGrantScopeValue[];
  /** Scope currently picked on this person's card. */
  readonly selectedScope?: string;
}

const GRANT_SCOPE_LABELS: Record<string, string> = {
  chat: "This chat",
  contact: "This contact (all chats)",
};

/**
 * A permission denial card: what the requester needed, and the grant buttons an
 * admin can use. Only the grants recorded in `allowed`/`scopes` are rendered,
 * so a card never shows a button the click gate would refuse.
 */
export function buildSlackPermissionGrantMessage(input: SlackPermissionGrantMessageInput): SlackBlockKitMessagePayload {
  const title = "Permission needed";
  const selectedScope = resolveSelectedScope(input);
  const bodyLines: string[] = [];
  const mentions = input.adminUserIds.map((id) => slackMention(id)).filter((id): id is string => Boolean(id));
  const requester = slackMention(input.requesterUserId);
  const who = requester ?? "someone";
  bodyLines.push(
    mentions.length > 0
      ? `${mentions.slice(0, 5).join(" ")} — ${who} hit a permission failure in this chat.`
      : `${who} hit a permission failure in this chat.`,
  );
  bodyLines.push(`*Needed:* \`${input.capabilityText}\``);
  const reason = sanitizeReason(input.reason);
  if (reason) bodyLines.push(`_${reason}_`);
  bodyLines.push("");
  bodyLines.push(
    input.allowed.includes("full-access")
      ? adminActivityHint(mentions.length)
      : "Full access is not offered here: it needs a Slack-linked admin contact.",
  );

  const blocks: SlackBlockKitBlock[] = [
    {
      type: "header",
      block_id: SLACK_APPROVAL_HEADER_BLOCK_ID,
      text: { type: "plain_text", text: title, emoji: true },
    },
    {
      type: "section",
      block_id: SLACK_APPROVAL_BODY_BLOCK_ID,
      text: { type: "mrkdwn", text: bodyLines.join("\n") },
    },
  ];

  const contextLine = buildApprovalContextLine({
    requestId: input.requestId,
    type: "permission",
    text: "",
    ...(input.agentId ? { agentId: input.agentId } : {}),
    ...(input.sessionName ? { sessionName: input.sessionName } : {}),
  });
  if (contextLine) {
    blocks.push({
      type: "context",
      block_id: SLACK_APPROVAL_CONTEXT_BLOCK_ID,
      elements: [{ type: "mrkdwn", text: contextLine }],
    });
  }
  blocks.push({
    type: "context",
    block_id: SLACK_APPROVAL_SCOPE_BLOCK_ID,
    elements: [
      {
        type: "mrkdwn",
        text:
          input.scopes.length > 0
            ? `Scope: *${describeScopeLabel(selectedScope)}* (default: this chat)`
            : "Scope: agent ceiling only — this turn has no resolved contact.",
      },
    ],
  });

  const elements: SlackBlockKitBlock[] = [];
  if (input.allowed.includes("full-access")) {
    elements.push({
      type: "button",
      action_id: SLACK_PERMISSION_GRANT_ACTION_FULL_ACCESS,
      text: { type: "plain_text", text: "Full access", emoji: true },
      style: "primary",
      value: buildSlackGrantActionValue(input.requestId, scopesHaveSelection(input) ? selectedScope : undefined),
    });
  }
  if (input.allowed.includes("exact")) {
    elements.push({
      type: "button",
      action_id: SLACK_PERMISSION_GRANT_ACTION_EXACT,
      text: { type: "plain_text", text: "Only what is needed", emoji: true },
      style: "primary",
      value: buildSlackGrantActionValue(input.requestId, scopesHaveSelection(input) ? selectedScope : undefined),
    });
  }
  if (input.scopes.length > 0) {
    const options = input.scopes.map((scope) => ({
      text: { type: "plain_text", text: describeScopeLabel(scope) },
      value: buildSlackGrantActionValue(input.requestId, scope),
    }));
    elements.push({
      type: "static_select",
      action_id: SLACK_PERMISSION_GRANT_ACTION_SCOPE,
      placeholder: { type: "plain_text", text: "Scope", emoji: true },
      options,
      initial_option:
        options.find((option) => option.value === buildSlackGrantActionValue(input.requestId, selectedScope)) ??
        options[0],
    });
  }
  elements.push({
    type: "button",
    action_id: SLACK_PERMISSION_GRANT_ACTION_IGNORE,
    text: { type: "plain_text", text: "Ignore", emoji: true },
    style: "danger",
    value: input.requestId,
  });

  blocks.push({
    type: "actions",
    block_id: SLACK_APPROVAL_ACTIONS_BLOCK_ID,
    elements,
  });

  const payload = { text: `${title}: ${input.capabilityText}`, blocks };
  validateSlackBlockKitMessage(payload);
  return payload;
}

function resolveSelectedScope(input: SlackPermissionGrantMessageInput): string | undefined {
  const selected = input.selectedScope?.trim();
  if (selected && input.scopes.includes(selected as PermissionGrantScopeValue)) return selected;
  return input.scopes[0];
}

function scopesHaveSelection(input: SlackPermissionGrantMessageInput): boolean {
  return input.scopes.length > 0;
}

function describeScopeLabel(scope: string | undefined): string {
  if (!scope) return "this chat";
  if (GRANT_SCOPE_LABELS[scope]) return GRANT_SCOPE_LABELS[scope];
  if (scope.startsWith("chat-tag:")) return `Every chat tagged ${scope.slice("chat-tag:".length)}`;
  return scope;
}

function adminActivityHint(adminCount: number): string {
  return adminCount > 0
    ? "Full access grants the admin profile; only what is needed grants this capability only."
    : "Only what is needed grants this capability to the contact in the selected scope.";
}

function sanitizeReason(value: string | undefined): string | undefined {
  const compact = value?.replace(/\s+/g, " ").trim();
  if (!compact) return undefined;
  return compact.length > 300 ? `${compact.slice(0, 297)}...` : compact;
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
  const status = compactApprovalStatus(input.outcome, input.reason, input.decidedBy, input.detail);
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

export function buildSlackApprovalClickNotice(
  notice: SlackApprovalClickNotice,
  request?: { readonly decision?: ApprovalDecisionValue | null; readonly decidedBy?: string | null },
): string {
  if (notice === "unauthorized") return "You can't decide this request: you don't have the permission it asks for.";
  if (notice === "expired") return "This request expired, so nothing was granted.";
  if (notice === "already_decided") {
    const by = slackMention(request?.decidedBy);
    const verb = request?.decision === "rejected" ? "rejected" : "approved";
    return by ? `This request was already ${verb} by ${by}.` : `This request was already ${verb}.`;
  }
  return "This request no longer exists.";
}

function compactApprovalStatus(
  outcome: ApprovalDecisionValue | "expired",
  reason?: string,
  decidedBy?: string,
  detail?: string,
): string {
  const by = slackMention(decidedBy);
  const extra = detail?.trim();
  if (outcome === "approved") {
    const approved = by ? `Approved by ${by}` : "Approved";
    return extra ? `${approved}: ${extra}` : approved;
  }
  if (outcome === "expired") return "Expired — no decision in 5 minutes.";
  const reasonText = reason?.trim();
  const rejected = by ? `Rejected by ${by}` : "Rejected";
  return reasonText && reasonText !== "rejected" ? `${rejected}: ${reasonText}` : rejected;
}

function slackMention(userId: string | null | undefined): string | undefined {
  const id = userId?.trim();
  return id && /^[UW][A-Z0-9]+$/i.test(id) ? `<@${id.toUpperCase()}>` : undefined;
}
