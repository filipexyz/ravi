import { foldKnowledgeText, KNOWLEDGE_STOPWORDS } from "./text";

const MAX_TERMS = 12;
const MIN_TERM_CHARS = 3;
const FALLBACK_MIN_TERM_CHARS = 2;
const SAFE_TERM = /^[a-z0-9]+$/;

export type KnowledgeQuery = {
  /** Terms joined by " ". */
  normalized: string;
  /** Folded, unique, in order, at most 12. */
  terms: string[];
  /** "t1:* & t2:*" for to_tsquery('simple', …). */
  simpleAnd: string;
  /** "t1:* | t2:*". */
  simpleOr: string;
  /** Same terms, for to_tsquery('portuguese', …). */
  stemAnd: string;
  stemOr: string;
};

/**
 * Builds the two-pass full-text query. Every term is folded to `[a-z0-9]`
 * before it becomes `term:*`, and callers bind the strings as parameters of
 * `to_tsquery`, so raw input never reaches SQL. Null means "no searchable
 * terms" (the caller answers 400).
 */
export function buildKnowledgeQuery(raw: string): KnowledgeQuery | null {
  const folded = [...new Set(foldKnowledgeText(raw).split(" ").filter(Boolean))].filter((term) =>
    SAFE_TERM.test(term),
  );
  const nonStopwords = folded.filter((term) => !KNOWLEDGE_STOPWORDS.has(term));
  let terms = nonStopwords.filter((term) => term.length >= MIN_TERM_CHARS);
  if (terms.length === 0) terms = nonStopwords.filter((term) => term.length >= FALLBACK_MIN_TERM_CHARS);
  if (terms.length === 0) return null;
  terms = terms.slice(0, MAX_TERMS);

  const prefixed = terms.map((term) => `${term}:*`);
  const and = prefixed.join(" & ");
  const or = prefixed.join(" | ");
  return {
    normalized: terms.join(" "),
    terms,
    simpleAnd: and,
    simpleOr: or,
    stemAnd: and,
    stemOr: or,
  };
}
