import { canonicalChannelId } from "./capabilities.js";

export const CHAT_ACTION_IDS = [
  "message.delete",
  "message.edit",
  "message.react",
  "sticker.send",
  "media.send",
  "message.reply",
  "thread.create",
  "thread.close",
] as const;

export type ChatActionId = (typeof CHAT_ACTION_IDS)[number];
export type ChatActionStatus = "available" | "unavailable" | "planned";
export type ChatActionExecutionMode = "durable" | "provider_confirmed" | "internal" | "legacy";
export type ChatActionUnavailableReasonCode =
  | "no_surface"
  | "unsupported_channel"
  | "missing_connection"
  | "missing_scope"
  | "permission_denied"
  | "invalid_target"
  | "unverifiable_ownership"
  | "no_eligible_resource"
  | "adapter_unavailable";

export interface ChatActionUnavailableReason {
  readonly code: ChatActionUnavailableReasonCode;
  readonly message: string;
}

export interface ChatActionSurface {
  readonly id: string;
  readonly channel: string;
  readonly instanceId: string;
  readonly platformChatId: string;
  readonly chatType?: string;
  readonly threadLifecycleStatus?: string;
  readonly credentialConfigured?: boolean;
  readonly ownMessageCount?: number;
  readonly ownTextMessageCount?: number;
  readonly eligibleStickerCount?: number;
}

export interface ChatActionAvailability {
  readonly actionId: ChatActionId;
  readonly surfaceId: string;
  readonly status: ChatActionStatus;
  readonly executionMode?: ChatActionExecutionMode;
  readonly requiredScopes?: readonly string[];
  readonly scopeVerification?: "not_required" | "deferred";
  readonly unavailableReason?: ChatActionUnavailableReason;
}

export interface ChatActionDescriptor {
  readonly id: ChatActionId;
  readonly targetKind: "chat" | "message" | "thread";
  readonly description: string;
}

export type ChannelChatActionContent =
  | {
      readonly type: "chat_action";
      readonly actionId: "message.delete";
      readonly canonicalMessageId?: string;
      readonly providerMessageId: string;
    }
  | {
      readonly type: "chat_action";
      readonly actionId: "message.edit";
      readonly canonicalMessageId?: string;
      readonly providerMessageId: string;
      readonly text: string;
    }
  | {
      readonly type: "chat_action";
      readonly actionId: "message.react";
      readonly canonicalMessageId?: string;
      readonly providerMessageId: string;
      readonly emoji: string;
      readonly operation?: "add" | "remove";
    }
  | {
      readonly type: "chat_action";
      readonly actionId: "thread.create";
      readonly text: string;
    };

export interface ChatActionRequest {
  readonly requestId: string;
  readonly surface: ChatActionSurface;
  readonly content: ChannelChatActionContent;
}

export type ChatActionResult =
  | {
      readonly status: "queued";
      readonly requestId: string;
      readonly idempotencyKey: string;
    }
  | {
      readonly status: "succeeded";
      readonly requestId: string;
      readonly provider: string;
      readonly providerMessageId?: string;
    }
  | {
      readonly status: "unavailable";
      readonly requestId: string;
      readonly reason: ChatActionUnavailableReason;
    };

export const CHAT_ACTION_DESCRIPTORS: readonly ChatActionDescriptor[] = [
  {
    id: "message.delete",
    targetKind: "message",
    description: "Delete one of the session's own channel messages.",
  },
  {
    id: "message.edit",
    targetKind: "message",
    description: "Edit one of the session's own text channel messages.",
  },
  {
    id: "message.react",
    targetKind: "message",
    description: "React to a channel message.",
  },
  {
    id: "sticker.send",
    targetKind: "chat",
    description: "Send an eligible sticker.",
  },
  {
    id: "media.send",
    targetKind: "chat",
    description: "Send a local image, video, audio, or document.",
  },
  {
    id: "message.reply",
    targetKind: "message",
    description: "Send a native quoted reply.",
  },
  {
    id: "thread.create",
    targetKind: "thread",
    description: "Create a new Slack thread and start a child session in it.",
  },
  {
    id: "thread.close",
    targetKind: "thread",
    description: "Close the current Slack thread session, optionally returning a result to its parent.",
  },
];

const SLACK_SCOPE_BY_ACTION: Partial<Record<ChatActionId, readonly string[]>> = {
  "message.delete": ["chat:write"],
  "message.edit": ["chat:write"],
  "message.react": ["reactions:write"],
  "media.send": ["files:write"],
  "thread.create": ["chat:write"],
};

