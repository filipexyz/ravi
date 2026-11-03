// Persistence for chat rooms. The service talks to this interface only, so
// tests run against the in-memory store (store-memory.ts) and production
// against Postgres. Sequence numbers are assigned by bumping
// `page_chat_rooms.last_seq` in the same transaction as the insert.

import { and, asc, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";

import { db, schema } from "@/server/db";
import type { JsonRecord } from "@/server/db/schema";

import type { ChatMessageSource, ChatMessageStatus, ChatPart, ChatRoomKind, ChatTurnStatus, ChatViewerRole } from "./types";

export type ChatRoomRecord = {
  id: string;
  organizationId: string;
  projectId: string;
  siteId: string;
  routeId: string;
  kind: ChatRoomKind;
  ownerUserId: string | null;
  path: string;
  lastSeq: number;
};

export type ChatMessageRecord = {
  id: string;
  roomId: string;
  organizationId: string;
  seq: number;
  authorType: "user" | "agent" | "system";
  authorUserId: string | null;
  authorName: string;
  authorRole: ChatViewerRole | null;
  body: string;
  parts: ChatPart[];
  status: ChatMessageStatus;
  source: ChatMessageSource;
  clientMessageId: string | null;
  anchor: JsonRecord | null;
  turnId: string | null;
  createdAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
};

export type ChatTurnRecord = {
  id: string;
  roomId: string;
  organizationId: string;
  projectId: string;
  siteId: string;
  triggerMessageId: string | null;
  replyMessageId: string | null;
  speakerUserId: string;
  speakerKind: ChatViewerRole;
  speakerOrgRole: string | null;
  pagesSessionId: string | null;
  status: ChatTurnStatus;
  runId: string | null;
  model: string;
  state: JsonRecord;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  toolCalls: number;
  error: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
};

export type ChatConfirmationRecord = {
  id: string;
  roomId: string;
  turnId: string;
  messageId: string;
  forUserId: string;
  toolCallId: string;
  operationId: string;
  input: JsonRecord;
  summary: string;
  status: "pending" | "confirmed" | "cancelled" | "expired";
  decidedAt: Date | null;
  expiresAt: Date;
};

export type NewChatMessage = {
  room: Pick<ChatRoomRecord, "id" | "organizationId">;
  authorType: ChatMessageRecord["authorType"];
  authorUserId: string | null;
  authorName: string;
  authorRole: ChatViewerRole | null;
  body: string;
  parts: ChatPart[];
  status: ChatMessageStatus;
  source: ChatMessageSource;
  clientMessageId: string | null;
  anchor: JsonRecord | null;
  turnId: string | null;
};

export type ChatMessagePatch = Partial<Pick<ChatMessageRecord, "body" | "parts" | "status" | "editedAt" | "deletedAt" | "turnId">>;

export type ChatTurnPatch = Partial<
  Pick<
    ChatTurnRecord,
    | "replyMessageId"
    | "status"
    | "runId"
    | "state"
    | "inputTokens"
    | "cachedInputTokens"
    | "outputTokens"
    | "costUsd"
    | "toolCalls"
    | "error"
    | "startedAt"
    | "finishedAt"
  >
>;

export type NewChatTurn = Omit<
  ChatTurnRecord,
  "id" | "replyMessageId" | "runId" | "state" | "inputTokens" | "cachedInputTokens" | "outputTokens" | "costUsd" | "toolCalls" | "error" | "startedAt" | "finishedAt" | "createdAt"
>;

export type ChatRoomStore = {
  findRoom(id: string): Promise<ChatRoomRecord | null>;
  getOrCreateRoom(input: Omit<ChatRoomRecord, "id" | "lastSeq">): Promise<ChatRoomRecord>;
  /** Inserts with the next seq; a repeated (author, clientMessageId) returns the first message and `created: false`. */
  insertMessage(input: NewChatMessage): Promise<{ message: ChatMessageRecord; created: boolean }>;
  updateMessage(id: string, patch: ChatMessagePatch): Promise<ChatMessageRecord | null>;
  getMessage(id: string): Promise<ChatMessageRecord | null>;
  listMessages(roomId: string, query: { afterSeq?: number; beforeSeq?: number; limit: number }): Promise<ChatMessageRecord[]>;
  /** Distinct people who ever wrote in the room (not deleted messages too: a deleted message still counted as a voice). */
  listAuthors(roomId: string): Promise<Array<{ userId: string; displayName: string; role: ChatViewerRole }>>;
  getLastRead(roomId: string, userId: string): Promise<number>;
  setLastRead(roomId: string, userId: string, seq: number): Promise<void>;
  insertTurn(input: NewChatTurn): Promise<ChatTurnRecord>;
  getTurn(id: string): Promise<ChatTurnRecord | null>;
  updateTurn(id: string, patch: ChatTurnPatch): Promise<ChatTurnRecord | null>;
  /** Turns of the room not yet complete or failed, newest first. */
  listOpenTurns(roomId: string): Promise<ChatTurnRecord[]>;
  insertConfirmation(input: Omit<ChatConfirmationRecord, "id" | "status" | "decidedAt">): Promise<ChatConfirmationRecord>;
  getConfirmation(id: string): Promise<ChatConfirmationRecord | null>;
  /** Moves a pending confirmation to `status`; null when it was no longer pending. */
  decideConfirmation(id: string, status: "confirmed" | "cancelled" | "expired", at: Date): Promise<ChatConfirmationRecord | null>;
  findUserDisplay(userId: string): Promise<{ displayName: string; email: string | null } | null>;
};

type RoomRow = typeof schema.pageChatRooms.$inferSelect;
type MessageRow = typeof schema.pageChatMessages.$inferSelect;
type TurnRow = typeof schema.pageChatTurns.$inferSelect;
type ConfirmationRow = typeof schema.pageChatConfirmations.$inferSelect;

function toRoom(row: RoomRow): ChatRoomRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    projectId: row.projectId,
    siteId: row.siteId,
    routeId: row.routeId,
    kind: row.kind === "private" ? "private" : "shared",
    ownerUserId: row.ownerUserId,
    path: row.path,
    lastSeq: row.lastSeq,
  };
}

