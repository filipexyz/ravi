import { serve } from "bun";
import { getRecentHistory } from "../db.js";
import { dbGetAgent, dbGetMessageMeta } from "../router/router-db.js";
import {
  listSessions,
  resolveSession,
  updateSessionDisplayName,
  updateSessionThinkingLevel,
  resetSession,
} from "../router/sessions.js";
import { closeNats, connectNats, publish, subscribe } from "../nats.js";
import { buildOverlaySnapshot, type OverlayActivity, type OverlayLiveState, type OverlayQuery } from "./model.js";
import type { OverlayPublishedState } from "./state.js";
import { getBindingForQuery, upsertBinding } from "./bindings.js";
import type { OverlayDomCommandEnvelope, OverlayDomCommandRequest, OverlayDomCommandResult } from "./dom-control.js";

const PORT = Number(process.env.RAVI_WA_OVERLAY_PORT ?? 4210);
const HOST = process.env.RAVI_WA_OVERLAY_HOST ?? "127.0.0.1";

const liveBySessionName = new Map<string, OverlayLiveState>();
let latestPublishedState: OverlayPublishedState | null = null;
const publishedHistory: OverlayPublishedState[] = [];
const pendingDomCommands: OverlayDomCommandEnvelope[] = [];
const domCommandResults = new Map<string, OverlayDomCommandResult>();

type ActionName = "abort" | "reset" | "set-thinking" | "rename";

type ActionBody = {
  session?: string;
  action?: ActionName;
  value?: string | null;
};

type BindBody = {
  session?: string;
  title?: string | null;
  chatId?: string | null;
};

type DomResultBody = {
  result?: OverlayDomCommandResult;
};

type ChatListResolveBody = {
  entries?: Array<{
    id?: string | null;
    chatId?: string | null;
    title?: string | null;
    session?: string | null;
  }>;
};

type MessageMetaBody = {
  session?: string | null;
  messageId?: string | null;
  chatId?: string | null;
};

void connectOverlayNats()
  .then(startRuntimeTracker)
  .catch(() => {
    // Bridge still works in DB-only mode when NATS is unavailable.
  });

const server = serve({
  hostname: HOST,
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }), url);
    }

    if (url.pathname === "/health") {
      return withCors(
        Response.json({
          ok: true,
          bridge: "ravi-whatsapp-overlay",
          host: HOST,
          port: PORT,
          generatedAt: Date.now(),
        }),
        url,
      );
    }

    if (url.pathname === "/api/whatsapp-overlay/snapshot" && req.method === "GET") {
      return handleSnapshot(url);
    }

    if (url.pathname === "/api/whatsapp-overlay/current" && req.method === "GET") {
      return handleCurrent(url);
    }

    if (url.pathname === "/api/whatsapp-overlay/current" && req.method === "POST") {
      return handlePublish(req, url);
    }

    if (url.pathname === "/api/whatsapp-overlay/chat-list/resolve" && req.method === "POST") {
      return handleChatListResolve(req, url);
    }

    if (url.pathname === "/api/whatsapp-overlay/message-meta" && req.method === "POST") {
      return handleMessageMeta(req, url);
    }

    if (url.pathname === "/api/whatsapp-overlay/session/action" && req.method === "POST") {
      return handleAction(req, url);
    }

    if (url.pathname === "/api/whatsapp-overlay/bind" && req.method === "POST") {
      return handleBind(req, url);
    }

    if (url.pathname === "/api/whatsapp-overlay/dom/command" && req.method === "POST") {
      return handleDomCommand(req, url);
    }

    if (url.pathname === "/api/whatsapp-overlay/dom/command/next" && req.method === "GET") {
      return handleNextDomCommand(url);
    }

    if (url.pathname === "/api/whatsapp-overlay/dom/result" && req.method === "POST") {
      return handleDomResult(req, url);
    }

    if (url.pathname === "/api/whatsapp-overlay/dom/result" && req.method === "GET") {
      return handleGetDomResult(url);
    }

    return withCors(Response.json({ ok: false, error: "Not found" }, { status: 404 }), url);
  },
});

console.log(`Ravi WhatsApp overlay bridge listening on http://${HOST}:${server.port}`);

