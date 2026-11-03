import type { KnowledgeChunkRow } from "./retrieval-core";

// Links a Knowledge result back to where it came from: the meeting screen at
// the call clock, or the page section on its Ravi Pages host. Notes and
// manual sources have no link.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

export function knowledgeResultUrl(row: KnowledgeChunkRow, origin: string): string | null {
  const location = row.location;
  if (row.kind === "meeting") {
    const meetingId = typeof location.meetingId === "string" ? location.meetingId : null;
    if (!meetingId || !UUID.test(meetingId) || !row.projectId || !UUID.test(row.projectId)) return null;
    const base = `${origin.replace(/\/+$/, "")}/p/${row.projectId}/meetings/${meetingId}`;
    const seconds = callSeconds(location.startSeconds);
    return seconds === null ? base : `${base}?t=${seconds}`;
  }

  if (row.kind === "page") {
    const host = typeof location.host === "string" ? location.host.trim().toLowerCase() : "";
    const path = typeof location.path === "string" ? location.path : "";
    if (!HOST.test(host) || !path.startsWith("/") || path.startsWith("//")) return null;
    const anchor = typeof location.anchor === "string" && location.anchor.length > 0 ? location.anchor : null;
    try {
      const url = new URL(`https://${host}${path}`);
      if (url.host !== host) return null;
      return anchor ? `${url.toString()}#${anchorFragment(anchor)}` : url.toString();
    } catch {
      return null;
    }
  }

  return null;
}

/** Seconds on the call clock as `hh:mm:ss`; null when unknown. */
export function formatCallClock(seconds: number | null): string | null {
  if (seconds === null || typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return null;
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  return [hours, minutes, secs].map((part) => String(part).padStart(2, "0")).join(":");
}

/** A finite non-negative call clock, rounded to tenths; null otherwise. */
export function callSeconds(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 10) / 10;
}

// Heading ids pass through; a `:~:text=` directive is already URL-encoded by
// the page producer. Anything that would break out of the fragment is encoded.
function anchorFragment(anchor: string) {
  return anchor.replace(/[\s#"<>`]/g, (char) => encodeURIComponent(char));
}
