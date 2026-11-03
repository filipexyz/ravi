import { type NextRequest } from "next/server";

import { respondKnowledgeProjectCli } from "@/server/console/knowledge/cli-api";

type RouteContext = {
  params: Promise<{ projectRef: string; segments?: string[] }>;
};

export const runtime = "nodejs";

// No DELETE export: the legacy soft delete moved to the Console UI, and Next answers 405.

export async function GET(request: NextRequest, context: RouteContext) {
  const { projectRef, segments = [] } = await context.params;
  return respondKnowledgeProjectCli(request, { projectRef, segments }, "GET");
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { projectRef, segments = [] } = await context.params;
  return respondKnowledgeProjectCli(request, { projectRef, segments }, "POST");
}
