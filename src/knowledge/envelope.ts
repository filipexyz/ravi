// Splits a stored inbound chat message (chat.db `messages.content`) into what
// the sender typed and what they only quoted or sent as audio. The formats are
// the ones the Omni consumer writes (`formatEnvelope`, `formatContent` in
// src/omni/consumer.ts):
//
//   [WhatsApp +5511… Name mid:… 16/10/2026, 14:32 fri] text
//   [WhatsApp Group id:…@g.us mid:… 16/10/2026, 14:32 fri] Name: text
//   [WhatsApp +5511… mid:… …]\n[Replying to X mid:…]\n<quoted>\n[/Replying]\n<text>
//   [Audio]\nTranscript:\n<transcript>\nfile: <path>
//
// A first `[session surface] …` line (the runtime's surface hint) is set apart.

export interface ParsedInboundContent {
  /** The `[session surface] …` first line. */
  surfaceHint: string | null;
  /** The `[<Channel> … dd/mm/yyyy hh:mm dow]` header. */
  header: string | null;
  senderName: string | null;
  /** What the sender typed: header, reply block, audio, transcript and file lines removed. */
  authoredText: string;
  /** `[Replying to …]` bodies. */
  quoted: string[];
  /** `Transcript:` blocks. */
  transcripts: string[];
  /** authoredText plus transcripts, for the index. */
  searchText: string;
}

const SURFACE_HINT = /^\[session surfaces?\][^\n]*(?:\n|$)/i;
const HEADER = /^\[([^\]\n]+?) (\d{2}\/\d{2}\/\d{4},? \d{1,2}:\d{2}(?::\d{2})?) ([A-Za-z]{2,4})\]/;
const GROUP_SENDER = /^ ([^\n:]{1,200}):(?=[ \n]|$)/;
const REPLY_OPEN = /^\n?\[Replying to [^\]\n]*\]\n/;
const REPLY_CLOSE = "\n[/Replying]";
const MEDIA_LABEL =
  /^\[(?:Audio|Voice|Image|Video|Document|Sticker|Gif|Location|Contact|Message edited)(?::[^\]\n]*)?\]$/i;
const FILE_LINE = /^file: .*$/;
const HEADER_TAG = /^(?:mid|thread|id):/;

export function parseInboundContent(content: string): ParsedInboundContent {
  let rest = typeof content === "string" ? content.replace(/\r\n/g, "\n") : "";

  let surfaceHint: string | null = null;
  const surface = rest.match(SURFACE_HINT);
  if (surface) {
    surfaceHint = surface[0].replace(/\n$/, "");
    rest = rest.slice(surface[0].length);
  }

  let header: string | null = null;
  let senderName: string | null = null;
  const headerMatch = rest.match(HEADER);
  if (headerMatch) {
    header = headerMatch[0];
    const inner = headerMatch[1] ?? "";
    rest = rest.slice(headerMatch[0].length);
    const tokens = inner.split(" ").filter(Boolean);
    const isGroup = tokens.some((token) => token.startsWith("id:"));
    if (isGroup) {
      const sender = rest.match(GROUP_SENDER);
      if (sender) {
        senderName = sender[1]?.trim() || null;
        rest = rest.slice(sender[0].length);
      }
    } else {
      senderName = dmSenderName(tokens);
    }
  }

  const quoted: string[] = [];
  const replyOpen = rest.match(REPLY_OPEN);
  if (replyOpen) {
    const body = rest.slice(replyOpen[0].length);
    // The quoted text is copied verbatim and may itself contain the closing
    // marker: the block ends at the last one.
    const close = lastCloseIndex(body);
    if (close >= 0) {
      quoted.push(body.slice(0, close));
      rest = body.slice(close + REPLY_CLOSE.length).replace(/^\n/, "");
    } else {
      quoted.push(body);
      rest = "";
    }
  } else {
    rest = rest.replace(/^ /, "");
  }

  const { authored, transcripts } = splitTranscripts(rest);
  const authoredText = authored.trim();
  const searchText = [authoredText, ...transcripts].filter(Boolean).join("\n").trim();
  return { surfaceHint, header, senderName, authoredText, quoted, transcripts, searchText };
}

/** `+<phone> [Name…] [mid:…] [thread:…]`: the name, or null when only the phone is shown. */
function dmSenderName(tokens: string[]): string | null {
  // tokens[0] is the channel name.
  const rest = tokens.slice(1);
  if (rest.length === 0) return null;
  const start = rest[0]?.startsWith("+") ? 1 : 0;
  const nameTokens: string[] = [];
  for (const token of rest.slice(start)) {
    if (HEADER_TAG.test(token)) break;
    nameTokens.push(token);
  }
  const name = nameTokens.join(" ").trim();
  if (name) return name;
  return start === 1 ? (rest[0] ?? null) : null;
}

function lastCloseIndex(body: string): number {
  let index = body.lastIndexOf(REPLY_CLOSE);
  while (index >= 0) {
    const after = body[index + REPLY_CLOSE.length];
    if (after === undefined || after === "\n") return index;
    index = body.lastIndexOf(REPLY_CLOSE, index - 1);
  }
  return -1;
}

/** Removes media labels, `Transcript:` blocks and `file:` lines; returns the transcripts apart. */
function splitTranscripts(text: string): { authored: string; transcripts: string[] } {
  const lines = text.split("\n");
  const kept: string[] = [];
  const transcripts: string[] = [];
  let transcript: string[] | null = null;
  for (const line of lines) {
    if (transcript !== null) {
      if (FILE_LINE.test(line)) {
        transcripts.push(transcript.join("\n").trim());
        transcript = null;
        continue;
      }
      transcript.push(line);
      continue;
    }
    const trimmed = line.trim();
    if (trimmed === "Transcript:") {
      transcript = [];
      continue;
    }
    if (MEDIA_LABEL.test(trimmed) || FILE_LINE.test(trimmed)) continue;
    kept.push(line);
  }
  if (transcript !== null) transcripts.push(transcript.join("\n").trim());
  return { authored: kept.join("\n"), transcripts: transcripts.filter(Boolean) };
}
