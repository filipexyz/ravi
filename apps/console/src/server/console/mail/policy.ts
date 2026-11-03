export type MailOperation = "read" | "decrypt" | "send";
export type MailPolicyDenialReason =
  | "cross_organization"
  | "mailbox_inactive"
  | "missing_read_permission"
  | "missing_send_permission"
  | "message_too_large"
  | "attachment_too_large"
  | "retention_out_of_range";
export type PublicMailPolicyErrorCode = "mail_operation_denied";

export type MailAccessContext = {
  actorOrganizationId: string;
  mailboxOrganizationId: string;
  mailboxStatus?: "active" | "disabled" | "deleted";
  canRead?: boolean;
  canSend?: boolean;
};

export type MailPolicyDecision =
  | {
      ok: true;
    }
  | {
      ok: false;
      reason: MailPolicyDenialReason;
      publicError: PublicMailPolicyErrorCode;
    };

export type MailSizeLimits = {
  maxMessageBytes: number;
  maxAttachmentBytes: number;
};

export const DEFAULT_MAIL_RETENTION_DAYS = 130;
export const DEFAULT_MAIL_SIZE_LIMITS = {
  maxMessageBytes: 10 * 1024 * 1024,
  maxAttachmentBytes: 5 * 1024 * 1024,
} satisfies MailSizeLimits;

export function decideMailAccess(operation: MailOperation, context: MailAccessContext): MailPolicyDecision {
  if (context.actorOrganizationId !== context.mailboxOrganizationId) {
    return deny("cross_organization");
  }

  if ((context.mailboxStatus ?? "active") !== "active") {
    return deny("mailbox_inactive");
  }

  if ((operation === "read" || operation === "decrypt") && !context.canRead) {
    return deny("missing_read_permission");
  }

  if (operation === "send" && !context.canSend) {
    return deny("missing_send_permission");
  }

  return {
    ok: true,
  };
}

export function resolveMailRetentionDays(value: unknown): MailPolicyDecision & { days?: number } {
  if (value === undefined || value === null) {
    return {
      ok: true,
      days: DEFAULT_MAIL_RETENTION_DAYS,
    };
  }

  if (!Number.isInteger(value) || typeof value !== "number" || value < 1 || value > 3650) {
    return deny("retention_out_of_range");
  }

  return {
    ok: true,
    days: value,
  };
}

export function validateMailPayloadSize({
  attachmentBytes = 0,
  messageBytes,
  limits = DEFAULT_MAIL_SIZE_LIMITS,
}: {
  messageBytes: number;
  attachmentBytes?: number;
  limits?: MailSizeLimits;
}): MailPolicyDecision {
  if (messageBytes > limits.maxMessageBytes) return deny("message_too_large");
  if (attachmentBytes > limits.maxAttachmentBytes) return deny("attachment_too_large");

  return {
    ok: true,
  };
}

function deny(reason: MailPolicyDenialReason) {
  return {
    ok: false,
    reason,
    publicError: "mail_operation_denied",
  } as const;
}
