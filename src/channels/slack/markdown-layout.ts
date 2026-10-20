/**
 * Lay agent Markdown out as Slack messages.
 *
 * Agents write standard Markdown once for every channel. Slack's `mrkdwn`
 * text has no tables or headings, and Slack itself cuts a `text` past about
 * 4,000 characters into several posts, even inside a code block. So Slack
 * egress sends Block Kit instead: `markdown` blocks (Slack translates tables,
 * code with a language, task lists and headings), `image` blocks for
 * standalone images, and long documents pulled out to be published apart
 * (a canvas, or a file).
 *
 * Messages are only ever split between top-level blocks: never inside a code
 * fence, a table or a paragraph, unless that one block alone is past the
 * limit (a fence is then reopened and closed in each part).
 */

import type { SlackBlockKitBlock } from "./block-kit.js";
import { markdownToSlackMrkdwn } from "./mrkdwn.js";

/** Slack allows 12,000 characters across the `markdown` blocks of one payload. */
export const SLACK_MESSAGE_MARKDOWN_LIMIT = 11_000;
/** Slack cuts `text` past about 4,000 characters; mrkdwn fallback parts stay under it. */
export const SLACK_MRKDWN_PART_LIMIT = 3_500;
/** A `markdown` or `text` fence at least this long is a document, published apart. */
export const SLACK_DOCUMENT_FENCE_MIN_LINES = 40;

const FALLBACK_TEXT_LIMIT = 300;
const LEAD_LIMIT = 1_200;
const MESSAGE_IMAGE_LIMIT = 10;
const DOCUMENT_TITLE_LIMIT = 80;
const DOCUMENT_FENCE_LANGUAGES = new Set(["markdown", "md", "text", "txt", "plain", "plaintext"]);
const MARKDOWN_FENCE_LANGUAGES = new Set(["markdown", "md"]);

const FENCE_OPEN_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const HEADING_RE = /^ {0,3}#{1,6}(?:\s|$)/;
const STANDALONE_IMAGE_RE = /^\s*!\[([^\]]*)\]\(\s*<?(https?:\/\/[^>\s)]+)>?(?:\s+"[^"]*")?\s*\)\s*$/;
const PLACEHOLDER_RE = /^RAVIDOC(\d+)$/;

export type SlackMarkdownUnit =
  | { readonly kind: "markdown"; readonly text: string; readonly heading: boolean }
  | {
      readonly kind: "fence";
      readonly text: string;
      readonly opener: string;
      readonly closer: string;
      readonly language: string;
      readonly body: readonly string[];
    }
  | { readonly kind: "image"; readonly text: string; readonly url: string; readonly alt: string };

export interface SlackLayoutDocument {
  /** The line standing for this document in `body` until it is published. */
  readonly placeholder: string;
  readonly title: string;
  readonly filename: string;
  /** What a canvas or file holds. */
  readonly content: string;
  /** What goes back in the message when the document cannot be published apart. */
  readonly inline: string;
}

export interface SlackMessageLayoutPlan {
  /** Markdown for the messages; each document stands as its own placeholder line. */
  readonly body: string;
  readonly documents: readonly SlackLayoutDocument[];
}

export interface SlackRenderedMessage {
  /** Notification and screen-reader text; Slack shows the blocks. */
  readonly text: string;
  readonly blocks: readonly SlackBlockKitBlock[];
  /** The Markdown this message carries, for the mrkdwn fallback. */
  readonly markdown: string;
}

