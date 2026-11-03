// One timeline for a recorded call: what was said, grouped into turns by
// speaker, with the meeting chat placed at the moment it was sent. Every time
// here is in seconds from the start of the first recording part, so the
// player, the conversation map and the transcript all agree on one clock.

import { formatClock } from "./format";
import type { Meeting, MeetingRecording, StoredTranscript } from "./types";

/** Speakers get one of these color slots, in order of how much they talked. */
export const SPEAKER_TONE_COUNT = 6;

export type Speaker = {
  key: string;
  name: string;
  isHost: boolean;
  /** Color slot, or null for people who never spoke. */
  tone: number | null;
  talkSeconds: number;
  /** Share of everything said in the call, 0 to 1. */
  share: number;
  lineCount: number;
  chatCount: number;
};

export type Line = { id: string; start: number | null; end: number | null; text: string };

export type TurnItem = {
  kind: "turn";
  id: string;
  speaker: string;
  start: number | null;
  end: number | null;
  lines: Line[];
};

export type ChatItem = {
  kind: "chat";
  id: string;
  speaker: string;
  at: number | null;
  text: string;
  /** False when the message went to one person rather than the whole call. */
  toEveryone: boolean;
};

export type ConversationItem = TurnItem | ChatItem;

export type TimedLine = Line & { speaker: string; turnId: string };

export type RecordingPart = {
  index: number;
  /** Where the part starts on the call's clock. */
  offset: number;
  duration: number | null;
};

export type Conversation = {
  speakers: Speaker[];
  speakerByKey: Map<string, Speaker>;
  items: ConversationItem[];
  /** Every line in time order, for finding what is being said at a moment. */
  lines: TimedLine[];
  parts: RecordingPart[];
  /** False when a recording in several parts can't be placed on one clock. */
  seekable: boolean;
  /** The best known length of the call, in seconds. */
  duration: number;
};

const UNKNOWN_SPEAKER = "Unknown speaker";

