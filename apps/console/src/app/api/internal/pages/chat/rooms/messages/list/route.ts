import { listChatMessages } from "@/server/console/pages/chat-rooms/service";
import { handleChatRoomRequest } from "@/server/console/pages/chat-rooms/http";

export const runtime = "nodejs";

/** Messages after or before a seq, for catch-up and history. */
export async function POST(request: Request) {
  return handleChatRoomRequest(request, (body, requestId) => listChatMessages(body, requestId));
}
