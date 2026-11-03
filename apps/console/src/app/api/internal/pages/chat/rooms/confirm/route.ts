import { decideChatConfirmation } from "@/server/console/pages/chat-rooms/service";
import { handleChatRoomRequest } from "@/server/console/pages/chat-rooms/http";

export const runtime = "nodejs";

/** The person the agent asked confirms or cancels a write. */
export async function POST(request: Request) {
  return handleChatRoomRequest(request, (body, requestId) => decideChatConfirmation(body, requestId));
}
