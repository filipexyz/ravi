import { and, eq, isNotNull, sql } from "drizzle-orm";

import { schema } from "@/server/db";

import type { KnowledgeDbExecutor } from "./types";

// A proposal's body is what a person or a contact wrote (a note, a question, a
// whole meeting transcript). It is kept only while someone may still need to
// read it: a decided transcript, an expired proposal, and a gap or transcript
// 30 days after it closed keep only `body_hash`.

/** Column values that drop a proposal's body and keep its sha256 hex (both read the row's old values). */
export function purgedProposalBody() {
  return {
    bodyHash: sql<string | null>`coalesce(${schema.knowledgeProposals.bodyHash}, encode(sha256(convert_to(${schema.knowledgeProposals.body}, 'UTF8')), 'hex'))`,
    body: null,
  };
}

/** Purges one proposal's body (the approved transcript behind a `transcript:<proposalId>` source). */
export async function purgeProposalBody(executor: KnowledgeDbExecutor, input: { organizationId: string; proposalId: string }): Promise<boolean> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.proposalId)) return false;
  const rows = await executor
    .update(schema.knowledgeProposals)
    .set({ ...purgedProposalBody(), updatedAt: new Date() })
    .where(
      and(
        eq(schema.knowledgeProposals.organizationId, input.organizationId),
        eq(schema.knowledgeProposals.id, input.proposalId),
        isNotNull(schema.knowledgeProposals.body),
      ),
    )
    .returning({ id: schema.knowledgeProposals.id });
  return rows.length > 0;
}
