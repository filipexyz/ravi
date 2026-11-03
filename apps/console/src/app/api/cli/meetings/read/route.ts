import { type NextRequest } from "next/server";

import { authenticateCliRequest } from "@/server/cli/auth";
import { cliFailure, cliSuccess, readJsonBody, requestIdFrom } from "@/server/cli/http";
import { readMeetingFromCli } from "@/server/console/meetings/cli";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const requestId = requestIdFrom(request);
  try {
    const auth = await authenticateCliRequest(request, requestId);
    const body = await readJsonBody(request, requestId, { maxBytes: 8_192 });
    const payload = await readMeetingFromCli({ auth, body, requestId });
    return cliSuccess(payload, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const response = cliFailure(error, requestId);
    response.headers.set("cache-control", "no-store");
    return response;
  }
}
