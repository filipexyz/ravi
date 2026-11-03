// Turns Recall's download files into Ravi's meeting recording shape. Emails
// and vendor-internal fields stay out: the OSS gets names, timings and text.

export type MeetingTranscriptSegment = {
  speaker: string | null;
  speakerId: string | null;
  isHost: boolean | null;
  startSeconds: number | null;
  endSeconds: number | null;
  startedAt: string | null;
  text: string;
};

export type MeetingParticipant = {
  id: string;
  name: string | null;
  isHost: boolean | null;
};

export type MeetingChatMessage = {
  sender: string | null;
  senderId: string | null;
  atSeconds: number | null;
  sentAt: string | null;
  to: string | null;
  text: string;
};

type RecallParticipant = { id?: unknown; name?: unknown; is_host?: unknown };
type RecallTimestamp = { relative?: unknown; absolute?: unknown } | null | undefined;

export function normalizeRecallTranscript(raw: unknown): MeetingTranscriptSegment[] {
  if (!Array.isArray(raw)) return [];
  const segments: MeetingTranscriptSegment[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const { participant, words } = entry as { participant?: RecallParticipant; words?: unknown };
    if (!Array.isArray(words) || words.length === 0) continue;
    const parts = words
      .map((word) => (word && typeof word === "object" ? (word as { text?: unknown }).text : null))
      .filter((text): text is string => typeof text === "string" && text.trim().length > 0);
    const text = parts.join(" ").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const first = words[0] as { start_timestamp?: RecallTimestamp };
    const last = words[words.length - 1] as { end_timestamp?: RecallTimestamp };
    segments.push({
      speaker: stringOrNull(participant?.name),
      speakerId: idOrNull(participant?.id),
      isHost: typeof participant?.is_host === "boolean" ? participant.is_host : null,
      startSeconds: seconds(first?.start_timestamp?.relative),
      endSeconds: seconds(last?.end_timestamp?.relative),
      startedAt: isoOrNull(first?.start_timestamp?.absolute),
      text,
    });
  }
  return segments;
}

export function normalizeRecallParticipants(raw: unknown): MeetingParticipant[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Map<string, MeetingParticipant>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const participant = entry as RecallParticipant;
    const id = idOrNull(participant.id);
    if (!id || seen.has(id)) continue;
    seen.set(id, {
      id,
      name: stringOrNull(participant.name),
      isHost: typeof participant.is_host === "boolean" ? participant.is_host : null,
    });
  }
  return [...seen.values()];
}

export function normalizeRecallChatMessages(raw: unknown): MeetingChatMessage[] {
  if (!Array.isArray(raw)) return [];
  const messages: MeetingChatMessage[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const event = entry as {
      action?: unknown;
      participant?: RecallParticipant;
      timestamp?: RecallTimestamp;
      data?: { text?: unknown; to?: unknown } | null;
    };
    if (event.action !== "chat_message" || typeof event.data?.text !== "string") continue;
    messages.push({
      sender: stringOrNull(event.participant?.name),
      senderId: idOrNull(event.participant?.id),
      atSeconds: seconds(event.timestamp?.relative),
      sentAt: isoOrNull(event.timestamp?.absolute),
      to: stringOrNull(event.data.to),
      text: event.data.text,
    });
  }
  return messages;
}

function stringOrNull(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function idOrNull(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return stringOrNull(value);
}

function seconds(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value * 1000) / 1000 : null;
}

function isoOrNull(value: unknown) {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
