// Knowledge text helpers: the same rules as the Console's
// `src/server/console/knowledge/text.ts` (contract §3.1), so a folded query or
// a neutralized excerpt reads the same on both sides.

/** Fold for search: NFD, no marks, lowercase, letters and digits only. */
export function foldKnowledgeText(s: string): string {
  return (s ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Ravi envelope prefixes the prompt treats as system or routing lines.
const ENVELOPE_PREFIX = /^(\s*)(\[|\uff3b)(?=\s*(system|trigger|replying to|from:|\+\d))/i;
const CONTROL_CHARS =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\ufeff]/g;
const FORMAT_CHARS = /[\p{Cf}\u061c\u00ad\u{e0000}-\u{e007f}]/gu;
const FENCE_WORDS = /RAVI_(KNOWLEDGE|CONTACT_MEMORY|PAGE_CONTENT)/gi;
const MARKDOWN_IMAGE = /!\[([^\]\n]*)\]\([^)\n]*\)/g;
const MARKDOWN_LINK = /\[([^\]\n]*)\]\([^)\n]*\)/g;

/**
 * Makes text safe to return inside a fence: NFKC, control and format
 * characters removed, fence tokens broken, Markdown images and links reduced
 * to their text, `<`/`>` escaped, long blank runs collapsed and envelope-like
 * line starts escaped.
 */
export function neutralizeKnowledgeText(s: string): string {
  return (s ?? "")
    .normalize("NFKC")
    .replace(CONTROL_CHARS, "")
    .replace(FORMAT_CHARS, "")
    .replace(/<<</g, "‹‹‹")
    .replace(/>>>/g, "›››")
    .replace(FENCE_WORDS, (word) => word.replace(/_/g, " "))
    .replace(MARKDOWN_IMAGE, (_match, alt: string) => `[image: ${alt.trim()}]`)
    .replace(MARKDOWN_LINK, (_match, text: string) => text)
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n(?:[ \t]*\n){3,}/g, "\n\n\n")
    .split("\n")
    .map((line) => line.replace(ENVELOPE_PREFIX, "$1\\["))
    .join("\n");
}

const MAX_SPEAKER_CHARS = 80;

/** A display name chosen by the participant, safe to show: at most 80 chars. */
export function sanitizeSpeakerName(s: string): string {
  const collapsed = neutralizeKnowledgeText(s ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const capped = Array.from(collapsed).slice(0, MAX_SPEAKER_CHARS).join("").trim();
  return capped || "Unknown speaker";
}

/** Folded stopwords, the same set as the Console query builder. */
export const KNOWLEDGE_STOPWORDS: ReadonlySet<string> = new Set([
  "de",
  "da",
  "do",
  "das",
  "dos",
  "que",
  "para",
  "pra",
  "com",
  "uma",
  "um",
  "uns",
  "umas",
  "por",
  "nos",
  "nas",
  "no",
  "na",
  "os",
  "as",
  "ate",
  "sobre",
  "entre",
  "mas",
  "como",
  "mais",
  "isso",
  "esse",
  "essa",
  "este",
  "esta",
  "ele",
  "ela",
  "eles",
  "elas",
  "voce",
  "voces",
  "meu",
  "minha",
  "seu",
  "sua",
  "nao",
  "sim",
  "ja",
  "foi",
  "ser",
  "ter",
  "tem",
  "era",
  "sao",
  "quando",
  "onde",
  "qual",
  "quais",
  "porque",
  "entao",
  "tambem",
  "aqui",
  "ali",
  "la",
  "the",
  "and",
  "for",
  "with",
  "what",
  "that",
  "this",
  "from",
  "about",
]);

const MAX_QUERY_TERMS = 12;

/**
 * Search terms of a query (contract §3.2): folded, unique, in order, at least
 * 3 chars and not a stopword; when nothing is left, the non-stopword terms of
 * 2 chars or more. At most 12. Empty when the query has no searchable term.
 */
export function knowledgeQueryTerms(raw: string): string[] {
  const words = [...new Set(foldKnowledgeText(raw).split(" ").filter(Boolean))].filter((word) =>
    /^[a-z0-9]+$/.test(word),
  );
  let terms = words.filter((word) => word.length >= 3 && !KNOWLEDGE_STOPWORDS.has(word));
  if (terms.length === 0) terms = words.filter((word) => word.length >= 2 && !KNOWLEDGE_STOPWORDS.has(word));
  return terms.slice(0, MAX_QUERY_TERMS);
}

/**
 * FTS5 MATCH strings for a query: every term as a quoted prefix (`"term"*`),
 * joined by AND and by OR. Terms are `[a-z0-9]` only, so nothing from the raw
 * input reaches the MATCH syntax. Null when there is no searchable term.
 */
export function buildLocalFtsQuery(raw: string): { and: string; or: string } | null {
  const terms = knowledgeQueryTerms(raw);
  if (terms.length === 0) return null;
  const parts = terms.map((term) => `"${term}"*`);
  return { and: parts.join(" AND "), or: parts.join(" OR ") };
}