function toMessage(row: MessageRow): ChatMessageRecord {
  return {
    id: row.id,
    roomId: row.roomId,
    organizationId: row.organizationId,
    seq: row.seq,
    authorType: row.authorType === "agent" ? "agent" : row.authorType === "system" ? "system" : "user",
    authorUserId: row.authorUserId,
    authorName: row.authorName,
    authorRole: row.authorRole === "guest" ? "guest" : row.authorRole === "member" ? "member" : null,
    body: row.body,
    parts: (row.partsJson ?? []) as unknown as ChatPart[],
    status: row.status as ChatMessageStatus,
    source: row.source as ChatMessageSource,
    clientMessageId: row.clientMessageId,
    anchor: row.anchorJson ?? null,
    turnId: row.turnId,
    createdAt: row.createdAt,
    editedAt: row.editedAt,
    deletedAt: row.deletedAt,
  };
}

function toTurn(row: TurnRow): ChatTurnRecord {
  return {
    id: row.id,
    roomId: row.roomId,
    organizationId: row.organizationId,
    projectId: row.projectId,
    siteId: row.siteId,
    triggerMessageId: row.triggerMessageId,
    replyMessageId: row.replyMessageId,
    speakerUserId: row.speakerUserId,
    speakerKind: row.speakerKind === "guest" ? "guest" : "member",
    speakerOrgRole: row.speakerOrgRole,
    pagesSessionId: row.pagesSessionId,
    status: row.status as ChatTurnStatus,
    runId: row.runId,
    model: row.model,
    state: row.stateJson ?? {},
    inputTokens: row.inputTokens,
    cachedInputTokens: row.cachedInputTokens,
    outputTokens: row.outputTokens,
    costUsd: row.costUsd == null ? null : Number(row.costUsd),
    toolCalls: row.toolCalls,
    error: row.error,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    createdAt: row.createdAt,
  };
}

function toConfirmation(row: ConfirmationRow): ChatConfirmationRecord {
  return {
    id: row.id,
    roomId: row.roomId,
    turnId: row.turnId,
    messageId: row.messageId,
    forUserId: row.forUserId,
    toolCallId: row.toolCallId,
    operationId: row.operationId,
    input: row.inputJson ?? {},
    summary: row.summary,
    status: row.status as ChatConfirmationRecord["status"],
    decidedAt: row.decidedAt,
    expiresAt: row.expiresAt,
  };
}