export function buildConversation(data: MeetingRecording): Conversation {
  // The API lists the transcript and the chat part by part, each part's times starting again from zero.
  const partCount = Math.max(1, data.recordings.length);
  const lengths = data.recordings.map((recording) => recordingLength(recording.startedAt, recording.completedAt));
  const segmentParts = partsByOrder(
    data.transcript.segments.map((segment) => segment.startSeconds),
    partCount,
    lengths,
  );
  const chatParts = partsByOrder(
    data.chat.map((message) => message.atSeconds),
    partCount,
    lengths,
  );
  const partEnds: number[] = [];
  const reach = (part: number, time: number | null) => {
    if (time !== null) partEnds[part] = Math.max(partEnds[part] ?? 0, time);
  };
  data.transcript.segments.forEach((segment, index) => reach(segmentParts[index]!, segment.endSeconds ?? segment.startSeconds));
  data.chat.forEach((message, index) => reach(chatParts[index]!, message.atSeconds));
  const clock = callClock(data.recordings, partEnds);

  // Speakers come from the participant list first, then from whoever spoke or wrote.
  const people = new Map<string, { key: string; name: string; isHost: boolean }>();
  const person = (id: string | null, name: string | null, isHost: boolean | null) => {
    const key = speakerKey(id, name);
    const known = people.get(key);
    if (!known) people.set(key, { key, name: name ?? UNKNOWN_SPEAKER, isHost: isHost === true });
    else {
      if (known.name === UNKNOWN_SPEAKER && name) known.name = name;
      if (isHost === true) known.isHost = true;
    }
    return key;
  };
  for (const participant of data.participants) person(participant.id, participant.name, participant.isHost);

  type Entry =
    | { kind: "line"; order: number; at: number | null; speaker: string; line: Line }
    | { kind: "chat"; order: number; at: number | null; item: ChatItem };
  const entries: Entry[] = [];
  data.transcript.segments.forEach((segment, index) => {
    const text = segment.text.trim();
    if (!text) return;
    const speaker = person(segment.speakerId, segment.speaker, segment.isHost);
    const start = clock.at(segment.startSeconds, segment.startedAt, segmentParts[index]!);
    const length =
      segment.startSeconds !== null && segment.endSeconds !== null ? Math.max(0, segment.endSeconds - segment.startSeconds) : null;
    entries.push({
      kind: "line",
      order: index,
      at: start,
      speaker,
      line: { id: `l${index}`, start, end: start !== null && length !== null ? start + length : null, text },
    });
  });
  data.chat.forEach((message, index) => {
    const text = message.text.trim();
    if (!text) return;
    const speaker = person(message.senderId, message.sender, null);
    const at = clock.at(message.atSeconds, message.sentAt, chatParts[index]!);
    entries.push({
      kind: "chat",
      order: data.transcript.segments.length + index,
      at,
      item: { kind: "chat", id: `c${index}`, speaker, at, text, toEveryone: !message.to || message.to === "everyone" },
    });
  });

  // Time order; entries without a time stay where they came, after what precedes them.
  let carried = -Infinity;
  const keyed = entries.map((entry) => {
    if (entry.at !== null) carried = Math.max(carried, entry.at);
    return { entry, key: entry.at ?? carried };
  });
  keyed.sort((a, b) => a.key - b.key || a.entry.order - b.entry.order);

  // Consecutive lines from one speaker read as one turn; a chat message between them splits it.
  const items: ConversationItem[] = [];
  const lines: TimedLine[] = [];
  for (const { entry } of keyed) {
    if (entry.kind === "chat") {
      items.push(entry.item);
      continue;
    }
    const last = items.at(-1);
    let turn: TurnItem;
    if (last && last.kind === "turn" && last.speaker === entry.speaker) {
      turn = last;
      turn.lines.push(entry.line);
      if (entry.line.end !== null) turn.end = Math.max(turn.end ?? entry.line.end, entry.line.end);
      if (turn.start === null) turn.start = entry.line.start;
    } else {
      turn = { kind: "turn", id: `t${items.length}`, speaker: entry.speaker, start: entry.line.start, end: entry.line.end, lines: [entry.line] };
      items.push(turn);
    }
    lines.push({ ...entry.line, speaker: entry.speaker, turnId: turn.id });
  }

  const talk = new Map<string, { seconds: number; lines: number; chats: number }>();
  const tally = (key: string) => {
    let value = talk.get(key);
    if (!value) talk.set(key, (value = { seconds: 0, lines: 0, chats: 0 }));
    return value;
  };
  for (const line of lines) {
    const value = tally(line.speaker);
    value.lines += 1;
    if (line.start !== null && line.end !== null) value.seconds += line.end - line.start;
  }
  for (const item of items) if (item.kind === "chat") tally(item.speaker).chats += 1;
  const totalTalk = [...talk.values()].reduce((sum, value) => sum + value.seconds, 0);

  const speakers: Speaker[] = [...people.values()]
    .map((entry) => {
      const value = talk.get(entry.key) ?? { seconds: 0, lines: 0, chats: 0 };
      return {
        ...entry,
        tone: null,
        talkSeconds: value.seconds,
        share: totalTalk > 0 ? value.seconds / totalTalk : 0,
        lineCount: value.lines,
        chatCount: value.chats,
      } satisfies Speaker;
    })
    .sort((a, b) => b.talkSeconds - a.talkSeconds || b.lineCount - a.lineCount || b.chatCount - a.chatCount || a.name.localeCompare(b.name));
  let tone = 0;
  for (const speaker of speakers) if (speaker.lineCount > 0) speaker.tone = tone++ % SPEAKER_TONE_COUNT;

  const lastPart = clock.parts.at(-1);
  const duration = Math.max(
    0,
    lastPart && lastPart.duration !== null ? lastPart.offset + lastPart.duration : 0,
    ...lines.map((line) => line.end ?? line.start ?? 0),
    ...items.map((item) => (item.kind === "chat" ? (item.at ?? 0) : 0)),
    clock.parts.length <= 1 ? (data.meeting.recordingSeconds ?? 0) : 0,
  );

  return {
    speakers,
    speakerByKey: new Map(speakers.map((speaker) => [speaker.key, speaker])),
    items,
    lines,
    parts: clock.parts,
    seekable: clock.seekable,
    duration,
  };
}

function speakerKey(id: string | null, name: string | null) {
  if (id) return `id:${id}`;
  if (name) return `name:${name}`;
  return "unknown";
}

/**
 * The part each time belongs to, in API order: a time well before the one
 * before it, or past the end of the current part when its length is known,
 * starts the next part.
 */
function partsByOrder(times: Array<number | null>, partCount: number, lengths: Array<number | null>) {
  let part = 0;
  let previous = -Infinity;
  return times.map((time) => {
    if (time !== null) {
      const length = lengths[part];
      const past = length !== null && length !== undefined && time > length + 1;
      if ((time < previous - 1 || past) && part < partCount - 1) part += 1;
      previous = time;
    }
    return part;
  });
}

/**
 * The call's clock. One part: times are the part's own. Several parts: each
 * transcript time is relative to its own part, so the absolute time places it
 * on one clock that starts with the first part, and each part sits at its
 * start. A time without an absolute one, or parts without start times, can
 * only be placed by the part it came in (parts then run end to end), which is
 * close but not exact, so nothing seeks from the conversation then.
 */
