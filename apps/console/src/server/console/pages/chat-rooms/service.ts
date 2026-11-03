// The text chat rooms of Ravi Pages: what the Pages Worker calls on behalf of
// the person in the panel (open, send, list, delete, read, confirm, widgets).
// Each call re-checks who the person is from the Pages session; the Worker
// never decides access. See `.ravi/specs/console/pages/chat-rooms/SPEC.md`.

import { eq } from "drizzle-orm";
import { after } from "next/server";

import { ConsoleApiError } from "@/server/console/api-error";
import { pageChatEngineEnabled, requirePageChatEngine } from "../chat/engine";
import { findLibrarySource } from "@/server/console/pages/kit/service";
import { effectiveCompiledTheme } from "@/server/console/widgets/live-theme";
import { db, schema } from "@/server/db";
import { isRateLimited } from "@/server/security/rate-limit";
import { compileWidget } from "@/shared/widgets/template/compile";
import type { CompiledWidget } from "@/shared/widgets/types";

import { authorizeRoom, matchChatRoute, resolveChatSite, resolveChatViewer, type ChatAccessDeps, type ChatViewer } from "./access";
import { publishRoomEvents, type RoomEventPublisher } from "./events";
import type { ChatProjectionJob } from "./projection";
import { shouldAgentReply, toChatMessage } from "./reply-policy";
import { chatRoomStoreForDb, type ChatRoomRecord, type ChatRoomStore } from "./store";
import {
  CHAT_HISTORY_PAGE,
  confirmBodySchema,
  deleteMessageBodySchema,
  listMessagesBodySchema,
  openRoomBodySchema,
  readRoomBodySchema,
  sendMessageBodySchema,
  widgetsBodySchema,
  type ChatMessage,
  type ChatPart,
  type RaviUiBlock,
} from "./types";
import { resolveTextChatAllowance, type TextChatAllowance } from "./usage";

/** Messages one person may send per minute in one room, and a whole room per minute. */
export const CHAT_SEND_LIMITS = { perViewer: 20, perRoom: 120, windowMs: 60_000 } as const;
/** Agent turns that may run at once in one room; more messages wait for the next one. */
export const CHAT_MAX_OPEN_TURNS = 2;
/** How long a write waits for the person's click. */
export const CHAT_CONFIRMATION_TTL_MS = 10 * 60_000;

export type ChatServiceDeps = ChatAccessDeps & {
  store?: ChatRoomStore;
  publish?: RoomEventPublisher;
  isRateLimited?: typeof isRateLimited;
  /** Starts the agent turn; returns its run id. */
  startTurn?: (turnId: string) => Promise<string | null>;
  /** Wakes the turn waiting on a confirmation. */
  resumeConfirmation?: (confirmationId: string, decision: "confirmed" | "cancelled") => Promise<void>;
  allowance?: (input: { organizationId: string; viewer: ChatViewer }) => Promise<TextChatAllowance>;
  defaultModel?: () => string;
  now?: () => Date;
  /** Queues the room's Base projection after the response. */
  project?: (job: ChatProjectionJob) => void;
};

/** Runs the Base projection once the response is sent; outside a request the next message catches up. */
export function scheduleChatProjection(job: ChatProjectionJob) {
  try {
    after(async () => {
      const { projectChatRoomIntoBase } = await import("./projection");
      await projectChatRoomIntoBase(job);
    });
  } catch {
    // Not in a request scope (tests, scripts).
  }
}

/** The model used when the site does not name one: Claude Sonnet 5.5 through the AI Gateway (K14). */
export const PAGE_CHAT_DEFAULT_TEXT_MODEL = "anthropic/claude-sonnet-5.5";

export function pageChatTextModel(siteModel: string | null) {
  return siteModel ?? process.env.PAGE_CHAT_TEXT_MODEL?.trim() ?? PAGE_CHAT_DEFAULT_TEXT_MODEL;
}

function storeOf(deps: ChatServiceDeps) {
  return deps.store ?? chatRoomStoreForDb();
}

function parse<T>(schemaLike: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } } }, body: unknown): T {
  const parsed = schemaLike.safeParse(body);
  if (!parsed.success) {
    throw new ConsoleApiError(400, {
      error: "payload_invalid",
      fieldErrors: Object.fromEntries(parsed.error.issues.map((issue) => [issue.path.map(String).join(".") || "body", issue.message])),
    });
  }
  return parsed.data;
}

