import { sendChatMessage } from "@/server/console/pages/chat-rooms/service";
import { handleChatRoomRequest } from "@/server/console/pages/chat-rooms/http";

export const runtime = "nodejs";

/** A person posts a message; the agent answers when the room's reply rules call it. */
export async function POST(request: Request) {
  return handleChatRoomRequest(request, (body, requestId) => sendChatMessage(body, requestId));
}
