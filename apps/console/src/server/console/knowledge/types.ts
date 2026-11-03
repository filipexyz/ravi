import type { db } from "@/server/db";

/** Ordered from highest to lowest: an item's tier is the lowest among its evidence. */
export type KnowledgeTrustTier = "approved" | "published" | "said" | "inferred";

/** Derived from a source's `origin_key` prefix; null is `manual`. */
export type KnowledgeSourceKind = "meeting" | "transcript" | "page" | "note" | "manual";

export const KNOWLEDGE_TRUST_ORDER: readonly KnowledgeTrustTier[] = ["approved", "published", "said", "inferred"];

/** The query surface every knowledge writer accepts: the pooled `db` or a transaction. */
export type KnowledgeDbExecutor = Pick<typeof db, "insert" | "select" | "update" | "delete" | "execute">;

export type KnowledgeTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export function knowledgeKindForOriginKey(originKey: string | null | undefined): KnowledgeSourceKind {
  if (!originKey) return "manual";
  if (originKey.startsWith("meeting:")) return "meeting";
  if (originKey.startsWith("transcript:")) return "transcript";
  if (originKey.startsWith("page:")) return "page";
  if (originKey.startsWith("note:")) return "note";
  return "manual";
}

/** `origin_key` prefix for a kind; `manual` has none (null origin). */
export function originKeyPrefixForKind(kind: KnowledgeSourceKind): string | null {
  return kind === "manual" ? null : `${kind}:`;
}
