/**
 * The Block Kit card an agent posts as the root of a thread it opens
 * (`ravi sessions create-thread`).
 *
 * The thread's initial message is the child session's whole brief. Posted as
 * plain text it fills the channel, so the root is a Slack `card` block
 * instead: the first line as the title, the latest progress or result as the
 * subtitle, a short summary of the rest as the body, and a status line (status,
 * who asked, when) as the subtext. Slack rejecting `card` falls back to the
 * same content as classic blocks. When the summary leaves part of the brief
 * out, the full brief goes as the first reply inside the thread. Report, close and reopen re-render the
 * card in place (`chat.update`) with the new status and the latest progress or
 * result.
 *
 * Everything shown comes from text that passes the outbound Knowledge guard:
 * the brief (`text`) and the card note (`threadCard.note`), plus the name of
 * the person who asked (`requestedBy`), resolved from the turn's contact.
 */

import type { SlackBlockKitBlock } from "./block-kit.js";
import { markdownToSlackMrkdwn } from "./mrkdwn.js";
import { decodeLiteralLineBreaks } from "./thread-text.js";

export type SlackThreadCardStatus = "open" | "closed" | "reopened";

export interface SlackThreadCardState {
  readonly status: SlackThreadCardStatus;
  /** Latest progress (open, reopened) or the close result (closed). */
  readonly note?: string;
  /** When the card last changed, in ms; shown as Slack-localized time. */
  readonly updatedAt?: number;
  /** The person who asked for the thread, by name. */
  readonly requestedBy?: string;
  /** Requested runtime shape, e.g. `codex · gpt-5.4 · high`; shown only when the caller pinned one. */
  readonly runtime?: string;
}

export interface SlackThreadCardMessage {
  /** Notification and fallback text. */
  readonly text: string;
  /** One Slack `card` block: title, latest note, summary and the status line. */
  readonly blocks: readonly SlackBlockKitBlock[];
  /** The same content as classic blocks, for a workspace or client that rejects `card`. */
  readonly fallbackBlocks: readonly SlackBlockKitBlock[];
  /** The whole brief as Markdown, to post inside the thread when the card summary leaves part of it out. */
  readonly fullBrief?: string;
}

// Slack card block limits: title and subtitle 150, body and subtext 200.
const TITLE_MAX_LENGTH = 150;
const SUBTITLE_MAX_LENGTH = 150;
const BODY_MAX_LENGTH = 200;
const SUBTEXT_MAX_LENGTH = 200;

const STATUS_LABELS: Record<SlackThreadCardStatus, string> = {
  open: ":large_green_circle: *Em andamento*",
  closed: ":white_check_mark: *Concluída*",
  reopened: ":arrows_counterclockwise: *Reaberta*",
};

const NOTE_LABELS: Record<SlackThreadCardStatus, string> = {
  open: "Progresso",
  closed: "Resultado",
  reopened: "Progresso",
};

export function buildSlackThreadCard(rawBrief: string, state: SlackThreadCardState): SlackThreadCardMessage {
  // Threads opened before the CLI decoded shell-typed `\n` still store them literally.
  const brief = decodeLiteralLineBreaks(rawBrief);
  const { title, body } = splitSlackThreadBrief(brief);
  const summary = body ? fitMrkdwn(body, BODY_MAX_LENGTH) : undefined;
  const truncated = summary !== undefined && summary.cut;
  const note = state.note === undefined ? undefined : decodeLiteralLineBreaks(state.note).trim();
  const noteLabel = `*${NOTE_LABELS[state.status]}:* `;
  const noteText = note ? fitMrkdwn(note, SUBTITLE_MAX_LENGTH - noteLabel.length) : undefined;

  const status = [STATUS_LABELS[state.status]];
  const requestedBy = state.requestedBy?.trim();
  const runtime = state.runtime?.trim();
  if (runtime) status.push(`runtime ${escapeSlackText(runtime)}`);
  if (requestedBy) status.push(`pedido por ${escapeSlackText(requestedBy)}`);
  if (state.updatedAt !== undefined) status.push(slackLocalTime(state.updatedAt));
  if (truncated) status.push("instruções completas na thread");
  const statusLine = joinWithin(status, SUBTEXT_MAX_LENGTH);

  const card: SlackBlockKitBlock = {
    type: "card",
    block_id: "ravi_thread_card",
    title: { type: "mrkdwn", text: escapedWithin(title, TITLE_MAX_LENGTH), verbatim: false },
    ...(noteText ? { subtitle: { type: "mrkdwn", text: `${noteLabel}${noteText.text}`, verbatim: false } } : {}),
    ...(summary ? { body: { type: "mrkdwn", text: summary.text, verbatim: false } } : {}),
    subtext: { type: "mrkdwn", text: statusLine, verbatim: false },
  };

  const fallbackBlocks: SlackBlockKitBlock[] = [
    { type: "header", block_id: "ravi_thread_title", text: { type: "plain_text", text: title, emoji: true } },
    ...(summary
      ? [{ type: "section", block_id: "ravi_thread_summary", text: { type: "mrkdwn", text: summary.text } }]
      : []),
    ...(noteText
      ? [
          {
            type: "section",
            block_id: "ravi_thread_note",
            text: { type: "mrkdwn", text: `${noteLabel}${noteText.text}` },
          },
        ]
      : []),
    { type: "context", block_id: "ravi_thread_status", elements: [{ type: "mrkdwn", text: statusLine }] },
  ];

  return {
    text: title,
    blocks: [card],
    fallbackBlocks,
    ...(truncated ? { fullBrief: `**Instruções completas**\n\n${brief.trim()}` } : {}),
  };
}

