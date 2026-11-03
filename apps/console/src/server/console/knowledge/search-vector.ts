import { sql, type SQL } from "drizzle-orm";

import { foldKnowledgeText } from "./text";

type SearchVectorParts = {
  title: string;
  heading: string | null;
  text: string;
  speakers: readonly string[];
};

/**
 * Both chunk search vectors: title (A), heading (B), text plus speakers (C),
 * each folded first. Every part is coalesced to '' because one NULL part would
 * make the whole vector NULL and the chunk would never match.
 */
export function knowledgeSearchVectorSql(parts: SearchVectorParts): { searchVector: SQL; searchVectorStem: SQL } {
  const title = foldKnowledgeText(parts.title ?? "");
  const heading = foldKnowledgeText(parts.heading ?? "");
  const text = foldKnowledgeText(parts.text ?? "");
  const speakers = foldKnowledgeText((parts.speakers ?? []).join(" "));
  const vector = (config: "simple" | "portuguese") =>
    sql`setweight(to_tsvector(${sql.raw(`'${config}'`)}::regconfig, coalesce(${title}::text, '')), 'A') || setweight(to_tsvector(${sql.raw(`'${config}'`)}::regconfig, coalesce(${heading}::text, '')), 'B') || setweight(to_tsvector(${sql.raw(`'${config}'`)}::regconfig, coalesce(${text}::text, '') || ' ' || coalesce(${speakers}::text, '')), 'C')`;
  return { searchVector: vector("simple"), searchVectorStem: vector("portuguese") };
}
