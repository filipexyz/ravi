/**
 * Shared `media send` command-access metadata and snapshot evaluation.
 *
 * `sessions actions` advertises WhatsApp `media.send` from channel support
 * alone. Execution still goes through gateway `enforceCliCommandAuthorization`,
 * so advertisement must evaluate the same snapshot candidates without ALS
 * (`sessions` tests mock `../context.js` without `runWithContext`).
 *
 * Explicit `--account` / `--to` never grant authority. Group vs DM source is
 * not a permission input. A missing runtime context keeps channel availability
 * so discovery outside a turn snapshot stays unchanged.
 */

import { canWithCapabilities } from "../permissions/capability-snapshot.js";
import type { ContextCapability } from "../router/router-db.js";
import type { ChatActionAvailability } from "../channels/chat-actions.js";
import type { CommandAccessOptions } from "./decorators.js";

export const MEDIA_SEND_COMMAND_ACCESS: CommandAccessOptions = {
  kind: "mutate",
  resource: "media",
  action: "send",
  risk: "high",
  redactions: ["filePath", "to", "account", "threadId"],
  requiresConfirmation: true,
};

export const MEDIA_SEND_PERMISSION_DENIED_REASON = {
  code: "permission_denied" as const,
  message: "The current runtime context is not authorized to send media.",
};

/** Same candidate order as `commandAccessCandidates` for `media send`. */
const MEDIA_SEND_CAPABILITY_CANDIDATES = [
  { permission: "mutate", objectType: "media", objectId: "send" },
  { permission: "mutate", objectType: "media", objectId: "*" },
  { permission: "mutate", objectType: "media.send", objectId: "*" },
  { permission: "execute", objectType: "group", objectId: "media_send" },
  { permission: "execute", objectType: "group", objectId: "media" },
] as const;

export function capabilitiesAllowMediaSend(
  capabilities: readonly ContextCapability[] | null | undefined,
): boolean {
  if (!capabilities?.length) return false;
  const snapshot = capabilities as ContextCapability[];
  return MEDIA_SEND_CAPABILITY_CANDIDATES.some((candidate) =>
    canWithCapabilities(snapshot, candidate.permission, candidate.objectType, candidate.objectId),
  );
}

/**
 * `undefined` means no runtime snapshot is present — keep channel status.
 * An empty snapshot is a present context with no grants.
 */
export function resolveRuntimeMediaSendCapabilities(
  context: { capabilities?: readonly ContextCapability[] } | null | undefined,
): ContextCapability[] | undefined {
  if (!context) return undefined;
  return [...(context.capabilities ?? [])];
}

export function overlayMediaSendAvailability(
  availability: ChatActionAvailability,
  runtimeCapabilities: readonly ContextCapability[] | undefined,
): ChatActionAvailability {
  if (runtimeCapabilities === undefined) return availability;
  if (availability.status !== "available") return availability;
  if (capabilitiesAllowMediaSend(runtimeCapabilities)) return availability;
  return {
    actionId: availability.actionId,
    surfaceId: availability.surfaceId,
    status: "unavailable",
    ...(availability.requiredScopes?.length
      ? {
          requiredScopes: availability.requiredScopes,
          scopeVerification: availability.scopeVerification ?? "deferred",
        }
      : { scopeVerification: availability.scopeVerification ?? "not_required" }),
    unavailableReason: MEDIA_SEND_PERMISSION_DENIED_REASON,
  };
}
