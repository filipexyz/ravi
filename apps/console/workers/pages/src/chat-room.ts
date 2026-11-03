// Page chat rooms on the Pages Worker: the `/_ravi/chat*` routes and the
// PageChatRoom Durable Object. The Console owns every message (K2); this
// Worker only authorizes sockets through the Console, proxies the panel's
// writes with the viewer's Pages session, and fans Console room events out to
// the sockets of one room. The Durable Object keeps nothing durable except the
// per-socket attachment hibernation needs, so an idle room costs nothing.
//
// Contract: /mnt/project-files/pages-chat/build/CONTRACT.md and
// .ravi/specs/console/pages/chat-rooms/{SPEC,WORKER}.md.

import { chatPanelHtml, chatPanelPolicy } from "./chat-panel";

export interface ChatRoomDurableObjectId {
  toString(): string;
}

export interface ChatRoomDurableObjectStub {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

export interface ChatRoomDurableObjectNamespace {
  idFromName(name: string): ChatRoomDurableObjectId;
  get(id: ChatRoomDurableObjectId): ChatRoomDurableObjectStub;
}

/** The hibernation-capable server end of a WebSocket, as the runtime hands it to the Durable Object. */
export interface ChatRoomSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

/** The subset of DurableObjectState the room uses (WebSocket Hibernation API). */
export interface ChatRoomDurableObjectState {
  acceptWebSocket(socket: ChatRoomSocket, tags?: string[]): void;
  getWebSockets(tag?: string): ChatRoomSocket[];
  setWebSocketAutoResponse?(pair: unknown): void;
}

/** The parts of the Pages Worker environment chat rooms read. */
export interface ChatRoomEnv {
  RAVI_CONSOLE_API_URL: string;
  RAVI_PAGES_CONTROL_TOKEN?: string;
  RAVI_PAGES_AUTH_START_PATH?: string;
  /** Prefix of the Console room endpoints; defaults to /api/internal/pages/chat/rooms. */
  RAVI_PAGES_CHAT_ROOMS_PATH?: string;
  /** Isolated origin for the panel (K10), e.g. https://chat.ravi.page. Unset = same origin. */
  RAVI_PAGES_CHAT_ORIGIN?: string;
  RAVI_PAGES_CHAT_ROOMS?: ChatRoomDurableObjectNamespace;
}

export type ChatViewer = {
  userId: string;
  displayName: string;
  role: "member" | "guest";
};

type SocketAttachment = ChatViewer & {
  joinedAt: number;
  /** Last relayed typing signal, for the per-socket rate limit. */
  typingAt: number;
};

const DEFAULT_ROOMS_PATH = "/api/internal/pages/chat/rooms";
const DEFAULT_AUTH_START_PATH = "/api/pages/auth/start";
const NO_STORE = "private, no-store";
const MAX_PROXY_BODY_BYTES = 32 * 1024;
const MAX_EVENTS_BODY_BYTES = 512 * 1024;
const MAX_EVENTS_PER_POST = 200;
const MAX_SOCKET_MESSAGE_BYTES = 1024;
const MAX_SOCKETS_PER_ROOM = 256;
const MAX_SOCKETS_PER_USER = 12;
const TYPING_INTERVAL_MS = 1500;
const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const HOST_PATTERN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
/** The ping frame the panel sends; answered by the runtime without waking the room. */
export const CHAT_PING_FRAME = '{"type":"ping"}';
export const CHAT_PONG_FRAME = '{"type":"pong"}';
const ROOM_EVENT_TYPES = new Set(["message.created", "message.updated", "message.delta", "message.deleted", "turn.status"]);

/** Fields the browser may send to each proxied endpoint. host and pagesSession never come from the body. */
const PROXY_FIELDS: Record<string, { console: string; fields: string[] }> = {
  open: { console: "/open", fields: ["path", "kind"] },
  send: { console: "/messages/send", fields: ["roomId", "clientMessageId", "text", "anchor", "action", "source", "speaker"] },
  list: { console: "/messages/list", fields: ["roomId", "afterSeq", "beforeSeq", "limit"] },
  delete: { console: "/messages/delete", fields: ["roomId", "messageId"] },
  read: { console: "/read", fields: ["roomId", "seq"] },
  confirm: { console: "/confirm", fields: ["roomId", "confirmationId", "decision"] },
  widgets: { console: "/widgets", fields: ["refs"] },
};

export function chatRoomPaths(reservedPrefix: string) {
  const base = `${reservedPrefix}chat`;
  return {
    base,
    shellSlash: `${base}/`,
    socket: `${base}/socket`,
    internalRooms: `${base}/internal/rooms/`,
    proxy: (name: string) => `${base}/${name}`,
  };
}

/** True for `/_ravi/chat` and everything below it (not `/_ravi/chat-x`). */
export function isChatRoomPath(pathname: string, reservedPrefix: string): boolean {
  const { base } = chatRoomPaths(reservedPrefix);
  return pathname === base || pathname.startsWith(`${base}/`);
}

/** Routes `/_ravi/chat*`. Returns null for any other path. */
export async function handleChatRoomRequest(input: {
  request: Request;
  env: ChatRoomEnv;
  url: URL;
  requestId: string;
  reservedPrefix: string;
  pagesSession: string | null;
  isSameOrigin: boolean;
  isControlAuthorized: () => Promise<boolean>;
}): Promise<Response | null> {
  const { request, url, reservedPrefix, requestId } = input;
  if (!isChatRoomPath(url.pathname, reservedPrefix)) return null;
  const paths = chatRoomPaths(reservedPrefix);
  const { pathname } = url;

  if (pathname.startsWith(paths.internalRooms)) return relayRoomEvents(input);

  if (pathname === paths.base || pathname === paths.shellSlash) {
    if (request.method !== "GET" && request.method !== "HEAD") return chatJson({ error: "method_not_allowed" }, 405, requestId);
    return panelResponse(input);
  }

  if (pathname === paths.socket) return openRoomSocket(input);

  const name = pathname.slice(paths.base.length + 1);
  if (Object.hasOwn(PROXY_FIELDS, name)) return proxyToConsole(input, name);

  return chatJson({ error: "not_found" }, 404, requestId);
}

/**
 * The page host a chat request acts for. On the page's own host it is that
 * host; on the isolated chat origin (K10) it is the `host` query parameter
 * (shell, socket) or the `x-ravi-chat-host` header (writes), validated as a
 * hostname. The Console still checks the Pages session against it.
 */
export function chatPageHost(request: Request, url: URL, env: Pick<ChatRoomEnv, "RAVI_PAGES_CHAT_ORIGIN">): string | null {
  const chatOrigin = parsedChatOrigin(env);
  if (!chatOrigin || chatOrigin.host !== url.host) return url.hostname;
  const candidate = (url.searchParams.get("host") ?? request.headers.get("x-ravi-chat-host") ?? "").trim().toLowerCase();
  return HOST_PATTERN.test(candidate) && candidate !== chatOrigin.hostname ? candidate : null;
}

export function parsedChatOrigin(env: Pick<ChatRoomEnv, "RAVI_PAGES_CHAT_ORIGIN">): URL | null {
  const raw = env.RAVI_PAGES_CHAT_ORIGIN?.trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" && parsed.hostname !== "localhost") return null;
    return new URL(parsed.origin);
  } catch {
    return null;
  }
}

