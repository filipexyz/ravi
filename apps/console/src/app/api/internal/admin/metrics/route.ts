import { handleMetricsSummaryHttp } from "@/server/console/metrics/http";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handleMetricsSummaryHttp(request);
}
