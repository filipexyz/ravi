import { handleConsoleToolsListRequest } from "@/server/mcp/console-tools";

export const runtime = "nodejs";

/** Worker -> Console (HMAC): the Console operations this person may call over MCP. */
export async function POST(request: Request) {
  return handleConsoleToolsListRequest(request);
}
