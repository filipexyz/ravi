import { deleteChatMessage } from "@/server/console/pages/chat-rooms/service";
import { handleChatRoomRequest } from "@/server/console/pages/chat-rooms/http";

export const runtime = "nodejs";

/** The author (or an org owner or admin) deletes a message. */
export async function POST(request: Request) {
  return handleChatRoomRequest(request, (body, requestId) => deleteChatMessage(body, requestId));
}