export function chatRoomStoreForDb(): ChatRoomStore {
  return {
    async findRoom(id) {
      const [row] = await db.select().from(schema.pageChatRooms).where(eq(schema.pageChatRooms.id, id)).limit(1);
      return row ? toRoom(row) : null;
    },

    async getOrCreateRoom(input) {
      const match = and(
        eq(schema.pageChatRooms.routeId, input.routeId),
        eq(schema.pageChatRooms.kind, input.kind),
        input.ownerUserId ? eq(schema.pageChatRooms.ownerUserId, input.ownerUserId) : isNull(schema.pageChatRooms.ownerUserId),
      );
      const [existing] = await db.select().from(schema.pageChatRooms).where(match).limit(1);
      if (existing) return toRoom(existing);
      await db
        .insert(schema.pageChatRooms)
        .values({
          organizationId: input.organizationId,
          projectId: input.projectId,
          siteId: input.siteId,
          routeId: input.routeId,
          kind: input.kind,
          ownerUserId: input.ownerUserId,
          path: input.path,
        })
        .onConflictDoNothing();
      const [row] = await db.select().from(schema.pageChatRooms).where(match).limit(1);
      if (!row) throw new Error("page chat room insert returned no row");
      return toRoom(row);
    },

    async insertMessage(input) {
      if (input.clientMessageId && input.authorUserId) {
        const [existing] = await db
          .select()
          .from(schema.pageChatMessages)
          .where(
            and(
              eq(schema.pageChatMessages.roomId, input.room.id),
              eq(schema.pageChatMessages.authorUserId, input.authorUserId),
              eq(schema.pageChatMessages.clientMessageId, input.clientMessageId),
            ),
          )
          .limit(1);
        if (existing) return { message: toMessage(existing), created: false };
      }
      const row = await db.transaction(async (tx) => {
        const [room] = await tx
          .update(schema.pageChatRooms)
          .set({ lastSeq: sql`${schema.pageChatRooms.lastSeq} + 1`, updatedAt: new Date() })
          .where(eq(schema.pageChatRooms.id, input.room.id))
          .returning({ lastSeq: schema.pageChatRooms.lastSeq });
        if (!room) throw new Error("page chat room not found");
        const [inserted] = await tx
          .insert(schema.pageChatMessages)
          .values({
            roomId: input.room.id,
            organizationId: input.room.organizationId,
            seq: room.lastSeq,
            authorType: input.authorType,
            authorUserId: input.authorUserId,
            authorName: input.authorName,
            authorRole: input.authorRole,
            body: input.body,
            partsJson: input.parts as unknown as JsonRecord[],
            status: input.status,
            source: input.source,
            clientMessageId: input.clientMessageId,
            anchorJson: input.anchor,
            turnId: input.turnId,
          })
          .returning();
        return inserted;
      });
      if (!row) throw new Error("page chat message insert returned no row");
      return { message: toMessage(row), created: true };
    },

    async updateMessage(id, patch) {
      const values: Partial<typeof schema.pageChatMessages.$inferInsert> = {};
      if (patch.body !== undefined) values.body = patch.body;
      if (patch.parts !== undefined) values.partsJson = patch.parts as unknown as JsonRecord[];
      if (patch.status !== undefined) values.status = patch.status;
      if (patch.editedAt !== undefined) values.editedAt = patch.editedAt;
      if (patch.deletedAt !== undefined) values.deletedAt = patch.deletedAt;
      if (patch.turnId !== undefined) values.turnId = patch.turnId;
      const [row] = await db.update(schema.pageChatMessages).set(values).where(eq(schema.pageChatMessages.id, id)).returning();
      return row ? toMessage(row) : null;
    },

    async getMessage(id) {
      const [row] = await db.select().from(schema.pageChatMessages).where(eq(schema.pageChatMessages.id, id)).limit(1);
      return row ? toMessage(row) : null;
    },

    async listMessages(roomId, query) {
      if (query.afterSeq !== undefined) {
        const rows = await db
          .select()
          .from(schema.pageChatMessages)
          .where(and(eq(schema.pageChatMessages.roomId, roomId), gt(schema.pageChatMessages.seq, query.afterSeq)))
          .orderBy(asc(schema.pageChatMessages.seq))
          .limit(query.limit);
        return rows.map(toMessage);
      }
      const rows = await db
        .select()
        .from(schema.pageChatMessages)
        .where(
          and(
            eq(schema.pageChatMessages.roomId, roomId),
            query.beforeSeq !== undefined ? lt(schema.pageChatMessages.seq, query.beforeSeq) : undefined,
          ),
        )
        .orderBy(desc(schema.pageChatMessages.seq))
        .limit(query.limit);
      return rows.map(toMessage).reverse();
    },

    async listAuthors(roomId) {
      const rows = await db
        .selectDistinctOn([schema.pageChatMessages.authorUserId], {
          userId: schema.pageChatMessages.authorUserId,
          displayName: schema.pageChatMessages.authorName,
          role: schema.pageChatMessages.authorRole,
        })
        .from(schema.pageChatMessages)
        .where(and(eq(schema.pageChatMessages.roomId, roomId), eq(schema.pageChatMessages.authorType, "user")))
        .orderBy(schema.pageChatMessages.authorUserId, desc(schema.pageChatMessages.seq))
        .limit(200);
      return rows
        .filter((row): row is typeof row & { userId: string } => Boolean(row.userId))
        .map((row) => ({ userId: row.userId, displayName: row.displayName, role: row.role === "guest" ? "guest" : "member" }));
    },

    async getLastRead(roomId, userId) {
      const [row] = await db
        .select({ seq: schema.pageChatReads.lastReadSeq })
        .from(schema.pageChatReads)
        .where(and(eq(schema.pageChatReads.roomId, roomId), eq(schema.pageChatReads.userId, userId)))
        .limit(1);
      return row?.seq ?? 0;
    },

    async setLastRead(roomId, userId, seq) {
      await db
        .insert(schema.pageChatReads)
        .values({ roomId, userId, lastReadSeq: seq, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: [schema.pageChatReads.roomId, schema.pageChatReads.userId],
          set: { lastReadSeq: sql`GREATEST(${schema.pageChatReads.lastReadSeq}, ${seq})`, updatedAt: new Date() },
        });
    },

    async insertTurn(input) {
      const [row] = await db.insert(schema.pageChatTurns).values(input).returning();
      if (!row) throw new Error("page chat turn insert returned no row");
      return toTurn(row);
    },

    async getTurn(id) {
      const [row] = await db.select().from(schema.pageChatTurns).where(eq(schema.pageChatTurns.id, id)).limit(1);
      return row ? toTurn(row) : null;
    },

    async updateTurn(id, patch) {
      const values: Partial<typeof schema.pageChatTurns.$inferInsert> = { updatedAt: new Date() };
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        if (key === "state") values.stateJson = value as JsonRecord;
        else if (key === "costUsd") values.costUsd = value == null ? null : String(value);
        else (values as Record<string, unknown>)[key] = value;
      }
      const [row] = await db.update(schema.pageChatTurns).set(values).where(eq(schema.pageChatTurns.id, id)).returning();
      return row ? toTurn(row) : null;
    },

    async listOpenTurns(roomId) {
      const rows = await db
        .select()
        .from(schema.pageChatTurns)
        .where(
          and(
            eq(schema.pageChatTurns.roomId, roomId),
            sql`${schema.pageChatTurns.status} IN ('queued', 'running', 'waiting_confirmation')`,
          ),
        )
        .orderBy(desc(schema.pageChatTurns.createdAt))
        .limit(10);
      return rows.map(toTurn);
    },

    async insertConfirmation(input) {
      const [row] = await db
        .insert(schema.pageChatConfirmations)
        .values({
          roomId: input.roomId,
          turnId: input.turnId,
          messageId: input.messageId,
          forUserId: input.forUserId,
          toolCallId: input.toolCallId,
          operationId: input.operationId,
          inputJson: input.input,
          summary: input.summary,
          expiresAt: input.expiresAt,
        })
        .returning();
      if (!row) throw new Error("page chat confirmation insert returned no row");
      return toConfirmation(row);
    },

    async getConfirmation(id) {
      const [row] = await db.select().from(schema.pageChatConfirmations).where(eq(schema.pageChatConfirmations.id, id)).limit(1);
      return row ? toConfirmation(row) : null;
    },

    async decideConfirmation(id, status, at) {
      const [row] = await db
        .update(schema.pageChatConfirmations)
        .set({ status, decidedAt: at })
        .where(and(eq(schema.pageChatConfirmations.id, id), eq(schema.pageChatConfirmations.status, "pending")))
        .returning();
      return row ? toConfirmation(row) : null;
    },

    async findUserDisplay(userId) {
      const [row] = await db
        .select({ displayName: schema.users.displayName, email: schema.users.primaryEmail })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1);
      if (!row) return null;
      return { displayName: displayNameOf(row.displayName, row.email), email: row.email ?? null };
    },
  };
}

/** A person's name in the chat: their display name, else their email's local part. */
export function displayNameOf(displayName: string | null | undefined, email: string | null | undefined) {
  const name = displayName?.trim();
  if (name) return name.slice(0, 80);
  const local = email?.split("@")[0]?.trim();
  return local ? local.slice(0, 80) : "Pessoa";
}