/** The route path a chat room is for: same origin, never the reserved namespace, without query or hash. */
export function chatRoomPath(value: unknown, reservedPrefix: string): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\") || value.length > 2048) return "/";
  let parsed: URL;
  try {
    parsed = new URL(value, "https://page.invalid");
  } catch {
    return "/";
  }
  if (parsed.origin !== "https://page.invalid" || parsed.pathname.startsWith(reservedPrefix)) return "/";
  return parsed.pathname;
}

export function chatRoomKind(value: unknown): "shared" | "private" {
  return value === "private" ? "private" : "shared";
}

function panelResponse(input: {
  request: Request;
  env: ChatRoomEnv;
  url: URL;
  requestId: string;
  reservedPrefix: string;
}): Response {
  const { request, env, url, reservedPrefix, requestId } = input;
  const host = chatPageHost(request, url, env);
  if (!host) return chatJson({ error: "payload_invalid" }, 400, requestId);
  const onChatOrigin = host !== url.hostname;
  const path = chatRoomPath(url.searchParams.get("path"), reservedPrefix);
  const mode = url.searchParams.get("mode") === "page" ? "page" : "panel";
  const kind = chatRoomKind(url.searchParams.get("kind"));
  const nonce = randomNonce();
  const html = chatPanelHtml({
    nonce,
    mode,
    kind,
    path,
    host: onChatOrigin ? host : null,
    parentOrigin: onChatOrigin ? `https://${host}` : null,
    base: chatRoomPaths(reservedPrefix).base,
    loginUrl: pagesAuthStartUrl(env, `https://${host}${path}`),
  });
  const headers = new Headers({
    "cache-control": "no-store",
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": chatPanelPolicy({
      nonce,
      socketOrigin: `wss://${url.host}`,
      frameAncestors: onChatOrigin ? `https://${host}` : "'self'",
    }),
    "permissions-policy": "microphone=(), camera=(), geolocation=(), payment=(), usb=()",
    "referrer-policy": "same-origin",
    "x-content-type-options": "nosniff",
    "x-request-id": requestId,
  });
  // CSP frame-ancestors is the rule; X-Frame-Options only backs it up on the same origin.
  if (!onChatOrigin) headers.set("x-frame-options", "SAMEORIGIN");
  return new Response(request.method === "HEAD" ? null : html, { status: 200, headers });
}

