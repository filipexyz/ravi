// Page Chat on the Pages Worker: the voice frame, the session route and the
// PageChatSession Durable Object. Audio goes from the browser straight to
// OpenAI over WebRTC; this Worker only exchanges the SDP with the platform key,
// keeps a sideband socket to enforce the time cap and reports usage to the
// Console when the conversation ends.

import { pageChatShellHtml } from "./page-chat-shell";

export interface PageChatDurableObjectId {
  toString(): string;
}

export interface PageChatDurableObjectStub {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

export interface PageChatDurableObjectNamespace {
  idFromName(name: string): PageChatDurableObjectId;
  get(id: PageChatDurableObjectId): PageChatDurableObjectStub;
}

export interface PageChatDurableObjectStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
  deleteAlarm(): Promise<void>;
}

export interface PageChatDurableObjectState {
  storage: PageChatDurableObjectStorage;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}

/** The parts of the Pages Worker environment Page Chat reads. */
export interface PageChatEnv {
  RAVI_CONSOLE_API_URL: string;
  RAVI_PAGES_CONTROL_TOKEN?: string;
  RAVI_PAGES_CHAT_SESSION_PATH?: string;
  RAVI_PAGES_CHAT_CLOSE_PATH?: string;
  /** Platform OpenAI key, a Worker secret. Never sent to the browser or the Console. */
  OPENAI_API_KEY?: string;
  /** Overridable for tests; defaults to https://api.openai.com. */
  RAVI_PAGE_CHAT_OPENAI_BASE_URL?: string;
  RAVI_PAGE_CHAT_SESSIONS?: PageChatDurableObjectNamespace;
  /** Native runtime transport; Cloudflare continues using its fetch-upgrade API. */
  connectVoiceSideband?: (url: string, headers: Record<string, string>) => Promise<SocketLike>;
}

export type SocketLike = {
  accept(): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close" | "error", listener: (event: unknown) => void): void;
};

const DEFAULT_CHAT_SESSION_PATH = "/api/internal/pages/chat/session";
const DEFAULT_CHAT_CLOSE_PATH = "/api/internal/pages/chat/close";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com";
const MAX_SDP_BYTES = 64 * 1024;
const NO_STORE = "private, no-store";
/** How long a close may take to bring `session.closed` before usage is reported as unconfirmed. */
const FINALIZE_GRACE_MS = 30_000;
/** How long a created session may go without the provider saying it runs. */
const CONFIRM_TIMEOUT_MS = 30_000;
/** Retry delay for a usage report the Console did not accept. */
const REPORT_RETRY_MS = 60_000;
const MAX_REPORT_ATTEMPTS = 10;

export function pageChatPaths(reservedPrefix: string) {
  const base = `${reservedPrefix}page-chat`;
  return {
    shell: base,
    shellSlash: `${base}/`,
    session: `${base}/session`,
    close: `${base}/close`,
  };
}

/** Routes `/_ravi/page-chat*`. Returns null for any other path. */
export async function handlePageChatRequest(input: {
  request: Request;
  env: PageChatEnv;
  url: URL;
  requestId: string;
  reservedPrefix: string;
  pagesSession: string | null;
  isSameOrigin: boolean;
}): Promise<Response | null> {
  const paths = pageChatPaths(input.reservedPrefix);
  const { pathname } = input.url;
  if (pathname === paths.shell || pathname === paths.shellSlash) {
    if (input.request.method !== "GET" && input.request.method !== "HEAD") return chatJson({ error: "method_not_allowed" }, 405, input.requestId);
    return shellResponse(input.url, input.reservedPrefix, input.request.method === "HEAD");
  }
  if (pathname === paths.session) return startPageChatSession(input);
  if (pathname === paths.close) return closePageChatSession(input);
  return null;
}

