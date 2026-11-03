import { afterEach, describe, expect, mock, test } from "bun:test";

import worker, { __resetPagesWorkerEdgeManifestCacheForTests, type PagesWorkerEnv } from "./index";
import {
  injectPageChatHeadShim,
  PageChatSession,
  safeFramePath,
  type PageChatDurableObjectNamespace,
  type PageChatDurableObjectState,
} from "./page-chat";

const originalFetch = globalThis.fetch;
const pagesSession = "sessionabcdefghijklmnopqrstuvwxyz123456";
const chatSessionId = "11111111-1111-4111-8111-111111111111";

afterEach(() => {
  globalThis.fetch = originalFetch;
  __resetPagesWorkerEdgeManifestCacheForTests();
});

describe("Page Chat routes", () => {
  test("serves the frame with the microphone allowed and the page path kept on this origin", async () => {
    const response = await worker.fetch(request("/_ravi/page-chat?path=%2Frelatorio%3Fa%3D1"), env());
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("permissions-policy")).toContain("microphone=(self)");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("content-security-policy")).toContain("frame-src 'self'");
    expect(html).toContain('"path":"/relatorio?a=1"');
    expect(html).toContain("window.__raviPageChatShell = true");
    // Finished voice lines go into the page's shared text room, both sides of the call.
    expect(html).toContain('"chat/send"');
    expect(html).toContain('source: "voice", speaker: speaker');
    expect(html).not.toMatch(/[^\x00-\x7f]/);
  });

  test("keeps the frame on this site's pages", () => {
    expect(safeFramePath("/a/b?x=1#c", "/_ravi/")).toBe("/a/b?x=1#c");
    expect(safeFramePath("//evil.example/x", "/_ravi/")).toBe("/");
    expect(safeFramePath("https://evil.example/x", "/_ravi/")).toBe("/");
    expect(safeFramePath("/_ravi/page-chat/session", "/_ravi/")).toBe("/");
    expect(safeFramePath("/\\evil", "/_ravi/")).toBe("/");
    expect(safeFramePath(null, "/_ravi/")).toBe("/");
  });

  test("requires a Pages session and a same-origin request to open a conversation", async () => {
    const consoleFetch = mock(async () => Response.json({}));
    globalThis.fetch = consoleFetch as unknown as typeof fetch;

    const anonymous = await worker.fetch(
      request("/_ravi/page-chat/session", { method: "POST", body: JSON.stringify({ sdp: "v=0", path: "/" }) }),
      env({ sessions: namespace() }),
    );
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual({ error: "page_chat_session_required" });

    const crossSite = await worker.fetch(
      request("/_ravi/page-chat/session", {
        method: "POST",
        headers: { cookie: `__Host-ravi_page_session=${pagesSession}`, origin: "https://evil.example" },
        body: JSON.stringify({ sdp: "v=0", path: "/" }),
      }),
      env({ sessions: namespace() }),
    );
    expect(crossSite.status).toBe(401);
    expect(consoleFetch).not.toHaveBeenCalled();
  });

  test("answers not configured until the OpenAI key is a Worker secret", async () => {
    const response = await worker.fetch(
      request("/_ravi/page-chat/session", {
        method: "POST",
        headers: { cookie: `__Host-ravi_page_session=${pagesSession}` },
        body: JSON.stringify({ sdp: "v=0", path: "/" }),
      }),
      env({ sessions: namespace(), openaiKey: null }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "page_chat_not_configured" });
  });

  test("asks the Console, then starts the conversation in its Durable Object", async () => {
    const consoleFetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://console.ravi.bot/api/internal/pages/chat/session");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer control-token");
      expect(JSON.parse(String(init?.body))).toEqual({
        host: "demo.ravi.page",
        path: "/relatorio",
        pagesSession,
        voice: "tempo",
      });
      return Response.json(authorized());
    });
    globalThis.fetch = consoleFetch as unknown as typeof fetch;
    const starts: unknown[] = [];
    const sessions = namespace(async (path, body) => {
      starts.push({ path, body });
      return Response.json({ sdp: "answer-sdp" }, { status: 201 });
    });

    const response = await worker.fetch(
      request("/_ravi/page-chat/session", {
        method: "POST",
        headers: { cookie: `__Host-ravi_page_session=${pagesSession}`, origin: "https://demo.ravi.page" },
        body: JSON.stringify({ sdp: "offer-sdp", path: "/relatorio?x=1", voice: "tempo" }),
      }),
      env({ sessions }),
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ chatSessionId, sdp: "answer-sdp", sessionMaxSeconds: 600 });
    expect(JSON.stringify(body)).not.toContain("sk-test");
    expect(JSON.stringify(body)).not.toContain("instructions");
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ path: "/start", body: { sdp: "offer-sdp", authorized: { chatSessionId } } });
    expect((starts[0] as { body: { viewerKey: string } }).body.viewerKey).toMatch(/^[0-9a-f]{64}$/);
  });

  test("passes the Console's refusal through without starting anything", async () => {
    globalThis.fetch = mock(async () => Response.json({ error: "viewer_daily_limit" }, { status: 429 })) as unknown as typeof fetch;
    const sessions = namespace(async () => {
      throw new Error("must not start");
    });

    const response = await worker.fetch(
      request("/_ravi/page-chat/session", {
        method: "POST",
        headers: { cookie: `__Host-ravi_page_session=${pagesSession}` },
        body: JSON.stringify({ sdp: "offer", path: "/" }),
      }),
      env({ sessions }),
    );
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "viewer_daily_limit" });
  });

  test("lets same-origin frames show Page Chat HTML and injects the action registry first", async () => {
    globalThis.fetch = mock(async () => Response.json(resolvedHtml({ pageChat: true }))) as unknown as typeof fetch;

    const response = await worker.fetch(
      request("/", { headers: { cookie: `__Host-ravi_page_session=${pagesSession}` } }),
      env({ assets: htmlAssets("<!doctype html><html><head><title>T</title></head><body><main>Page</main></body></html>") }),
    );
    const html = await response.text();

    expect(response.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
    expect(response.headers.get("content-security-policy")).not.toContain("frame-ancestors 'none'");
    expect(html.indexOf("p.action=function")).toBeGreaterThan(html.indexOf("<head>"));
    expect(html.indexOf("p.action=function")).toBeLessThan(html.indexOf("<title>"));
    expect(html).toContain('"pageChatUrl":"/_ravi/page-chat"');
    expect(html).toContain("window.parent.__raviPageChatShell");
  });

  test("keeps frames denied and adds no Page Chat when the Console does not offer it", async () => {
    globalThis.fetch = mock(async () => Response.json(resolvedHtml({ pageChat: false }))) as unknown as typeof fetch;

    const response = await worker.fetch(
      request("/", { headers: { cookie: `__Host-ravi_page_session=${pagesSession}` } }),
      env({ assets: htmlAssets("<!doctype html><html><head></head><body>Page</body></html>") }),
    );
    const html = await response.text();

    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(html).not.toContain("p.action=function");
    expect(html).toContain('"pageChatUrl":null');
  });

  test("puts the registry after a doctype when the page has no head", () => {
    expect(injectPageChatHeadShim("<!DOCTYPE html><p>x</p>")).toMatch(/^<!DOCTYPE html><script>/);
    expect(injectPageChatHeadShim("<p>x</p>")).toMatch(/^<script>/);
    expect(injectPageChatHeadShim("<html><header>h</header></html>")).toMatch(/^<script>/);
  });
});