function callClock(recordings: MeetingRecording["recordings"], partEnds: number[]) {
  const seconds = recordingLength;
  if (recordings.length <= 1) {
    const only = recordings[0];
    return {
      parts: [{ index: 0, offset: 0, duration: only ? seconds(only.startedAt, only.completedAt) : null }] as RecordingPart[],
      seekable: true,
      at: (relative: number | null) => relative,
    };
  }
  const starts = recordings.map((recording) => (recording.startedAt ? Date.parse(recording.startedAt) : NaN));
  const first = starts[0]!;
  const started = starts.every(Number.isFinite);
  let end = 0;
  const parts: RecordingPart[] = recordings.map((recording, index) => {
    const duration = seconds(recording.startedAt, recording.completedAt);
    const offset = started ? (starts[index]! - first) / 1000 : end;
    end = offset + (duration ?? partEnds[index] ?? 0);
    return { index, offset, duration };
  });
  let placed = started;
  return {
    parts,
    get seekable() {
      return placed;
    },
    at: (relative: number | null, absolute: string | null, part: number) => {
      const time = started && absolute ? Date.parse(absolute) : NaN;
      if (Number.isFinite(time)) return Math.max(0, (time - first) / 1000);
      if (relative === null) return null;
      placed = false;
      return (parts[part]?.offset ?? 0) + relative;
    },
  };
}

/** A part's length from when it started and finished, when both are known. */
function recordingLength(from: string | null, to: string | null) {
  const a = from ? Date.parse(from) : NaN;
  const b = to ? Date.parse(to) : NaN;
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? (b - a) / 1000 : null;
}

/** Which part plays a moment of the call, and where inside that part. */
export function locate(parts: RecordingPart[], time: number) {
  let part = parts[0] ?? { index: 0, offset: 0, duration: null };
  for (const candidate of parts) if (candidate.offset <= time) part = candidate;
  return { part: part.index, local: Math.max(0, time - part.offset) };
}

// The lines that have a start, per conversation, so finding the line at a moment stays a binary search.
const timedLines = new WeakMap<TimedLine[], TimedLine[]>();

/** The line being said at `time`: the last one that started by then. */
export function lineAt(lines: TimedLine[], time: number) {
  let timed = timedLines.get(lines);
  if (!timed) {
    timed = lines.filter((line) => line.start !== null);
    timedLines.set(lines, timed);
  }
  let low = 0;
  let high = timed.length - 1;
  let found: TimedLine | null = null;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (timed[middle]!.start! <= time + 0.05) {
      found = timed[middle]!;
      low = middle + 1;
    } else high = middle - 1;
  }
  return found;
}

/** The item at or right before `time`, to scroll the conversation there. */
export function itemAt(items: ConversationItem[], time: number) {
  let found: ConversationItem | null = items[0] ?? null;
  for (const item of items) {
    const start = item.kind === "turn" ? item.start : item.at;
    if (start === null) continue;
    if (start > time + 0.05) break;
    found = item;
  }
  return found;
}

/** What to bring into view for a moment: the turn being said then, else the last thing before it. */
export function itemForMoment(lines: TimedLine[], items: ConversationItem[], time: number) {
  const line = lineAt(lines, time);
  if (line && line.end !== null && time <= line.end + 1) {
    const turn = items.find((item) => item.id === line.turnId);
    if (turn) return turn;
  }
  return itemAt(items, time);
}

// Search ignores case and accents, so "transcricao" finds "transcrição".

/**
 * Text folded for search, with the index in the original of each folded UTF-16
 * unit (and one more for the end), so a match in the folded text maps back.
 */
export function foldForSearch(text: string) {
  let folded = "";
  const map: number[] = [];
  let index = 0;
  // One character as a reader sees it at a time, so letters written in pieces (Hangul jamo) recompose whole.
  for (const char of graphemes(text)) {
    const plain = char.normalize("NFD").replace(/\p{M}/gu, "").normalize("NFC").toLowerCase();
    folded += plain;
    for (let unit = 0; unit < plain.length; unit++) map.push(index);
    index += char.length;
  }
  map.push(index);
  return { folded, map };
}

const segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

function graphemes(text: string): Iterable<string> {
  return segmenter ? Array.from(segmenter.segment(text), (piece) => piece.segment) : text;
}

export type SearchMatch = {
  /** Running number, the order the matches are stepped through. */
  index: number;
  itemId: string;
  /** When it was said: the start of the first line it touches, or the chat message's time. */
  time: number | null;
  /** The matched text in the original, per line it touches (one piece with lineId null for a chat message). */
  pieces: Array<{ lineId: string | null; from: number; to: number }>;
};