/** True when Slack refused the blocks themselves (a block type it does not know, a bad field). */
export function isSlackInvalidBlocksError(error: unknown): boolean {
  const slackError = (error as { slackError?: unknown } | null)?.slackError;
  return typeof slackError === "string" && slackError.startsWith("invalid_blocks");
}

/** Markdown cut to fit `maxLength` once converted to mrkdwn (links grow when converted). */
function fitMrkdwn(source: string, maxLength: number): { text: string; cut: boolean } {
  const whole = source.trim();
  let limit = maxLength;
  while (limit > 20) {
    const cutSource = truncateAtBoundary(whole, limit);
    const text = markdownToSlackMrkdwn(cutSource);
    if (text.length <= maxLength) return { text, cut: cutSource !== whole };
    limit = Math.floor(limit * 0.8);
  }
  return { text: `${escapeSlackText(whole).slice(0, maxLength - 1)}…`, cut: true };
}

/** Join parts with " · ", dropping trailing parts that would pass `maxLength`. */
function joinWithin(parts: string[], maxLength: number): string {
  let line = parts[0] ?? "";
  for (const part of parts.slice(1)) {
    const next = `${line}  ·  ${part}`;
    if (next.length > maxLength) break;
    line = next;
  }
  return line;
}

/**
 * Title (first non-empty line, as plain text) and the rest of the brief. A
 * first line too long for a header gives its first sentence as the title, or
 * failing that its start, with the whole line kept in the body.
 */
export function splitSlackThreadBrief(brief: string): { title: string; body?: string } {
  const lines = brief.trim().split(/\r?\n/);
  const firstIndex = lines.findIndex((line) => line.trim());
  if (firstIndex < 0) return { title: "Thread" };
  const firstLine = lines[firstIndex]?.trim() ?? "";
  const rest = lines
    .slice(firstIndex + 1)
    .join("\n")
    .trim();
  const title = plainTitle(firstLine);
  if (title.length <= TITLE_MAX_LENGTH) return { title: title || "Thread", ...(rest ? { body: rest } : {}) };

  const sentence = /^(.+?[.!?])\s+(.+)$/s.exec(firstLine);
  const sentenceTitle = sentence ? plainTitle(sentence[1] ?? "") : "";
  if (sentence && sentenceTitle && sentenceTitle.length <= TITLE_MAX_LENGTH) {
    const body = [sentence[2]?.trim(), rest].filter(Boolean).join("\n");
    return { title: sentenceTitle, ...(body ? { body } : {}) };
  }
  return {
    title: `${title.slice(0, TITLE_MAX_LENGTH - 1).trimEnd()}…`,
    body: [firstLine, rest].filter(Boolean).join("\n"),
  };
}

function plainTitle(line: string): string {
  return line
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .replace(/!?\[([^\]]+)\]\([^)\s]+\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/`([^`]*)`/g, "$1")
    .trim();
}

/** Cut text at a sentence or word boundary, with an ellipsis when it was cut mid-sentence. */
function truncateAtBoundary(text: string, maxLength: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) return trimmed;
  const window = trimmed.slice(0, maxLength);
  const sentenceEnd = Math.max(
    window.lastIndexOf(". "),
    window.lastIndexOf("! "),
    window.lastIndexOf("? "),
    window.lastIndexOf("\n"),
  );
  if (sentenceEnd >= maxLength * 0.5) return window.slice(0, sentenceEnd + 1).trimEnd();
  const wordEnd = window.lastIndexOf(" ");
  const cut = wordEnd >= maxLength * 0.5 ? window.slice(0, wordEnd) : window.slice(0, maxLength - 1);
  return `${cut.trimEnd()}…`;
}

/** Escaped text within `maxLength`, cut before escaping so no entity is split. */
function escapedWithin(text: string, maxLength: number): string {
  let cut = text;
  let escaped = escapeSlackText(cut);
  while (escaped.length > maxLength && cut.length > 1) {
    cut = `${cut.slice(0, Math.max(1, cut.length - (escaped.length - maxLength) - 1)).trimEnd()}…`;
    escaped = escapeSlackText(cut);
  }
  return escaped;
}

function escapeSlackText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function slackLocalTime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const fallback = new Date(seconds * 1000).toISOString().replace("T", " ").slice(0, 16);
  return `<!date^${seconds}^{date_short_pretty} {time}|${fallback} UTC>`;
}