describe("PageChatSession", () => {
  test("creates the session with the platform key, enforces nothing early and reports usage once on close", async () => {
    const socket = fakeSocket();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === "https://api.openai.com/v1/live/sessions") {
        return Response.json({ session: { id: "live_abc" }, transport: { type: "webrtc", sdp: "answer" } }, { status: 201 });
      }
      if (url === "https://api.openai.com/v1/live/sessions/live_abc/attach") {
        return Object.assign(new Response(null, { status: 200 }), { webSocket: socket });
      }
      if (url === "https://console.ravi.bot/api/internal/pages/chat/close") return Response.json({ ok: true });
      throw new Error(`unexpected ${url}`);
    }) as unknown as typeof fetch;
    const state = fakeState();
    const session = new PageChatSession(state, chatEnv());

    const started = await session.fetch(doRequest("/start", { authorized: authorized(), sdp: "offer", viewerKey: "viewer-key" }));
    expect(started.status).toBe(201);
    expect(await started.json()).toEqual({ sdp: "answer" });

    const create = calls[0]!;
    expect(new Headers(create.init?.headers).get("authorization")).toBe("Bearer sk-test");
    expect(new Headers(create.init?.headers).get("openai-safety-identifier")).toBe("safety-hash");
    expect(JSON.parse(String(create.init?.body))).toEqual({
      session: authorized().session,
      transport: { type: "webrtc", sdp: "offer" },
    });
    expect(socket.accepted).toBe(true);
    expect(state.alarm).not.toBeNull();

    socket.emit({ type: "session.usage.updated", usage: { seconds: 42 } });
    socket.emit({
      type: "response.event",
      delegation_id: "d1",
      event: { type: "response.output_item.done", item: { type: "function_call", name: "page_read", call_id: "c1" } },
    });
    socket.emit({
      type: "response.event",
      delegation_id: "d1",
      event: {
        type: "response.completed",
        response: { usage: { input_tokens: 1200, input_tokens_details: { cached_tokens: 200 }, output_tokens: 80 } },
      },
    });
    socket.emit({ type: "session.closed", reason: "close_requested", usage: { seconds: 61 } });
    await settle();

    const reports = calls.filter((call) => call.url.endsWith("/api/internal/pages/chat/close"));
    expect(reports).toHaveLength(1);
    expect(JSON.parse(String(reports[0]!.init?.body))).toMatchObject({
      chatSessionId,
      endReason: "viewer_closed",
      voiceSeconds: 61,
      usageComplete: true,
      model: "gpt-6-luna",
      inputTokens: 1000,
      cachedInputTokens: 200,
      outputTokens: 80,
      toolCalls: { page_read: 1 },
    });
    expect(socket.closed).toBe(true);

    socket.emit({ type: "session.closed", reason: "close_requested", usage: { seconds: 61 } });
    await settle();
    expect(calls.filter((call) => call.url.endsWith("/api/internal/pages/chat/close"))).toHaveLength(1);
  });

  test("warns a minute before the cap, then closes and reports unconfirmed usage if OpenAI never confirms", async () => {
    const socket = fakeSocket();
    const reports: unknown[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/live/sessions")) return Response.json({ session: { id: "live_x" }, transport: { sdp: "a" } });
      if (url.endsWith("/attach")) return Object.assign(new Response(null), { webSocket: socket });
      reports.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;
    const state = fakeState();
    const session = new PageChatSession(state, chatEnv());
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      await session.fetch(doRequest("/start", { authorized: authorized(), sdp: "offer", viewerKey: "k" }));
      socket.emit({ type: "session.started" });
      await settle();

      now += 541_000;
      await session.alarm();
      expect(socket.sent.map((event) => event.type)).toEqual(["session.instructions.append"]);

      now += 60_000;
      await session.alarm();
      expect(socket.sent.map((event) => event.type)).toEqual([
        "session.instructions.append",
        "session.instructions.append",
        "session.close",
      ]);
      expect(reports).toHaveLength(0);

      now += 31_000;
      await session.alarm();
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({ endReason: "limit_reached", usageComplete: false, voiceSeconds: 600 });
    } finally {
      Date.now = realNow;
    }
  });

  test("ends a created session the provider never starts and keeps only the up-front charge", async () => {
    const socket = fakeSocket();
    const reports: unknown[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/live/sessions")) return Response.json({ session: { id: "live_z" }, transport: { sdp: "a" } });
      if (url.endsWith("/attach")) return Object.assign(new Response(null), { webSocket: socket });
      reports.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;
    const state = fakeState();
    const session = new PageChatSession(state, chatEnv());
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      await session.fetch(doRequest("/start", { authorized: authorized(), sdp: "offer", viewerKey: "k" }));
      expect(state.alarm).toBe(now + 30_000);

      now += 31_000;
      await session.alarm();
      expect(socket.sent.map((event) => event.type)).toEqual(["session.close"]);
      expect(reports).toEqual([
        expect.objectContaining({ endReason: "start_failed", voiceSeconds: 15, usageComplete: false, chatSessionId }),
      ]);
    } finally {
      Date.now = realNow;
    }
  });

  test("withholds the answer when the sideband cannot attach, so no session runs unmetered", async () => {
    const reports: unknown[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/live/sessions")) return Response.json({ session: { id: "live_w" }, transport: { sdp: "a" } });
      if (url.endsWith("/attach")) return new Response(null, { status: 503 });
      reports.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;
    const session = new PageChatSession(fakeState(), chatEnv());

    const response = await session.fetch(doRequest("/start", { authorized: authorized(), sdp: "offer", viewerKey: "k" }));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "page_chat_start_failed" });
    expect(reports).toEqual([expect.objectContaining({ endReason: "start_failed", voiceSeconds: 15, chatSessionId })]);
  });

  test("only the viewer who opened the conversation can close it", async () => {
    const socket = fakeSocket();
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/live/sessions")) return Response.json({ session: { id: "live_y" }, transport: { sdp: "a" } });
      if (url.endsWith("/attach")) return Object.assign(new Response(null), { webSocket: socket });
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;
    const session = new PageChatSession(fakeState(), chatEnv());
    await session.fetch(doRequest("/start", { authorized: authorized(), sdp: "offer", viewerKey: "owner" }));

    const stranger = await session.fetch(doRequest("/close", { viewerKey: "someone-else" }));
    expect(stranger.status).toBe(403);
    expect(socket.sent).toEqual([]);

    const owner = await session.fetch(doRequest("/close", { viewerKey: "owner" }));
    expect(owner.status).toBe(200);
    expect(socket.sent.map((event) => event.type)).toEqual(["session.close"]);
  });

  test("reports a failed start so the conversation stops counting as open", async () => {
    const reports: unknown[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/v1/live/sessions")) return Response.json({ error: { message: "busy" } }, { status: 429 });
      reports.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;
    const session = new PageChatSession(fakeState(), chatEnv());

    const response = await session.fetch(doRequest("/start", { authorized: authorized(), sdp: "offer", viewerKey: "k" }));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "page_chat_busy" });
    expect(reports).toEqual([expect.objectContaining({ endReason: "start_failed", voiceSeconds: 0, chatSessionId })]);
  });
});

