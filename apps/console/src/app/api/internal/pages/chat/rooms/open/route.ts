import { openChatRoom } from "@/server/console/pages/chat-rooms/service";
import { handleChatRoomRequest } from "@/server/console/pages/chat-rooms/http";

export const runtime = "nodejs";

/** The Pages Worker opens a room for the person in the panel: the route's shared room or their private one. */
export async function POST(request: Request) {
  return handleChatRoomRequest(request, (body, requestId) => openChatRoom(body, requestId));
}
