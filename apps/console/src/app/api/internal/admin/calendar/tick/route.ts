import { handleCalendarTickHttp } from "@/server/console/calendar/tick";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handleCalendarTickHttp(request);
}

export async function POST(request: Request) {
  return handleCalendarTickHttp(request);
}
