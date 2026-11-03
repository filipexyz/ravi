import { handleBasesTickHttp } from "@/server/console/bases/tick";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handleBasesTickHttp(request);
}

export async function POST(request: Request) {
  return handleBasesTickHttp(request);
}
