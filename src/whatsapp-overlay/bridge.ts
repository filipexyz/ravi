import { serve } from "bun";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getRecentHistory, getRecentSessionHistory } from "../db.js";
import { ensureAgentInstructionFiles } from "../runtime/agent-instructions.js";
import { snapshotAgentCapabilities } from "../runtime/context-registry.js";
import { createAgent, ensureAgentDirs, getAllAgents, loadRouterConfig } from "../router/config.js";
import { expandHome } from "../router/resolver.js";
import { buildSessionKey } from "../router/session-key.js";
import { ensureUniqueName, generateSessionName } from "../router/session-name.js";
import {
  dbCreateRoute,
  dbGetAgent,
  dbGetMessageMeta,
  dbGetRoute,
  dbUpdateRoute,
  type ContextCapability,
} from "../router/router-db.js";
import {
  getOrCreateSession,
  getSessionByName,
  listSessions,
  resolveSession,
  updateSessionName,
  updateSessionSource,
  updateSessionDisplayName,
  updateSessionThinkingLevel,
  resetSession,
} from "../router/sessions.js";
import { closeNats, connectNats, publish, subscribe } from "../nats.js";
import { agentCan } from "../permissions/engine.js";
import { canAccessSession, canModifySession, canViewAgent, type ScopeContext } from "../permissions/scope.js";
import {
  buildOverlaySessionWorkspaceTimeline,
  buildOverlaySnapshot,
  mergeOverlaySessionWorkspaceMessages,
  parseOverlayTimestamp,
  type OverlayActivity,
  type OverlayChatArtifact,
  type OverlayChatArtifactAnchor,
  type OverlayLiveState,
  type OverlayQuery,
  type OverlaySessionSnapshot,
  type OverlaySessionEvent,
  type OverlaySessionWorkspaceMessage,
  upsertOverlayChatArtifact,
} from "./model.js";
import type { OverlayPublishedState } from "./state.js";
import { getBindingForQuery, upsertBinding } from "./bindings.js";
import type { OverlayDomCommandEnvelope, OverlayDomCommandRequest, OverlayDomCommandResult } from "./dom-control.js";
import { deriveOmniRouteTarget, isOmniGroupChat } from "./routing.js";
import { CliStreamRelayCommandError, createCliStreamRelay } from "../stream/relay.js";
import type { StreamEventMessage } from "../stream/protocol.js";
import { buildOverlayV3PlaceholderSnapshot, type OverlayV3RelayHealth } from "./placeholders.js";
import { buildOverlayTasksDailyActivity, type OverlayTasksDailyActivitySummary } from "./tasks-activity.js";
import type { SessionEntry } from "../router/types.js";
import { matchOmniChatFromRow } from "./chat-list-match.js";
import { publishSessionPrompt } from "../omni/session-stream.js";
import {
  buildTaskStreamSnapshot,
  dispatchTask,
  emitTaskEvent,
  getTaskDocPath,
  readTaskDocFrontmatter,
  taskProfileUsesTaskDocument,
  type TaskDocFrontmatterState,
  type TaskStatus,
  type TaskStreamSelection,
  type TaskStreamTaskEntity,
} from "../tasks/index.js";
import { buildOverlayTaskDispatchState, type OverlayTaskDispatchState } from "./task-dispatch.js";
import { buildOverlayInsightsPayload, type OverlayInsightsSnapshot } from "./insights.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../..");
const PORT = Number(process.env.RAVI_WA_OVERLAY_PORT ?? 4210);
const HOST = process.env.RAVI_WA_OVERLAY_HOST ?? "127.0.0.1";
const CHAT_LIST_OMNI_CACHE_TTL_MS = 5_000;
const HOT_SESSION_TASK_CACHE_TTL_MS = 1_000;
const SESSION_LIVE_EVENT_LIMIT = 40;
const SESSION_LIVE_MESSAGE_LIMIT = 24;
const SESSION_LIVE_MESSAGE_MATCH_WINDOW_MS = 2 * 60 * 1000;

function toTaskDocRef(task: { id: string; taskDir: string | null }) {
  return {
    id: task.id,
    taskDir: task.taskDir ?? undefined,
  };
}

const liveBySessionName = new Map<string, OverlayLiveState>();
type SessionArtifactTurnState = {
  activeResponseEmitIds: string[];
  activeDeliveredMessageIds: string[];
  activePromptMessageIds: string[];
  activeAssistantMessageId: string | null;
  pendingArtifactId: string | null;
  pendingArtifactEmitId: string | null;
};
const artifactTurnStateBySessionName = new Map<string, SessionArtifactTurnState>();
let latestPublishedState: OverlayPublishedState | null = null;
const publishedHistory: OverlayPublishedState[] = [];
const pendingDomCommands: OverlayDomCommandEnvelope[] = [];
const domCommandResults = new Map<string, OverlayDomCommandResult>();
const runtimeTrackerTasks = new Set<Promise<void>>();
let chatListResolveOmniCache: { expiresAt: number; chats: OmniPanelChat[] } | null = null;
let hotSessionTaskCache: { expiresAt: number; items: TaskStreamTaskEntity[] } | null = null;

type ActionName = "abort" | "reset" | "set-thinking" | "rename";

type ActionBody = {
  session?: string;
  action?: ActionName;
  value?: string | null;
};

type PromptBody = {
  session?: string;
  prompt?: string | null;
};

type BindBody = {
  session?: string;
  title?: string | null;
  chatId?: string | null;
};

type OmniRouteBody = {
  action?: "bind-existing" | "create-session" | "migrate-session";
  actorSession?: string | null;
  session?: string | null;
  title?: string | null;
  chatId?: string | null;
  instance?: string | null;
  chatType?: string | null;
  chatName?: string | null;
  agentId?: string | null;
  sessionName?: string | null;
  createAgent?: boolean;
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
    preview?: string | null;
    timeLabel?: string | null;
  }>;
};

type MessageMetaBody = {
  session?: string | null;
  messageId?: string | null;
  chatId?: string | null;
};

type OverlayV3CommandBody = {
  name?: string | null;
  args?: Record<string, unknown> | null;
};

type OverlayTasksQuery = {
  taskId: string | null;
  status: TaskStatus | null;
  agentId: string | null;
  sessionName: string | null;
  actorSession: string | null;
  eventsLimit: number;
  timeZone: string | null;
  todayKey: string | null;
};

type OverlayInsightsQuery = {
  limit: number;
};

type OverlayTasksSnapshot = {
  ok: true;
  generatedAt: number;
  query: OverlayTasksQuery;
  agents: OverlayTaskDispatchAgent[];
  sessions: OverlayTaskDispatchSession[];
  stats: {
    total: number;
    open: number;
    dispatched: number;
    inProgress: number;
    blocked: number;
    done: number;
    failed: number;
  };
  items: TaskStreamTaskEntity[];
  activeItems: TaskStreamTaskEntity[];
  dailyActivity: OverlayTasksDailyActivitySummary;
  selectedTask: OverlayTaskSelection | null;
};

type OverlayInsightsPayload = OverlayInsightsSnapshot & {
  query: OverlayInsightsQuery;
};

type OverlayTaskDocumentSummary = {
  taskDir: string | null;
  path: string;
  frontmatter: TaskDocFrontmatterState;
};

type OverlayTaskDispatchAgent = {
  id: string;
  name: string | null;
  provider: string | null;
};

type OverlayTaskDispatchSession = {
  sessionKey: string;
  sessionName: string;
  agentId: string;
  displayName: string | null;
  chatLabel: string | null;
  updatedAt: number;
  activity: OverlayActivity;
};

type OverlayTaskSelection = TaskStreamSelection & {
  taskDocument: OverlayTaskDocumentSummary | null;
  dispatch: OverlayTaskDispatchState | null;
};

type OverlayTaskDispatchBody = {
  taskId?: string | null;
  agentId?: string | null;
  sessionName?: string | null;
  reportToSessionName?: string | null;
  actorSession?: string | null;
  eventsLimit?: number | null;
  timeZone?: string | null;
  todayKey?: string | null;
};

type OmniInstanceRecord = {
  id: string;
  name: string;
  channel?: string | null;
  isActive?: boolean;
  profileName?: string | null;
  ownerIdentifier?: string | null;
  lastSeenAt?: string | null;
  updatedAt?: string | null;
};

type OmniWhoamiRecord = {
  instanceId?: string | null;
  phone?: string | null;
  profileName?: string | null;
  ownerIdentifier?: string | null;
  state?: string | null;
  isConnected?: boolean;
};

type OmniChatRecord = {
  id: string;
  instanceId: string;
  externalId?: string | null;
  canonicalId?: string | null;
  chatType?: string | null;
  channel?: string | null;
  name?: string | null;
  description?: string | null;
  participantCount?: number | null;
  unreadCount?: number | null;
  lastMessageAt?: string | null;
  lastMessagePreview?: string | null;
  updatedAt?: string | null;
};

type OmniGroupRecord = {
  externalId?: string | null;
  name?: string | null;
  description?: string | null;
  memberCount?: number | null;
  createdAt?: string | null;
  isReadOnly?: boolean;
  platformMetadata?: {
    isCommunity?: boolean;
    isCommunityAnnounce?: boolean;
  } | null;
};

type OmniPanelInstance = {
  id: string;
  name: string;
  channel: string;
  isActive: boolean;
  status: string;
  isConnected: boolean;
  profileName: string | null;
  phone: string | null;
  ownerIdentifier: string | null;
  lastSeenAt: string | null;
  updatedAt: string | null;
  auth?: OmniPanelItemAuth;
};

type OmniPanelAgent = {
  id: string;
  name: string | null;
  cwd: string;
  provider: string | null;
  auth?: OmniPanelItemAuth;
};

type OmniPanelChat = {
  id: string;
  instanceId: string;
  instanceName: string;
  externalId: string | null;
  canonicalId: string | null;
  chatType: string | null;
  channel: string | null;
  name: string | null;
  participantCount: number | null;
  unreadCount: number | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  updatedAt: string | null;
  matchesCurrent: boolean;
  linkedSession: OverlaySessionSnapshot | null;
  routePattern?: string | null;
  routeObjectId?: string | null;
  auth?: OmniPanelItemAuth;
};

type OmniPanelGroup = {
  instanceId: string;
  externalId: string | null;
  name: string | null;
  description: string | null;
  memberCount: number | null;
  createdAt: string | null;
  isReadOnly: boolean;
  isCommunity: boolean;
  routePattern?: string | null;
  routeObjectId?: string | null;
  auth?: OmniPanelItemAuth;
};

type OmniPanelActor = {
  sessionKey: string;
  sessionName: string;
  agentId: string;
  capabilities: ContextCapability[];
};

type OmniPermissionDecision = {
  allowed: boolean;
  matched: string[];
  missing: string[];
  reason: string | null;
};

type OmniPanelItemAuth = {
  visibility: "full" | "opaque";
  view: OmniPermissionDecision;
};

type OmniPanelSnapshot = {
  ok: true;
  query: {
    chatId: string | null;
    title: string | null;
    session: string | null;
    instance: string | null;
  };
  actor: OmniPanelActor | null;
  preferredInstance: OmniPanelInstance | null;
  currentChat: OmniPanelChat | null;
  instances: OmniPanelInstance[];
  agents: OmniPanelAgent[];
  chats: OmniPanelChat[];
  groups: OmniPanelGroup[];
  sessions: OverlaySessionSnapshot[];
  warnings: string[];
  generatedAt: number;
};

class OverlayV3CommandValidationError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;

  constructor(message: string, options: { code: string; status: number; details?: unknown }) {
    super(message);
    this.name = "OverlayV3CommandValidationError";
    this.code = options.code;
    this.status = options.status;
    this.details = options.details ?? null;
  }
}

class OverlayHttpResponseError extends Error {
  readonly status: number;
  readonly payload: Record<string, unknown>;

  constructor(status: number, payload: Record<string, unknown>) {
    super(typeof payload.error === "string" ? payload.error : `HTTP ${status}`);
    this.name = "OverlayHttpResponseError";
    this.status = status;
    this.payload = payload;
  }
}

const OMNI_PANEL_CACHE_TTL_MS = 3_000;
const omniPanelCache = new Map<string, { expiresAt: number; value: Promise<OmniPanelSnapshot> | OmniPanelSnapshot }>();
const overlayV3Relay = createCliStreamRelay({
  command: "bun",
  args: ["src/cli/index.ts", "stream", "--scope", "overlay.whatsapp", "--heartbeat-ms", "1500"],
  cwd: REPO_ROOT,
  scope: "overlay.whatsapp",
});
let overlayV3RelayBoot: Promise<void> | null = null;
let overlayV3RelayEventsBound = false;

