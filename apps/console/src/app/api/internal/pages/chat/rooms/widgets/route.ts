import { loadChatWidgets } from "@/server/console/pages/chat-rooms/service";
import { handleChatRoomRequest } from "@/server/console/pages/chat-rooms/http";

export const runtime = "nodejs";

/** Compiled Library widgets by ref and the theme CSS, for UI blocks in replies. */
export async function POST(request: Request) {
  return handleChatRoomRequest(request, (body, requestId) => loadChatWidgets(body, requestId));
}