function authorized() {
  return {
    chatSessionId,
    organizationId: "org_1",
    projectId: "proj_1",
    siteId: "site_1",
    releaseId: "release_1",
    routeId: "route_1",
    viewerUserId: "user_1",
    sessionMaxSeconds: 600,
    warnAtSeconds: 540,
    backendModel: "gpt-6-luna",
    safetyIdentifier: "safety-hash",
    session: { model: "gpt-live-1", instructions: "instructions", audio: { output: { voice: "bossa" } } },
    frame: { assistantName: "Ravi", voice: "bossa", routes: ["/"], connectorActions: [] },
  };
}

function request(path: string, init?: RequestInit, host = "demo.ravi.page"): Request {
  return new Request(`https://${host}${path}`, init);
}

function doRequest(path: string, body: unknown) {
  return new Request(`https://page-chat.internal${path}`, { method: "POST", body: JSON.stringify(body) });
}

function chatEnv() {
  return {
    RAVI_CONSOLE_API_URL: "https://console.ravi.bot",
    RAVI_PAGES_CONTROL_TOKEN: "control-token",
    OPENAI_API_KEY: "sk-test",
  };
}

function env(
  options: {
    assets?: Record<string, { body: ReadableStream; httpMetadata?: Record<string, string> }>;
    sessions?: PageChatDurableObjectNamespace;
    openaiKey?: string | null;
  } = {},
): PagesWorkerEnv {
  return {
    RAVI_CONSOLE_API_URL: "https://console.ravi.bot",
    RAVI_PAGES_CONTROL_TOKEN: "control-token",
    OPENAI_API_KEY: options.openaiKey === null ? undefined : (options.openaiKey ?? "sk-test"),
    RAVI_PAGE_CHAT_SESSIONS: options.sessions,
    RAVI_PAGES_ASSETS: {
      async get(key: string) {
        return options.assets?.[key] ?? null;
      },
      async put() {
        return {};
      },
    },
  } as PagesWorkerEnv;
}

