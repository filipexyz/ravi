import { expect, test } from "bun:test";
import worker, { type PagesWorkerEnv } from "../src/index";
import { BunChatRooms, type RoomSocketData } from "./rooms";

test("Bun socket transport keeps Console authorization, event fanout and reconnect/catchup contract", async () => {
  let authorizeCalls = 0;
  let revoked = false;
  const consoleServer = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    authorizeCalls++;
    expect(request.headers.get("authorization")).toBe("Bearer synthetic-control");
    const input = await request.json() as Record<string, unknown>;
    expect(input.host).toBe("site.pages.example");
    expect(input.pagesSession).toBe("synthetic-session-for-pages-test-0001");
    return revoked ? Response.json({ error: "chat_forbidden" }, { status: 403 }) : Response.json({ room: { id: "room-1" }, viewer: { userId: "user-1", displayName: "Test", role: "member" } });
  } });
  const rooms = new BunChatRooms();
  const env: PagesWorkerEnv = { RAVI_CONSOLE_API_URL: consoleServer.url.toString(), RAVI_PAGES_CONTROL_TOKEN: "synthetic-control", RAVI_PAGES_ASSETS: { get: async () => null }, RAVI_PAGES_CHAT_ROOMS: rooms };
  const server = Bun.serve<RoomSocketData>({ port: 0, hostname: "127.0.0.1", websocket: rooms.websocket, async fetch(request, server) {
    const canonical = new Request(`https://site.pages.example${new URL(request.url).pathname}${new URL(request.url).search}`, request);
    const scope = { request, server, upgraded: false };
    return rooms.scope.run(scope, async () => {
      const response = await worker.fetch(canonical, env);
      return scope.upgraded ? undefined : response;
    });
  } });
  const headers = { origin: "https://site.pages.example", cookie: "__Host-ravi_page_session=synthetic-session-for-pages-test-0001" };
  const socketUrl = `${server.url.toString().replace("http:", "ws:")}_ravi/chat/socket?roomId=room-1&path=/report`;
  const NativeWebSocket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;
  let socket: WebSocket | undefined;
  try {
    const noCookie = await fetch(new URL("/_ravi/chat/socket?roomId=room-1", server.url), { headers: { upgrade: "websocket", origin: headers.origin } });
    expect(noCookie.status).toBe(401);
    const crossOrigin = await fetch(new URL("/_ravi/chat/socket?roomId=room-1", server.url), { headers: { ...headers, upgrade: "websocket", origin: "https://other.example" } });
    expect(crossOrigin.status).toBe(403);
    expect(authorizeCalls).toBe(0);
    const wrongRoom = await fetch(new URL("/_ravi/chat/socket?roomId=room-other", server.url), { headers: { ...headers, upgrade: "websocket" } });
    expect(wrongRoom.status).toBe(403);
    socket = new NativeWebSocket(socketUrl, { headers });
    const messages: Array<Record<string, unknown>> = [];
    socket.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data))));
    await new Promise<void>((resolve, reject) => { socket!.addEventListener("open", () => resolve(), { once: true }); socket!.addEventListener("error", () => reject(new Error("socket_failed")), { once: true }); });
    await waitFor(() => messages.some((m) => m.type === "presence"));
    socket.send('{"type":"ping"}');
    await waitFor(() => messages.some((m) => m.type === "pong"));
    const events = [{ type: "message.created", roomId: "room-1", message: { id: "message-1", seq: 1 } }];
    const denied = await fetch(new URL("/_ravi/chat/internal/rooms/room-1/events", server.url), { method: "POST", body: JSON.stringify({ events }) });
    expect(denied.status).toBe(401);
    const published = await fetch(new URL("/_ravi/chat/internal/rooms/room-1/events", server.url), { method: "POST", headers: { authorization: "Bearer synthetic-control", "content-type": "application/json" }, body: JSON.stringify({ events }) });
    expect(published.status).toBe(200);
    await waitFor(() => messages.some((m) => m.type === "event"));
    expect(messages.find((m) => m.type === "event")?.event).toEqual(events[0]);
    socket.close();
    revoked = true;
    const reconnect = await fetch(new URL("/_ravi/chat/socket?roomId=room-1", server.url), { headers: { ...headers, upgrade: "websocket" } });
    expect(reconnect.status).toBe(403);
  } finally { socket?.close(); rooms.close(); await server.stop(true); await consoleServer.stop(true); }
});

async function waitFor(predicate: () => boolean) {
  const end = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("socket_event_timeout");
    await Bun.sleep(10);
  }
}
