import { handleKnowledgeTickHttp } from "@/server/console/knowledge/tick";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handleKnowledgeTickHttp(request);
}

export async function POST(request: Request) {
  return handleKnowledgeTickHttp(request);
}