export async function openChatRoom(body: unknown, requestId: string, deps: ChatServiceDeps = {}) {
  requirePageChatEngine();
  const input = parse(openRoomBodySchema, body);
  const store = storeOf(deps);
  const { site, settings } = await resolveChatSite(input.host, deps);
  const route = await matchChatRoute(site, input.path, deps);
  if (!route) throw new ConsoleApiError(404, { error: "chat_room_not_found" });
  const viewer = await resolveChatViewer(
    { host: input.host, pagesSession: input.pagesSession, requestId, site, routeId: route.routeId },
    store,
    deps,
  );
  const room = await store.getOrCreateRoom({
    organizationId: site.organizationId,
    projectId: site.projectId,
    siteId: site.id,
    routeId: route.routeId,
    kind: input.kind,
    ownerUserId: input.kind === "private" ? viewer.userId : null,
    path: route.path,
  });
  const [messages, authors, lastReadSeq] = await Promise.all([
    store.listMessages(room.id, { limit: CHAT_HISTORY_PAGE }),
    store.listAuthors(room.id),
    store.getLastRead(room.id, viewer.userId),
  ]);
  const members = authors.some((author) => author.userId === viewer.userId)
    ? authors
    : [{ userId: viewer.userId, displayName: viewer.displayName, role: viewer.role }, ...authors];
  return {
    room: { id: room.id, kind: room.kind, siteId: room.siteId, routeId: room.routeId, path: room.path, replyPolicy: settings.replyPolicy },
    viewer: { userId: viewer.userId, displayName: viewer.displayName, role: viewer.role },
    members,
    assistantName: settings.assistantName ?? "Ravi",
    messages: messages.map(toChatMessage),
    lastSeq: room.lastSeq,
    lastReadSeq,
    voiceEnabled: settings.enabled,
  };
}

