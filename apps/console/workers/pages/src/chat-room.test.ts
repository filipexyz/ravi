import { describe, expect, test } from "bun:test";

import {
  CHAT_PING_FRAME,
  chatPageHost,
  chatRoomPath,
  isChatRoomPath,
  PageChatRoom,
  parseRoomEvents,
  type ChatRoomDurableObjectState,
  type ChatRoomSocket,
} from "./chat-room";

type FakeSocket = ChatRoomSocket & { tags: string[]; sent: Array<Record<string, unknown>>; closed: boolean };

function fakeSocket(): FakeSocket {
  let attachment: unknown = null;
  const socket: FakeSocket = {
    tags: [],
    sent: [],
    closed: false,
    send(data: string) {
      if (socket.closed) throw new Error("closed");
      socket.sent.push(JSON.parse(data));
    },
    close() {
      socket.closed = true;
    },
    serializeAttachment(value: unknown) {
      attachment = structuredClone(value);
    },
    deserializeAttachment() {
      return structuredClone(attachment);
    },
  };
  return socket;
}

/** Like the runtime, a closing socket may still be listed while webSocketClose runs. */
function fakeState() {
  const sockets: FakeSocket[] = [];
  const state: ChatRoomDurableObjectState & { sockets: FakeSocket[] } = {
    sockets,
    acceptWebSocket(socket, tags) {
      (socket as FakeSocket).tags = tags ?? [];
      sockets.push(socket as FakeSocket);
    },
    getWebSockets(tag?: string) {
      return sockets.filter((socket) => !tag || socket.tags.includes(tag));
    },
  };
  return state;
}

class TestRoom extends PageChatRoom {
  protected override createPair() {
    return { 0: fakeSocket(), 1: fakeSocket() };
  }

  protected override upgradeResponse(_client: unknown): Response {
    return new Response(null, { status: 200, headers: { "x-test-upgraded": "1" } });
  }
}

function connect(room: PageChatRoom, viewer: Record<string, unknown> | null, upgrade = true) {
  const headers: Record<string, string> = {};
  if (upgrade) headers.upgrade = "websocket";
  if (viewer) headers["x-ravi-chat-viewer"] = encodeURIComponent(JSON.stringify(viewer));
  return room.fetch(new Request("https://chat-room.internal/connect", { headers }));
}

const ana = { userId: "user_ana", displayName: "Ana Lima", role: "member" };
const bruno = { userId: "user_bruno", displayName: "Bruno", role: "guest" };

describe("PageChatRoom", () => {
  test("accepts handed-over sockets with the viewer attachment and broadcasts deduped presence", async () => {
    const state = fakeState();
    const room = new TestRoom(state);

    expect((await connect(room, ana)).headers.get("x-test-upgraded")).toBe("1");
    expect((await connect(room, bruno)).status).toBe(200);
    expect((await connect(room, ana)).status).toBe(200);

    expect(state.sockets).toHaveLength(3);
    expect(state.sockets[0]!.tags).toEqual(["u:user_ana"]);
    expect(state.sockets[0]!.deserializeAttachment()).toMatchObject({ userId: "user_ana", displayName: "Ana Lima", role: "member" });
    const last = state.sockets[1]!.sent.at(-1);
    expect(last).toEqual({
      type: "presence",
      online: [
        { userId: "user_ana", displayName: "Ana Lima" },
        { userId: "user_bruno", displayName: "Bruno" },
      ],
    });
  });

  test("refuses connections without an upgrade or a viewer", async () => {
    const room = new TestRoom(fakeState());
    expect((await connect(room, ana, false)).status).toBe(426);
    expect((await connect(room, null)).status).toBe(400);
    expect((await connect(room, { displayName: "x" })).status).toBe(400);
  });

  test("relays typing to the others at most once per interval and answers pings", async () => {
    const state = fakeState();
    const room = new TestRoom(state);
    await connect(room, ana);
    await connect(room, bruno);
    const [anaSocket, brunoSocket] = state.sockets as [FakeSocket, FakeSocket];
    anaSocket.sent.length = 0;
    brunoSocket.sent.length = 0;

    await room.webSocketMessage(anaSocket, '{"type":"typing"}');
    await room.webSocketMessage(anaSocket, '{"type":"typing"}');
    expect(brunoSocket.sent).toEqual([{ type: "typing", userId: "user_ana", displayName: "Ana Lima" }]);
    expect(anaSocket.sent).toEqual([]);

    await room.webSocketMessage(anaSocket, CHAT_PING_FRAME);
    expect(anaSocket.sent).toEqual([{ type: "pong" }]);

    // Oversized, binary and unknown frames are ignored.
    await room.webSocketMessage(anaSocket, JSON.stringify({ type: "typing", pad: "x".repeat(2000) }));
    await room.webSocketMessage(anaSocket, new ArrayBuffer(4));
    await room.webSocketMessage(anaSocket, '{"type":"event","event":{}}');
    expect(brunoSocket.sent).toHaveLength(1);
  });

  test("fans Console events out verbatim to every socket", async () => {
    const state = fakeState();
    const room = new TestRoom(state);
    await connect(room, ana);
    await connect(room, bruno);
    for (const socket of state.sockets) socket.sent.length = 0;

    const event = { type: "message.delta", messageId: "m1", text: "Olá" };
    const response = await room.fetch(
      new Request("https://chat-room.internal/events", { method: "POST", body: JSON.stringify({ events: [event] }) }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, sockets: 2 });
    for (const socket of state.sockets) expect(socket.sent).toEqual([{ type: "event", event }]);

    const invalid = await room.fetch(
      new Request("https://chat-room.internal/events", { method: "POST", body: JSON.stringify({ events: [{ type: "nope" }] }) }),
    );
    expect(invalid.status).toBe(400);
  });

  test("drops a closing socket from presence even while the runtime still lists it", async () => {
    const state = fakeState();
    const room = new TestRoom(state);
    await connect(room, ana);
    await connect(room, bruno);
    const [anaSocket, brunoSocket] = state.sockets as [FakeSocket, FakeSocket];
    anaSocket.sent.length = 0;

    await room.webSocketClose(brunoSocket, 1001, "gone", true);
    expect(brunoSocket.closed).toBe(true);
    expect(anaSocket.sent).toEqual([{ type: "presence", online: [{ userId: "user_ana", displayName: "Ana Lima" }] }]);
  });

  test("caps sockets per viewer", async () => {
    const room = new TestRoom(fakeState());
    for (let index = 0; index < 12; index += 1) expect((await connect(room, ana)).status).toBe(200);
    expect((await connect(room, ana)).status).toBe(429);
    expect((await connect(room, bruno)).status).toBe(200);
  });
});