async function handleAction(req: Request, url: URL): Promise<Response> {
  try {
    const body = (await req.json()) as ActionBody;
    const session = body.session ? resolveSession(body.session) : null;
    if (!session) {
      return withCors(Response.json({ ok: false, error: "Session not found" }, { status: 404 }), url);
    }

    switch (body.action) {
      case "abort":
        await publish("ravi.session.abort", {
          sessionKey: session.sessionKey,
          sessionName: session.name ?? session.sessionKey,
        });
        upsertLive(session.name ?? session.sessionKey, "blocked", "aborted from WhatsApp overlay");
        break;
      case "reset":
        await publish("ravi.session.abort", {
          sessionKey: session.sessionKey,
          sessionName: session.name ?? session.sessionKey,
        });
        resetSession(session.sessionKey);
        upsertLive(session.name ?? session.sessionKey, "idle", "session reset from WhatsApp overlay");
        break;
      case "set-thinking":
        if (body.value !== "off" && body.value !== "normal" && body.value !== "verbose") {
          return withCors(Response.json({ ok: false, error: "Invalid thinking level" }, { status: 400 }), url);
        }
        updateSessionThinkingLevel(session.sessionKey, body.value);
        break;
      case "rename":
        if (typeof body.value !== "string" || body.value.trim().length === 0) {
          return withCors(Response.json({ ok: false, error: "Missing display name" }, { status: 400 }), url);
        }
        updateSessionDisplayName(session.sessionKey, body.value.trim());
        break;
      default:
        return withCors(Response.json({ ok: false, error: "Unsupported action" }, { status: 400 }), url);
    }

    const snapshot = buildSnapshot({
      session: session.name ?? session.sessionKey,
      title: session.displayName ?? session.subject ?? undefined,
      chatId: session.lastTo ?? undefined,
    });
    return withCors(Response.json(snapshot), url);
  } catch (error) {
    return withCors(
      Response.json(
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
        { status: 500 },
      ),
      url,
    );
  }
}

async function handleBind(req: Request, url: URL): Promise<Response> {
  try {
    const body = (await req.json()) as BindBody;
    const session = body.session ? resolveSession(body.session) : null;
    if (!session) {
      return withCors(Response.json({ ok: false, error: "Session not found" }, { status: 404 }), url);
    }

    const title = cleanNullable(body.title);
    const chatId = cleanNullable(body.chatId);
    if (!title && !chatId) {
      return withCors(Response.json({ ok: false, error: "Missing title or chatId for binding" }, { status: 400 }), url);
    }

    const binding = upsertBinding({
      title,
      chatId,
      session: session.name ?? session.sessionKey,
    });

    const snapshot = buildSnapshot({
      title,
      chatId,
      session: session.name ?? session.sessionKey,
    });

    return withCors(Response.json({ ok: true, binding, snapshot }), url);
  } catch (error) {
    return withCors(
      Response.json(
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
        { status: 500 },
      ),
      url,
    );
  }
}