export async function sendChatMessage(body: unknown, requestId: string, deps: ChatServiceDeps = {}) {
  requirePageChatEngine();
  const input = parse(sendMessageBodySchema, body);
  const store = storeOf(deps);
  const { room, viewer, context } = await authorizeRoom({ ...input, requestId }, store, deps);
  const limited = deps.isRateLimited ?? isRateLimited;
  if (
    limited({ key: `page-chat-send:${room.id}:${viewer.userId}`, limit: CHAT_SEND_LIMITS.perViewer, windowMs: CHAT_SEND_LIMITS.windowMs }) ||
    limited({ key: `page-chat-send:${room.id}`, limit: CHAT_SEND_LIMITS.perRoom, windowMs: CHAT_SEND_LIMITS.windowMs })
  ) {
    throw new ConsoleApiError(429, { error: "chat_rate_limited" });
  }

  const parts: ChatPart[] = [];
  let offeredLabel: string | null = null;
  if (input.action) {
    const target = await store.getMessage(input.action.replyToMessageId);
    const offered = target && target.roomId === room.id && target.authorType === "agent" ? offeredAction(target.parts, input.action.actionId) : null;
    if (!offered) throw new ConsoleApiError(400, { error: "payload_invalid", fieldErrors: { action: "That button is no longer offered." } });
    parts.push({ type: "action", actionId: offered.id, label: offered.label, replyToMessageId: input.action.replyToMessageId });
    offeredLabel = offered.label;
  }
  // A click is written as the button's own label, never one the browser sent.
  const text = input.text.trim() || offeredLabel || "";
  const publish = deps.publish ?? publishRoomEvents;
  const host = context.site.defaultHostname;

  if (input.speaker === "assistant") {
    // What the voice agent said back during the call; it never starts a text turn.
    const { message } = await store.insertMessage({
      room,
      authorType: "agent",
      authorUserId: null,
      authorName: context.settings.assistantName ?? "Ravi",
      authorRole: null,
      body: text,
      parts: [],
      status: "complete",
      source: "voice",
      clientMessageId: null,
      anchor: null,
      turnId: null,
    });
    await publish({ host, roomId: room.id, events: [{ type: "message.created", message: toChatMessage(message) }] });
    (deps.project ?? scheduleChatProjection)({ roomId: room.id });
    return { message: toChatMessage(message), turn: null };
  }

  const { message, created } = await store.insertMessage({
    room,
    authorType: "user",
    authorUserId: viewer.userId,
    authorName: viewer.displayName,
    authorRole: viewer.role,
    body: text,
    parts,
    status: "complete",
    source: input.source,
    clientMessageId: input.clientMessageId,
    anchor: input.anchor ?? null,
    turnId: null,
  });
  if (!created) {
    const existingTurn = message.turnId ? await store.getTurn(message.turnId) : null;
    return { message: toChatMessage(message), turn: existingTurn ? { id: existingTurn.id, status: existingTurn.status } : null };
  }
  await publish({ host, roomId: room.id, events: [{ type: "message.created", message: toChatMessage(message) }] });
  await store.setLastRead(room.id, viewer.userId, message.seq);
  (deps.project ?? scheduleChatProjection)({ roomId: room.id });

  const authors = await store.listAuthors(room.id);
  const reply = shouldAgentReply({
    roomKind: room.kind,
    replyPolicy: context.settings.replyPolicy,
    assistantName: context.settings.assistantName ?? "Ravi",
    text,
    isAction: Boolean(input.action),
    humanAuthorCount: authors.length,
  });
  // A voice transcript only starts a turn when the voice agent is not answering it (it always is).
  if (!reply || input.source !== "text") return { message: toChatMessage(message), turn: null };

  const open = await store.listOpenTurns(room.id);
  if (open.length >= CHAT_MAX_OPEN_TURNS) {
    return { message: toChatMessage(message), turn: null };
  }

  const allowance = await (deps.allowance ?? ((args) => resolveTextChatAllowance(args)))({
    organizationId: room.organizationId,
    viewer,
  });
  const assistantName = context.settings.assistantName ?? "Ravi";
  if (!allowance.allowed) {
    const notice = await store.insertMessage({
      room,
      authorType: "system",
      authorUserId: null,
      authorName: "Ravi",
      authorRole: null,
      body: allowance.reason === "person_daily_limit"
        ? `${viewer.displayName}, você chegou ao limite de mensagens com o ${assistantName} por hoje.`
        : `O ${assistantName} não está disponível agora nesta organização.`,
      parts: [],
      status: "complete",
      source: "text",
      clientMessageId: null,
      anchor: null,
      turnId: null,
    });
    await publish({ host, roomId: room.id, events: [{ type: "message.created", message: toChatMessage(notice.message) }] });
    return { message: toChatMessage(message), turn: null };
  }

  const model = pageChatTextModel(context.settings.textModel);
  const turn = await store.insertTurn({
    roomId: room.id,
    organizationId: room.organizationId,
    projectId: room.projectId,
    siteId: room.siteId,
    triggerMessageId: message.id,
    speakerUserId: viewer.userId,
    speakerKind: viewer.role,
    speakerOrgRole: viewer.orgRole,
    pagesSessionId: viewer.pagesSessionId,
    status: "queued",
    model,
  });
  const replyMessage = await store.insertMessage({
    room,
    authorType: "agent",
    authorUserId: null,
    authorName: assistantName,
    authorRole: null,
    body: "",
    parts: [],
    status: "streaming",
    source: "text",
    clientMessageId: null,
    anchor: null,
    turnId: turn.id,
  });
  await store.updateTurn(turn.id, { replyMessageId: replyMessage.message.id });
  await store.updateMessage(message.id, { turnId: turn.id });
  await publish({
    host,
    roomId: room.id,
    events: [
      { type: "message.created", message: toChatMessage(replyMessage.message) },
      { type: "turn.status", turnId: turn.id, messageId: replyMessage.message.id, status: "queued" },
    ],
  });

  try {
    const runId = await (deps.startTurn ?? defaultStartTurn)(turn.id);
    if (runId) await store.updateTurn(turn.id, { runId });
  } catch (error) {
    console.error("Page chat turn could not start", { turnId: turn.id, error: error instanceof Error ? error.message : "error" });
    const failed = await store.updateMessage(replyMessage.message.id, {
      status: "failed",
      body: `O ${assistantName} não conseguiu responder agora. Tente de novo em instantes.`,
    });
    await store.updateTurn(turn.id, { status: "failed", error: "start_failed", finishedAt: new Date() });
    if (failed) {
      await publish({
        host,
        roomId: room.id,
        events: [
          { type: "message.updated", message: toChatMessage(failed) },
          { type: "turn.status", turnId: turn.id, messageId: failed.id, status: "failed" },
        ],
      });
    }
    return { message: toChatMessage(message), turn: { id: turn.id, status: "failed" as const } };
  }
  return { message: toChatMessage(message), turn: { id: turn.id, status: "queued" as const } };
}

export async function listChatMessages(body: unknown, requestId: string, deps: ChatServiceDeps = {}) {
  const input = parse(listMessagesBodySchema, body);
  const store = storeOf(deps);
  const { room } = await authorizeRoom({ ...input, requestId }, store, deps);
  const messages = await store.listMessages(room.id, {
    afterSeq: input.afterSeq,
    beforeSeq: input.beforeSeq,
    limit: input.limit ?? CHAT_HISTORY_PAGE,
  });
  const fresh = await store.findRoom(room.id);
  return { messages: messages.map(toChatMessage), lastSeq: fresh?.lastSeq ?? room.lastSeq };
}

