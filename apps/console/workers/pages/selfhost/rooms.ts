import { AsyncLocalStorage } from "node:async_hooks";
import type { Server, ServerWebSocket } from "bun";
import { PageChatRoom, type ChatRoomDurableObjectId, type ChatRoomDurableObjectNamespace, type ChatRoomSocket } from "../src/chat-room";

export type RoomSocketData = { socket: BunRoomSocket; roomId: string };
type RequestScope = { request: Request; server: Server<RoomSocketData>; upgraded: boolean };

/** Bun socket transport only. All authorization still runs in handleChatRoomRequest. */
export class BunChatRooms implements ChatRoomDurableObjectNamespace {
  readonly scope = new AsyncLocalStorage<RequestScope>();
  private readonly rooms = new Map<string, { room: PageChatRoom; sockets: Set<BunRoomSocket> }>();

  idFromName(name: string): ChatRoomDurableObjectId { return { toString: () => name }; }
  get(id: ChatRoomDurableObjectId) {
    const name = id.toString();
    return { fetch: async (input: Request | string, init?: RequestInit) => {
      const request = new Request(input, init);
      const state = this.room(name);
      try { return await state.room.fetch(request); }
      finally { if (!state.sockets.size) this.rooms.delete(name); }
    } };
  }

  private room(name: string) {
    const existing = this.rooms.get(name);
    if (existing) return existing;
    const sockets = new Set<BunRoomSocket>();
    const owner = this;
    class BunRoom extends PageChatRoom {
      protected override createPair() {
        const socket = new BunRoomSocket(() => {
          sockets.delete(socket);
          if (!sockets.size) owner.rooms.delete(name);
        });
        return { 0: socket, 1: socket };
      }
      protected override upgradeResponse(client: unknown): Response {
        const socket = client as BunRoomSocket;
        const scope = owner.scope.getStore();
        if (!scope || !scope.server.upgrade(scope.request, { data: { socket, roomId: name } })) {
          socket.close(1011, "upgrade_failed");
          return Response.json({ error: "chat_unavailable" }, { status: 503 });
        }
        scope.upgraded = true;
        // Bun performs the 101 response itself; this never reaches HTTP clients.
        return new Response(null, { status: 204 });
      }
    }
    const room = new BunRoom({
      acceptWebSocket(socket) { sockets.add(socket as BunRoomSocket); },
      getWebSockets(tag) {
        return [...sockets].filter((socket) => !tag || `u:${(socket.deserializeAttachment() as { userId?: string })?.userId}`.slice(0, 256) === tag);
      },
    });
    const state = { room, sockets };
    this.rooms.set(name, state);
    return state;
  }

  readonly websocket = {
    maxPayloadLength: 1024,
    backpressureLimit: 512 * 1024,
    closeOnBackpressureLimit: true,
    idleTimeout: 90,
    open: (ws: ServerWebSocket<RoomSocketData>) => ws.data.socket.bind(ws),
    message: (ws: ServerWebSocket<RoomSocketData>, message: string | Buffer) => {
      const room = this.rooms.get(ws.data.roomId);
      if (room) void room.room.webSocketMessage(ws.data.socket, typeof message === "string" ? message : new ArrayBuffer(0));
    },
    close: (ws: ServerWebSocket<RoomSocketData>, code: number, reason: string) => {
      const room = this.rooms.get(ws.data.roomId);
      ws.data.socket.detach();
      if (room) void room.room.webSocketClose(ws.data.socket, code, reason, true);
    },
  };

  close() { for (const { sockets } of this.rooms.values()) for (const socket of sockets) socket.close(1012, "service_restart"); }
}

class BunRoomSocket implements ChatRoomSocket {
  private attachment: unknown;
  private ws?: ServerWebSocket<RoomSocketData>;
  private pending: string[] = [];
  private closed = false;
  private expiry?: ReturnType<typeof setTimeout>;
  constructor(private readonly remove: () => void) {}
  bind(ws: ServerWebSocket<RoomSocketData>) {
    this.ws = ws;
    if (this.closed) { ws.close(1011, "closed"); return; }
    for (const data of this.pending) ws.send(data);
    this.pending = [];
    // Reconnect must reauthorize through Console. Durable history catches up by
    // seq; an old membership cannot keep an indefinitely authorized live socket.
    this.expiry = setTimeout(() => this.close(4001, "reauthorize"), 60_000);
    this.expiry.unref();
  }
  send(data: string) {
    if (this.closed) throw new Error("socket_closed");
    if (this.ws) this.ws.send(data);
    else if (this.pending.length < 256) this.pending.push(data);
    else this.close(1013, "backpressure");
  }
  close(code = 1000, reason = "bye") { this.detach(); this.ws?.close(code, reason); }
  detach() { this.closed = true; this.pending = []; if (this.expiry) clearTimeout(this.expiry); this.remove(); }
  serializeAttachment(value: unknown) { this.attachment = value; }
  deserializeAttachment() { return this.attachment; }
}
