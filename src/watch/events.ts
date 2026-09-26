import type { InboxNatsPayload } from "../inbox/types.js";
import { isPageCommentInboxEvent, pageCommentWatchSubject, type PageCommentEventType } from "./page-comment.js";
import type { EffectiveWatchPlacement, WatchNatsPayload } from "./types.js";

const PAGE_COMMENT_IDENTITY_KEYS = ["pageId", "siteId", "orgId", "organizationId", "projectId"] as const;

export function watchEventFromInboxPayload(
  inbox: InboxNatsPayload,
  origin: { inboxItemId?: number | string | null } = {},
): WatchNatsPayload | null {
  if (isPageCommentInboxEvent(inbox.eventType)) {
    return pageCommentWatchEvent(inbox, inbox.eventType, origin);
  }
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

function pageCommentWatchEvent(
  inbox: InboxNatsPayload,
  eventType: PageCommentEventType,
  origin: { inboxItemId?: number | string | null },
): WatchNatsPayload {
  const payload = normalizePageCommentPayload(objectValue(inbox.payload));
  const source = objectValue(inbox.source) ?? {};
  const sensitivity = normalizeSensitivity(inbox.sensitivity);
  const delivery = {
    ...objectValue(inbox.delivery),
    inboxEventId: inbox.eventId,
    ...(origin.inboxItemId !== undefined && origin.inboxItemId !== null ? { inboxItemId: origin.inboxItemId } : {}),
  };
  const identity = hoistIdentity(payload);

  return {
    version: 1,
    eventId: inbox.eventId,
    watchId: stringValue(payload.watchId) ?? inbox.dedupeKey ?? inbox.eventId,
    connector: "console",
    placement: "console",
    eventType,
    dedupeKey: inbox.dedupeKey,
    subject: pageCommentWatchSubject(eventType),
    source,
    payload,
    ...(Array.isArray(inbox.links) ? { links: inbox.links } : {}),
    ...(sensitivity ? { sensitivity } : {}),
    delivery,
    occurredAt: inbox.occurredAt,
    createdAt: inbox.createdAt,
    ...identity,
  };
}

function normalizePageCommentPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const next = { ...payload };
  if (typeof next.body === "string" && next.body.trim()) return next;
  const text = stringValue(next.text);
  const comment = objectValue(next.comment);
  const commentBody = stringValue(comment?.body) ?? stringValue(comment?.text);
  if (text) next.body = text;
  else if (commentBody) next.body = commentBody;
  return next;
}

function hoistIdentity(payload: Record<string, unknown>): Partial<WatchNatsPayload> {
  const identity: Partial<WatchNatsPayload> = {};
  for (const key of PAGE_COMMENT_IDENTITY_KEYS) {
    const value = stringValue(payload[key]);
    if (value) identity[key] = value;
  }
  return identity;
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