/** Top-level blocks of `markdown`, in order: paragraphs (lists, tables, quotes), headings, fences, images. */
export function splitSlackMarkdownUnits(markdown: string): SlackMarkdownUnit[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const units: SlackMarkdownUnit[] = [];
  let paragraph: string[] = [];

  const flush = () => {
    if (paragraph.length === 0) return;
    const text = paragraph.join("\n");
    paragraph = [];
    const image = text.includes("\n") ? null : STANDALONE_IMAGE_RE.exec(text);
    if (image) {
      units.push({ kind: "image", text, alt: image[1]?.trim() ?? "", url: image[2] ?? "" });
      return;
    }
    units.push({ kind: "markdown", text, heading: false });
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const open = FENCE_OPEN_RE.exec(line);
    if (open && !(open[2]?.startsWith("`") && open[3]?.includes("`"))) {
      flush();
      const marker = open[2] ?? "```";
      const body: string[] = [];
      let closer = "";
      let cursor = index + 1;
      for (; cursor < lines.length; cursor++) {
        const candidate = lines[cursor] ?? "";
        if (isFenceClose(candidate, marker)) {
          closer = candidate;
          break;
        }
        body.push(candidate);
      }
      // An unclosed fence runs to the end, as in CommonMark; it is closed here so
      // a later split never leaves one open.
      const closing = closer || `${open[1] ?? ""}${marker}`;
      units.push({
        kind: "fence",
        text: [line, ...body, closing].join("\n"),
        opener: line,
        closer: closing,
        language: (open[3] ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "",
        body,
      });
      index = closer ? cursor : lines.length;
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    if (HEADING_RE.test(line)) {
      flush();
      units.push({ kind: "markdown", text: line, heading: true });
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return units;
}

/**
 * Pull long documents out of a reply: a `markdown`/`text` fence of
 * {@link SLACK_DOCUMENT_FENCE_MIN_LINES} lines or more, or the whole reply when
 * what is left would still not fit one message.
 */
export function planSlackMessageLayout(
  markdown: string,
  options: { readonly allowDocuments?: boolean } = {},
): SlackMessageLayoutPlan {
  if (options.allowDocuments === false) return { body: markdown, documents: [] };
  const units = splitSlackMarkdownUnits(markdown);
  const documents: SlackLayoutDocument[] = [];
  const parts: string[] = [];

  for (const unit of units) {
    if (unit.kind === "fence" && isDocumentFence(unit)) {
      const placeholder = documentPlaceholder(documents.length);
      const isMarkdown = MARKDOWN_FENCE_LANGUAGES.has(unit.language);
      const content = isMarkdown ? unit.body.join("\n") : unit.text;
      const title = documentTitle(isMarkdown ? content : unit.body.join("\n"));
      documents.push({
        placeholder,
        title,
        filename: `${slugify(title)}.${isMarkdown ? "md" : "txt"}`,
        content,
        inline: unit.text,
      });
      parts.push(placeholder);
      continue;
    }
    parts.push(unit.text);
  }

  const body = documents.length > 0 ? parts.join("\n\n") : markdown;
  if (bodyLength(body, documents) <= SLACK_MESSAGE_MARKDOWN_LIMIT) return { body, documents };

  // Still too long for one message: the whole reply is the document, and the
  // message carries its opening and the link.
  const title = documentTitle(markdown);
  const placeholder = documentPlaceholder(0);
  return {
    body: [leadOf(units), placeholder].filter(Boolean).join("\n\n"),
    documents: [{ placeholder, title, filename: `${slugify(title)}.md`, content: markdown, inline: markdown }],
  };
}

/** Block Kit messages for `markdown`, split only between top-level blocks. */
export function renderSlackMarkdownMessages(
  markdown: string,
  options: { readonly limit?: number } = {},
): SlackRenderedMessage[] {
  const limit = options.limit ?? SLACK_MESSAGE_MARKDOWN_LIMIT;
  const messages: SlackRenderedMessage[] = [];
  let pieces: SlackMarkdownUnit[] = [];
  let size = 0;
  let images = 0;

  const flush = () => {
    if (pieces.length === 0) return;
    const message = buildMessage(pieces);
    if (message) messages.push(message);
    pieces = [];
    size = 0;
    images = 0;
  };

  const units = splitSlackMarkdownUnits(markdown);
  // One message with no image: the Markdown goes exactly as written.
  if (markdown.length <= limit && !units.some((unit) => unit.kind === "image")) {
    const whole = markdown.trim();
    if (!whole) return [];
    return [{ text: fallbackText(units), blocks: [{ type: "markdown", text: whole }], markdown: whole }];
  }

  for (const unit of fitUnits(units, limit)) {
    if (unit.kind === "image") {
      if (images >= MESSAGE_IMAGE_LIMIT) flush();
      pieces.push(unit);
      images += 1;
      continue;
    }
    const added = unit.text.length + (size > 0 ? 2 : 0);
    if (size > 0 && size + added > limit) flush();
    pieces.push(unit);
    size += unit.text.length + (size > 0 ? 2 : 0);
  }
  flush();
  return messages;
}

/**
 * Plain mrkdwn parts for when Slack refuses the blocks: the same safe split,
 * small enough that Slack does not cut them itself.
 */
export function renderSlackMrkdwnParts(markdown: string, options: { readonly converted?: boolean } = {}): string[] {
  const parts: string[] = [];
  let current: string[] = [];
  let size = 0;
  const flush = () => {
    if (current.length === 0) return;
    const joined = current.join("\n\n");
    const text = (options.converted ? joined : markdownToSlackMrkdwn(joined)).trim();
    if (text) parts.push(text);
    current = [];
    size = 0;
  };
  for (const unit of fitUnits(splitSlackMarkdownUnits(markdown), SLACK_MRKDWN_PART_LIMIT)) {
    const added = unit.text.length + (size > 0 ? 2 : 0);
    if (size > 0 && size + added > SLACK_MRKDWN_PART_LIMIT) flush();
    current.push(unit.text);
    size += added;
  }
  flush();
  return parts;
}

/** The line a published document leaves in the message: its title as a link. */
export function slackDocumentLinkLine(document: SlackLayoutDocument, url: string): string {
  return `📄 [${document.title.replace(/[[\]]/g, "")}](${url})`;
}

/** The line a document sent as a file leaves in the message. */
export function slackDocumentFileLine(document: SlackLayoutDocument): string {
  return `📎 **${document.title}**`;
}

export function isSlackDocumentPlaceholder(line: string): boolean {
  return PLACEHOLDER_RE.test(line.trim());
}

function isFenceClose(line: string, marker: string): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
  const candidate = match?.[1];
  return Boolean(candidate && candidate[0] === marker[0] && candidate.length >= marker.length);
}

function isDocumentFence(unit: Extract<SlackMarkdownUnit, { kind: "fence" }>): boolean {
  return DOCUMENT_FENCE_LANGUAGES.has(unit.language) && unit.body.length >= SLACK_DOCUMENT_FENCE_MIN_LINES;
}

function documentPlaceholder(index: number): string {
  return `RAVIDOC${index}`;
}

/** The body as it will read once each placeholder becomes a short link line. */
function bodyLength(body: string, documents: readonly SlackLayoutDocument[]): number {
  let length = body.length;
  for (const document of documents) length += document.title.length + 64 - document.placeholder.length;
  return length;
}

/** The reply's opening for a message that links to the whole: a heading and its first paragraph. */
function leadOf(units: readonly SlackMarkdownUnit[]): string {
  const lead: string[] = [];
  for (const unit of units) {
    if (unit.kind !== "markdown") break;
    if (unit.heading) {
      if (lead.length > 0) break;
      lead.push(unit.text);
      continue;
    }
    lead.push(unit.text.length > LEAD_LIMIT ? cutAtBoundary(unit.text, LEAD_LIMIT) : unit.text);
    break;
  }
  return lead.join("\n\n");
}

/** A title for a document: frontmatter `name`, its first heading, or its first line. */
function documentTitle(content: string): string {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  if (lines[0]?.trim() === "---") {
    for (const line of lines.slice(1)) {
      if (line.trim() === "---") break;
      const name = /^name:\s*(.+)$/.exec(line.trim())?.[1];
      if (name) return shortTitle(name.replace(/^["']|["']$/g, ""));
    }
  }
  const heading = lines.find((line) => HEADING_RE.test(line));
  if (heading) return shortTitle(heading.replace(/^ {0,3}#{1,6}\s*/, ""));
  const first = lines.find((line) => line.trim() && line.trim() !== "---" && !FENCE_OPEN_RE.test(line));
  return shortTitle(first ?? "") || "Documento";
}

function shortTitle(value: string): string {
  const plain = value
    .replace(/[*_`~]/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > DOCUMENT_TITLE_LIMIT ? `${plain.slice(0, DOCUMENT_TITLE_LIMIT - 1).trimEnd()}…` : plain;
}

function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug || "documento";
}

/** Units no longer than `limit`: an oversized fence is reopened per part, a paragraph is cut by line. */
function fitUnits(units: readonly SlackMarkdownUnit[], limit: number): SlackMarkdownUnit[] {
  const fitted: SlackMarkdownUnit[] = [];
  for (const unit of units) {
    if (unit.text.length <= limit) {
      fitted.push(unit);
      continue;
    }
    if (unit.kind === "fence") {
      const room = Math.max(1, limit - unit.opener.length - unit.closer.length - 2);
      for (const body of packLines(unit.body, room)) {
        fitted.push({ ...unit, body, text: [unit.opener, ...body, unit.closer].join("\n") });
      }
      continue;
    }
    for (const text of packLines(unit.text.split("\n"), limit)) {
      fitted.push({ kind: "markdown", text: text.join("\n"), heading: false });
    }
  }
  return fitted;
}

/** Group lines into runs of at most `limit` characters, cutting a single overlong line. */
function packLines(lines: readonly string[], limit: number): string[][] {
  const runs: string[][] = [];
  let run: string[] = [];
  let size = 0;
  for (const whole of lines) {
    const pieces = whole.length > limit ? chunkString(whole, limit) : [whole];
    for (const line of pieces) {
      const added = line.length + (run.length > 0 ? 1 : 0);
      if (run.length > 0 && size + added > limit) {
        runs.push(run);
        run = [];
        size = 0;
      }
      size += line.length + (run.length > 0 ? 1 : 0);
      run.push(line);
    }
  }
  if (run.length > 0) runs.push(run);
  return runs;
}

function chunkString(value: string, size: number): string[] {
  const chunks: string[] = [];
  const symbols = Array.from(value);
  for (let index = 0; index < symbols.length; index += size) chunks.push(symbols.slice(index, index + size).join(""));
  return chunks;
}

function buildMessage(pieces: readonly SlackMarkdownUnit[]): SlackRenderedMessage | undefined {
  const blocks: SlackBlockKitBlock[] = [];
  const markdown: string[] = [];
  let run: string[] = [];
  const flushRun = () => {
    if (run.length === 0) return;
    blocks.push({ type: "markdown", text: run.join("\n\n") });
    run = [];
  };
  for (const piece of pieces) {
    markdown.push(piece.text);
    if (piece.kind === "image") {
      flushRun();
      blocks.push({ type: "image", image_url: piece.url, alt_text: piece.alt || "imagem" });
      continue;
    }
    run.push(piece.text);
  }
  flushRun();
  if (blocks.length === 0) return undefined;
  const source = markdown.join("\n\n");
  return { text: fallbackText(pieces), blocks, markdown: source };
}

/** The first line of the message as short mrkdwn, for notifications and screen readers. */
function fallbackText(pieces: readonly SlackMarkdownUnit[]): string {
  for (const piece of pieces) {
    if (piece.kind === "image") continue;
    const source = piece.kind === "fence" ? piece.body.find((line) => line.trim()) : piece.text;
    const line = (source ?? "")
      .split("\n")
      .map((value) =>
        value
          .replace(/^ {0,3}#{1,6}\s+/, "")
          .replace(/^\s*(?:[-*+]|\d+[.)]|>)\s+/, "")
          .trim(),
      )
      .find((value) => value && !/^\|?[\s:|-]+\|?$/.test(value));
    if (!line) continue;
    const text = markdownToSlackMrkdwn(
      line.length > FALLBACK_TEXT_LIMIT ? cutAtBoundary(line, FALLBACK_TEXT_LIMIT) : line,
    );
    if (text.trim()) return text.trim();
  }
  const image = pieces.find((piece) => piece.kind === "image");
  return image?.kind === "image" && image.alt ? image.alt : "Imagem";
}

function cutAtBoundary(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const window = text.slice(0, limit - 1);
  const sentence = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "));
  if (sentence >= limit * 0.5) return window.slice(0, sentence + 1);
  const word = window.lastIndexOf(" ");
  return `${(word >= limit * 0.5 ? window.slice(0, word) : window).trimEnd()}…`;
}
