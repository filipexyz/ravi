// Library search text: lowercase, no diacritics, letters and digits only, so
// Postgres' `simple` configuration needs no extension. Each query term is a
// prefix match and terms are OR-ed; `ts_rank_cd` ranks name over description
// over body (weights A, B, C).

const MAX_QUERY_TERMS = 12;
const MAX_BODY_CHARS = 100_000;

export function normalizeLibrarySearchText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** A `to_tsquery('simple', …)` string, or null when the query has no searchable term. */
export function buildLibraryTsQuery(query: string) {
  const terms = [...new Set(normalizeLibrarySearchText(query).split(" ").filter(Boolean))].slice(0, MAX_QUERY_TERMS);
  if (terms.length === 0) return null;
  return terms.map((term) => `${term}:*`).join(" | ");
}

/** The three weighted parts of an item's search vector, already normalized. */
export function librarySearchParts(input: { slug: string; name: string; description: string; body: string }) {
  const head = normalizeLibrarySearchText(`${input.slug} ${input.name}`);
  const description = normalizeLibrarySearchText(input.description);
  const body = normalizeLibrarySearchText(input.body).slice(0, MAX_BODY_CHARS);
  return { head, description, body, text: [head, description, body].filter(Boolean).join(" ") };
}
