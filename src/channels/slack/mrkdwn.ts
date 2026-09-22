/**
 * Convert CommonMark-ish agent text to Slack mrkdwn.
 *
 * Slack chat.postMessage / chat.update render mrkdwn (`*bold*`, `_italic_`,
 * `<url|text>`), not CommonMark (`**bold**`, `[text](url)`). Agent replies are
 * written once for every channel, so Slack egress must translate — not the
 * shared system prompt.
 *
 * Apply this once at a Slack text egress boundary. Code fences and inline code
 * are copied through unchanged.
 */

const FENCE_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`\n]*`/g;
const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\(\s*<?([^>\s)]+)>?\s*\)/g;
const MARKDOWN_LINK_RE = /\[([^\]]+)\]\(\s*<?([^>\s)]+)>?\s*\)/g;
const BOLD_ITALIC_RE = /(\*\*\*|___)(.+?)\1/g;
const BOLD_RE = /(\*\*|__)(.+?)\1/g;
const ITALIC_RE = /(?<![*\w])\*(?!\*)([^*\n]+?)\*(?!\*)/g;
const STRIKE_RE = /~~([^~\n]+?)~~/g;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const UNORDERED_LIST_RE = /^(\s*)([*+-])\s+(.*)$/;
const ORDERED_LIST_RE = /^(\s*)(\d+)\.\s+(.*)$/;
const BLOCKQUOTE_PREFIX_RE = /^( *)>/gm;
const EXISTING_ENTITY_RE = /&(?:amp|lt|gt);/g;
const SLACK_SPECIAL_RE =
  /<(?:https?:\/\/[^>\s]+|mailto:[^>\s]+|@[UW][A-Z0-9]+(?:\|[^>]+)?|#[CG][A-Z0-9]+(?:\|[^>]+)?|!(?:here|channel|everyone|subteam\^[^>]+)|[^|\s<>]+\|[^>\n]+)>/g;

type Stash = { readonly token: string; readonly value: string };

export function markdownToSlackMrkdwn(input: string): string {
  if (!input) return input;

  const fences = stash(input, FENCE_RE, "FENCE");
  const codes = stash(fences.text, INLINE_CODE_RE, "CODE");
  const images = stashReplaced(codes.text, MARKDOWN_IMAGE_RE, "IMG", slackMarkdownLink);
  const links = stashReplaced(images.text, MARKDOWN_LINK_RE, "MDN", slackMarkdownLink);

  const converted = links.text
    .split(/\r?\n/)
    .map((line) => convertSlackLine(line))
    .join("\n");

  const escaped = escapeSlackMrkdwn(converted);
  return restore(restore(restore(restore(escaped, links.stash), images.stash), codes.stash), fences.stash);
}

function convertSlackLine(line: string): string {
  const heading = HEADING_RE.exec(line);
  if (heading) {
    const inner = flattenHeadingText(convertSlackInlines(heading[2] ?? ""));
    return inner ? `*${inner}*` : line;
  }

  const unordered = UNORDERED_LIST_RE.exec(line);
  if (unordered) {
    return `${unordered[1]}• ${convertSlackInlines(unordered[3] ?? "")}`;
  }

  const ordered = ORDERED_LIST_RE.exec(line);
  if (ordered) {
    return `${ordered[1]}${ordered[2]}. ${convertSlackInlines(ordered[3] ?? "")}`;
  }

  return convertSlackInlines(line);
}

function convertSlackInlines(text: string): string {
  let out = text;
  out = out.replace(BOLD_ITALIC_RE, "_*$2*_");
  out = out.replace(ITALIC_RE, "_$1_");
  out = out.replace(BOLD_RE, "*$2*");
  out = out.replace(STRIKE_RE, "~$1~");
  return out;
}

function flattenHeadingText(text: string): string {
  return text.replace(/[*_~]/g, "").replace(/\s+/g, " ").trim();
}

function slackMarkdownLink(_match: string, label: string, url: string): string {
  const safeUrl = escapeSlackMrkdwn(url);
  const safeLabel = escapeSlackMrkdwn(convertSlackInlines(label));
  return `<${safeUrl}|${safeLabel}>`;
}

function escapeSlackMrkdwn(text: string): string {
  const entities = stash(text, EXISTING_ENTITY_RE, "ENT");
  const specials = stash(entities.text, SLACK_SPECIAL_RE, "SLACK");
  const quotes = stashReplaced(specials.text, BLOCKQUOTE_PREFIX_RE, "BQ", (_match, spaces) => `${spaces}>`);
  const escaped = quotes.text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return restore(restore(restore(escaped, quotes.stash), specials.stash), entities.stash);
}

function stash(input: string, pattern: RegExp, prefix: string): { text: string; stash: Stash[] } {
  const collected: Stash[] = [];
  const text = input.replace(pattern, (value) => {
    const token = stashToken(prefix, collected.length);
    collected.push({ token, value });
    return token;
  });
  return { text, stash: collected };
}

function stashReplaced(
  input: string,
  pattern: RegExp,
  prefix: string,
  replace: (...args: string[]) => string,
): { text: string; stash: Stash[] } {
  const collected: Stash[] = [];
  const text = input.replace(pattern, (...args) => {
    const token = stashToken(prefix, collected.length);
    collected.push({ token, value: replace(...(args as string[])) });
    return token;
  });
  return { text, stash: collected };
}

function stashToken(prefix: string, index: number): string {
  return `\uE000${prefix}${index}\uE001`;
}

function restore(text: string, collected: readonly Stash[]): string {
  let out = text;
  for (const item of collected) {
    out = out.replace(item.token, () => item.value);
  }
  return out;
}
