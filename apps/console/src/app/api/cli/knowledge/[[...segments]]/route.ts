import { type NextRequest } from "next/server";

import { respondKnowledgeOrgCli } from "@/server/console/knowledge/org-cli-api";

type RouteContext = {
  params: Promise<{ segments?: string[] }>;
};

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: NextRequest, context: RouteContext) {
  const { segments = [] } = await context.params;
  return respondKnowledgeOrgCli(request, segments, "GET");
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { segments = [] } = await context.params;
  return respondKnowledgeOrgCli(request, segments, "POST");
}
