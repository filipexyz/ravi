// Text helpers shared by every knowledge writer and reader. Folding feeds the
// `simple` and `portuguese` search vectors; neutralizing runs on ingest (the
// stored chunk text) and again on output, so it must be idempotent.

import { neutralizePageText } from "@/server/console/pages/read-extract";

const MAX_SPEAKER_NAME_CHARS = 80;
const UNKNOWN_SPEAKER = "Unknown speaker";

// Format characters (zero-width, bidi marks, soft hyphen, Arabic letter mark)
// and the tag block, which can hide instructions inside visible text.
const FORMAT_CHARS = /[\p{Cf}؜­\u{e0000}-\u{e007f}]/gu;
// Tokens our own prompt fences use. Split so text can never close or open one.
const FENCE_OPEN = /<<</g;
const FENCE_CLOSE = />>>/g;
const FENCE_NAMES = /RAVI_(KNOWLEDGE|CONTACT_MEMORY|PAGE_CONTENT)/gi;
const MARKDOWN_IMAGE = /!\[([^\]\n]*)\]\([^)\n]*\)/g;
const MARKDOWN_LINK = /\[([^\]\n]*)\]\([^)\n]*\)/g;
const EXTRA_BLANK_LINES = /(?:\n[ \t]*){4,}/g;

export const KNOWLEDGE_STOPWORDS: ReadonlySet<string> = new Set([
  "de", "da", "do", "das", "dos", "que", "para", "pra", "com", "uma", "um", "uns", "umas", "por",
  "nos", "nas", "no", "na", "os", "as", "ate", "sobre", "entre", "mas", "como", "mais", "isso",
  "esse", "essa", "este", "esta", "ele", "ela", "eles", "elas", "voce", "voces", "meu", "minha",
  "seu", "sua", "nao", "sim", "ja", "foi", "ser", "ter", "tem", "era", "sao", "quando", "onde",
  "qual", "quais", "porque", "entao", "tambem", "aqui", "ali", "la", "the", "and", "for", "with",
  "what", "that", "this", "from", "about",
]);

/** Lowercase, no diacritics, letters and digits only (same as Library search). */
export function foldKnowledgeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Makes stored or returned knowledge text inert: no hidden characters, fences, links, images or tags. */
export function neutralizeKnowledgeText(value: string): string {
  return neutralizePageText(value.replace(/\r\n?/g, "\n"))
    .replace(FORMAT_CHARS, "")
    .replace(FENCE_OPEN, "‹‹‹")
    .replace(FENCE_CLOSE, "›››")
    .replace(FENCE_NAMES, (match) => match.replace(/_/g, " "))
    .replace(MARKDOWN_IMAGE, (_match, alt: string) => `[image: ${alt.trim()}]`)
    .replace(MARKDOWN_LINK, (_match, label: string) => label)
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(EXTRA_BLANK_LINES, "\n\n\n");
}

// Transcript lines are `«speaker»: text`, so a name must never carry the quote marks.
const SPEAKER_QUOTES = /[«»]/g;

/** A display name chosen by a meeting participant, made safe to quote. */
export function sanitizeSpeakerName(name: string | null | undefined): string {
  const cleaned = neutralizeKnowledgeText(name ?? "").replace(SPEAKER_QUOTES, "").replace(/\s+/g, " ").trim();
  const capped = Array.from(cleaned).slice(0, MAX_SPEAKER_NAME_CHARS).join("").trim();
  return capped || UNKNOWN_SPEAKER;
}
