// Google Meet is the only platform for now. A meeting is addressed by its
// code (abc-defg-hij); query strings such as ?authuser are dropped because the
// bot joins as itself.

const MEET_HOST = "meet.google.com";
const MEET_CODE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

export const MEETING_PLATFORM_GOOGLE_MEET = "google_meet";

export type ParsedMeetingUrl = {
  platform: typeof MEETING_PLATFORM_GOOGLE_MEET;
  code: string;
  url: string;
};

export function parseGoogleMeetUrl(input: string): ParsedMeetingUrl | null {
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > 2048) return null;

  const bare = trimmed.toLowerCase();
  if (MEET_CODE.test(bare)) return meet(bare);

  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.hostname.toLowerCase() !== MEET_HOST || url.username || url.password || url.port) return null;
  const code = url.pathname.replace(/^\/+|\/+$/g, "").toLowerCase();
  return MEET_CODE.test(code) ? meet(code) : null;
}

function meet(code: string): ParsedMeetingUrl {
  return { platform: MEETING_PLATFORM_GOOGLE_MEET, code, url: `https://${MEET_HOST}/${code}` };
}
