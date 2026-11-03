// Console -> Pages Worker room events. Best effort: the Console tables are the
// record and panels catch up with `messages/list` when they see a seq gap, so
// a failed post is logged and dropped, never retried.

import { getPagesResolveControlToken } from "@/server/console/pages/resolve";

import type { RoomEvent } from "./types";

export type RoomEventPublisher = (input: { host: string; roomId: string; events: RoomEvent[] }) => Promise<void>;

const PUBLISH_TIMEOUT_MS = 2_500;

export const publishRoomEvents: RoomEventPublisher = async ({ host, roomId, events }) => {
  if (events.length === 0) return;
  const token = getPagesResolveControlToken();
  if (!token) return;
  const base = process.env.RAVI_PAGES_CHAT_EVENTS_ORIGIN?.trim() || `https://${host}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUBLISH_TIMEOUT_MS);
  try {
    const response = await fetch(`${base}/_ravi/chat/internal/rooms/${encodeURIComponent(roomId)}/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-ravi-pages-host": host },
      body: JSON.stringify({ events }),
      signal: controller.signal,
    });
    if (!response.ok) console.warn("Page chat room events were not accepted", { roomId, status: response.status });
  } catch (error) {
    console.warn("Page chat room events could not be sent", { roomId, error: error instanceof Error ? error.name : "error" });
  } finally {
    clearTimeout(timer);
  }
};