/** Two letters at least, or one Chinese, Japanese or Korean character, which is often a whole word. */
export function isSearchable(query: string) {
  const needle = foldForSearch(query.trim()).folded;
  return needle.length >= 2 || /^[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(needle);
}

export function searchConversation(items: ConversationItem[], query: string): SearchMatch[] {
  if (!isSearchable(query)) return [];
  const needle = foldForSearch(query.trim()).folded;
  const matches: SearchMatch[] = [];
  // A turn's lines are searched as one text, joined by spaces as they read, so a phrase can run across lines.
  const scan = (itemId: string, parts: Array<{ lineId: string | null; text: string; time: number | null }>) => {
    let text = "";
    const starts = parts.map((part, index) => {
      if (index) text += " ";
      const start = text.length;
      text += part.text;
      return start;
    });
    const { folded, map } = foldForSearch(text);
    let at = folded.indexOf(needle);
    while (at !== -1) {
      const from = map[at]!;
      const to = map[at + needle.length]!;
      const pieces: SearchMatch["pieces"] = [];
      let time: number | null = null;
      parts.forEach((part, index) => {
        const start = starts[index]!;
        const pieceFrom = Math.max(from, start);
        const pieceTo = Math.min(to, start + part.text.length);
        if (pieceFrom >= pieceTo) return;
        pieces.push({ lineId: part.lineId, from: pieceFrom - start, to: pieceTo - start });
        time ??= part.time;
      });
      if (pieces.length) matches.push({ index: matches.length, itemId, time, pieces });
      at = folded.indexOf(needle, at + needle.length);
    }
  };
  for (const item of items) {
    if (item.kind === "chat") scan(item.id, [{ lineId: null, text: item.text, time: item.at }]);
    else scan(item.id, item.lines.map((line) => ({ lineId: line.id, text: line.text, time: line.start })));
  }
  return matches;
}

/** Links in a chat message: http(s) addresses, without trailing punctuation or a closing bracket they don't open. */
export function findLinks(text: string) {
  const links: Array<{ from: number; to: number; href: string }> = [];
  const count = (value: string, char: string) => value.split(char).length - 1;
  for (const found of text.matchAll(/https?:\/\/[^\s<>"']+/g)) {
    let href = found[0];
    for (;;) {
      const last = href.at(-1);
      if (last && ".,;:!?".includes(last)) href = href.slice(0, -1);
      else if (last === ")" && count(href, "(") < count(href, ")")) href = href.slice(0, -1);
      else if (last === "]" && count(href, "[") < count(href, "]")) href = href.slice(0, -1);
      else break;
    }
    const from = found.index ?? 0;
    if (/^https?:\/\/[^/?#]+/.test(href)) links.push({ from, to: from + href.length, href });
  }
  return links;
}

export type TextRun = { text: string; match: number | null; href: string | null };

/** Splits text where search matches and links begin and end, so a match can sit inside a link and a link stays whole. */
export function textRuns(
  text: string,
  ranges: ReadonlyArray<{ from: number; to: number; index: number }>,
  links: ReadonlyArray<{ from: number; to: number; href: string }> = [],
) {
  const clamp = (value: number) => Math.min(text.length, Math.max(0, value));
  const cuts = new Set([0, text.length]);
  for (const range of ranges) {
    cuts.add(clamp(range.from));
    cuts.add(clamp(range.to));
  }
  for (const link of links) {
    cuts.add(link.from);
    cuts.add(link.to);
  }
  const sorted = [...cuts].sort((a, b) => a - b);
  const runs: TextRun[] = [];
  for (let at = 0; at < sorted.length - 1; at++) {
    const from = sorted[at]!;
    const to = sorted[at + 1]!;
    if (from === to) continue;
    runs.push({
      text: text.slice(from, to),
      match: ranges.find((range) => range.from <= from && range.to >= to)?.index ?? null,
      href: links.find((link) => link.from <= from && link.to >= to)?.href ?? null,
    });
  }
  return runs;
}

/** A `?t=` value: seconds ("95", "16.7"), a clock ("1:35", "105:30", "1:02:09") or "1m35s". */
export function parseMoment(value: string | null | undefined) {
  if (!value) return null;
  const text = value.trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text);
  const clock = /^(?:(\d+):(\d{1,2})|(\d+)):(\d{2})$/.exec(text);
  if (clock) return Number(clock[1] ?? 0) * 3600 + Number(clock[2] ?? clock[3]) * 60 + Number(clock[4]);
  const units = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(text);
  if (units && (units[1] || units[2] || units[3])) return Number(units[1] ?? 0) * 3600 + Number(units[2] ?? 0) * 60 + Number(units[3] ?? 0);
  return null;
}

/** The whole conversation as plain text, one turn or chat message per paragraph. */
export function conversationText(conversation: Conversation) {
  return conversation.items
    .map((item) => {
      const who = conversation.speakerByKey.get(item.speaker)?.name ?? UNKNOWN_SPEAKER;
      if (item.kind === "chat") {
        const at = formatClock(item.at);
        return `${at ? `[${at}] ` : ""}${who} (${item.toEveryone ? "chat" : "private message"}): ${item.text}`;
      }
      const at = formatClock(item.start);
      return `${at ? `[${at}] ` : ""}${who}: ${item.lines.map((line) => line.text).join(" ")}`;
    })
    .join("\n\n");
}

// When the recording's media and transcript are gone, the transcript Ravi kept
// (when the organization uses Knowledge) stands in for it.

export type ConversationSource = "recording" | "stored" | "none";

/**
 * Which transcript the meeting page shows: the recording's while it has one,
 * else the kept one, also when the recording itself no longer loads.
 */
/**
 * True when the recording has nothing to show, so the kept transcript is asked
 * for. A recording that already loaded is judged by its own data: a failed
 * background refresh keeps it on screen. Only a first load that fails counts
 * as empty.
 */
export function recordingNeedsStored(recording: { data: MeetingRecording | undefined; isError: boolean }): boolean {
  if (!recording.data) return recording.isError;
  return recording.data.transcript.status !== "processing" && !recording.data.transcript.segments.some((segment) => segment.text.trim());
}

/** The loading skeleton is shown only while nothing is on screen yet; a refresh never unmounts the player. */
export function recordingShowsSkeleton(input: {
  recording: { data: MeetingRecording | undefined; isPending: boolean };
  stored: { data: StoredTranscript | null | undefined; isPending: boolean };
  needsStored: boolean;
}): boolean {
  if (input.recording.data === undefined && input.recording.isPending) return true;
  return input.needsStored && input.stored.data === undefined && input.stored.isPending;
}

export function conversationSource(recording: MeetingRecording | null | undefined, stored: StoredTranscript | null | undefined): ConversationSource {
  const hasRecordingLines = Boolean(recording?.transcript.segments.some((segment) => segment.text.trim()));
  if (hasRecordingLines) return "recording";
  const hasStored = Boolean(stored?.segments.some((segment) => segment.text.trim()));
  // Still being made: the recording's own transcript is on its way.
  if (hasStored && recording?.transcript.status !== "processing") return "stored";
  return recording ? "recording" : "none";
}

/**
 * The kept transcript in the recording's shape, so the conversation, search and
 * `?t=` work the same. Times are already on the call's clock; there is no media,
 * chat or participant list.
 */
export function recordingFromStored(meeting: Meeting, stored: StoredTranscript): MeetingRecording {
  const segments = stored.segments.filter((segment) => segment.text.trim());
  return {
    meeting,
    transcript: {
      status: "done",
      segments: segments.map((segment, index) => {
        const next = segments.slice(index + 1).find((candidate) => candidate.t !== null)?.t ?? null;
        return {
          speaker: segment.speaker,
          speakerId: segment.speakerId,
          isHost: null,
          startSeconds: segment.t,
          endSeconds: segment.t !== null && next !== null && next >= segment.t ? next : segment.t,
          startedAt: null,
          text: segment.text,
        };
      }),
    },
    participants: [],
    chat: [],
    media: [],
    recordings: [],
  };
}

/**
 * What the conversation says when it has no lines, or null when it has some.
 * "Nobody spoke" only when the transcript was made and is empty: media that
 * expired is not silence.
 */
export function emptyTranscriptCopy(
  recording: MeetingRecording | null | undefined,
  stored: StoredTranscript | null | undefined,
): { tone: "info" | "warn"; text: string } | null {
  const source = conversationSource(recording, stored);
  if (source === "stored") return null;
  if (recording?.transcript.segments.some((segment) => segment.text.trim())) return null;
  switch (recording?.transcript.status) {
    case "processing":
      return { tone: "info", text: "The transcript is still being prepared. This page updates when it's ready." };
    case "failed":
      return { tone: "warn", text: "The transcript couldn't be made for this call. The recording is still available." };
    case "done":
      return { tone: "info", text: "Nobody spoke in this call." };
    default:
      return { tone: "info", text: "This call's recording and transcript are no longer available." };
  }
}