function shellResponse(url: URL, reservedPrefix: string, head: boolean): Response {
  const path = safeFramePath(url.searchParams.get("path"), reservedPrefix);
  const headers = new Headers({
    "cache-control": "no-store",
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": "base-uri 'none'; object-src 'none'; frame-ancestors 'none'; frame-src 'self'",
    "permissions-policy": "microphone=(self), camera=(), geolocation=()",
    "referrer-policy": "same-origin",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
  return new Response(head ? null : pageChatShellHtml({ path, reservedPrefix }), { status: 200, headers });
}

/** The page path the frame opens: same origin, never the reserved namespace. */
export function safeFramePath(value: string | null, reservedPrefix: string): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  let parsed: URL;
  try {
    parsed = new URL(value, "https://page.invalid");
  } catch {
    return "/";
  }
  if (parsed.origin !== "https://page.invalid" || parsed.pathname.startsWith(reservedPrefix)) return "/";
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

async function startPageChatSession(input: {
  request: Request;
  env: PageChatEnv;
  url: URL;
  requestId: string;
  reservedPrefix: string;
  pagesSession: string | null;
  isSameOrigin: boolean;
}): Promise<Response> {
  const { request, env, requestId } = input;
  if (request.method !== "POST") return chatJson({ error: "method_not_allowed" }, 405, requestId);
  if (!input.isSameOrigin) return chatJson({ error: "page_chat_unauthorized" }, 401, requestId);
  if (!input.pagesSession) return chatJson({ error: "page_chat_session_required" }, 401, requestId);
  if (!env.OPENAI_API_KEY || !env.RAVI_PAGE_CHAT_SESSIONS) {
    return chatJson({ error: "page_chat_not_configured" }, 503, requestId);
  }

  const raw = await request.text();
  if (raw.length > MAX_SDP_BYTES) return chatJson({ error: "payload_invalid" }, 413, requestId);
  let body: { sdp?: unknown; path?: unknown; voice?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return chatJson({ error: "payload_invalid" }, 400, requestId);
  }
  if (typeof body.sdp !== "string" || !body.sdp.trim() || typeof body.path !== "string") {
    return chatJson({ error: "payload_invalid" }, 400, requestId);
  }

  let authorize: Response;
  try {
    authorize = await fetch(new URL(env.RAVI_PAGES_CHAT_SESSION_PATH ?? DEFAULT_CHAT_SESSION_PATH, env.RAVI_CONSOLE_API_URL), {
      method: "POST",
      headers: consoleHeaders(env, requestId),
      body: JSON.stringify({
        host: input.url.hostname,
        path: safeFramePath(body.path, input.reservedPrefix).split(/[?#]/)[0],
        pagesSession: input.pagesSession,
        voice: typeof body.voice === "string" ? body.voice : null,
      }),
    });
  } catch {
    return chatJson({ error: "page_chat_unavailable" }, 503, requestId);
  }
  const authorized = (await authorize.json().catch(() => null)) as AuthorizedSession | { error?: string } | null;
  if (!authorize.ok || !authorized || !("chatSessionId" in authorized)) {
    const error = authorized && "error" in authorized && typeof authorized.error === "string" ? authorized.error : "page_chat_unavailable";
    return chatJson({ error }, authorize.ok ? 503 : authorize.status, requestId);
  }

  const stub = env.RAVI_PAGE_CHAT_SESSIONS.get(env.RAVI_PAGE_CHAT_SESSIONS.idFromName(authorized.chatSessionId));
  const started = await stub.fetch("https://page-chat.internal/start", {
    method: "POST",
    headers: { "content-type": "application/json", "x-request-id": requestId },
    body: JSON.stringify({
      authorized,
      sdp: body.sdp,
      viewerKey: await sha256Hex(input.pagesSession),
    } satisfies StartBody),
  });
  const startedBody = (await started.json().catch(() => null)) as { sdp?: string; error?: string } | null;
  if (!started.ok || !startedBody?.sdp) {
    return chatJson({ error: startedBody?.error ?? "page_chat_start_failed" }, started.ok ? 502 : started.status, requestId);
  }

  return chatJson(
    {
      chatSessionId: authorized.chatSessionId,
      sdp: startedBody.sdp,
      sessionMaxSeconds: authorized.sessionMaxSeconds,
      warnAtSeconds: authorized.warnAtSeconds,
      frame: authorized.frame,
    },
    201,
    requestId,
  );
}

async function closePageChatSession(input: {
  request: Request;
  env: PageChatEnv;
  requestId: string;
  pagesSession: string | null;
  isSameOrigin: boolean;
}): Promise<Response> {
  const { request, env, requestId } = input;
  if (request.method !== "POST") return chatJson({ error: "method_not_allowed" }, 405, requestId);
  if (!input.isSameOrigin) return chatJson({ error: "page_chat_unauthorized" }, 401, requestId);
  if (!input.pagesSession) return chatJson({ error: "page_chat_session_required" }, 401, requestId);
  if (!env.RAVI_PAGE_CHAT_SESSIONS) return chatJson({ error: "page_chat_not_configured" }, 503, requestId);

  const body = (await request.json().catch(() => null)) as { chatSessionId?: unknown } | null;
  const chatSessionId = typeof body?.chatSessionId === "string" ? body.chatSessionId : "";
  if (!/^[0-9a-f-]{36}$/i.test(chatSessionId)) return chatJson({ error: "payload_invalid" }, 400, requestId);

  const stub = env.RAVI_PAGE_CHAT_SESSIONS.get(env.RAVI_PAGE_CHAT_SESSIONS.idFromName(chatSessionId));
  const closed = await stub.fetch("https://page-chat.internal/close", {
    method: "POST",
    headers: { "content-type": "application/json", "x-request-id": requestId },
    body: JSON.stringify({ viewerKey: await sha256Hex(input.pagesSession) }),
  });
  return chatJson(await closed.json().catch(() => ({ ok: false })), closed.status, requestId);
}

type AuthorizedSession = {
  chatSessionId: string;
  organizationId: string;
  viewerUserId: string;
  sessionMaxSeconds: number;
  warnAtSeconds: number;
  backendModel: string;
  safetyIdentifier: string;
  session: Record<string, unknown>;
  frame: Record<string, unknown>;
};

type StartBody = {
  authorized: AuthorizedSession;
  sdp: string;
  viewerKey: string;
};

type EndReason = "viewer_closed" | "limit_reached" | "start_failed" | "disconnected" | "error";

type ChatState = {
  chatSessionId: string;
  liveSessionId: string | null;
  viewerKey: string;
  safetyIdentifier: string;
  backendModel: string;
  startedAt: number;
  warnAt: number;
  maxAt: number;
  warned: boolean;
  /** Set once the provider reports the session running (`session.started` or usage). */
  confirmed?: boolean;
  /** When an unconfirmed session is given up; null once confirmed. */
  confirmBy?: number | null;
  closeRequestedAt: number | null;
  closeReason: EndReason | null;
  voiceSeconds: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  toolCalls: Record<string, number>;
  finalized: boolean;
  report: Record<string, unknown> | null;
  reportAttempts: number;
};

/** The next check: the confirmation deadline while unconfirmed, then the warning, then the cap. */
function nextAlarm(state: ChatState): number {
  const timed = state.warned ? state.maxAt : state.warnAt;
  return !state.confirmed && state.confirmBy ? Math.min(state.confirmBy, timed) : timed;
}

/**
 * One gpt-live-1 conversation. Creates the session with the platform key,
 * holds the sideband socket, warns and closes at the cap, and reports usage
 * to the Console exactly once (the Console dedupes by conversation id).
 */
export class PageChatSession {
  private socket: SocketLike | null = null;
  private state: ChatState | null = null;

  constructor(
    private readonly ctx: PageChatDurableObjectState,
    private readonly env: PageChatEnv,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
    if (request.method === "POST" && url.pathname === "/start") {
      return this.start((await request.json()) as StartBody, requestId);
    }
    if (request.method === "POST" && url.pathname === "/close") {
      const body = (await request.json().catch(() => ({}))) as { viewerKey?: string };
      return this.requestClose(body.viewerKey ?? "", requestId);
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  async alarm(): Promise<void> {
    const state = await this.loadState();
    if (!state) return;
    const now = Date.now();

    if (state.finalized) {
      if (state.report) await this.sendReport(state);
      return;
    }

    if (state.closeRequestedAt !== null && now >= state.closeRequestedAt + FINALIZE_GRACE_MS) {
      // session.closed never came back: report what we saw as unconfirmed.
      await this.finalize(state, state.closeReason ?? "disconnected", false);
      return;
    }

    if (!state.confirmed && state.confirmBy && now >= state.confirmBy) {
      if (this.send({ type: "session.close", event_id: `page_chat_close_${state.chatSessionId}` })) {
        // The provider never said the session runs and we closed it: keep only the up-front charge.
        await this.finalize(state, "start_failed", false);
        return;
      }
      // The sideband is gone, so the session may be live and cannot be closed from here:
      // keep the clock running to the cap or the viewer's close, as for any lost sideband.
      state.confirmBy = null;
      await this.saveState(state);
    }

    if (now >= state.maxAt) {
      await this.beginClose(state, "limit_reached");
      return;
    }

    if (!state.warned && now >= state.warnAt) {
      state.warned = true;
      this.send({
        type: "session.instructions.append",
        event_id: `page_chat_warn_${state.chatSessionId}`,
        delegation_id: null,
        content: "About one minute of this conversation remains. Tell the person once, briefly, and keep helping.",
      });
      await this.saveState(state);
    }
    await this.ctx.storage.setAlarm(nextAlarm(state));
  }

  private async start(body: StartBody, requestId: string): Promise<Response> {
    const { authorized } = body;
    const now = Date.now();
    const state: ChatState = {
      chatSessionId: authorized.chatSessionId,
      liveSessionId: null,
      viewerKey: body.viewerKey,
      safetyIdentifier: authorized.safetyIdentifier,
      backendModel: authorized.backendModel,
      startedAt: now,
      warnAt: now + Math.max(0, authorized.warnAtSeconds) * 1000,
      maxAt: now + Math.max(1, authorized.sessionMaxSeconds) * 1000,
      warned: authorized.warnAtSeconds >= authorized.sessionMaxSeconds,
      closeRequestedAt: null,
      closeReason: null,
      voiceSeconds: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      toolCalls: {},
      finalized: false,
      report: null,
      reportAttempts: 0,
    };
    this.state = state;
    await this.saveState(state);

    let created: Response;
    try {
      created = await fetch(`${this.openaiBase()}/v1/live/sessions`, {
        method: "POST",
        headers: this.openaiHeaders(state, { "content-type": "application/json" }),
        body: JSON.stringify({ session: authorized.session, transport: { type: "webrtc", sdp: body.sdp } }),
      });
    } catch {
      await this.finalize(state, "start_failed", true);
      return Response.json({ error: "page_chat_start_failed" }, { status: 502 });
    }
    const payload = (await created.json().catch(() => null)) as {
      session?: { id?: string };
      transport?: { sdp?: string };
    } | null;
    const liveSessionId = payload?.session?.id;
    const answer = payload?.transport?.sdp;
    if (!created.ok || !liveSessionId || !answer) {
      console.error("Page Chat session creation failed", { status: created.status, requestId });
      await this.finalize(state, "start_failed", true);
      return Response.json({ error: created.status === 429 ? "page_chat_busy" : "page_chat_start_failed" }, { status: 502 });
    }

    state.liveSessionId = liveSessionId;
    // WebRTC creation bills this much up front; it is credited once the session runs.
    state.voiceSeconds = 15;
    state.confirmed = false;
    state.confirmBy = Date.now() + CONFIRM_TIMEOUT_MS;
    await this.saveState(state);
    await this.ctx.storage.setAlarm(nextAlarm(state));
    if (!(await this.attach(state))) {
      // Withhold the answer: the browser never connects, so the session cannot run unmetered.
      await this.finalize(state, "start_failed", false);
      return Response.json({ error: "page_chat_start_failed" }, { status: 502 });
    }
    return Response.json({ sdp: answer }, { status: 201 });
  }

  /** Opens the sideband. Without it the session can be neither metered nor closed from here. */
  private async attach(state: ChatState): Promise<boolean> {
    if (!state.liveSessionId) return false;
    try {
      const endpoint = `${this.openaiBase()}/v1/live/sessions/${encodeURIComponent(state.liveSessionId)}/attach`;
      const response = this.env.connectVoiceSideband ? null : (await fetch(endpoint, {
        headers: this.openaiHeaders(state, { upgrade: "websocket" }),
      })) as Response & { webSocket?: SocketLike | null };
      const socket = this.env.connectVoiceSideband
        ? await this.env.connectVoiceSideband(endpoint, this.openaiHeaders(state, {}))
        : response?.webSocket;
      if (!socket) {
        console.error("Page Chat sideband attach failed", { status: response?.status });
        return false;
      }
      socket.accept();
      this.socket = socket;
      socket.addEventListener("message", (event) => {
        void this.onSidebandMessage(event.data);
      });
      socket.addEventListener("close", () => {
        void this.onSidebandClosed();
      });
      socket.addEventListener("error", () => {
        void this.onSidebandClosed();
      });
      return true;
    } catch {
      console.error("Page Chat sideband attach failed");
      return false;
    }
  }

  private async onSidebandMessage(data: unknown) {
    if (typeof data !== "string") return;
    let event: SidebandEvent;
    try {
      event = JSON.parse(data) as SidebandEvent;
    } catch {
      return;
    }
    const state = await this.loadState();
    if (!state || state.finalized) return;

    if (
      !state.confirmed &&
      (event.type === "session.started" || event.type === "session.usage.updated")
    ) {
      state.confirmed = true;
      state.confirmBy = null;
      await this.saveState(state);
      if (state.closeRequestedAt === null) await this.ctx.storage.setAlarm(nextAlarm(state));
    }
    if (event.type === "session.usage.updated" && typeof event.usage?.seconds === "number") {
      state.voiceSeconds = Math.max(state.voiceSeconds, event.usage.seconds);
      await this.saveState(state);
      return;
    }
    if (event.type === "session.closed") {
      // The up-front 15 s stays billed even when the conversation was shorter.
      if (typeof event.usage?.seconds === "number") state.voiceSeconds = Math.max(15, event.usage.seconds);
      await this.finalize(state, endReasonFor(event.reason, state.closeReason), true);
      return;
    }
    if (event.type === "response.event" && event.event) {
      const nested = event.event;
      if (nested.type === "response.output_item.done" && nested.item?.type === "function_call" && nested.item.name) {
        const name = nested.item.name.slice(0, 64);
        state.toolCalls[name] = (state.toolCalls[name] ?? 0) + 1;
        await this.saveState(state);
        return;
      }
      if (nested.type === "response.completed" && nested.response?.usage) {
        const usage = nested.response.usage;
        const cached = usage.input_tokens_details?.cached_tokens ?? 0;
        state.inputTokens += Math.max(0, (usage.input_tokens ?? 0) - cached);
        state.cachedInputTokens += cached;
        state.outputTokens += usage.output_tokens ?? 0;
        await this.saveState(state);
      }
    }
  }

  private async onSidebandClosed() {
    this.socket = null;
    const state = await this.loadState();
    if (!state || state.finalized) return;
    // Keep counting on the clock; the alarm finalizes at the cap or after a close request.
    if (state.closeRequestedAt === null) {
      state.closeRequestedAt = Date.now();
      state.closeReason = "disconnected";
      await this.saveState(state);
      await this.ctx.storage.setAlarm(Date.now() + FINALIZE_GRACE_MS);
    }
  }

  private async requestClose(viewerKey: string, _requestId: string): Promise<Response> {
    const state = await this.loadState();
    if (!state) return Response.json({ error: "page_chat_session_unknown" }, { status: 404 });
    if (!viewerKey || viewerKey !== state.viewerKey) {
      return Response.json({ error: "page_chat_unauthorized" }, { status: 403 });
    }
    if (!state.finalized) await this.beginClose(state, "viewer_closed");
    return Response.json({ ok: true });
  }

  private async beginClose(state: ChatState, reason: EndReason) {
    if (state.closeRequestedAt === null) {
      state.closeRequestedAt = Date.now();
      state.closeReason = reason;
    }
    if (reason === "limit_reached") {
      this.send({
        type: "session.instructions.append",
        event_id: `page_chat_limit_${state.chatSessionId}`,
        delegation_id: null,
        content: "The time for this conversation is over. Say goodbye in one short sentence.",
      });
    }
    this.send({ type: "session.close", event_id: `page_chat_close_${state.chatSessionId}` });
    await this.saveState(state);
    await this.ctx.storage.setAlarm(Date.now() + FINALIZE_GRACE_MS);
  }

  private async finalize(state: ChatState, reason: EndReason, usageComplete: boolean) {
    if (state.finalized) return;
    const elapsedSeconds = Math.ceil((Date.now() - state.startedAt) / 1000);
    const voiceSeconds = usageComplete || reason === "start_failed"
      ? state.voiceSeconds
      : Math.max(state.voiceSeconds, Math.min(elapsedSeconds, Math.ceil((state.maxAt - state.startedAt) / 1000)));
    state.finalized = true;
    state.report = {
      chatSessionId: state.chatSessionId,
      endedAt: new Date().toISOString(),
      endReason: reason,
      voiceSeconds: reason === "start_failed" && !state.liveSessionId ? 0 : voiceSeconds,
      usageComplete,
      model: state.backendModel,
      inputTokens: state.inputTokens,
      cachedInputTokens: state.cachedInputTokens,
      outputTokens: state.outputTokens,
      toolCalls: state.toolCalls,
    };
    await this.saveState(state);
    try {
      this.socket?.close(1000, "page chat finished");
    } catch {
      // Already closed.
    }
    this.socket = null;
    await this.sendReport(state);
  }

  private async sendReport(state: ChatState) {
    if (!state.report) return;
    state.reportAttempts += 1;
    let ok = false;
    try {
      const response = await fetch(new URL(this.env.RAVI_PAGES_CHAT_CLOSE_PATH ?? DEFAULT_CHAT_CLOSE_PATH, this.env.RAVI_CONSOLE_API_URL), {
        method: "POST",
        headers: consoleHeaders(this.env, crypto.randomUUID()),
        body: JSON.stringify(state.report),
      });
      // 404 means the Console never authorized this id; retrying cannot help.
      ok = response.ok || response.status === 404 || response.status === 400;
    } catch {
      ok = false;
    }
    if (ok || state.reportAttempts >= MAX_REPORT_ATTEMPTS) {
      if (!ok) console.error("Page Chat usage report dropped after retries", { chatSessionId: state.chatSessionId });
      state.report = null;
      await this.saveState(state);
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.saveState(state);
    await this.ctx.storage.setAlarm(Date.now() + REPORT_RETRY_MS);
  }

  /** Sends on the sideband; false when there is no live socket. */
  private send(event: Record<string, unknown>): boolean {
    if (!this.socket) return false;
    try {
      this.socket.send(JSON.stringify(event));
      return true;
    } catch {
      // The alarm path covers a dead socket.
      return false;
    }
  }

  private openaiBase() {
    return (this.env.RAVI_PAGE_CHAT_OPENAI_BASE_URL ?? DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, "");
  }

  private openaiHeaders(state: ChatState, extra: Record<string, string>) {
    return {
      authorization: `Bearer ${this.env.OPENAI_API_KEY ?? ""}`,
      "openai-safety-identifier": state.safetyIdentifier,
      ...extra,
    };
  }

  private async loadState(): Promise<ChatState | null> {
    if (this.state) return this.state;
    this.state = (await this.ctx.storage.get<ChatState>("state")) ?? null;
    return this.state;
  }

  private async saveState(state: ChatState) {
    this.state = state;
    await this.ctx.storage.put("state", state);
  }
}

type SidebandEvent = {
  type?: string;
  reason?: string;
  usage?: { seconds?: number };
  event?: {
    type?: string;
    item?: { type?: string; name?: string };
    response?: {
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        input_tokens_details?: { cached_tokens?: number };
      };
    };
  };
};

function endReasonFor(providerReason: string | undefined, requested: EndReason | null): EndReason {
  if (requested) return requested;
  if (providerReason === "expired") return "limit_reached";
  if (providerReason === "close_requested" || providerReason === "remote_hangup") return "viewer_closed";
  if (providerReason === "connection_lost") return "disconnected";
  return "error";
}

function consoleHeaders(env: PageChatEnv, requestId: string) {
  return {
    accept: "application/json",
    authorization: `Bearer ${env.RAVI_PAGES_CONTROL_TOKEN ?? ""}`,
    "content-type": "application/json",
    "x-request-id": requestId,
  };
}

function chatJson(payload: unknown, status: number, requestId: string): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "cache-control": NO_STORE,
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      "x-request-id": requestId,
    },
  });
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Runs at the top of every Page Chat HTML document, before the page's own
 * scripts, so a page can register actions with `ravi.pageChat.action(...)` or
 * by pushing onto `ravi.pageChat.actions`. Pure ASCII, no backticks.
 */
export function pageChatHeadShim(): string {
  return [
    "<script>(function(){",
    "var w=window,r=w.ravi=w.ravi||{},p=r.pageChat=r.pageChat||{};",
    "if(!Array.isArray(p.actions))p.actions=[];",
    "p.enabled=true;",
    "p.action=function(name,def){",
    "if(typeof name!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(name))throw new Error('ravi.pageChat.action: invalid name');",
    "def=def||{};if(typeof def.run!=='function')throw new Error('ravi.pageChat.action: run must be a function');",
    "var entry={name:name,description:String(def.description||''),parameters:def.parameters||{type:'object',properties:{}},kind:def.kind==='write'?'write':'read',run:def.run};",
    "for(var i=p.actions.length-1;i>=0;i--){if(p.actions[i]&&p.actions[i].name===name)p.actions.splice(i,1);}",
    "p.actions.push(entry);return entry;};",
    "})();</script>",
  ].join("");
}

export function injectPageChatHeadShim(html: string): string {
  const shim = pageChatHeadShim();
  const head = html.match(/<head(\s[^>]*)?>/i);
  if (head && head.index !== undefined) {
    const at = head.index + head[0].length;
    return `${html.slice(0, at)}${shim}${html.slice(at)}`;
  }
  const doctype = html.match(/^\s*<!doctype[^>]*>/i);
  if (doctype) return `${doctype[0]}${shim}${html.slice(doctype[0].length)}`;
  return `${shim}${html}`;
}