/** The author deletes their own message; an org owner or admin deletes anyone's. The agent's replies count as anyone's. */
export async function deleteChatMessage(body: unknown, requestId: string, deps: ChatServiceDeps = {}) {
  const input = parse(deleteMessageBodySchema, body);
  const store = storeOf(deps);
  const { room, viewer, context } = await authorizeRoom({ ...input, requestId }, store, deps);
  const message = await store.getMessage(input.messageId);
  if (!message || message.roomId !== room.id) throw new ConsoleApiError(404, { error: "chat_room_not_found" });
  const own = message.authorType === "user" && message.authorUserId === viewer.userId;
  const moderator = viewer.role === "member" && (viewer.orgRole === "owner" || viewer.orgRole === "admin");
  const privateOwner = room.kind === "private" && room.ownerUserId === viewer.userId;
  if (!own && !moderator && !privateOwner) throw new ConsoleApiError(403, { error: "chat_forbidden" });
  if (!message.deletedAt) {
    const now = (deps.now ?? (() => new Date()))();
    await store.updateMessage(message.id, { deletedAt: now, body: "", parts: [] });
    await (deps.publish ?? publishRoomEvents)({
      host: context.site.defaultHostname,
      roomId: room.id,
      events: [{ type: "message.deleted", messageId: message.id, seq: message.seq }],
    });
    (deps.project ?? scheduleChatProjection)({ roomId: room.id, deletedMessageId: message.id });
  }
  return { ok: true as const };
}

/**
 * Mirrors a new Page comment into the route's shared room as a message with
 * the comment's anchor (K6). Best effort: a site without text chat, a path no
 * route serves or any failure leaves the comment as it is and returns null.
 */
export async function mirrorPageCommentIntoRoom(
  input: {
    host: string;
    path: string;
    comment: { id: string; body: string; target: unknown; parentId: string | null; author: { id: string | null; displayName: string | null } };
  },
  deps: ChatServiceDeps = {},
): Promise<ChatMessage | null> {
  if (!pageChatEngineEnabled()) return null;
  if (!input.comment.author.id) return null;
  try {
    const store = storeOf(deps);
    const { site } = await resolveChatSite(input.host, deps);
    const route = await matchChatRoute(site, input.path, deps);
    if (!route) return null;
    const room = await store.getOrCreateRoom({
      organizationId: site.organizationId,
      projectId: site.projectId,
      siteId: site.id,
      routeId: route.routeId,
      kind: "shared",
      ownerUserId: null,
      path: route.path,
    });
    const person = await store.findUserDisplay(input.comment.author.id);
    const { message, created } = await store.insertMessage({
      room,
      authorType: "user",
      authorUserId: input.comment.author.id,
      authorName: input.comment.author.displayName ?? person?.displayName ?? "Alguém",
      // Only people who can write the project leave comments.
      authorRole: "member",
      body: input.comment.body,
      parts: [],
      status: "complete",
      source: "comment",
      clientMessageId: `comment:${input.comment.id}`,
      anchor: { commentId: input.comment.id, parentId: input.comment.parentId, target: input.comment.target, path: input.path },
      turnId: null,
    });
    if (created) {
      await (deps.publish ?? publishRoomEvents)({ host: site.defaultHostname, roomId: room.id, events: [{ type: "message.created", message: toChatMessage(message) }] });
      (deps.project ?? scheduleChatProjection)({ roomId: room.id });
    }
    return toChatMessage(message);
  } catch (error) {
    if (!(error instanceof ConsoleApiError)) {
      console.error("Page comment was not mirrored into the chat room", { commentId: input.comment.id, error: error instanceof Error ? error.message : "error" });
    }
    return null;
  }
}

export async function readChatRoom(body: unknown, requestId: string, deps: ChatServiceDeps = {}) {
  const input = parse(readRoomBodySchema, body);
  const store = storeOf(deps);
  const { room, viewer } = await authorizeRoom({ ...input, requestId }, store, deps);
  await store.setLastRead(room.id, viewer.userId, Math.min(input.seq, room.lastSeq));
  return { ok: true as const };
}

