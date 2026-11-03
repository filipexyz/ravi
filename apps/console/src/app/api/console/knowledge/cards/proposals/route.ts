import type { NextRequest } from "next/server";

import { handleKnowledgeProposalCardPost } from "@/server/console/knowledge/proposals";

export const runtime = "nodejs";
// A gap Publish uploads, finalizes and captures /faq in this request.
export const maxDuration = 120;

/** Publish, approve, reject or dismiss from the one-card page: same-origin POST by a project admin. */
export async function POST(request: NextRequest) {
  return handleKnowledgeProposalCardPost(request);
}