/** Console auth start for a page URL: the same entry the Worker redirects to elsewhere. */
export function pagesAuthStartUrl(env: Pick<ChatRoomEnv, "RAVI_CONSOLE_API_URL" | "RAVI_PAGES_AUTH_START_PATH">, returnTo: string): string | null {
  try {
    const endpoint = new URL(env.RAVI_PAGES_AUTH_START_PATH ?? DEFAULT_AUTH_START_PATH, env.RAVI_CONSOLE_API_URL);
    endpoint.searchParams.set("returnTo", returnTo);
    return endpoint.toString();
  } catch {
    return null;
  }
}

type OpenedRoom = {
  room?: { id?: unknown };
  viewer?: { userId?: unknown; displayName?: unknown; role?: unknown };
  error?: unknown;
};

/** POSTs one Console room endpoint with the control token. */
async function callConsole(env: ChatRoomEnv, path: string, body: Record<string, unknown>, requestId: string): Promise<Response> {
  const endpoint = new URL(`${(env.RAVI_PAGES_CHAT_ROOMS_PATH ?? DEFAULT_ROOMS_PATH).replace(/\/+$/, "")}${path}`, env.RAVI_CONSOLE_API_URL);
  return fetch(endpoint.toString(), {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${env.RAVI_PAGES_CONTROL_TOKEN ?? ""}`,
      "content-type": "application/json",
      "x-request-id": requestId,
    },
    body: JSON.stringify(body),
  });
}

async function openRoomSocket(input: {
  request: Request;
  env: ChatRoomEnv;
  url: URL;
  requestId: string;
  reservedPrefix: string;
  pagesSession: string | null;
  isSameOrigin: boolean;
}): Promise<Response> {
  const { request, env, url, requestId } = input;
  if (request.method !== "GET") return chatJson({ error: "method_not_allowed" }, 405, requestId);
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return chatJson({ error: "websocket_required" }, 426, requestId);
  // Browsers always send Origin on a WebSocket handshake; a missing or foreign one is refused.
  if (!request.headers.get("origin") || !input.isSameOrigin) return chatJson({ error: "chat_forbidden" }, 403, requestId);
  if (!input.pagesSession) return chatJson({ error: "chat_session_required" }, 401, requestId);
  if (!env.RAVI_PAGES_CHAT_ROOMS) return chatJson({ error: "chat_unavailable" }, 503, requestId);
  const host = chatPageHost(request, url, env);
  const requestedRoomId = url.searchParams.get("roomId") ?? "";
  if (!host || !ROOM_ID_PATTERN.test(requestedRoomId)) return chatJson({ error: "payload_invalid" }, 400, requestId);

  // The room comes from the Console for this viewer, never from the browser.
  let opened: Response;
  try {
    opened = await callConsole(
      env,
      "/open",
      {
        host,
        path: chatRoomPath(url.searchParams.get("path"), input.reservedPrefix),
        pagesSession: input.pagesSession,
        kind: chatRoomKind(url.searchParams.get("kind")),
      },
      requestId,
    );
  } catch {
    return chatJson({ error: "chat_unavailable" }, 503, requestId);
  }
  const payload = (await opened.json().catch(() => null)) as OpenedRoom | null;
  if (!opened.ok) {
    return chatJson({ error: typeof payload?.error === "string" ? payload.error : "chat_unavailable" }, opened.status, requestId);
  }
  const roomId = typeof payload?.room?.id === "string" ? payload.room.id : "";
  const viewer = viewerFrom(payload?.viewer);
  if (!roomId || !viewer) return chatJson({ error: "chat_unavailable" }, 503, requestId);
  if (roomId !== requestedRoomId) return chatJson({ error: "chat_forbidden" }, 403, requestId);

  const stub = env.RAVI_PAGES_CHAT_ROOMS.get(env.RAVI_PAGES_CHAT_ROOMS.idFromName(roomId));
  return stub.fetch("https://chat-room.internal/connect", {
    method: "GET",
    headers: {
      upgrade: "websocket",
      "x-request-id": requestId,
      "x-ravi-chat-viewer": encodeURIComponent(JSON.stringify(viewer)),
    },
  });
}

function viewerFrom(value: OpenedRoom["viewer"]): ChatViewer | null {
  if (!value || typeof value.userId !== "string" || !value.userId) return null;
  const displayName = typeof value.displayName === "string" && value.displayName.trim() ? value.displayName.trim().slice(0, 80) : "Visitante";
  return { userId: value.userId.slice(0, 128), displayName, role: value.role === "guest" ? "guest" : "member" };
}

async function proxyToConsole(
  input: {
    request: Request;
    env: ChatRoomEnv;
    url: URL;
    requestId: string;
    reservedPrefix: string;
    pagesSession: string | null;
    isSameOrigin: boolean;
  },
  name: string,
): Promise<Response> {
  const { request, env, url, requestId } = input;
  if (request.method !== "POST") return chatJson({ error: "method_not_allowed" }, 405, requestId);
  if (!input.isSameOrigin) return chatJson({ error: "chat_forbidden" }, 403, requestId);
  if (!input.pagesSession) return chatJson({ error: "chat_session_required" }, 401, requestId);
  const host = chatPageHost(request, url, env);
  if (!host) return chatJson({ error: "payload_invalid" }, 400, requestId);

  const raw = await boundedText(request, MAX_PROXY_BODY_BYTES);
  if (raw === null) return chatJson({ error: "payload_invalid" }, 413, requestId);
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw || "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return chatJson({ error: "payload_invalid" }, 400, requestId);
  }

  const route = PROXY_FIELDS[name]!;
  const payload: Record<string, unknown> = {};
  for (const field of route.fields) {
    if (body[field] !== undefined) payload[field] = body[field];
  }
  if (name === "open") {
    payload.path = chatRoomPath(body.path, input.reservedPrefix);
    payload.kind = chatRoomKind(body.kind);
  }
  payload.host = host;
  payload.pagesSession = input.pagesSession;

  let response: Response;
  try {
    response = await callConsole(env, route.console, payload, requestId);
  } catch {
    return chatJson({ error: "chat_unavailable" }, 503, requestId);
  }
  const text = await response.text();
  return new Response(text, { status: response.status, headers: jsonHeaders(requestId) });
}

async function relayRoomEvents(input: {
  request: Request;
  env: ChatRoomEnv;
  url: URL;
  requestId: string;
  reservedPrefix: string;
  isControlAuthorized: () => Promise<boolean>;
}): Promise<Response> {
  const { request, env, url, requestId, reservedPrefix } = input;
  const rest = url.pathname.slice(chatRoomPaths(reservedPrefix).internalRooms.length);
  const match = rest.match(/^([^/]+)\/events$/);
  if (!match) return chatJson({ error: "not_found" }, 404, requestId);
  if (request.method !== "POST") return chatJson({ error: "method_not_allowed" }, 405, requestId);
  if (!(await input.isControlAuthorized())) return chatJson({ error: "unauthorized" }, 401, requestId);
  const roomId = decodeURIComponentSafe(match[1]!);
  if (!roomId || !ROOM_ID_PATTERN.test(roomId)) return chatJson({ error: "payload_invalid" }, 400, requestId);
  if (!env.RAVI_PAGES_CHAT_ROOMS) return chatJson({ error: "chat_unavailable" }, 503, requestId);

  const raw = await boundedText(request, MAX_EVENTS_BODY_BYTES);
  if (raw === null) return chatJson({ error: "payload_invalid" }, 413, requestId);
  const events = parseRoomEvents(raw);
  if (!events) return chatJson({ error: "payload_invalid" }, 400, requestId);

  const stub = env.RAVI_PAGES_CHAT_ROOMS.get(env.RAVI_PAGES_CHAT_ROOMS.idFromName(roomId));
  const relayed = await stub.fetch("https://chat-room.internal/events", {
    method: "POST",
    headers: { "content-type": "application/json", "x-request-id": requestId },
    body: JSON.stringify({ events }),
  });
  return new Response(await relayed.text(), { status: relayed.status, headers: jsonHeaders(requestId) });
}

/** `{events: RoomEvent[]}` with known event types only; anything else is refused whole. */
export function parseRoomEvents(raw: string): Array<Record<string, unknown>> | null {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return null;
  }
  const events = (body as { events?: unknown } | null)?.events;
  if (!Array.isArray(events) || events.length === 0 || events.length > MAX_EVENTS_PER_POST) return null;
  for (const event of events) {
    if (!event || typeof event !== "object" || Array.isArray(event)) return null;
    if (!ROOM_EVENT_TYPES.has(String((event as { type?: unknown }).type))) return null;
  }
  return events as Array<Record<string, unknown>>;
}

/** Reads a body up to `limit` bytes; null when content-length or the bytes read exceed it. */
async function boundedText(request: Request, limit: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

type WebSocketPairLike = { 0: ChatRoomSocket & { accept?(): void }; 1: ChatRoomSocket };

/**
 * One Page chat room: the live sockets of every viewer of one room. Uses the
 * WebSocket Hibernation API, so the object sleeps between events; each socket
 * carries its viewer as an attachment. Nothing else is stored.
 */
export class PageChatRoom {
  constructor(
    private readonly ctx: ChatRoomDurableObjectState,
    _env?: unknown,
  ) {
    // Pings are answered by the runtime without waking the room.
    const Pair = (globalThis as { WebSocketRequestResponsePair?: new (request: string, response: string) => unknown })
      .WebSocketRequestResponsePair;
    if (Pair && ctx.setWebSocketAutoResponse) {
      try {
        ctx.setWebSocketAutoResponse(new Pair(CHAT_PING_FRAME, CHAT_PONG_FRAME));
      } catch {
        // Older runtimes: webSocketMessage answers pings.
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/connect") return this.connect(request);
    if (url.pathname === "/events" && request.method === "POST") {
      const events = parseRoomEvents(await request.text());
      if (!events) return Response.json({ error: "payload_invalid" }, { status: 400 });
      let delivered = 0;
      for (const event of events) delivered = this.broadcast({ type: "event", event });
      return Response.json({ ok: true, sockets: delivered });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  private connect(request: Request): Response {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return Response.json({ error: "websocket_required" }, { status: 426 });
    }
    const viewer = parseViewerHeader(request.headers.get("x-ravi-chat-viewer"));
    if (!viewer) return Response.json({ error: "payload_invalid" }, { status: 400 });
    const sockets = this.ctx.getWebSockets();
    if (sockets.length >= MAX_SOCKETS_PER_ROOM) return Response.json({ error: "chat_rate_limited" }, { status: 429 });
    if (this.ctx.getWebSockets(userTag(viewer.userId)).length >= MAX_SOCKETS_PER_USER) {
      return Response.json({ error: "chat_rate_limited" }, { status: 429 });
    }

    const pair = this.createPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [userTag(viewer.userId)]);
    server.serializeAttachment({ ...viewer, joinedAt: Date.now(), typingAt: 0 } satisfies SocketAttachment);
    this.broadcastPresence();
    return this.upgradeResponse(client);
  }

  /** Overridable in tests; the runtime provides WebSocketPair. */
  protected createPair(): WebSocketPairLike {
    const Pair = (globalThis as { WebSocketPair?: new () => WebSocketPairLike }).WebSocketPair;
    if (!Pair) throw new Error("WebSocketPair is not available");
    return new Pair();
  }

  protected upgradeResponse(client: unknown): Response {
    return new Response(null, { status: 101, webSocket: client } as ResponseInit);
  }

  async webSocketMessage(socket: ChatRoomSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string" || message.length > MAX_SOCKET_MESSAGE_BYTES) return;
    let frame: { type?: unknown };
    try {
      frame = JSON.parse(message) as { type?: unknown };
    } catch {
      return;
    }
    const attachment = readAttachment(socket);
    if (!attachment) return;
    if (frame.type === "ping") {
      safeSend(socket, CHAT_PONG_FRAME);
      return;
    }
    if (frame.type === "typing") {
      const now = Date.now();
      if (now - attachment.typingAt < TYPING_INTERVAL_MS) return;
      attachment.typingAt = now;
      socket.serializeAttachment(attachment);
      this.broadcast({ type: "typing", userId: attachment.userId, displayName: attachment.displayName }, socket);
    }
  }

  async webSocketClose(socket: ChatRoomSocket, code: number, _reason: string, _wasClean: boolean): Promise<void> {
    try {
      socket.close(code === 1005 || code === 1006 ? 1000 : code, "bye");
    } catch {
      // Already closed.
    }
    this.broadcastPresence(socket);
  }

  async webSocketError(socket: ChatRoomSocket): Promise<void> {
    try {
      socket.close(1011, "error");
    } catch {
      // Already closed.
    }
    this.broadcastPresence(socket);
  }

  /** Online viewers, one entry per user, in join order. */
  private presence(except?: ChatRoomSocket) {
    const online = new Map<string, { userId: string; displayName: string }>();
    const sockets = this.ctx
      .getWebSockets()
      .filter((socket) => socket !== except)
      .map((socket) => readAttachment(socket))
      .filter((attachment): attachment is SocketAttachment => Boolean(attachment))
      .sort((left, right) => left.joinedAt - right.joinedAt);
    for (const attachment of sockets) {
      if (!online.has(attachment.userId)) online.set(attachment.userId, { userId: attachment.userId, displayName: attachment.displayName });
    }
    return [...online.values()];
  }

  private broadcastPresence(except?: ChatRoomSocket) {
    this.broadcast({ type: "presence", online: this.presence(except) }, undefined, except);
  }

  /** Sends to every socket but `skip` (the typing sender) and `gone` (a closing socket). Returns how many got it. */
  private broadcast(frame: unknown, skip?: ChatRoomSocket, gone?: ChatRoomSocket): number {
    const data = JSON.stringify(frame);
    let sent = 0;
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === skip || socket === gone) continue;
      if (safeSend(socket, data)) sent += 1;
    }
    return sent;
  }
}

function userTag(userId: string) {
  return `u:${userId}`.slice(0, 256);
}

function parseViewerHeader(value: string | null): ChatViewer | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(value)) as OpenedRoom["viewer"];
    return viewerFrom(parsed);
  } catch {
    return null;
  }
}

function readAttachment(socket: ChatRoomSocket): SocketAttachment | null {
  try {
    const value = socket.deserializeAttachment() as SocketAttachment | null;
    return value && typeof value.userId === "string" ? value : null;
  } catch {
    return null;
  }
}

function safeSend(socket: ChatRoomSocket, data: string): boolean {
  try {
    socket.send(data);
    return true;
  } catch {
    return false;
  }
}

function decodeURIComponentSafe(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

function randomNonce() {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, (char) => (char === "+" ? "-" : char === "/" ? "_" : ""));
}

function jsonHeaders(requestId: string) {
  return new Headers({
    "cache-control": NO_STORE,
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    "x-request-id": requestId,
  });
}

function chatJson(payload: unknown, status: number, requestId: string): Response {
  return new Response(JSON.stringify(payload), { status, headers: jsonHeaders(requestId) });
}
