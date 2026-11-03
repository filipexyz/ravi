import { handleMetricsTickHttp } from "@/server/console/metrics/http";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handleMetricsTickHttp(request);
}

export async function POST(request: Request) {
  return handleMetricsTickHttp(request);
}
