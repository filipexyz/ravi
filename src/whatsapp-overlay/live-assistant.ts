import type { OverlayRuntimeMetadata } from "./model.js";

export type OverlayAssistantMessageIdsByKey = Record<string, string>;

const DEFAULT_OVERLAY_ASSISTANT_SLOT_KEY = "default";

export function resolveOverlayAssistantMessageSlotKey(metadata?: OverlayRuntimeMetadata | null): string {
  const item = asPlainRecord(metadata?.item);
  const itemId = cleanString(item?.id);
  if (itemId) {
    return `item:${itemId}`;
  }
  return DEFAULT_OVERLAY_ASSISTANT_SLOT_KEY;
}

export function ensureOverlayAssistantMessageId(
  activeIdsByKey: OverlayAssistantMessageIdsByKey,
  timestamp: number,
  metadata?: OverlayRuntimeMetadata | null,
): string {
  const slotKey = resolveOverlayAssistantMessageSlotKey(metadata);
  const existing = activeIdsByKey[slotKey];
  if (existing) {
    return existing;
  }

  const nextId =
    slotKey === DEFAULT_OVERLAY_ASSISTANT_SLOT_KEY
      ? `live:assistant:${timestamp}`
      : `live:assistant:${sanitizeOverlayAssistantSlotKey(slotKey)}`;
  activeIdsByKey[slotKey] = nextId;
  return nextId;
}

function sanitizeOverlayAssistantSlotKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9:_-]+/g, "_");
}

function asPlainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
