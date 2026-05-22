import type { InboxNatsPayload } from "../inbox/types.js";
import type { EffectiveWatchPlacement, WatchNatsPayload } from "./types.js";

export function watchEventFromInboxPayload(
  inbox: InboxNatsPayload,
  origin: { inboxItemId?: number | string | null } = {},
): WatchNatsPayload | null {
  if (!inbox.eventType.startsWith("watch.")) return null;

  const [, connector, ...rest] = inbox.eventType.split(".");
  if (!connector || rest.length === 0) return null;

  const eventType = rest.join(".");
  const payload = objectValue(inbox.payload);
  const watch = objectValue(payload.watch);
  const source = objectValue(inbox.source) ?? {};
  const watchId = stringValue(watch?.id) ?? stringValue(payload.watchId) ?? inbox.dedupeKey;
  const placement = normalizePlacement(stringValue(watch?.placement));
  const subject = `ravi.watch.${connector}.${eventType}`;
  const sensitivity = normalizeSensitivity(inbox.sensitivity);
  const delivery = {
    ...objectValue(inbox.delivery),
    inboxEventId: inbox.eventId,
    ...(origin.inboxItemId !== undefined && origin.inboxItemId !== null ? { inboxItemId: origin.inboxItemId } : {}),
  };

  return {
    version: 1,
    eventId: inbox.eventId,
    watchId,
    ...(stringValue(watch?.name) ? { watchName: stringValue(watch?.name)! } : {}),
    connector,
    placement,
    eventType,
    dedupeKey: inbox.dedupeKey,
    subject,
    source,
    payload,
    ...(Array.isArray(inbox.links) ? { links: inbox.links } : {}),
    ...(sensitivity ? { sensitivity } : {}),
    delivery,
    occurredAt: inbox.occurredAt,
    createdAt: inbox.createdAt,
  };
}

function normalizePlacement(value: string | null): EffectiveWatchPlacement {
  return value === "local" ? "local" : "console";
}

function normalizeSensitivity(value: string | null): "public" | "private" | "restricted" | null {
  if (value === "public" || value === "private" || value === "restricted") return value;
  return null;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