async function handleDomCommand(req: Request, url: URL): Promise<Response> {
  try {
    const body = (await req.json()) as OverlayDomCommandRequest;
    if (!body?.name) {
      return withCors(Response.json({ ok: false, error: "Missing command name" }, { status: 400 }), url);
    }

    const commandId = `wdc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const targetClientId = cleanNullable(body.clientId) ?? latestPublishedState?.clientId ?? null;
    if (!targetClientId) {
      return withCors(Response.json({ ok: false, error: "No active WhatsApp overlay client" }, { status: 409 }), url);
    }

    const envelope: OverlayDomCommandEnvelope = {
      id: commandId,
      targetClientId,
      createdAt: Date.now(),
      request: body,
    };

    pendingDomCommands.push(envelope);
    trimDomCommandState();

    return withCors(Response.json({ ok: true, commandId, targetClientId }), url);
  } catch (error) {
    return withCors(
      Response.json(
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
        { status: 500 },
      ),
      url,
    );
  }
}

function handleNextDomCommand(url: URL): Response {
  const clientId = cleanNullable(url.searchParams.get("clientId"));
  if (!clientId) {
    return withCors(Response.json({ ok: false, error: "Missing clientId" }, { status: 400 }), url);
  }

  trimDomCommandState();
  const index = pendingDomCommands.findIndex((entry) => entry.targetClientId === clientId);
  if (index === -1) {
    return withCors(Response.json({ ok: true, command: null }), url);
  }

  const [command] = pendingDomCommands.splice(index, 1);
  return withCors(Response.json({ ok: true, command }), url);
}

async function handleDomResult(req: Request, url: URL): Promise<Response> {
  try {
    const body = (await req.json()) as DomResultBody;
    if (!body?.result?.id) {
      return withCors(Response.json({ ok: false, error: "Missing DOM command result" }, { status: 400 }), url);
    }

    domCommandResults.set(body.result.id, body.result);
    trimDomCommandState();
    return withCors(Response.json({ ok: true }), url);
  } catch (error) {
    return withCors(
      Response.json(
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
        { status: 500 },
      ),
      url,
    );
  }
}

function handleGetDomResult(url: URL): Response {
  trimDomCommandState();
  const id = cleanNullable(url.searchParams.get("id"));
  if (!id) {
    return withCors(Response.json({ ok: false, error: "Missing command id" }, { status: 400 }), url);
  }

  const result = domCommandResults.get(id) ?? null;
  return withCors(Response.json({ ok: true, result }), url);
}

function handleSnapshot(url: URL): Response {
  const snapshot = buildSnapshot({
    chatId: url.searchParams.get("chatId"),
    title: url.searchParams.get("title"),
    session: url.searchParams.get("session"),
  });
  return withCors(Response.json(snapshot), url);
}

async function handleChatListResolve(req: Request, url: URL): Promise<Response> {
  try {
    const body = (await req.json()) as ChatListResolveBody;
    const rawEntries = Array.isArray(body?.entries) ? body.entries : [];
    const sessions = getOverlaySessions();
    const entries = rawEntries
      .slice(0, 60)
      .map((entry, index) => ({
        id: cleanNullable(entry?.id) ?? `row-${index}`,
        query: {
          chatId: cleanNullable(entry?.chatId),
          title: cleanNullable(entry?.title),
          session: cleanNullable(entry?.session),
        },
      }))
      .filter((entry) => entry.query.chatId || entry.query.title || entry.query.session);

    const items = entries.map((entry) => {
      const snapshot = buildSnapshotWithSessions(entry.query, sessions);
      return {
        id: entry.id,
        query: snapshot.query,
        resolved: snapshot.resolved,
        session: snapshot.session,
        warnings: snapshot.warnings,
      };
    });

    return withCors(
      Response.json({
        ok: true,
        items,
        generatedAt: Date.now(),
      }),
      url,
    );
  } catch (error) {
    return withCors(
      Response.json(
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
        { status: 500 },
      ),
      url,
    );
  }
}

async function handleMessageMeta(req: Request, url: URL): Promise<Response> {
  try {
    const body = (await req.json()) as MessageMetaBody;
    const requestedMessageId = cleanNullable(body?.messageId);
    const externalMessageId = extractExternalMessageId(requestedMessageId);
    if (!externalMessageId) {
      return withCors(Response.json({ ok: false, error: "Missing messageId" }, { status: 400 }), url);
    }

    const sessionName = cleanNullable(body?.session);
    const stored = dbGetMessageMeta(externalMessageId);
    if (stored?.transcription || stored?.mediaType) {
      return withCors(
        Response.json({
          ok: true,
          messageId: externalMessageId,
          meta: {
            transcription: stored.transcription ?? null,
            mediaType: stored.mediaType ?? null,
            createdAt: stored.createdAt,
            source: "message-metadata",
          },
        }),
        url,
      );
    }

    if (sessionName) {
      const transcript = findTranscriptInSessionHistory(sessionName, externalMessageId);
      if (transcript) {
        return withCors(
          Response.json({
            ok: true,
            messageId: externalMessageId,
            meta: {
              transcription: transcript,
              mediaType: "audio",
              createdAt: Date.now(),
              source: "session-history",
            },
          }),
          url,
        );
      }
    }

    return withCors(
      Response.json({
        ok: true,
        messageId: externalMessageId,
        meta: null,
      }),
      url,
    );
  } catch (error) {
    return withCors(
      Response.json(
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
        { status: 500 },
      ),
      url,
    );
  }
}

async function handlePublish(req: Request, url: URL): Promise<Response> {
  try {
    const body = (await req.json()) as OverlayPublishedState;
    if (!body?.clientId || !body?.view?.screen) {
      return withCors(Response.json({ ok: false, error: "Invalid overlay state payload" }, { status: 400 }), url);
    }

    latestPublishedState = {
      clientId: body.clientId,
      app: "whatsapp-web",
      context: {
        chatId: body.context?.chatId ?? null,
        title: body.context?.title ?? null,
        session: body.context?.session ?? null,
      },
      view: body.view,
      postedAt: typeof body.postedAt === "number" ? body.postedAt : Date.now(),
    };
    publishedHistory.unshift(latestPublishedState);
    publishedHistory.splice(20);

    const snapshot = buildSnapshot(queryFromPublishedState(latestPublishedState));
    return withCors(
      Response.json({
        ok: true,
        current: latestPublishedState,
        snapshot,
        historySize: publishedHistory.length,
      }),
      url,
    );
  } catch (error) {
    return withCors(
      Response.json(
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
        { status: 500 },
      ),
      url,
    );
  }
}

function handleCurrent(url: URL): Response {
  const snapshot = latestPublishedState ? buildSnapshot(queryFromPublishedState(latestPublishedState)) : null;
  return withCors(
    Response.json({
      ok: true,
      current: latestPublishedState,
      snapshot,
      history: publishedHistory,
      generatedAt: Date.now(),
    }),
    url,
  );
}

function buildSnapshot(query: OverlayQuery) {
  return buildSnapshotWithSessions(query, getOverlaySessions());
}

function getOverlaySessions() {
  return listSessions().map((session) => {
    const agent = dbGetAgent(session.agentId);
    return {
      ...session,
      modelOverride: session.modelOverride ?? agent?.model ?? undefined,
    };
  });
}

function buildSnapshotWithSessions(query: OverlayQuery, sessions: ReturnType<typeof getOverlaySessions>) {
  const binding = getBindingForQuery(query);
  const boundSession = binding ? resolveSession(binding.session) : null;
  const effectiveQuery =
    boundSession && !query.session
      ? {
          ...query,
          session: boundSession.name ?? boundSession.sessionKey,
        }
      : query;
  return buildOverlaySnapshot({
    query: effectiveQuery,
    sessions,
    liveBySessionName,
  });
}

function queryFromPublishedState(state: OverlayPublishedState): OverlayQuery {
  return {
    chatId: cleanNullable(state.context?.chatId) ?? cleanNullable(state.view?.chatIdCandidate),
    title:
      cleanNullable(state.context?.title) ??
      cleanNullable(state.view?.title) ??
      cleanNullable(state.view?.selectedChat),
    session: cleanNullable(state.context?.session),
  };
}

function cleanNullable(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function extractExternalMessageId(value: string | null): string | null {
  if (!value) return null;
  const parts = value.split("_").filter(Boolean);
  if (parts.length >= 3 && (parts[0] === "true" || parts[0] === "false")) {
    return parts[2] ?? null;
  }
  return value;
}

function findTranscriptInSessionHistory(sessionName: string, externalMessageId: string): string | null {
  const history = getRecentHistory(sessionName, 200);

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (message.role !== "user") continue;
    if (!message.content.includes(`mid:${externalMessageId}`)) continue;

    const match = message.content.match(/\[Audio\]\s*Transcript:\s*([\s\S]+)/i);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return null;
}

async function startRuntimeTracker(): Promise<void> {
  for await (const event of subscribe(
    "ravi.session.*.prompt",
    "ravi.session.*.response",
    "ravi.session.*.runtime",
    "ravi.session.*.claude",
    "ravi.session.*.stream",
    "ravi.session.*.tool",
    "ravi.approval.request",
    "ravi.approval.response",
  )) {
    const { topic, data } = event;

    if (topic.startsWith("ravi.session.")) {
      const sessionName = topic.split(".")[2];
      if (!sessionName) continue;

      if (topic.endsWith(".prompt")) {
        upsertLive(sessionName, "thinking", "prompt queued");
        continue;
      }

      if (topic.endsWith(".stream")) {
        upsertLive(sessionName, "streaming", "streaming reply");
        continue;
      }

      if (topic.endsWith(".response")) {
        upsertLive(sessionName, "streaming", "response emitted", false);
        continue;
      }

      if (topic.endsWith(".tool")) {
        const eventName = typeof data.event === "string" ? data.event : undefined;
        const toolName = typeof data.toolName === "string" ? data.toolName : "tool";
        if (eventName === "start") {
          upsertLive(sessionName, "thinking", `${toolName} running`);
        } else if (eventName === "end") {
          upsertLive(sessionName, "thinking", `${toolName} finished`);
        }
        continue;
      }

      if (topic.endsWith(".runtime") || topic.endsWith(".claude")) {
        const type = typeof data.type === "string" ? data.type : undefined;
        const subtype = typeof data.subtype === "string" ? data.subtype : undefined;
        const status = typeof data.status === "string" ? data.status : undefined;

        if (status === "compacting" || (type === "system" && subtype === "status" && status === "compacting")) {
          upsertLive(sessionName, "compacting", "compacting");
        } else if (status === "thinking" || status === "queued") {
          upsertLive(sessionName, "thinking", status);
        } else if (type === "assistant" || type === "assistant.message") {
          upsertLive(sessionName, "streaming", "assistant composing");
        } else if (type === "tool.started") {
          upsertLive(sessionName, "thinking", "tool running");
        } else if (type === "tool.completed") {
          upsertLive(sessionName, "thinking", "tool finished");
        } else if (type === "provider.raw" || type === "system" || type === "user") {
          upsertLive(sessionName, "thinking", "working");
        } else if (isTerminalRuntimeEvent(type) || status === "idle") {
          upsertLive(sessionName, "idle", "idle");
        }
      }
      continue;
    }

    if (topic === "ravi.approval.request") {
      const sessionName = typeof data.sessionName === "string" ? data.sessionName : null;
      if (sessionName) {
        upsertLive(sessionName, "awaiting_approval", "approval pending", true);
      }
      continue;
    }

    if (topic === "ravi.approval.response") {
      const sessionName = typeof data.sessionName === "string" ? data.sessionName : null;
      if (sessionName) {
        upsertLive(sessionName, "idle", "approval answered", false);
      }
    }
  }
}

function isTerminalRuntimeEvent(type?: string): boolean {
  return type === "result" || type === "turn.complete" || type === "turn.failed" || type === "turn.interrupted";
}

function upsertLive(sessionName: string, activity: OverlayActivity, summary: string, approvalPending?: boolean): void {
  const current = liveBySessionName.get(sessionName);
  liveBySessionName.set(sessionName, {
    activity,
    summary,
    approvalPending: approvalPending ?? current?.approvalPending,
    updatedAt: Date.now(),
  });
}

function withCors(response: Response, url: URL): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", url.origin === "null" ? "*" : url.origin);
  headers.set("Access-Control-Allow-Headers", "content-type");
  headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function trimDomCommandState(): void {
  const cutoff = Date.now() - 60_000;
  while (pendingDomCommands.length > 0 && pendingDomCommands[0]!.createdAt < cutoff) {
    pendingDomCommands.shift();
  }

  for (const [id, result] of domCommandResults) {
    if (result.finishedAt < cutoff) {
      domCommandResults.delete(id);
    }
  }
}

async function connectOverlayNats(): Promise<void> {
  const configuredUrl = process.env.RAVI_WA_OVERLAY_NATS_URL ?? process.env.NATS_URL ?? "nats://127.0.0.1:4222";
  const candidates = buildOverlayNatsCandidates(configuredUrl);
  let lastError: unknown = null;

  for (const url of candidates) {
    try {
      await closeNats();
      await connectNats(url);
      return;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error("Unable to connect overlay bridge to NATS");
}

function buildOverlayNatsCandidates(configuredUrl: string): string[] {
  const candidates = [configuredUrl];

  try {
    const parsed = new URL(configuredUrl);
    if (
      (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") &&
      !candidates.includes("nats://[::1]:4222")
    ) {
      const ipv6 = new URL(configuredUrl);
      ipv6.hostname = "[::1]";
      candidates.unshift(ipv6.toString());
    }
  } catch {
    return candidates;
  }

  return [...new Set(candidates)];
}