function namespace(
  handler: (path: string, body: unknown) => Promise<Response> = async () => Response.json({ sdp: "answer" }, { status: 201 }),
): PageChatDurableObjectNamespace {
  return {
    idFromName: (name: string) => ({ toString: () => name }),
    get: () => ({
      fetch: async (input: Request | string, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input.url);
        return handler(url.pathname, JSON.parse(String(init?.body ?? "{}")));
      },
    }),
  };
}

function htmlAssets(html: string) {
  return {
    "org/org_1/project/proj_1/artifact/art_1/version/ver_1/index.html": {
      body: new Response(html).body as ReadableStream,
      httpMetadata: {},
    },
  };
}

function resolvedHtml(options: { pageChat: boolean }) {
  return {
    status: "ok",
    site: { id: "site_1", organizationId: "org_1", projectId: "proj_1", visibility: "private" },
    release: { id: "release_1", number: 5 },
    route: { id: "route_1", bindingId: "binding_1", path: "/", matchType: "spa", visibility: "private" },
    artifact: { id: "art_1", versionId: "ver_1", versionNumber: 2 },
    object: {
      r2Key: "org/org_1/project/proj_1/artifact/art_1/version/ver_1/index.html",
      path: "index.html",
      contentType: "text/html; charset=utf-8",
      cache: "private",
    },
    toolbar: {
      enabled: true,
      host: "demo.ravi.page",
      path: "/",
      effectiveVisibility: "private",
      siteId: "site_1",
      projectId: "proj_1",
      routeId: "route_1",
      releaseId: "release_1",
      releaseNumber: 5,
      artifactId: "art_1",
      artifactVersionId: "ver_1",
      artifactVersionNumber: 2,
      ...(options.pageChat ? { pageChat: { enabled: true } } : {}),
    },
  };
}

