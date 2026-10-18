/**
 * The Block Kit card an agent posts as the root of a thread it opens
 * (`ravi sessions create-thread`).
 *
 * The thread's initial message is the child session's whole brief. Posted as
 * plain text it fills the channel, so the root shows a card instead: the
 * first line as the title, a short summary of the rest, and the thread's
 * status. When the summary leaves part of the brief out, the full brief goes
 * as the first reply inside the thread. Report, close and reopen re-render the
 * card in place (`chat.update`) with the new status and the latest progress or
 * result.
 *
 * Everything shown comes from text that passes the outbound Knowledge guard:
 * the brief (`text`) and the card note (`threadCard.note`), plus the name of
 * the person who asked (`requestedBy`), resolved from the turn's contact.
 */

import type { SlackBlockKitBlock } from "./block-kit.js";
import { markdownToSlackMrkdwn } from "./mrkdwn.js";

export type SlackThreadCardStatus = "open" | "closed" | "reopened";

export interface SlackThreadCardState {
  readonly status: SlackThreadCardStatus;
  /** Latest progress (open, reopened) or the close result (closed). */
  readonly note?: string;
  /** When the card last changed, in ms; shown as Slack-localized time. */
  readonly updatedAt?: number;
  /** The person who asked for the thread, by name. */
  readonly requestedBy?: string;
}

export interface SlackThreadCardMessage {
  /** Notification and fallback text. */
  readonly text: string;
  readonly blocks: readonly SlackBlockKitBlock[];
  /** The whole brief, to post inside the thread when the card summary leaves part of it out. */
  readonly fullBrief?: string;
}

const HEADER_MAX_LENGTH = 150;
const SUMMARY_MAX_LENGTH = 300;
const NOTE_MAX_LENGTH = 500;

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

export function buildSlackThreadCard(brief: string, state: SlackThreadCardState): SlackThreadCardMessage {
  const { title, body } = splitSlackThreadBrief(brief);
  const summary = body ? truncateAtBoundary(body, SUMMARY_MAX_LENGTH) : undefined;
  const truncated = summary !== undefined && summary !== body;
  const blocks: SlackBlockKitBlock[] = [
    {
      type: "header",
      block_id: "ravi_thread_title",
      text: { type: "plain_text", text: title, emoji: true },
    },
  ];
  if (summary) {
    blocks.push({
      type: "section",
      block_id: "ravi_thread_summary",
      text: { type: "mrkdwn", text: markdownToSlackMrkdwn(summary) },
    });
  }
  const note = state.note?.trim();
  if (note) {
    blocks.push({
      type: "section",
      block_id: "ravi_thread_note",
      text: {
        type: "mrkdwn",
        text: `*${NOTE_LABELS[state.status]}*\n${markdownToSlackMrkdwn(truncateAtBoundary(note, NOTE_MAX_LENGTH))}`,
      },
    });
  }
  const context = [STATUS_LABELS[state.status]];
  const requestedBy = state.requestedBy?.trim();
  if (requestedBy) context.push(`pedido por ${escapeSlackText(requestedBy)}`);
  if (state.updatedAt !== undefined) context.push(slackLocalTime(state.updatedAt));
  if (truncated) context.push("instruções completas na thread");
  blocks.push({
    type: "context",
    block_id: "ravi_thread_status",
    elements: [{ type: "mrkdwn", text: context.join("  ·  ") }],
  });

  return {
    text: title,
    blocks,
    ...(truncated ? { fullBrief: `*Instruções completas*\n${markdownToSlackMrkdwn(brief.trim())}` } : {}),
  };
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
  if (title.length <= HEADER_MAX_LENGTH) return { title: title || "Thread", ...(rest ? { body: rest } : {}) };

  const sentence = /^(.+?[.!?])\s+(.+)$/s.exec(firstLine);
  const sentenceTitle = sentence ? plainTitle(sentence[1] ?? "") : "";
  if (sentence && sentenceTitle && sentenceTitle.length <= HEADER_MAX_LENGTH) {
    const body = [sentence[2]?.trim(), rest].filter(Boolean).join("\n");
    return { title: sentenceTitle, ...(body ? { body } : {}) };
  }
  return {
    title: `${title.slice(0, HEADER_MAX_LENGTH - 1).trimEnd()}…`,
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

function escapeSlackText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function slackLocalTime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const fallback = new Date(seconds * 1000).toISOString().replace("T", " ").slice(0, 16);
  return `<!date^${seconds}^{date_short_pretty} {time}|${fallback} UTC>`;
}
