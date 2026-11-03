import { handleConsoleToolsCallRequest } from "@/server/mcp/console-tools";

export const runtime = "nodejs";

/** Worker -> Console (HMAC): run one Console operation as the person; writes return a preview first. */
export async function POST(request: Request) {
  return handleConsoleToolsCallRequest(request);
}