void ensureOverlayV3Relay();

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

    if (url.pathname === "/api/whatsapp-overlay/session/workspace" && req.method === "GET") {
      return handleSessionWorkspace(url);
    }

    if (url.pathname === "/api/whatsapp-overlay/session/prompt" && req.method === "POST") {
      return handleSessionPrompt(req, url);
    }

    if (url.pathname === "/api/whatsapp-overlay/tasks" && req.method === "GET") {
      return handleTasks(url);
    }

    if (url.pathname === "/api/whatsapp-overlay/insights" && req.method === "GET") {
      return handleInsights(url);
    }

    if (url.pathname === "/api/whatsapp-overlay/tasks/dispatch" && req.method === "POST") {
      return handleTaskDispatch(req, url);
    }

    if (url.pathname === "/api/whatsapp-overlay/current" && req.method === "POST") {
      return handlePublish(req, url);
    }

    if (url.pathname === "/api/whatsapp-overlay/v3/placeholders" && req.method === "GET") {
      return handleV3Placeholders(url);
    }

    if (url.pathname === "/api/whatsapp-overlay/v3/command" && req.method === "POST") {
      return handleV3Command(req, url);
    }

    if (url.pathname === "/api/whatsapp-overlay/chat-list/resolve" && req.method === "POST") {
      return handleChatListResolve(req, url);
    }

    if (url.pathname === "/api/whatsapp-overlay/message-meta" && req.method === "POST") {
      return handleMessageMeta(req, url);
    }

    if (url.pathname === "/api/whatsapp-overlay/omni/panel" && req.method === "GET") {
      return handleOmniPanel(url);
    }

    if (url.pathname === "/api/whatsapp-overlay/omni/route" && req.method === "POST") {
      return handleOmniRoute(req, url);
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

async function ensureOverlayV3Relay(): Promise<void> {
  bindOverlayV3RelayEvents();
  const health = overlayV3Relay.health();
  if (health.status === "running") {
    if (!health.snapshot) {
      try {
        await overlayV3Relay.requestSnapshot();
      } catch {}
    }
    return;
  }

  if (overlayV3RelayBoot) {
    return await overlayV3RelayBoot;
  }

  overlayV3RelayBoot = (async () => {
    await overlayV3Relay.start();
    if (!overlayV3Relay.health().snapshot) {
      try {
        await overlayV3Relay.requestSnapshot();
      } catch {}
    }
  })()
    .catch((error) => {
      console.warn("[RaviOverlay] v3 relay bootstrap failed", error);
      throw error;
    })
    .finally(() => {
      overlayV3RelayBoot = null;
    });

  return await overlayV3RelayBoot;
}

function bindOverlayV3RelayEvents(): void {
  if (overlayV3RelayEventsBound) return;
  overlayV3RelayEventsBound = true;
  overlayV3Relay.events.on("event", (message: StreamEventMessage) => {
    void handleOverlayV3RelayEvent(message).catch((error) => {
      console.warn("[RaviOverlay] v3 relay event handling failed", error);
    });
  });
}

function getOverlayV3RelayHealth(): OverlayV3RelayHealth {
  const health = overlayV3Relay.health();
  return {
    status: health.status,
    pid: health.pid,
    scope: health.scope,
    topicPatterns: health.topicPatterns,
    lastHeartbeatAt: health.lastHeartbeatAt,
    lastCursor: health.lastCursor,
    lastError: health.lastError,
    hasHello: Boolean(health.hello),
    hasSnapshot: Boolean(health.snapshot),
  };
}

async function handleV3Placeholders(url: URL): Promise<Response> {
  try {
    await ensureOverlayV3Relay();
  } catch {
    // keep serving degraded placeholder state even if the relay is down
  }

  const payload = buildOverlayV3PlaceholderSnapshot({
    publishedState: latestPublishedState,
    relay: getOverlayV3RelayHealth(),
  });
  return withCors(Response.json(payload), url);
}

async function handleV3Command(req: Request, url: URL): Promise<Response> {
  try {
    const body = (await req.json()) as OverlayV3CommandBody;
    const name = cleanNullable(body?.name);
    if (!name) {
      return withCors(
        Response.json(
          {
            ok: false,
            error: "Missing name",
            code: "invalid_command",
          },
          { status: 400 },
        ),
        url,
      );
    }
    const args = normalizeOverlayV3CommandArgs(name, body?.args);

    if (name === "chat.bindSession") {
      const commandId = `v3c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const result = await executeOmniRoute({
        action: "bind-existing",
        actorSession: cleanNullable(typeof args.actorSession === "string" ? args.actorSession : null),
        session: cleanRequired(typeof args.session === "string" ? args.session : null, "session"),
        title: cleanNullable(typeof args.title === "string" ? args.title : null),
        chatId: cleanRequired(typeof args.chatId === "string" ? args.chatId : null, "chatId"),
        instance: cleanRequired(typeof args.instance === "string" ? args.instance : null, "instance"),
        chatType: cleanNullable(typeof args.chatType === "string" ? args.chatType : null),
        chatName: cleanNullable(typeof args.chatName === "string" ? args.chatName : null),
      });
      return withCors(
        Response.json({
          ok: true,
          ack: {
            body: {
              commandId,
              ok: true,
              result,
            },
          },
        }),
        url,
      );
    }

    await ensureOverlayV3Relay();
    const ack = await overlayV3Relay.sendCommand(name, args);
    return withCors(
      Response.json({
        ok: true,
        ack,
      }),
      url,
    );
  } catch (error) {
    if (error instanceof CliStreamRelayCommandError) {
      return withCors(
        Response.json(
          {
            ok: false,
            error: error.message,
            code: error.code,
            retryable: error.retryable,
            details: error.details ?? null,
          },
          { status: 400 },
        ),
        url,
      );
    }

    if (error instanceof OverlayHttpResponseError) {
      return withCors(Response.json(error.payload, { status: error.status }), url);
    }

    if (error instanceof OverlayV3CommandValidationError) {
      return withCors(
        Response.json(
          {
            ok: false,
            error: error.message,
            code: error.code,
            details: error.details,
          },
          { status: error.status },
        ),
        url,
      );
    }

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

    enqueueDomCommandRequest(targetClientId, body, commandId);

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

function normalizeOverlayV3CommandArgs(
  name: string,
  argsInput: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const args = argsInput && typeof argsInput === "object" ? { ...argsInput } : {};

  if (name === "placeholder.outline") {
    const componentId = cleanRequired(typeof args.componentId === "string" ? args.componentId : null, "componentId");
    const component = latestPublishedState?.view.components?.find((entry) => entry.id === componentId) ?? null;
    const selector =
      cleanNullable(typeof args.selector === "string" ? args.selector : null) ?? component?.selector ?? null;
    if (!selector) {
      throw new OverlayV3CommandValidationError(`Mapped selector not found for component: ${componentId}`, {
        code: "selector_unavailable",
        status: 409,
        details: { componentId },
      });
    }

    const clientId =
      cleanNullable(typeof args.clientId === "string" ? args.clientId : null) ?? latestPublishedState?.clientId ?? null;
    if (!clientId) {
      throw new OverlayV3CommandValidationError("No active WhatsApp overlay client", {
        code: "no_active_client",
        status: 409,
      });
    }

    const color = cleanNullable(typeof args.color === "string" ? args.color : null) ?? "#53bdeb";
    const durationMs = normalizePositiveNumber(args.durationMs, 2500);

    return {
      ...args,
      componentId,
      selector,
      clientId,
      color,
      durationMs,
      limit: 1,
      visible: true,
    };
  }

  if (name === "chat.bindSession") {
    const session = cleanRequired(typeof args.session === "string" ? args.session : null, "session");
    const chatId = cleanRequired(typeof args.chatId === "string" ? args.chatId : null, "chatId");
    const instance = cleanRequired(typeof args.instance === "string" ? args.instance : null, "instance");
    const title = cleanNullable(typeof args.title === "string" ? args.title : null);
    const chatName = cleanNullable(typeof args.chatName === "string" ? args.chatName : null) ?? title;
    const chatType = cleanNullable(typeof args.chatType === "string" ? args.chatType : null);
    const actorSession = cleanNullable(typeof args.actorSession === "string" ? args.actorSession : null);

    return {
      ...args,
      actorSession,
      session,
      title,
      chatId,
      instance,
      chatType,
      chatName,
    };
  }

  return args;
}

async function handleOverlayV3RelayEvent(message: StreamEventMessage): Promise<void> {
  if (message.topic !== "overlay.whatsapp.command.requested") return;

  const eventBody = message.body as {
    name?: unknown;
    args?: Record<string, unknown>;
  };
  const name = cleanNullable(typeof eventBody.name === "string" ? eventBody.name : null);
  if (name !== "placeholder.outline") return;

  const args = eventBody.args ?? {};
  const selector = cleanNullable(typeof args.selector === "string" ? args.selector : null);
  const clientId = cleanNullable(typeof args.clientId === "string" ? args.clientId : null);
  if (!selector || !clientId) return;

  const color = cleanNullable(typeof args.color === "string" ? args.color : null) ?? "#53bdeb";
  const durationMs = normalizePositiveNumber(args.durationMs, 2500);

  enqueueDomCommandRequest(clientId, { name: "clear" });
  enqueueDomCommandRequest(clientId, {
    name: "outline",
    selector,
    visible: true,
    limit: 1,
    attrValue: color,
  });

  const clearTimer = setTimeout(() => {
    enqueueDomCommandRequest(clientId, { name: "clear" });
  }, durationMs);
  clearTimer.unref?.();
}

function enqueueDomCommandRequest(
  targetClientId: string,
  request: OverlayDomCommandRequest,
  commandId = `wdc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
): string {
  const envelope: OverlayDomCommandEnvelope = {
    id: commandId,
    targetClientId,
    createdAt: Date.now(),
    request,
  };

  pendingDomCommands.push(envelope);
  trimDomCommandState();
  return commandId;
}

function handleSnapshot(url: URL): Response {
  const snapshot = buildSnapshot({
    chatId: url.searchParams.get("chatId"),
    title: url.searchParams.get("title"),
    session: url.searchParams.get("session"),
  });
  return withCors(Response.json(snapshot), url);
}

function buildOverlayTaskDispatchAgents(): OverlayTaskDispatchAgent[] {
  return getAllAgents()
    .map((agent) => ({
      id: agent.id,
      name: cleanNullable(agent.name),
      provider: cleanNullable(agent.provider ?? null),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function rankOverlayTaskDispatchSession(activity: OverlayActivity): number {
  switch (activity) {
    case "streaming":
      return 5;
    case "thinking":
    case "awaiting_approval":
      return 4;
    case "compacting":
      return 3;
    case "blocked":
      return 2;
    default:
      return 1;
  }
}

function buildOverlayTaskDispatchSessions(
  sessions: ReturnType<typeof getOverlaySessions> = getOverlaySessions(),
): OverlayTaskDispatchSession[] {
  return sessions
    .map((session) => {
      const sessionName = cleanNullable(session.name ?? session.sessionKey);
      if (!sessionName) return null;
      const activity = liveBySessionName.get(session.name ?? "")?.activity ?? "idle";
      return {
        sessionKey: session.sessionKey,
        sessionName,
        agentId: session.agentId,
        displayName: cleanNullable(session.displayName),
        chatLabel:
          cleanNullable(session.displayName) ?? cleanNullable(session.subject) ?? cleanNullable(session.lastTo) ?? null,
        updatedAt: session.updatedAt,
        activity,
      };
    })
    .filter((session): session is OverlayTaskDispatchSession => Boolean(session))
    .sort((left, right) => {
      const rightRank = rankOverlayTaskDispatchSession(right.activity);
      const leftRank = rankOverlayTaskDispatchSession(left.activity);
      return (
        rightRank - leftRank || right.updatedAt - left.updatedAt || left.sessionName.localeCompare(right.sessionName)
      );
    });
}

function buildOverlayTasksPayload(query: OverlayTasksQuery): OverlayTasksSnapshot {
  const overlaySessions = getOverlaySessions();
  const dispatchSessions = buildOverlayTaskDispatchSessions(overlaySessions);
  const actorSession = query.actorSession ? resolveSession(query.actorSession) : null;
  const listSnapshot = buildTaskStreamSnapshot({
    ...(query.status ? { status: query.status } : {}),
    ...(query.agentId ? { agentId: query.agentId } : {}),
    ...(query.sessionName ? { sessionName: query.sessionName } : {}),
    eventsLimit: query.eventsLimit,
  });
  const items = [...listSnapshot.items].sort((a, b) => b.updatedAt - a.updatedAt);
  const activeItems = items.filter((item) => item.status !== "done" && item.status !== "failed");
  let selectedTaskId = query.taskId ?? activeItems[0]?.id ?? items[0]?.id ?? null;
  let selectedTask: TaskStreamSelection | null = null;

  if (selectedTaskId) {
    try {
      selectedTask =
        buildTaskStreamSnapshot({
          taskId: selectedTaskId,
          eventsLimit: query.eventsLimit,
        }).selectedTask ?? null;
    } catch (error) {
      if (query.taskId && error instanceof Error && /task not found/i.test(error.message)) {
        selectedTaskId = activeItems[0]?.id ?? items[0]?.id ?? null;
        selectedTask = selectedTaskId
          ? (buildTaskStreamSnapshot({
              taskId: selectedTaskId,
              eventsLimit: query.eventsLimit,
            }).selectedTask ?? null)
          : null;
      } else {
        throw error;
      }
    }
  }

  const selectedTaskWithDocument: OverlayTaskSelection | null = selectedTask
    ? {
        ...selectedTask,
        taskDocument: !taskProfileUsesTaskDocument(selectedTask.task.taskProfile)
          ? null
          : {
              taskDir: selectedTask.task.taskDir ?? null,
              path: getTaskDocPath(toTaskDocRef(selectedTask.task)),
              frontmatter: readTaskDocFrontmatter(toTaskDocRef(selectedTask.task)),
            },
        dispatch: buildOverlayTaskDispatchState(selectedTask, {
          actorSessionName: actorSession?.name ?? actorSession?.sessionKey ?? null,
          actorAgentId: actorSession?.agentId ?? null,
          availableSessions: dispatchSessions.map((session) => ({
            sessionName: session.sessionName,
            agentId: session.agentId,
          })),
        }),
      }
    : null;

  return {
    ok: true,
    generatedAt: Date.now(),
    query: {
      taskId: selectedTaskId,
      status: query.status,
      agentId: query.agentId,
      sessionName: query.sessionName,
      actorSession: query.actorSession,
      eventsLimit: query.eventsLimit,
      timeZone: query.timeZone,
      todayKey: query.todayKey,
    },
    agents: buildOverlayTaskDispatchAgents(),
    sessions: dispatchSessions,
    stats: listSnapshot.stats,
    items,
    activeItems,
    dailyActivity: buildOverlayTasksDailyActivity({
      tasks: items,
      timeZone: query.timeZone,
      todayKey: query.todayKey,
    }),
    selectedTask: selectedTaskWithDocument,
  };
}

function buildOverlayInsightsReadModel(query: OverlayInsightsQuery): OverlayInsightsPayload {
  const snapshot = buildOverlayInsightsPayload({
    limit: query.limit,
    sessions: getOverlaySessions(),
    liveBySessionName,
  });

  return {
    ...snapshot,
    query,
  };
}

function handleTasks(url: URL): Response {
  try {
    const payload = buildOverlayTasksPayload({
      taskId: cleanNullable(url.searchParams.get("taskId")),
      status: cleanTaskStatus(url.searchParams.get("status")),
      agentId: cleanNullable(url.searchParams.get("agentId")),
      sessionName: cleanNullable(url.searchParams.get("sessionName")),
      actorSession: cleanNullable(url.searchParams.get("actorSession")),
      eventsLimit: normalizeTaskEventsLimit(url.searchParams.get("eventsLimit")),
      timeZone: cleanNullable(url.searchParams.get("timeZone")),
      todayKey: cleanNullable(url.searchParams.get("todayKey")),
    });
    return withCors(Response.json(payload), url);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /task not found/i.test(message) ? 404 : 500;
    return withCors(
      Response.json(
        {
          ok: false,
          error: message,
        },
        { status },
      ),
      url,
    );
  }
}

function handleInsights(url: URL): Response {
  try {
    const payload = buildOverlayInsightsReadModel({
      limit: normalizeInsightsLimit(url.searchParams.get("limit")),
    });
    return withCors(Response.json(payload), url);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return withCors(
      Response.json(
        {
          ok: false,
          error: message,
        },
        { status: 500 },
      ),
      url,
    );
  }
}

async function handleTaskDispatch(req: Request, url: URL): Promise<Response> {
  try {
    const body = ((await req.json()) as OverlayTaskDispatchBody | null) ?? {};
    const taskId = cleanRequired(cleanNullable(body.taskId), "taskId");
    const agentId = cleanRequired(cleanNullable(body.agentId), "agentId");
    const eventsLimit = normalizeTaskEventsLimit(String(body.eventsLimit ?? 20));
    const selection = buildTaskStreamSnapshot({
      taskId,
      eventsLimit,
    }).selectedTask;

    if (!selection) {
      throw new OverlayHttpResponseError(404, { ok: false, error: `Task not found: ${taskId}` });
    }

    const actorSessionName = cleanNullable(body.actorSession);
    const dispatchSessions = buildOverlayTaskDispatchSessions();
    const actorSession = actorSessionName ? resolveSession(actorSessionName) : null;
    const dispatch = buildOverlayTaskDispatchState(selection, {
      actorSessionName: actorSession?.name ?? actorSession?.sessionKey ?? null,
      actorAgentId: actorSession?.agentId ?? null,
      availableSessions: dispatchSessions.map((session) => ({
        sessionName: session.sessionName,
        agentId: session.agentId,
      })),
    });
    if (!dispatch?.allowed) {
      const error =
        dispatch?.reason === "assigned"
          ? "Essa task já tem assignment ativo."
          : dispatch?.reason === "archived"
            ? "Task arquivada não pode ser despachada pelo kanban."
            : "Só tasks open e ainda não despachadas podem ser enviadas pelo kanban.";
      throw new OverlayHttpResponseError(409, { ok: false, error });
    }

    const sessionName = cleanNullable(body.sessionName) ?? dispatch.defaultSessionName;
    const reportToSessionName = cleanNullable(body.reportToSessionName) ?? dispatch.defaultReportToSessionName;
    const result = await dispatchTask(taskId, {
      agentId,
      sessionName,
      assignedBy: actorSession?.name ?? actorSession?.sessionKey ?? "wa-overlay",
      ...(actorSession?.agentId ? { assignedByAgentId: actorSession.agentId } : {}),
      ...(actorSession ? { assignedBySessionName: actorSession.name ?? actorSession.sessionKey } : {}),
      ...(reportToSessionName ? { reportToSessionName } : {}),
    });
    await emitTaskEvent(result.task, result.event);
    hotSessionTaskCache = null;

    const snapshot = buildOverlayTasksPayload({
      taskId,
      status: null,
      agentId: null,
      sessionName: null,
      actorSession: actorSessionName,
      eventsLimit,
      timeZone: cleanNullable(body.timeZone),
      todayKey: cleanNullable(body.todayKey),
    });

    return withCors(
      Response.json({
        ok: true,
        taskId,
        sessionName: result.sessionName,
        reportToSessionName: result.assignment.reportToSessionName ?? reportToSessionName ?? null,
        assignment: result.assignment,
        dispatchSummary: result.dispatchSummary,
        snapshot,
      }),
      url,
    );
  } catch (error) {
    if (error instanceof OverlayHttpResponseError) {
      return withCors(Response.json(error.payload, { status: error.status }), url);
    }
    const message = error instanceof Error ? error.message : String(error);
    const status = /task not found/i.test(message) ? 404 : 400;
    return withCors(Response.json({ ok: false, error: message }, { status }), url);
  }
}

async function handleOmniPanel(url: URL): Promise<Response> {
  try {
    const query = {
      chatId: cleanNullable(url.searchParams.get("chatId")),
      title: cleanNullable(url.searchParams.get("title")),
      session: cleanNullable(url.searchParams.get("session")),
      instance: cleanNullable(url.searchParams.get("instance")),
    };
    const snapshot = await getCachedOmniPanel(query);
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

async function handleOmniRoute(req: Request, url: URL): Promise<Response> {
  try {
    const body = (await req.json()) as OmniRouteBody;
    const result = await executeOmniRoute(body);
    return withCors(Response.json(result), url);
  } catch (error) {
    if (error instanceof OverlayHttpResponseError) {
      return withCors(Response.json(error.payload, { status: error.status }), url);
    }
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

async function executeOmniRoute(body: OmniRouteBody): Promise<Record<string, unknown>> {
  const actor = resolveOmniRouteActor(cleanNullable(body.actorSession));
  if (!actor) {
    throw new OverlayHttpResponseError(403, {
      ok: false,
      error: "Permission denied: no current session actor",
      missingRelations: ["current session actor"],
    });
  }

  const target = deriveOmniRouteTarget({
    chatId: cleanRequired(body.chatId, "chatId"),
    instanceName: cleanRequired(body.instance, "instance"),
    chatType: cleanNullable(body.chatType),
    title: cleanNullable(body.chatName) ?? cleanNullable(body.title),
  });
  const routeObjectId = buildRouteObjectId(target.instanceName, target.routePattern);

  const title = cleanNullable(body.title) ?? target.title;
  const sessionNameInput = cleanNullable(body.sessionName);
  let session: ReturnType<typeof resolveSession> = null;
  let createdAgent = false;
  let createdSession = false;

  if (body.action === "bind-existing") {
    session = body.session ? resolveSession(body.session) : null;
    if (!session) {
      throw new OverlayHttpResponseError(404, { ok: false, error: "Session not found" });
    }
    const permissions = [
      checkSessionAccess(actor, toOmniPanelSessionSnapshot(session)),
      checkRouteModify(actor, routeObjectId),
    ];
    const denied = collectDeniedRelations(permissions);
    if (denied.length > 0) {
      throw new OverlayHttpResponseError(403, {
        ok: false,
        error: "Permission denied",
        missingRelations: denied,
      });
    }
  } else if (body.action === "create-session" || body.action === "migrate-session") {
    const agentId = cleanRequired(body.agentId, "agentId");
    const permissions = [
      checkGroupExecute(actor, "sessions"),
      checkRouteModify(actor, routeObjectId),
      checkAgentView(actor, agentId),
    ];
    if (body.action === "migrate-session") {
      const currentSession = body.session ? resolveSession(body.session) : null;
      permissions.push(checkSessionModify(actor, currentSession ? toOmniPanelSessionSnapshot(currentSession) : null));
    }
    if (body.action === "create-session" && body.createAgent === true) {
      permissions.push(checkGroupExecute(actor, "agents"));
    }
    const denied = collectDeniedRelations(permissions);
    if (denied.length > 0) {
      throw new OverlayHttpResponseError(403, {
        ok: false,
        error: "Permission denied",
        missingRelations: denied,
      });
    }

    createdAgent = ensureOmniAgent(agentId, body.action === "create-session" && body.createAgent === true);
    const agentConfig = dbGetAgent(agentId);
    if (!agentConfig) {
      throw new OverlayHttpResponseError(404, { ok: false, error: `Agent not found: ${agentId}` });
    }

    const currentSession =
      body.action === "migrate-session" ? (body.session ? resolveSession(body.session) : null) : null;
    if (body.action === "migrate-session") {
      if (!currentSession) {
        throw new OverlayHttpResponseError(404, { ok: false, error: "Current session not found" });
      }
      if (currentSession.agentId === agentId) {
        throw new OverlayHttpResponseError(409, { ok: false, error: "Essa sessão já está nesse agent" });
      }
    }

    const sessionKey = buildSessionKey({
      agentId,
      channel: "whatsapp",
      accountId: target.instanceName,
      peerKind: target.peerKind,
      peerId: target.peerId,
    });
    const existingByKey = resolveSession(sessionKey);
    const existingNamed = sessionNameInput ? getSessionByName(sessionNameInput) : null;
    if (existingNamed && existingNamed.sessionKey !== existingByKey?.sessionKey) {
      throw new OverlayHttpResponseError(409, {
        ok: false,
        error: `Session already exists: ${sessionNameInput}. Escolha a sessão existente para migrar.`,
      });
    }
    const generatedName =
      sessionNameInput ??
      existingByKey?.name ??
      ensureUniqueName(
        generateSessionName(agentId, {
          chatType: target.chatType,
          groupName: target.chatType === "group" ? (target.title ?? undefined) : undefined,
          peerKind: target.peerKind,
          peerId: target.peerId,
        }),
      );
    createdSession = !existingByKey;
    session = getOrCreateSession(sessionKey, agentId, expandHome(agentConfig.cwd), {
      name: generatedName,
      chatType: target.chatType,
      channel: "whatsapp",
      accountId: target.instanceName,
      groupId: target.groupId ?? undefined,
      subject: target.chatType === "group" ? (target.title ?? undefined) : undefined,
      displayName: target.title ?? undefined,
      lastChannel: "whatsapp",
      lastAccountId: target.instanceName,
      lastTo: target.sourceChatId,
    });
    if ((sessionNameInput || !session.name) && session.name !== generatedName) {
      updateSessionName(session.sessionKey, generatedName);
      session = resolveSession(session.sessionKey);
    }
  } else {
    throw new OverlayHttpResponseError(400, { ok: false, error: "Unsupported Omni route action" });
  }

  if (!session) {
    throw new OverlayHttpResponseError(404, { ok: false, error: "Session not found" });
  }

  updateSessionSource(session.sessionKey, {
    channel: "whatsapp",
    accountId: target.instanceName,
    chatId: target.sourceChatId,
  });
  if (title) {
    updateSessionDisplayName(session.sessionKey, title);
  }

  const existingRoute = dbGetRoute(target.routePattern, target.instanceName);
  if (existingRoute) {
    dbUpdateRoute(
      target.routePattern,
      { agent: session.agentId, session: session.name ?? session.sessionKey },
      target.instanceName,
    );
  } else {
    dbCreateRoute({
      pattern: target.routePattern,
      accountId: target.instanceName,
      agent: session.agentId,
      session: session.name ?? session.sessionKey,
      priority: 0,
    });
  }

  const binding = upsertBinding({
    title,
    chatId: target.sourceChatId,
    session: session.name ?? session.sessionKey,
  });

  omniPanelCache.clear();
  await publish("ravi.config.changed", {}).catch(() => {});

  const snapshot = buildSnapshot({
    title,
    chatId: target.sourceChatId,
    session: session.name ?? session.sessionKey,
  });
  return {
    ok: true,
    action: body.action,
    createdAgent,
    createdSession,
    binding,
    route: {
      pattern: target.routePattern,
      accountId: target.instanceName,
      agent: session.agentId,
      session: session.name ?? session.sessionKey,
    },
    snapshot,
    actor,
  };
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
        hints: {
          preview: cleanNullable(entry?.preview),
          timeLabel: cleanNullable(entry?.timeLabel),
        },
      }))
      .filter((entry) => entry.query.chatId || entry.query.title || entry.query.session);

    const needsOmniFallback = entries.some(
      (entry) => !entry.query.chatId && (entry.hints.preview || entry.hints.timeLabel),
    );
    const omniChats = needsOmniFallback ? await getChatListResolveOmniChats(sessions) : [];

    const items = entries.map((entry) => {
      const initialSnapshot = buildSnapshotWithSessions(entry.query, sessions);
      const matchedOmniChat =
        !initialSnapshot.resolved && omniChats.length > 0
          ? matchOmniChatFromRow(
              {
                title: entry.query.title,
                preview: entry.hints.preview,
                timeLabel: entry.hints.timeLabel,
                chatIdCandidate: entry.query.chatId,
              },
              omniChats,
            )
          : null;
      const matchedChatId = matchedOmniChat ? getPromotedOmniChatId(matchedOmniChat) : null;
      const snapshot =
        matchedChatId && matchedChatId !== initialSnapshot.query.chatId
          ? buildSnapshotWithSessions(
              {
                ...entry.query,
                chatId: matchedChatId,
              },
              sessions,
            )
          : initialSnapshot;

      return {
        id: entry.id,
        query: snapshot.query,
        resolved: snapshot.resolved,
        session: snapshot.session,
        warnings: snapshot.warnings,
        matchSource: matchedChatId ? "omni-row-hints" : null,
        matchedChat:
          matchedChatId && matchedOmniChat
            ? {
                externalId: cleanNullable(matchedOmniChat.externalId),
                canonicalId: cleanNullable(matchedOmniChat.canonicalId),
                name: cleanNullable(matchedOmniChat.name),
                lastMessageAt: cleanNullable(matchedOmniChat.lastMessageAt),
                lastMessagePreview: cleanNullable(matchedOmniChat.lastMessagePreview),
              }
            : null,
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

async function getChatListResolveOmniChats(sessions: ReturnType<typeof getOverlaySessions>): Promise<OmniPanelChat[]> {
  const now = Date.now();
  if (chatListResolveOmniCache && chatListResolveOmniCache.expiresAt > now) {
    return chatListResolveOmniCache.chats;
  }

  const instances = await listOmniWhatsAppInstances();
  const preferredInstanceName = getChatListResolvePreferredInstanceName();
  const preferredInstance = findOmniInstanceByHint(instances, preferredInstanceName);
  const targetInstances = preferredInstance ? [preferredInstance] : instances;
  const chats = (
    await Promise.all(targetInstances.map((instance) => listOmniChats(instance.name, 80, sessions, null)))
  ).flat();

  chatListResolveOmniCache = {
    expiresAt: now + CHAT_LIST_OMNI_CACHE_TTL_MS,
    chats,
  };
  return chats;
}

function getChatListResolvePreferredInstanceName(): string | null {
  if (!latestPublishedState) return null;
  return cleanNullable(buildSnapshot(queryFromPublishedState(latestPublishedState)).session?.accountId);
}

function isOmniGroupChatMatch(chat: OmniPanelChat): boolean {
  return Boolean(
    isOmniGroupChat(cleanNullable(chat.externalId) ?? cleanNullable(chat.canonicalId), cleanNullable(chat.chatType)),
  );
}

function getPromotedOmniChatId(chat: OmniPanelChat): string | null {
  if (!isOmniGroupChatMatch(chat)) {
    return null;
  }

  return cleanNullable(chat.externalId) ?? cleanNullable(chat.canonicalId);
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

function handleSessionWorkspace(url: URL): Response {
  const sessionName = cleanNullable(url.searchParams.get("session"));
  if (!sessionName) {
    return withCors(Response.json({ ok: false, error: "Missing session" }, { status: 400 }), url);
  }

  const snapshot = buildSnapshot({ session: sessionName });
  if (!snapshot.session) {
    return withCors(
      Response.json(
        {
          ok: true,
          session: null,
          snapshot,
          messages: [],
          timeline: [],
          historySource: "missing",
          generatedAt: Date.now(),
        },
        { status: 404 },
      ),
      url,
    );
  }

  const providerHistoryMessages = getRecentSessionHistory(snapshot.session.sessionName, 80).map((message) => ({
    id: String(message.id),
    role: message.role,
    content: message.content,
    createdAt: parseOverlayTimestamp(message.created_at),
    source: "history" as const,
  }));
  const recentHistoryMessages = getRecentHistory(snapshot.session.sessionName, 80).map((message) => ({
    id: String(message.id),
    role: message.role,
    content: message.content,
    createdAt: parseOverlayTimestamp(message.created_at),
    source: "history" as const,
  }));
  const messages = mergeOverlaySessionWorkspaceMessages(recentHistoryMessages, providerHistoryMessages);
  const timeline = buildOverlaySessionWorkspaceTimeline({
    messages,
    live: snapshot.session.live,
  });

  return withCors(
    Response.json({
      ok: true,
      session: snapshot.session,
      snapshot,
      messages,
      timeline,
      historySource: providerHistoryMessages.length > 0 ? "merged-history" : "recent-history",
      generatedAt: Date.now(),
    }),
    url,
  );
}

async function handleSessionPrompt(req: Request, url: URL): Promise<Response> {
  try {
    const body = (await req.json()) as PromptBody;
    const session = body.session ? resolveSession(body.session) : null;
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";

    if (!session) {
      return withCors(Response.json({ ok: false, error: "Session not found" }, { status: 404 }), url);
    }

    if (!prompt) {
      return withCors(Response.json({ ok: false, error: "Missing prompt" }, { status: 400 }), url);
    }

    const sessionName = session.name ?? session.sessionKey;
    await publishSessionPrompt(sessionName, { prompt });
    const currentActivity = liveBySessionName.get(sessionName)?.activity;
    upsertLive(sessionName, currentActivity && currentActivity !== "idle" ? currentActivity : "thinking", prompt);

    return withCors(
      Response.json({
        ok: true,
        session: buildSnapshot({ session: sessionName }).session,
        queued: true,
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

function buildSnapshot(query: OverlayQuery) {
  return buildSnapshotWithSessions(query, getOverlaySessions());
}

function getOverlaySessions(): SessionEntry[] {
  return listSessions().map((session) => {
    const agent = dbGetAgent(session.agentId);
    return {
      ...session,
      modelOverride: session.modelOverride ?? agent?.model ?? undefined,
    };
  });
}

function getHotSessionTaskCandidates(): TaskStreamTaskEntity[] {
  const now = Date.now();
  if (hotSessionTaskCache && hotSessionTaskCache.expiresAt > now) {
    return hotSessionTaskCache.items;
  }

  const items = buildTaskStreamSnapshot({
    all: true,
    eventsLimit: 1,
  }).items;

  hotSessionTaskCache = {
    expiresAt: now + HOT_SESSION_TASK_CACHE_TTL_MS,
    items,
  };
  return items;
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
    taskSessions: getHotSessionTaskCandidates(),
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

async function getCachedOmniPanel(query: {
  chatId: string | null;
  title: string | null;
  session: string | null;
  instance: string | null;
}): Promise<OmniPanelSnapshot> {
  const cacheKey = JSON.stringify(query);
  const cached = omniPanelCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return await cached.value;
  }

  const pending = buildOmniPanelSnapshot(query);
  omniPanelCache.set(cacheKey, {
    expiresAt: Date.now() + OMNI_PANEL_CACHE_TTL_MS,
    value: pending,
  });

  try {
    const value = await pending;
    omniPanelCache.set(cacheKey, {
      expiresAt: Date.now() + OMNI_PANEL_CACHE_TTL_MS,
      value,
    });
    return value;
  } catch (error) {
    omniPanelCache.delete(cacheKey);
    throw error;
  }
}

async function buildOmniPanelSnapshot(query: {
  chatId: string | null;
  title: string | null;
  session: string | null;
  instance: string | null;
}): Promise<OmniPanelSnapshot> {
  const overlaySnapshot = buildSnapshot({
    chatId: query.chatId,
    title: query.title,
    session: query.session,
  });
  const actor = buildOmniPanelActor(overlaySnapshot.session);
  const omniAgents = buildOmniPanelAgents(actor);
  const instances = await listOmniWhatsAppInstances();
  const preferredHint = resolvePreferredOmniInstanceHint(query.instance, overlaySnapshot.session?.accountId ?? null);
  const authorizedInstances = instances.map((instance) => applyOmniInstanceAuth(instance, actor));
  const activeInstances = authorizedInstances.filter((instance) => instance.isActive);
  const candidateInstances = activeInstances.length > 0 ? activeInstances : authorizedInstances;

  if (candidateInstances.length === 0) {
    return {
      ok: true,
      query,
      actor,
      preferredInstance: null,
      currentChat: null,
      instances: [],
      agents: omniAgents,
      chats: [],
      groups: [],
      sessions: buildOmniPanelSessions(getOverlaySessions(), actor),
      warnings: ["Nenhuma instância WhatsApp do Omni disponível."],
      generatedAt: Date.now(),
    };
  }

  const overlaySessions = getOverlaySessions();
  const omniSessions = buildOmniPanelSessions(overlaySessions, actor);
  const chatsByInstanceEntries = await Promise.all(
    candidateInstances.map(async (instance) => {
      const chats = await listOmniChats(instance.name, 60, overlaySessions, actor);
      return [instance.id, chats] as const;
    }),
  );
  const chatsByInstance = new Map<string, OmniPanelChat[]>(chatsByInstanceEntries);

  const matchedCurrentChat = findPreferredOmniChat(query, chatsByInstance);
  const preferredInstance =
    findOmniInstanceByHint(candidateInstances, preferredHint) ??
    (matchedCurrentChat
      ? (candidateInstances.find((instance) => instance.id === matchedCurrentChat.instanceId) ?? null)
      : null) ??
    candidateInstances.find((instance) => instance.name === "luis") ??
    candidateInstances[0] ??
    null;

  const currentChat =
    matchedCurrentChat && preferredInstance && matchedCurrentChat.instanceId === preferredInstance.id
      ? matchedCurrentChat
      : preferredInstance
        ? findCurrentOmniChatInList(query, chatsByInstance.get(preferredInstance.id) ?? [])
        : null;

  const chats = preferredInstance ? (chatsByInstance.get(preferredInstance.id) ?? []) : [];
  const groups = preferredInstance ? await listOmniGroups(preferredInstance.name, actor) : [];
  const warnings = buildOmniWarnings(preferredInstance, currentChat, query);

  return {
    ok: true,
    query,
    actor,
    preferredInstance,
    currentChat,
    instances: candidateInstances,
    agents: omniAgents,
    chats,
    groups,
    sessions: omniSessions,
    warnings,
    generatedAt: Date.now(),
  };
}

async function runOmniJson(args: string[]): Promise<unknown> {
  const commandArgs = args.includes("--json") ? args : [...args, "--json"];
  return await new Promise((resolve, reject) => {
    const proc = spawn("omni", commandArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    proc.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    proc.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    proc.on("error", reject);
    proc.on("close", (code) => {
      const stdoutText = Buffer.concat(stdout).toString("utf8").trim();
      const stderrText = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) {
        reject(new Error(stderrText || `omni ${args.join(" ")} failed`));
        return;
      }
      if (!stdoutText) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(stdoutText));
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function listOmniWhatsAppInstances(): Promise<OmniPanelInstance[]> {
  const raw = await runOmniJson(["instances", "list"]);
  const records = Array.isArray(raw) ? (raw as OmniInstanceRecord[]) : [];
  const whatsappInstances = records.filter((record) => normalizeLookupToken(record.channel).includes("whatsapp"));

  const enriched = await Promise.all(
    whatsappInstances.map(async (record) => {
      const whoami = await getOmniWhoami(record.name);
      return {
        id: record.id,
        name: record.name,
        channel: cleanNullable(record.channel) ?? "whatsapp-baileys",
        isActive: record.isActive === true,
        status: cleanNullable(whoami?.state) ?? (record.isActive ? "active" : "inactive"),
        isConnected: whoami?.isConnected === true,
        profileName: cleanNullable(whoami?.profileName) ?? cleanNullable(record.profileName),
        phone: cleanNullable(whoami?.phone),
        ownerIdentifier: cleanNullable(whoami?.ownerIdentifier) ?? cleanNullable(record.ownerIdentifier),
        lastSeenAt: cleanNullable(record.lastSeenAt),
        updatedAt: cleanNullable(record.updatedAt),
      } satisfies OmniPanelInstance;
    }),
  );

  return enriched.sort((a, b) => compareOmniInstances(a, b));
}

async function getOmniWhoami(instanceName: string): Promise<OmniWhoamiRecord | null> {
  try {
    const raw = await runOmniJson(["instances", "whoami", instanceName]);
    if (!raw || Array.isArray(raw) || typeof raw !== "object") return null;
    return raw as OmniWhoamiRecord;
  } catch {
    return null;
  }
}

async function listOmniChats(
  instanceName: string,
  limit = 40,
  sessions: ReturnType<typeof getOverlaySessions> = getOverlaySessions(),
  actor: OmniPanelActor | null = null,
): Promise<OmniPanelChat[]> {
  try {
    const raw = await runOmniJson(["chats", "list", "--instance", instanceName, "--limit", String(limit)]);
    const records = Array.isArray(raw) ? (raw as OmniChatRecord[]) : [];
    return records.map((record) => toOmniPanelChat(record, instanceName, sessions, actor)).sort(compareOmniChats);
  } catch {
    return [];
  }
}

async function listOmniGroups(instanceName: string, actor: OmniPanelActor | null = null): Promise<OmniPanelGroup[]> {
  try {
    const raw = await runOmniJson(["instances", "groups", instanceName]);
    const records = Array.isArray(raw) ? (raw as OmniGroupRecord[]) : [];
    return records
      .map((record) => applyOmniGroupAuth(toOmniPanelGroup(record, instanceName), actor))
      .sort(compareOmniGroups)
      .slice(0, 12);
  } catch {
    return [];
  }
}

function buildOmniPanelSessions(
  sessions: ReturnType<typeof getOverlaySessions>,
  actor: OmniPanelActor | null = null,
): OverlaySessionSnapshot[] {
  return sessions
    .filter((session) => isOmniRelevantSession(session))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 80)
    .map((session) => applyOmniSessionAuth(toOmniPanelSessionSnapshot(session), actor));
}

function buildOmniPanelAgents(actor: OmniPanelActor | null = null): OmniPanelAgent[] {
  return getAllAgents()
    .map((agent) =>
      applyOmniAgentAuth(
        {
          id: agent.id,
          name: cleanNullable(agent.name),
          cwd: agent.cwd,
          provider: agent.provider ?? null,
        },
        actor,
      ),
    )
    .sort((a, b) => a.id.localeCompare(b.id));
}

function toOmniPanelGroup(record: OmniGroupRecord, instanceName: string): OmniPanelGroup {
  const target = buildOmniRouteDescriptor(
    cleanNullable(record.externalId),
    instanceName,
    "group",
    cleanNullable(record.name),
  );
  return {
    instanceId: instanceName,
    externalId: cleanNullable(record.externalId),
    name: cleanNullable(record.name),
    description: cleanNullable(record.description),
    memberCount: typeof record.memberCount === "number" ? record.memberCount : null,
    createdAt: cleanNullable(record.createdAt),
    isReadOnly: record.isReadOnly === true,
    isCommunity: record.platformMetadata?.isCommunity === true,
    routePattern: target?.routePattern ?? null,
    routeObjectId: target ? buildRouteObjectId(target.instanceName, target.routePattern) : null,
  };
}

function buildOmniPanelActor(session: OverlaySessionSnapshot | null): OmniPanelActor | null {
  if (!session?.agentId) return null;
  return {
    sessionKey: session.sessionKey,
    sessionName: session.sessionName,
    agentId: session.agentId,
    capabilities: snapshotAgentCapabilities(session.agentId),
  };
}

function resolveOmniRouteActor(sessionHint: string | null): OmniPanelActor | null {
  const hinted = sessionHint ? resolveSession(sessionHint) : null;
  if (hinted) {
    return buildOmniPanelActor(toOmniPanelSessionSnapshot(hinted));
  }

  const fallbackSnapshot = latestPublishedState ? buildSnapshot(queryFromPublishedState(latestPublishedState)) : null;
  return buildOmniPanelActor(fallbackSnapshot?.session ?? null);
}

function buildScopeContext(actor: OmniPanelActor | null): ScopeContext {
  return {
    agentId: actor?.agentId,
    sessionKey: actor?.sessionKey,
    sessionName: actor?.sessionName,
  };
}

function buildRouteObjectId(instanceName: string, routePattern: string): string {
  return `${instanceName}:${routePattern}`;
}

function buildOmniRouteDescriptor(
  chatId: string | null,
  instanceName: string,
  chatType: string | null,
  title: string | null,
): { instanceName: string; routePattern: string } | null {
  if (!chatId) return null;
  try {
    const target = deriveOmniRouteTarget({
      chatId,
      instanceName,
      chatType,
      title,
    });
    return {
      instanceName: target.instanceName,
      routePattern: target.routePattern,
    };
  } catch {
    return null;
  }
}

function allowDecision(relation?: string): OmniPermissionDecision {
  return {
    allowed: true,
    matched: relation ? [relation] : [],
    missing: [],
    reason: null,
  };
}

function denyDecision(...relations: Array<string | null | undefined>): OmniPermissionDecision {
  const missing = relations.filter((relation): relation is string => Boolean(relation));
  return {
    allowed: false,
    matched: [],
    missing,
    reason: missing.length > 0 ? `missing ${missing.join(" + ")}` : "missing permission",
  };
}

function collectDeniedRelations(decisions: OmniPermissionDecision[]): string[] {
  return Array.from(new Set(decisions.filter((decision) => !decision.allowed).flatMap((decision) => decision.missing)));
}

function checkInstanceRead(actor: OmniPanelActor | null, instanceName: string): OmniPermissionDecision {
  const relation = `read instance:${instanceName}`;
  if (!actor?.agentId) return denyDecision(relation);
  return agentCan(actor.agentId, "read", "instance", instanceName) ? allowDecision(relation) : denyDecision(relation);
}

function checkRouteRead(actor: OmniPanelActor | null, routeObjectId: string | null): OmniPermissionDecision {
  const relation = routeObjectId ? `read route:${routeObjectId}` : null;
  if (!routeObjectId) return denyDecision();
  const target = routeObjectId as string;
  if (!actor?.agentId) return denyDecision(relation);
  return agentCan(actor.agentId, "read", "route", target)
    ? allowDecision(relation ?? undefined)
    : denyDecision(relation);
}

function checkRouteModify(actor: OmniPanelActor | null, routeObjectId: string | null): OmniPermissionDecision {
  const relation = routeObjectId ? `modify route:${routeObjectId}` : null;
  if (!routeObjectId) return denyDecision();
  const target = routeObjectId as string;
  if (!actor?.agentId) return denyDecision(relation);
  return agentCan(actor.agentId, "modify", "route", target)
    ? allowDecision(relation ?? undefined)
    : denyDecision(relation);
}

function checkSessionAccess(
  actor: OmniPanelActor | null,
  session: OverlaySessionSnapshot | null,
): OmniPermissionDecision {
  const target = session?.sessionName ?? session?.sessionKey ?? null;
  const relation = target ? `access session:${target}` : null;
  if (!target) return denyDecision();
  const scopeContext = buildScopeContext(actor);
  return canAccessSession(scopeContext, target) ? allowDecision(relation ?? undefined) : denyDecision(relation);
}

function checkSessionModify(
  actor: OmniPanelActor | null,
  session: OverlaySessionSnapshot | null,
): OmniPermissionDecision {
  const target = session?.sessionName ?? session?.sessionKey ?? null;
  const relation = target ? `modify session:${target}` : null;
  if (!target) return denyDecision();
  const scopeContext = buildScopeContext(actor);
  return canModifySession(scopeContext, target) ? allowDecision(relation ?? undefined) : denyDecision(relation);
}

function checkAgentView(actor: OmniPanelActor | null, agentId: string): OmniPermissionDecision {
  const relation = `view agent:${agentId}`;
  const scopeContext = buildScopeContext(actor);
  return canViewAgent(scopeContext, agentId) ? allowDecision(relation) : denyDecision(relation);
}

function checkGroupExecute(actor: OmniPanelActor | null, groupName: string): OmniPermissionDecision {
  const relation = `execute group:${groupName}`;
  if (!actor?.agentId) return denyDecision(relation);
  return agentCan(actor.agentId, "execute", "group", groupName) ? allowDecision(relation) : denyDecision(relation);
}

function combineAnyDecisions(...decisions: OmniPermissionDecision[]): OmniPermissionDecision {
  const allowed = decisions.find((decision) => decision.allowed);
  if (allowed) {
    return {
      allowed: true,
      matched: decisions.flatMap((decision) => decision.matched),
      missing: [],
      reason: null,
    };
  }
  return {
    allowed: false,
    matched: [],
    missing: Array.from(new Set(decisions.flatMap((decision) => decision.missing))),
    reason:
      decisions
        .map((decision) => decision.reason)
        .filter(Boolean)
        .join(" | ") || "missing permission",
  };
}

function applyOmniInstanceAuth(instance: OmniPanelInstance, actor: OmniPanelActor | null): OmniPanelInstance {
  const view = checkInstanceRead(actor, instance.name);
  return {
    ...instance,
    profileName: view.allowed ? instance.profileName : null,
    phone: view.allowed ? instance.phone : null,
    ownerIdentifier: view.allowed ? instance.ownerIdentifier : null,
    auth: { visibility: view.allowed ? "full" : "opaque", view },
  };
}

function applyOmniAgentAuth(agent: OmniPanelAgent, actor: OmniPanelActor | null): OmniPanelAgent {
  const view = checkAgentView(actor, agent.id);
  return {
    ...agent,
    name: view.allowed ? agent.name : null,
    cwd: view.allowed ? agent.cwd : "",
    provider: view.allowed ? agent.provider : null,
    auth: { visibility: view.allowed ? "full" : "opaque", view },
  };
}

function applyOmniSessionAuth(session: OverlaySessionSnapshot, actor: OmniPanelActor | null): OverlaySessionSnapshot {
  const view = checkSessionAccess(actor, session);
  return {
    ...session,
    displayName: view.allowed ? session.displayName : null,
    subject: view.allowed ? session.subject : null,
    chatId: view.allowed ? session.chatId : null,
    lastHeartbeatText: view.allowed ? session.lastHeartbeatText : null,
    auth: { visibility: view.allowed ? "full" : "opaque", view },
  };
}

function applyOmniChatAuth(chat: OmniPanelChat, actor: OmniPanelActor | null): OmniPanelChat {
  const routeRead = checkRouteRead(actor, chat.routeObjectId ?? null);
  const sessionAccess = checkSessionAccess(actor, chat.linkedSession);
  const view = combineAnyDecisions(routeRead, sessionAccess);
  return {
    ...chat,
    participantCount: view.allowed ? chat.participantCount : null,
    unreadCount: view.allowed ? chat.unreadCount : null,
    lastMessagePreview: view.allowed ? chat.lastMessagePreview : null,
    linkedSession: view.allowed ? chat.linkedSession : null,
    auth: { visibility: view.allowed ? "full" : "opaque", view },
  };
}

function applyOmniGroupAuth(group: OmniPanelGroup, actor: OmniPanelActor | null): OmniPanelGroup {
  const view = checkRouteRead(actor, group.routeObjectId ?? null);
  return {
    ...group,
    description: view.allowed ? group.description : null,
    memberCount: view.allowed ? group.memberCount : null,
    auth: { visibility: view.allowed ? "full" : "opaque", view },
  };
}

function toOmniPanelChat(
  record: OmniChatRecord,
  instanceName: string,
  sessions: ReturnType<typeof getOverlaySessions>,
  actor: OmniPanelActor | null = null,
): OmniPanelChat {
  const query = {
    chatId: cleanNullable(record.externalId) ?? cleanNullable(record.canonicalId),
    title: cleanNullable(record.name),
    session: null,
  };
  const snapshot = buildSnapshotWithSessions(query, sessions);
  const target = buildOmniRouteDescriptor(
    cleanNullable(record.externalId) ?? cleanNullable(record.canonicalId),
    instanceName,
    cleanNullable(record.chatType),
    cleanNullable(record.name),
  );

  return applyOmniChatAuth(
    {
      id: record.id,
      instanceId: record.instanceId,
      instanceName,
      externalId: cleanNullable(record.externalId),
      canonicalId: cleanNullable(record.canonicalId),
      chatType: cleanNullable(record.chatType),
      channel: cleanNullable(record.channel),
      name: cleanNullable(record.name),
      participantCount: typeof record.participantCount === "number" ? record.participantCount : null,
      unreadCount: typeof record.unreadCount === "number" ? record.unreadCount : null,
      lastMessageAt: cleanNullable(record.lastMessageAt),
      lastMessagePreview: cleanNullable(record.lastMessagePreview),
      updatedAt: cleanNullable(record.updatedAt),
      matchesCurrent: false,
      linkedSession: snapshot.session,
      routePattern: target?.routePattern ?? null,
      routeObjectId: target ? buildRouteObjectId(target.instanceName, target.routePattern) : null,
    },
    actor,
  );
}

function toOmniPanelSessionSnapshot(session: SessionEntry): OverlaySessionSnapshot {
  const live = session.name ? liveBySessionName.get(session.name) : undefined;
  return {
    sessionKey: session.sessionKey,
    sessionName: session.name ?? session.sessionKey,
    agentId: session.agentId,
    displayName: session.displayName ?? null,
    subject: session.subject ?? null,
    chatType: session.chatType ?? null,
    channel: session.lastChannel ?? session.channel ?? null,
    accountId: session.lastAccountId ?? session.accountId ?? null,
    chatId: session.lastTo ?? null,
    threadId: session.lastThreadId ?? null,
    modelOverride: session.modelOverride ?? null,
    thinkingLevel: session.thinkingLevel ?? null,
    queueMode: session.queueMode ?? null,
    abortedLastRun: session.abortedLastRun === true,
    compactionCount: session.compactionCount ?? 0,
    runtimeProvider: session.runtimeProvider ?? null,
    providerSessionId: session.providerSessionId ?? null,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastHeartbeatText: session.lastHeartbeatText ?? null,
    lastHeartbeatSentAt: session.lastHeartbeatSentAt ?? null,
    ephemeral: session.ephemeral === true,
    expiresAt: session.expiresAt ?? null,
    live:
      live ??
      (session.abortedLastRun
        ? { activity: "blocked", summary: "last run aborted", updatedAt: session.updatedAt }
        : { activity: "idle", updatedAt: session.updatedAt }),
  };
}

function isOmniRelevantSession(session: ReturnType<typeof getOverlaySessions>[number]): boolean {
  const channel = normalizeLookupToken(session.lastChannel ?? session.channel);
  return !channel || channel.includes("whatsapp");
}

function resolvePreferredOmniInstanceHint(
  explicitInstance: string | null,
  _sessionAccountId: string | null,
): string | null {
  return cleanNullable(explicitInstance);
}

function findOmniInstanceByHint(instances: OmniPanelInstance[], hint: string | null): OmniPanelInstance | null {
  const needle = normalizeLookupToken(hint);
  if (!needle) return null;
  return (
    instances.find((instance) => normalizeLookupToken(instance.id) === needle) ??
    instances.find((instance) => normalizeLookupToken(instance.name) === needle) ??
    null
  );
}

function findPreferredOmniChat(
  query: { chatId: string | null; title: string | null },
  chatsByInstance: Map<string, OmniPanelChat[]>,
): OmniPanelChat | null {
  const entries = Array.from(chatsByInstance.values()).flat();
  return findCurrentOmniChatInList(query, entries);
}

function findCurrentOmniChatInList(
  query: { chatId: string | null; title: string | null },
  chats: OmniPanelChat[],
): OmniPanelChat | null {
  const chatIdVariants = buildOmniChatIdVariants(query.chatId);
  if (chatIdVariants.length > 0) {
    const byChatId = chats.find((chat) => {
      const values = [chat.externalId, chat.canonicalId].map(normalizeLookupToken).filter(Boolean) as string[];
      return values.some((value) => chatIdVariants.includes(value));
    });
    if (byChatId) {
      return { ...byChatId, matchesCurrent: true };
    }
  }

  const titleNeedle = normalizeComparableTitle(query.title);
  if (!titleNeedle) return null;
  if (shouldDisableOmniTitleMatch(titleNeedle)) return null;

  const exact = chats.find((chat) => normalizeComparableTitle(chat.name) === titleNeedle);
  if (exact) {
    return { ...exact, matchesCurrent: true };
  }

  return null;
}

function buildOmniWarnings(
  preferredInstance: OmniPanelInstance | null,
  currentChat: OmniPanelChat | null,
  query: { chatId: string | null; title: string | null },
): string[] {
  const warnings: string[] = [];
  if (!preferredInstance) {
    warnings.push("Nenhuma instância WhatsApp do Omni disponível.");
    return warnings;
  }

  if ((query.chatId || query.title) && !currentChat) {
    warnings.push("Chat atual ainda não casou com um chat do Omni.");
  }

  if (!preferredInstance.isConnected) {
    warnings.push(`Instância ${preferredInstance.name} não está conectada.`);
  }

  return warnings;
}

function buildOmniChatIdVariants(value: string | null | undefined): string[] {
  const normalized = normalizeLookupToken(value);
  if (!normalized) return [];

  const variants = new Set<string>([normalized]);
  if (/^\d+$/.test(normalized)) {
    variants.add(`${normalized}@g.us`);
    variants.add(`${normalized}@s.whatsapp.net`);
    variants.add(`group:${normalized}`);
  }

  const groupMatch = normalized.match(/^group:(.+)$/);
  if (groupMatch) {
    variants.add(`${groupMatch[1]}@g.us`);
  }

  const groupJid = normalized.match(/^(.+)@g\.us$/);
  if (groupJid) {
    variants.add(groupJid[1]);
    variants.add(`group:${groupJid[1]}`);
  }

  const dmJid = normalized.match(/^(\d+)@s\.whatsapp\.net$/);
  if (dmJid) {
    variants.add(dmJid[1]);
  }

  return [...variants];
}

function normalizeComparableTitle(value: string | null | undefined): string {
  return normalizeLookupToken(value)
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function shouldDisableOmniTitleMatch(value: string): boolean {
  return !value.includes(" ") && value.length <= 5;
}

function compareOmniInstances(a: OmniPanelInstance, b: OmniPanelInstance): number {
  return (
    Number(b.isConnected) - Number(a.isConnected) ||
    Number(b.isActive) - Number(a.isActive) ||
    compareIsoDateDesc(a.lastSeenAt, b.lastSeenAt) ||
    a.name.localeCompare(b.name)
  );
}

function compareOmniChats(a: OmniPanelChat, b: OmniPanelChat): number {
  return (
    compareIsoDateDesc(a.lastMessageAt ?? a.updatedAt, b.lastMessageAt ?? b.updatedAt) ||
    (b.unreadCount ?? 0) - (a.unreadCount ?? 0) ||
    (a.name ?? a.externalId ?? "").localeCompare(b.name ?? b.externalId ?? "")
  );
}

function compareOmniGroups(a: OmniPanelGroup, b: OmniPanelGroup): number {
  return (
    (b.memberCount ?? 0) - (a.memberCount ?? 0) ||
    compareIsoDateDesc(a.createdAt, b.createdAt) ||
    (a.name ?? a.externalId ?? "").localeCompare(b.name ?? b.externalId ?? "")
  );
}

function compareIsoDateDesc(a: string | null | undefined, b: string | null | undefined): number {
  const aTime = a ? Date.parse(a) : 0;
  const bTime = b ? Date.parse(b) : 0;
  return bTime - aTime;
}

function cleanRequired(value: string | null | undefined, field: string): string {
  const cleaned = cleanNullable(value);
  if (!cleaned) {
    throw new Error(`Missing ${field}`);
  }
  return cleaned;
}

function cleanNullable(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizePositiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function cleanTaskStatus(value: string | null | undefined): TaskStatus | null {
  const normalized = cleanNullable(value);
  switch (normalized) {
    case "open":
    case "dispatched":
    case "in_progress":
    case "blocked":
    case "done":
    case "failed":
      return normalized;
    default:
      return null;
  }
}

function normalizeTaskEventsLimit(value: string | null | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 20;
  return Math.max(1, Math.min(parsed, 50));
}

function normalizeInsightsLimit(value: string | null | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 80;
  return Math.max(1, Math.min(parsed, 200));
}

function normalizeLookupToken(value: string | null | undefined): string {
  return cleanNullable(value)?.toLowerCase() ?? "";
}

function ensureOmniAgent(agentId: string, createIfMissing: boolean): boolean {
  if (dbGetAgent(agentId)) {
    return false;
  }

  if (!createIfMissing) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  const cwd = join(homedir(), "ravi", agentId);
  createAgent({ id: agentId, cwd });
  ensureAgentDirs(loadRouterConfig());
  ensureAgentInstructionFiles(cwd, {
    createAgentsStub: `# ${agentId}\n\nInstruções do agente aqui.\n`,
  });
  return true;
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
  const sessionTask = trackSessionRuntime().catch((error) => {
    console.error("[ravi-wa-overlay] session runtime tracker failed", error);
  });
  runtimeTrackerTasks.add(sessionTask);
  void sessionTask.finally(() => runtimeTrackerTasks.delete(sessionTask));

  const approvalTask = trackApprovalRuntime().catch((error) => {
    console.error("[ravi-wa-overlay] approval runtime tracker failed", error);
  });
  runtimeTrackerTasks.add(approvalTask);
  void approvalTask.finally(() => runtimeTrackerTasks.delete(approvalTask));
}

async function trackSessionRuntime(): Promise<void> {
  for await (const event of subscribe("ravi.session.>")) {
    const { topic, data } = event;
    const sessionName = topic.split(".")[2];
    if (!sessionName) continue;

    if (topic.endsWith(".prompt")) {
      const eventTimestamp = Date.now();
      const promptContext =
        data.context && typeof data.context === "object" ? (data.context as Record<string, unknown>) : null;
      const promptMessageId =
        extractExternalMessageId(
          cleanNullable(typeof promptContext?.messageId === "string" ? promptContext.messageId : null),
        ) ?? extractPromptMessageId(typeof data.prompt === "string" ? data.prompt : "");
      if (promptMessageId) {
        rememberPromptMessageId(sessionName, promptMessageId);
      }
      clearActiveAssistantMessageId(sessionName);
      const promptText = formatLiveText(typeof data.prompt === "string" ? data.prompt : "");
      pushLiveEvent(sessionName, {
        kind: "prompt",
        label: "prompt",
        detail: promptText,
        timestamp: eventTimestamp,
      });
      upsertLiveWorkspaceMessage(sessionName, {
        id: `live:user:${eventTimestamp}`,
        role: "user",
        content: promptText,
        createdAt: eventTimestamp,
        source: "live",
        pending: true,
      });
      upsertLive(sessionName, "thinking", "prompt queued");
      continue;
    }

    if (topic.endsWith(".delivery")) {
      const deliveredMessageId = extractExternalMessageId(
        cleanNullable(typeof data.messageId === "string" ? data.messageId : null),
      );
      const emitId = cleanNullable(typeof data.emitId === "string" ? data.emitId : null);
      if (deliveredMessageId) {
        rememberDeliveredMessageId(sessionName, emitId, deliveredMessageId);
      }
      continue;
    }

    if (topic.endsWith(".stream")) {
      const chunk = typeof data.chunk === "string" ? data.chunk : "";
      updateStreamEvent(sessionName, chunk);
      upsertLive(sessionName, "streaming", "streaming reply");
      continue;
    }

    if (topic.endsWith(".response")) {
      const eventTimestamp = Date.now();
      const emitId = cleanNullable(typeof data._emitId === "string" ? data._emitId : null);
      if (emitId) {
        rememberResponseEmitId(sessionName, emitId);
      }
      const responseText = typeof data.response === "string" ? data.response : "";
      pushLiveEvent(sessionName, {
        kind: "response",
        label: "response",
        detail: formatLiveText(responseText),
        timestamp: eventTimestamp,
      });
      upsertLiveWorkspaceMessage(sessionName, {
        id: ensureActiveAssistantMessageId(sessionName, eventTimestamp),
        role: "assistant",
        content: formatLiveText(responseText),
        createdAt: eventTimestamp,
        source: "live",
        pending: true,
      });
      upsertLive(sessionName, "streaming", "response emitted", false);
      continue;
    }

    if (topic.endsWith(".tool")) {
      const eventTimestamp = Date.now();
      const eventName = typeof data.event === "string" ? data.event : undefined;
      const toolId = cleanNullable(typeof data.toolId === "string" ? data.toolId : null) ?? `tool-${eventTimestamp}`;
      const toolName = typeof data.toolName === "string" ? data.toolName : "tool";
      const toolDetail = summarizeToolArtifactPreview(data, summarizeToolInput(data.input) || null) || undefined;
      pushLiveEvent(sessionName, {
        kind: "tool",
        label: toolName,
        detail: toolDetail,
        timestamp: eventTimestamp,
      });
      if (eventName === "start" || eventName === "end") {
        pushLiveArtifact(sessionName, buildToolArtifact(sessionName, toolId, toolName, data, eventTimestamp));
      }
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
      const eventTimestamp = Date.now();

      if (status === "compacting" || (type === "system" && subtype === "status" && status === "compacting")) {
        pushLiveEvent(sessionName, {
          kind: "runtime",
          label: "runtime",
          detail: "compacting",
          timestamp: eventTimestamp,
        });
        upsertLive(sessionName, "compacting", "compacting");
      } else if (status === "thinking" || status === "queued") {
        upsertLive(sessionName, "thinking", status);
      } else if (type === "assistant" || type === "assistant.message") {
        upsertLive(sessionName, "streaming", "assistant composing");
      } else if (type === "tool.started") {
        pushLiveEvent(sessionName, {
          kind: "tool",
          label: "tool",
          detail: "running",
          timestamp: eventTimestamp,
        });
        upsertLive(sessionName, "thinking", "tool running");
      } else if (type === "tool.completed") {
        pushLiveEvent(sessionName, {
          kind: "tool",
          label: "tool",
          detail: "finished",
          timestamp: eventTimestamp,
        });
        upsertLive(sessionName, "thinking", "tool finished");
      } else if (type === "provider.raw" || type === "system" || type === "user") {
        upsertLive(sessionName, "thinking", "working");
      } else if (type === "turn.interrupted") {
        const artifact = buildInterruptionArtifact(
          sessionName,
          data,
          eventTimestamp,
          resolveActiveArtifactAnchor(sessionName),
        );
        pushLiveEvent(sessionName, {
          kind: "runtime",
          label: "runtime",
          detail: "turn.interrupted",
          timestamp: eventTimestamp,
        });
        pushLiveArtifact(sessionName, artifact);
        const pendingEmitId = getLatestResponseEmitId(sessionName);
        if (artifact.anchor?.placement !== "after-message-id" && pendingEmitId) {
          rememberPendingArtifactAnchor(sessionName, artifact.id, pendingEmitId);
        }
        upsertLive(sessionName, "idle", "idle");
        resetActiveArtifactTurnState(sessionName);
      } else if (isTerminalRuntimeEvent(type)) {
        pushLiveEvent(sessionName, {
          kind: "runtime",
          label: "runtime",
          detail: type ?? status ?? "idle",
          timestamp: eventTimestamp,
        });
        upsertLive(sessionName, "idle", "idle");
        resetActiveArtifactTurnState(sessionName);
      } else if (status === "idle") {
        pushLiveEvent(sessionName, {
          kind: "runtime",
          label: "runtime",
          detail: type ?? status ?? "idle",
          timestamp: eventTimestamp,
        });
        upsertLive(sessionName, "idle", "idle");
      }
    }
  }
}

async function trackApprovalRuntime(): Promise<void> {
  for await (const event of subscribe("ravi.approval.request", "ravi.approval.response")) {
    const { topic, data } = event;

    if (topic === "ravi.approval.request") {
      const sessionName = typeof data.sessionName === "string" ? data.sessionName : null;
      if (sessionName) {
        pushLiveEvent(sessionName, {
          kind: "approval",
          label: "approval",
          detail: "pending",
          timestamp: Date.now(),
        });
        upsertLive(sessionName, "awaiting_approval", "approval pending", true);
      }
      continue;
    }

    if (topic === "ravi.approval.response") {
      const sessionName = typeof data.sessionName === "string" ? data.sessionName : null;
      if (sessionName) {
        pushLiveEvent(sessionName, {
          kind: "approval",
          label: "approval",
          detail: "answered",
          timestamp: Date.now(),
        });
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
  const now = Date.now();
  const nextBusySince = isBusyOverlayActivity(activity)
    ? (current?.busySince ?? (isBusyOverlayActivity(current?.activity) ? current?.updatedAt : undefined) ?? now)
    : undefined;
  liveBySessionName.set(sessionName, {
    ...current,
    activity,
    summary,
    approvalPending: approvalPending ?? current?.approvalPending,
    updatedAt: now,
    busySince: nextBusySince,
  });
}

function pushLiveEvent(sessionName: string, event: OverlaySessionEvent): void {
  const current = liveBySessionName.get(sessionName);
  const previous = Array.isArray(current?.events) ? current.events : [];
  const next = [event, ...previous].slice(0, SESSION_LIVE_EVENT_LIMIT);
  liveBySessionName.set(sessionName, {
    ...current,
    activity: current?.activity ?? "unknown",
    updatedAt: event.timestamp,
    busySince: current?.busySince,
    events: next,
  });
}

function pushLiveArtifact(sessionName: string, artifact: OverlayChatArtifact): void {
  const current = liveBySessionName.get(sessionName);
  liveBySessionName.set(sessionName, {
    ...current,
    activity: current?.activity ?? "unknown",
    updatedAt: artifact.updatedAt ?? artifact.createdAt,
    busySince: current?.busySince,
    artifacts: upsertOverlayChatArtifact(current?.artifacts, artifact),
  });
}

function findLiveArtifact(sessionName: string, artifactId: string): OverlayChatArtifact | null {
  const currentArtifacts = liveBySessionName.get(sessionName)?.artifacts ?? [];
  return currentArtifacts.find((artifact) => artifact.id === artifactId) ?? null;
}

function getOrCreateArtifactTurnState(sessionName: string): SessionArtifactTurnState {
  const existing = artifactTurnStateBySessionName.get(sessionName);
  if (existing) return existing;

  const created: SessionArtifactTurnState = {
    activeResponseEmitIds: [],
    activeDeliveredMessageIds: [],
    activePromptMessageIds: [],
    activeAssistantMessageId: null,
    pendingArtifactId: null,
    pendingArtifactEmitId: null,
  };
  artifactTurnStateBySessionName.set(sessionName, created);
  return created;
}

function rememberResponseEmitId(sessionName: string, emitId: string): void {
  const state = getOrCreateArtifactTurnState(sessionName);
  state.activeResponseEmitIds = [...state.activeResponseEmitIds.filter((value) => value !== emitId), emitId].slice(-8);
}

function rememberPromptMessageId(sessionName: string, messageId: string): void {
  const state = getOrCreateArtifactTurnState(sessionName);
  state.activePromptMessageIds = [
    ...state.activePromptMessageIds.filter((value) => value !== messageId),
    messageId,
  ].slice(-8);
}

function rememberDeliveredMessageId(sessionName: string, emitId: string | null, messageId: string): void {
  const state = getOrCreateArtifactTurnState(sessionName);
  const belongsToActiveTurn = Boolean(emitId && state.activeResponseEmitIds.includes(emitId));
  if (belongsToActiveTurn) {
    state.activeDeliveredMessageIds = [
      ...state.activeDeliveredMessageIds.filter((value) => value !== messageId),
      messageId,
    ].slice(-8);
  }

  if (!emitId || state.pendingArtifactEmitId !== emitId || !state.pendingArtifactId) {
    return;
  }

  const currentArtifacts = liveBySessionName.get(sessionName)?.artifacts ?? [];
  const pendingArtifact = currentArtifacts.find((artifact) => artifact.id === state.pendingArtifactId);
  if (pendingArtifact) {
    pushLiveArtifact(sessionName, {
      ...pendingArtifact,
      updatedAt: Date.now(),
      anchor: { placement: "after-message-id", messageId },
    });
  }

  state.pendingArtifactId = null;
  state.pendingArtifactEmitId = null;
}

function resolveActiveArtifactAnchor(sessionName: string): OverlayChatArtifactAnchor {
  const state = artifactTurnStateBySessionName.get(sessionName);
  const deliveredMessageId = state?.activeDeliveredMessageIds.at(-1) ?? null;
  if (deliveredMessageId) {
    return { placement: "after-message-id", messageId: deliveredMessageId };
  }
  const promptMessageId = state?.activePromptMessageIds.at(-1) ?? null;
  if (promptMessageId) {
    return { placement: "after-message-id", messageId: promptMessageId };
  }
  const historyPromptMessageId = findRecentPromptMessageIdInHistory(sessionName);
  if (historyPromptMessageId) {
    return { placement: "after-message-id", messageId: historyPromptMessageId };
  }
  return { placement: "after-last-message" };
}

function rememberPendingArtifactAnchor(sessionName: string, artifactId: string, emitId: string): void {
  const state = getOrCreateArtifactTurnState(sessionName);
  state.pendingArtifactId = artifactId;
  state.pendingArtifactEmitId = emitId;
}

function getLatestResponseEmitId(sessionName: string): string | null {
  return artifactTurnStateBySessionName.get(sessionName)?.activeResponseEmitIds.at(-1) ?? null;
}

function resetActiveArtifactTurnState(sessionName: string): void {
  const state = artifactTurnStateBySessionName.get(sessionName);
  if (!state) return;
  state.activeResponseEmitIds = [];
  state.activeDeliveredMessageIds = [];
  state.activePromptMessageIds = [];
  state.activeAssistantMessageId = null;
}

function ensureActiveAssistantMessageId(sessionName: string, timestamp: number): string {
  const state = getOrCreateArtifactTurnState(sessionName);
  if (!state.activeAssistantMessageId) {
    state.activeAssistantMessageId = `live:assistant:${timestamp}`;
  }
  return state.activeAssistantMessageId;
}

function clearActiveAssistantMessageId(sessionName: string): void {
  const state = artifactTurnStateBySessionName.get(sessionName);
  if (!state) return;
  state.activeAssistantMessageId = null;
}

function upsertLiveWorkspaceMessage(sessionName: string, message: OverlaySessionWorkspaceMessage): void {
  const content = normalizeLiveWorkspaceText(message.content);
  const createdAt = parseOverlayTimestamp(message.createdAt);
  if (!content || !createdAt) {
    return;
  }

  const current = liveBySessionName.get(sessionName);
  const previous = Array.isArray(current?.messages) ? current.messages : [];
  const next = previous.slice();
  const index = next.findIndex((item) => liveWorkspaceMessagesMatch(item, message));

  if (index === -1) {
    next.push({
      ...message,
      content: message.content.trim(),
      createdAt,
      source: message.source ?? "live",
    });
  } else {
    const existing = next[index]!;
    const existingText = normalizeLiveWorkspaceText(existing.content);
    const shouldReplace =
      content.length > existingText.length ||
      (content.length === existingText.length && createdAt >= parseOverlayTimestamp(existing.createdAt));
    if (shouldReplace) {
      next[index] = {
        ...existing,
        ...message,
        id: existing.id,
        createdAt: parseOverlayTimestamp(existing.createdAt) || createdAt,
        source: existing.source ?? message.source ?? "live",
      };
    }
  }

  next.sort((left, right) => parseOverlayTimestamp(left.createdAt) - parseOverlayTimestamp(right.createdAt));

  liveBySessionName.set(sessionName, {
    ...current,
    activity: current?.activity ?? "unknown",
    updatedAt: Math.max(current?.updatedAt ?? 0, createdAt),
    busySince: current?.busySince,
    messages: next.slice(-SESSION_LIVE_MESSAGE_LIMIT),
  });
}

function normalizeLiveWorkspaceText(value: string | null | undefined): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function liveWorkspaceMessagesMatch(
  left: OverlaySessionWorkspaceMessage,
  right: OverlaySessionWorkspaceMessage,
): boolean {
  const leftId = cleanNullable(left.id);
  const rightId = cleanNullable(right.id);
  if (leftId && rightId && leftId === rightId) {
    return true;
  }

  if (left.role !== right.role) {
    return false;
  }

  const leftCreatedAt = parseOverlayTimestamp(left.createdAt);
  const rightCreatedAt = parseOverlayTimestamp(right.createdAt);
  if (!leftCreatedAt || !rightCreatedAt) {
    return false;
  }

  if (Math.abs(leftCreatedAt - rightCreatedAt) > SESSION_LIVE_MESSAGE_MATCH_WINDOW_MS) {
    return false;
  }

  return liveWorkspaceTextsOverlap(normalizeLiveWorkspaceText(left.content), normalizeLiveWorkspaceText(right.content));
}

function liveWorkspaceTextsOverlap(left: string, right: string): boolean {
  if (!left || !right) return false;
  return left === right || left.includes(right) || right.includes(left);
}

function updateStreamEvent(sessionName: string, detail: string): void {
  const current = liveBySessionName.get(sessionName);
  const previous = Array.isArray(current?.events) ? [...current.events] : [];
  const timestamp = Date.now();
  const existingIndex = previous.findIndex((event) => event.kind === "stream");
  const nextDetail = mergeStreamText(existingIndex >= 0 ? previous[existingIndex]?.detail : "", detail);

  if (existingIndex >= 0) {
    previous[existingIndex] = {
      ...previous[existingIndex]!,
      detail: nextDetail,
      timestamp,
    };
  } else {
    previous.unshift({
      kind: "stream",
      label: "stream",
      detail: nextDetail,
      timestamp,
    });
  }

  liveBySessionName.set(sessionName, {
    ...current,
    activity: current?.activity ?? "streaming",
    updatedAt: timestamp,
    busySince: current?.busySince ?? timestamp,
    events: previous.sort((a, b) => b.timestamp - a.timestamp).slice(0, SESSION_LIVE_EVENT_LIMIT),
  });

  upsertLiveWorkspaceMessage(sessionName, {
    id: ensureActiveAssistantMessageId(sessionName, timestamp),
    role: "assistant",
    content: nextDetail,
    createdAt: timestamp,
    source: "live",
    pending: true,
  });
}

function isBusyOverlayActivity(activity: OverlayActivity | null | undefined): boolean {
  return Boolean(activity && activity !== "idle" && activity !== "unknown");
}

function formatLiveText(value: string, max = 3200): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 3)}...`;
}

function mergeStreamText(previous: string | undefined, chunk: string, max = 3200): string {
  const rawChunk = typeof chunk === "string" ? chunk : "";
  if (!rawChunk.trim()) {
    return previous ?? "";
  }

  const base = typeof previous === "string" ? previous.trim() : "";
  const merged = `${base}${rawChunk}`.replace(/\s+/g, " ").trim();
  return merged.length <= max ? merged : `${merged.slice(0, max - 3)}...`;
}

function buildInterruptionArtifact(
  sessionName: string,
  data: Record<string, unknown>,
  timestamp: number,
  anchor: OverlayChatArtifactAnchor,
): OverlayChatArtifact {
  const detail = extractRuntimeText(data) || "execução interrompida";
  return {
    id: `${sessionName}:turn.interrupted:${timestamp}`,
    kind: "interruption",
    label: "interrupção",
    detail,
    createdAt: timestamp,
    updatedAt: timestamp,
    anchor,
  };
}

function buildToolArtifact(
  sessionName: string,
  toolId: string,
  toolName: string,
  data: Record<string, unknown>,
  timestamp: number,
): OverlayChatArtifact {
  const artifactId = `${sessionName}:tool:${toolId}`;
  const existing = findLiveArtifact(sessionName, artifactId);
  const description = summarizeToolInputCompact(toolName, data.input) || existing?.description || null;
  const preview = summarizeToolArtifactPreview(data, existing?.preview ?? null);
  const fullDetail = buildToolArtifactFullDetail(data, existing?.fullDetail ?? null);
  const status = resolveToolArtifactStatus(data, existing?.status ?? null);
  const duration = resolveToolArtifactDuration(data, existing?.duration ?? null);
  return {
    id: artifactId,
    kind: "tool",
    label: toolName,
    detail: preview || description || existing?.detail || toolName,
    description,
    preview,
    fullDetail,
    status,
    duration,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
    anchor: existing?.anchor ?? resolveActiveArtifactAnchor(sessionName),
    dedupeKey: artifactId,
  };
}

function extractRuntimeText(data: Record<string, unknown>): string {
  const candidates = [data.detail, data.message, data.reason, data.error, data.status];

  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) {
      const normalized = formatLiveText(value, 160);
      if (normalized) return normalized;
    }
  }

  return "";
}

function extractPromptMessageId(prompt: string): string | null {
  if (typeof prompt !== "string" || !prompt.trim()) return null;
  const match = prompt.match(/\bmid:([^\]\s]+)/i);
  return extractExternalMessageId(match?.[1] ?? null);
}

function findRecentPromptMessageIdInHistory(sessionName: string): string | null {
  const history = getRecentHistory(sessionName, 40);
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (message.role !== "user") continue;
    const promptMessageId = extractPromptMessageId(message.content);
    if (promptMessageId) {
      return promptMessageId;
    }
  }
  return null;
}

function shortenFilePath(filePath: string, maxLen = 40): string {
  if (filePath.length <= maxLen) return filePath;
  const parts = filePath.split("/");
  if (parts.length <= 2) return filePath.slice(-maxLen);
  // Try progressively shorter: last 2, last 1
  const last2 = "…/" + parts.slice(-2).join("/");
  if (last2.length <= maxLen) return last2;
  const last1 = "…/" + parts[parts.length - 1];
  if (last1.length <= maxLen) return last1;
  return last1.slice(-maxLen);
}

function summarizeToolInputCompact(toolName: string, input: unknown): string {
  if (input == null) return "";
  if (typeof input !== "object" || Array.isArray(input)) return summarizeToolValue(input, 80);
  const obj = input as Record<string, unknown>;

  switch (toolName) {
    case "Read": {
      const fp = typeof obj.file_path === "string" ? shortenFilePath(obj.file_path) : null;
      if (!fp) return summarizeToolValue(input, 80);
      const parts = [fp];
      if (typeof obj.offset === "number") parts.push(`L${obj.offset}`);
      if (typeof obj.limit === "number") parts.push(`+${obj.limit}`);
      return parts.join(" ");
    }
    case "Write":
    case "Edit": {
      const fp = typeof obj.file_path === "string" ? shortenFilePath(obj.file_path) : null;
      return fp || summarizeToolValue(input, 80);
    }
    case "Bash": {
      const cmd = typeof obj.command === "string" ? obj.command : null;
      return cmd ? formatLiveText(cmd, 80) : summarizeToolValue(input, 80);
    }
    case "Grep": {
      const pattern = typeof obj.pattern === "string" ? obj.pattern : null;
      const path = typeof obj.path === "string" ? shortenFilePath(obj.path, 30) : null;
      const parts: string[] = [];
      if (pattern) parts.push(`/${pattern}/`);
      if (path) parts.push(`in ${path}`);
      return parts.join(" ") || summarizeToolValue(input, 80);
    }
    case "Glob": {
      const pattern = typeof obj.pattern === "string" ? obj.pattern : null;
      const path = typeof obj.path === "string" ? shortenFilePath(obj.path, 30) : null;
      const parts: string[] = [];
      if (pattern) parts.push(pattern);
      if (path) parts.push(`in ${path}`);
      return parts.join(" ") || summarizeToolValue(input, 80);
    }
    case "Agent": {
      const desc = typeof obj.description === "string" ? obj.description : null;
      return desc ? formatLiveText(desc, 60) : summarizeToolValue(input, 80);
    }
    default:
      return summarizeToolValue(input, 80);
  }
}

function summarizeToolInput(value: unknown): string {
  return summarizeToolValue(value, 180);
}

function summarizeToolOutput(value: unknown): string {
  return summarizeToolValue(value, 120);
}

function summarizeToolArtifactPreview(data: Record<string, unknown>, fallback: string | null): string {
  const eventName = typeof data.event === "string" ? data.event : undefined;
  if (eventName === "start") {
    return fallback || "executando";
  }

  if (eventName === "end") {
    const outputSummary = summarizeToolOutput(resolveToolArtifactResultValue(data));
    if (outputSummary) return outputSummary;
    return data.isError === true ? "erro" : fallback || "concluído";
  }

  return fallback || "";
}

function resolveToolArtifactDuration(data: Record<string, unknown>, fallback: string | null): string | null {
  const eventName = typeof data.event === "string" ? data.event : undefined;
  if (eventName === "end" && typeof data.durationMs === "number" && Number.isFinite(data.durationMs)) {
    return formatDurationCompact(data.durationMs);
  }
  return fallback;
}

function resolveToolArtifactStatus(
  data: Record<string, unknown>,
  fallback: OverlayChatArtifact["status"] | null | undefined,
): OverlayChatArtifact["status"] | null {
  const eventName = typeof data.event === "string" ? data.event : undefined;
  if (eventName === "start") {
    return "running";
  }
  if (eventName === "end") {
    return data.isError === true ? "error" : "ok";
  }
  return fallback ?? null;
}

function buildToolArtifactFullDetail(data: Record<string, unknown>, fallback: string | null): string | null {
  const eventName = typeof data.event === "string" ? data.event : undefined;
  if (eventName !== "end") {
    return fallback;
  }

  const lines: string[] = [];
  lines.push(`status: ${data.isError === true ? "error" : "ok"}`);

  if (typeof data.durationMs === "number" && Number.isFinite(data.durationMs)) {
    lines.push(`duration: ${formatDurationCompact(data.durationMs)}`);
  }

  const inputDetail = formatToolDetailValue(data.input);
  if (inputDetail) {
    lines.push("");
    lines.push("input:");
    lines.push(inputDetail);
  }

  const resultDetail = formatToolDetailValue(resolveToolArtifactResultValue(data));
  if (resultDetail) {
    lines.push("");
    lines.push(data.isError === true ? "error:" : "result:");
    lines.push(resultDetail);
  }

  const detail = lines.join("\n").trim();
  return detail || fallback;
}

function resolveToolArtifactResultValue(data: Record<string, unknown>): unknown {
  return data.isError === true
    ? (data.output ?? data.error ?? data.message ?? data.reason ?? null)
    : (data.output ?? data.result ?? data.message ?? null);
}

function summarizeToolValue(value: unknown, max = 220): string {
  if (value == null) return "";
  if (typeof value === "string") return formatLiveText(value, max);
  if (typeof value === "number" || typeof value === "boolean") return String(value);

  if (Array.isArray(value)) {
    const summary = value
      .slice(0, 3)
      .map((entry) => summarizeToolLeafValue(entry))
      .filter(Boolean)
      .join(" · ");
    return formatLiveText(summary, max);
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue != null && entryValue !== "")
      .slice(0, 4)
      .map(([key, entryValue]) => `${key}=${summarizeToolLeafValue(entryValue)}`)
      .filter(Boolean);
    if (entries.length > 0) {
      return formatLiveText(entries.join(" · "), max);
    }
    return formatToolDetailValue(value).replace(/\s+/g, " ").trim().slice(0, max);
  }

  return formatLiveText(String(value), max);
}

function summarizeToolLeafValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") {
    return formatLiveText(value, 40);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return formatLiveText(
      value
        .slice(0, 3)
        .map((entry) => summarizeToolLeafValue(entry))
        .filter(Boolean)
        .join(", "),
      40,
    );
  }
  if (typeof value === "object") {
    return formatLiveText(
      Object.keys(value as Record<string, unknown>)
        .slice(0, 3)
        .join(", "),
      40,
    );
  }
  return formatLiveText(String(value), 40);
}

function formatToolDetailValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatDurationCompact(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)}s`;
  return `${Math.round(durationMs / 60_000)}m`;
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
      candidates.push(ipv6.toString());
    }
  } catch {
    return candidates;
  }

  return [...new Set(candidates)];
}
