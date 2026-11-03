import { handleCloudAgentsTickHttp } from "@/server/console/cloud-agents/tick";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handleCloudAgentsTickHttp(request);
}

export async function POST(request: Request) {
  return handleCloudAgentsTickHttp(request);
}