function fakeState(): PageChatDurableObjectState & { alarm: number | null } {
  const data = new Map<string, unknown>();
  const state = {
    alarm: null as number | null,
    storage: {
      async get<T>(key: string) {
        return structuredClone(data.get(key)) as T | undefined;
      },
      async put<T>(key: string, value: T) {
        data.set(key, structuredClone(value));
      },
      async delete(key: string) {
        return data.delete(key);
      },
      async setAlarm(time: number | Date) {
        state.alarm = typeof time === "number" ? time : time.getTime();
      },
      async deleteAlarm() {
        state.alarm = null;
      },
    },
    async blockConcurrencyWhile<T>(callback: () => Promise<T>) {
      return callback();
    },
  };
  return state;
}

function fakeSocket() {
  const listeners: Record<string, Array<(event: { data: unknown }) => void>> = {};
  const socket = {
    accepted: false,
    closed: false,
    sent: [] as Array<Record<string, unknown>>,
    accept() {
      socket.accepted = true;
    },
    send(data: string) {
      socket.sent.push(JSON.parse(data));
    },
    close() {
      socket.closed = true;
    },
    addEventListener(type: string, listener: (event: { data: unknown }) => void) {
      (listeners[type] ||= []).push(listener);
    },
    emit(event: unknown) {
      for (const listener of listeners.message ?? []) listener({ data: JSON.stringify(event) });
    },
  };
  return socket;
}

async function settle() {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}