describe("chat room helpers", () => {
  test("keeps room paths on this site and out of the reserved namespace", () => {
    expect(chatRoomPath("/relatorio?x=1#y", "/_ravi/")).toBe("/relatorio");
    expect(chatRoomPath("//evil.example/x", "/_ravi/")).toBe("/");
    expect(chatRoomPath("https://evil.example/x", "/_ravi/")).toBe("/");
    expect(chatRoomPath("/_ravi/chat", "/_ravi/")).toBe("/");
    expect(chatRoomPath(42, "/_ravi/")).toBe("/");
  });

  test("matches only the chat namespace", () => {
    expect(isChatRoomPath("/_ravi/chat", "/_ravi/")).toBe(true);
    expect(isChatRoomPath("/_ravi/chat/send", "/_ravi/")).toBe(true);
    expect(isChatRoomPath("/_ravi/chatx", "/_ravi/")).toBe(false);
    expect(isChatRoomPath("/_ravi/page-chat", "/_ravi/")).toBe(false);
  });

  test("takes the page host from the query only on the isolated chat origin", () => {
    const env = { RAVI_PAGES_CHAT_ORIGIN: "https://chat.ravi.page" };
    const onPage = new URL("https://demo.ravi.page/_ravi/chat?host=evil.example");
    expect(chatPageHost(new Request(onPage), onPage, env)).toBe("demo.ravi.page");
    const onChat = new URL("https://chat.ravi.page/_ravi/chat?host=demo.ravi.page");
    expect(chatPageHost(new Request(onChat), onChat, env)).toBe("demo.ravi.page");
    const header = new URL("https://chat.ravi.page/_ravi/chat/send");
    expect(chatPageHost(new Request(header, { headers: { "x-ravi-chat-host": "Demo.Ravi.Page" } }), header, env)).toBe("demo.ravi.page");
    const bad = new URL("https://chat.ravi.page/_ravi/chat?host=a%20b");
    expect(chatPageHost(new Request(bad), bad, env)).toBeNull();
    const self = new URL("https://chat.ravi.page/_ravi/chat?host=chat.ravi.page");
    expect(chatPageHost(new Request(self), self, env)).toBeNull();
  });

  test("accepts only known room event types", () => {
    expect(parseRoomEvents('{"events":[{"type":"message.created","message":{}}]}')).toHaveLength(1);
    expect(parseRoomEvents('{"events":[]}')).toBeNull();
    expect(parseRoomEvents('{"events":[{"type":"presence"}]}')).toBeNull();
    expect(parseRoomEvents("not json")).toBeNull();
  });
});
