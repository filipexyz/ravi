import { readChatRoom } from "@/server/console/pages/chat-rooms/service";
import { handleChatRoomRequest } from "@/server/console/pages/chat-rooms/http";

export const runtime = "nodejs";

/** Marks the room read up to a seq for the person. */
export async function POST(request: Request) {
  return handleChatRoomRequest(request, (body, requestId) => readChatRoom(body, requestId));
}