export function resolveChatActionAvailability(
  surface: ChatActionSurface,
  actionId: ChatActionId,
): ChatActionAvailability {
  const channel = canonicalChannelId(surface.channel);

  if (actionId === "message.reply") {
    return {
      actionId,
      surfaceId: surface.id,
      status: "planned",
    };
  }

  if ((actionId === "thread.create" || actionId === "thread.close") && channel !== "slack") {
    return unavailable(surface, actionId, "unsupported_channel", `${actionId} is currently supported only on Slack.`);
  }

  if (channel === "slack") {
    return resolveSlackAvailability(surface, actionId);
  }

  if (channel === "whatsapp") {
    return resolveWhatsAppAvailability(surface, actionId);
  }

  if (channel === "matrix") {
    if (actionId === "message.react") return available(surface, actionId, "legacy");
    if (actionId === "media.send") return available(surface, actionId, "legacy");
    return unavailable(surface, actionId, "unsupported_channel", `${actionId} is not supported on Matrix.`);
  }

  return unavailable(
    surface,
    actionId,
    "unsupported_channel",
    `${actionId} is not supported on channel ${surface.channel || "unknown"}.`,
  );
}

export function unavailableChatActionWithoutSurface(actionId: ChatActionId): ChatActionAvailability {
  return {
    actionId,
    surfaceId: "",
    status: actionId === "message.reply" ? "planned" : "unavailable",
    ...(actionId === "message.reply"
      ? {}
      : {
          unavailableReason: {
            code: "no_surface" as const,
            message: "No current, attached, or recent chat surface was found for this session.",
          },
        }),
  };
}

function resolveSlackAvailability(surface: ChatActionSurface, actionId: ChatActionId): ChatActionAvailability {
  if (actionId === "sticker.send") {
    return unavailable(surface, actionId, "unsupported_channel", "Slack does not support Ravi stickers.");
  }

  if (actionId === "thread.close") {
    if (surface.chatType !== "thread") {
      return unavailable(
        surface,
        actionId,
        "invalid_target",
        "thread.close is available only inside a Slack thread session.",
      );
    }
    if (surface.threadLifecycleStatus === "closed") {
      return unavailable(surface, actionId, "invalid_target", "This Slack thread session is already closed.");
    }
    return available(surface, actionId, "internal");
  }

  if (surface.credentialConfigured !== true) {
    return unavailable(
      surface,
      actionId,
      "missing_connection",
      "The Slack channel has no enabled brokered credential connection.",
      SLACK_SCOPE_BY_ACTION[actionId],
    );
  }

  if (actionId === "message.delete" && (surface.ownMessageCount ?? 0) === 0) {
    return unavailable(
      surface,
      actionId,
      "no_eligible_resource",
      "No own outbound message from this session is available on this Slack surface.",
      SLACK_SCOPE_BY_ACTION[actionId],
    );
  }

  if (actionId === "message.edit" && (surface.ownTextMessageCount ?? 0) === 0) {
    return unavailable(
      surface,
      actionId,
      "no_eligible_resource",
      "No own outbound text message from this session is available on this Slack surface.",
      SLACK_SCOPE_BY_ACTION[actionId],
    );
  }

  return available(
    surface,
    actionId,
    actionId === "media.send" ? "provider_confirmed" : "durable",
    SLACK_SCOPE_BY_ACTION[actionId],
  );
}

function resolveWhatsAppAvailability(surface: ChatActionSurface, actionId: ChatActionId): ChatActionAvailability {
  if (actionId === "message.delete" && (surface.ownMessageCount ?? 0) === 0) {
    return unavailable(
      surface,
      actionId,
      "no_eligible_resource",
      "No own outbound message from this session is available on this WhatsApp surface.",
    );
  }
  if (actionId === "message.edit" && (surface.ownTextMessageCount ?? 0) === 0) {
    return unavailable(
      surface,
      actionId,
      "no_eligible_resource",
      "No own outbound text message from this session is available on this WhatsApp surface.",
    );
  }
  if (actionId === "sticker.send" && (surface.eligibleStickerCount ?? 0) === 0) {
    return unavailable(
      surface,
      actionId,
      "no_eligible_resource",
      "No enabled sticker is eligible for this agent and WhatsApp surface.",
    );
  }
  return available(surface, actionId, "legacy");
}

function available(
  surface: ChatActionSurface,
  actionId: ChatActionId,
  executionMode: ChatActionExecutionMode,
  requiredScopes?: readonly string[],
): ChatActionAvailability {
  return {
    actionId,
    surfaceId: surface.id,
    status: "available",
    executionMode,
    ...(requiredScopes?.length
      ? {
          requiredScopes,
          scopeVerification: "deferred" as const,
        }
      : { scopeVerification: "not_required" as const }),
  };
}

function unavailable(
  surface: ChatActionSurface,
  actionId: ChatActionId,
  code: ChatActionUnavailableReasonCode,
  message: string,
  requiredScopes?: readonly string[],
): ChatActionAvailability {
  return {
    actionId,
    surfaceId: surface.id,
    status: "unavailable",
    ...(requiredScopes?.length
      ? {
          requiredScopes,
          scopeVerification: "deferred" as const,
        }
      : { scopeVerification: "not_required" as const }),
    unavailableReason: { code, message },
  };
}
