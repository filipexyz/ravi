import type { NextRequest } from "next/server";

import { handleKnowledgeRouteCardPost } from "@/server/console/knowledge/proposals";

export const runtime = "nodejs";
export const maxDuration = 120;

/** Mark, re-approve or unmark a page route from its one-card page: same-origin POST by a project admin. */
export async function POST(request: NextRequest) {
  return handleKnowledgeRouteCardPost(request);
}