/** Only the person the agent asked may confirm or cancel; the turn then runs or drops the write. */
export async function decideChatConfirmation(body: unknown, requestId: string, deps: ChatServiceDeps = {}) {
  requirePageChatEngine();
  const input = parse(confirmBodySchema, body);
  const store = storeOf(deps);
  const { room, viewer, context } = await authorizeRoom({ ...input, requestId }, store, deps);
  const confirmation = await store.getConfirmation(input.confirmationId);
  if (!confirmation || confirmation.roomId !== room.id) throw new ConsoleApiError(404, { error: "chat_room_not_found" });
  if (confirmation.forUserId !== viewer.userId) throw new ConsoleApiError(403, { error: "chat_forbidden" });
  const now = (deps.now ?? (() => new Date()))();
  const expired = confirmation.expiresAt.getTime() <= now.getTime();
  const status: "expired" | "confirmed" | "cancelled" = expired ? "expired" : input.decision === "confirm" ? "confirmed" : "cancelled";
  const decided = await store.decideConfirmation(confirmation.id, status, now);
  if (!decided) throw new ConsoleApiError(409, { error: "payload_invalid", fieldErrors: { confirmationId: "Already decided." } });

  const message = await store.getMessage(confirmation.messageId);
  if (message) {
    const parts: ChatPart[] = message.parts.map((part) =>
      part.type === "confirmation" && part.confirmationId === confirmation.id ? { ...part, status } : part,
    );
    const updated = await store.updateMessage(message.id, { parts });
    if (updated) {
      await (deps.publish ?? publishRoomEvents)({
        host: context.site.defaultHostname,
        roomId: room.id,
        events: [{ type: "message.updated", message: toChatMessage(updated) }],
      });
    }
  }
  if (status !== "expired") {
    await (deps.resumeConfirmation ?? defaultResumeConfirmation)(confirmation.id, status);
  } else {
    await (deps.resumeConfirmation ?? defaultResumeConfirmation)(confirmation.id, "cancelled");
  }
  return { ok: true as const, status };
}

export type ChatWidgetPayload = { ref: string; widget: CompiledWidget };

/** Compiled Library widgets by ref (org widgets and the site project's) plus the effective theme CSS. */
export async function loadChatWidgets(body: unknown, requestId: string, deps: ChatServiceDeps = {}) {
  const input = parse(widgetsBodySchema, body);
  const store = storeOf(deps);
  const { site } = await resolveChatSite(input.host, deps);
  // Widget templates carry no rows: any signed-in viewer of the site (member, or
  // guest of some route) may load them, so a guest not given "/" still passes.
  const route = await matchChatRoute(site, "/", deps);
  await resolveChatViewer(
    { host: input.host, pagesSession: input.pagesSession, requestId, site, routeId: route?.routeId ?? "" },
    store,
    deps,
  ).catch(async (error) => {
    if (!(error instanceof ConsoleApiError) || error.payload.error !== "chat_forbidden") throw error;
  });
  const project = await loadProjectSlug(site.projectId);
  const scope = { organizationId: site.organizationId, project: { id: site.projectId, slug: project ?? site.projectId } };
  const widgets: ChatWidgetPayload[] = [];
  for (const ref of [...new Set(input.refs)]) {
    const lookup = await findLibrarySource(scope, "widget", ref);
    if (!lookup.ok) continue;
    const compiled = compileWidget(lookup.source.files, {
      ref: { itemId: lookup.source.itemId, ref: lookup.source.ref, version: lookup.source.version },
    });
    if (compiled.widget) widgets.push({ ref, widget: compiled.widget });
  }
  const theme = await effectiveCompiledTheme({ organizationId: site.organizationId, projectId: site.projectId });
  return { widgets, themeCss: theme?.theme?.css ?? null };
}

async function loadProjectSlug(projectId: string) {
  const [row] = await db.select({ slug: schema.projects.slug }).from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1);
  return row?.slug ?? null;
}

function offeredAction(parts: ChatPart[], actionId: string) {
  for (const part of parts) {
    if (part.type !== "ui") continue;
    const block: RaviUiBlock = part.block;
    if (block.kind !== "actions") continue;
    const action = block.actions.find((item) => item.id === actionId);
    if (action) return action;
  }
  return null;
}

async function defaultStartTurn(turnId: string) {
  const { startPageChatTurn } = await import("./agent/runner");
  return startPageChatTurn(turnId);
}

async function defaultResumeConfirmation(confirmationId: string, decision: "confirmed" | "cancelled") {
  const { resumePageChatConfirmation } = await import("./agent/runner");
  await resumePageChatConfirmation(confirmationId, decision);
}

export type { ChatMessage, ChatRoomRecord };
