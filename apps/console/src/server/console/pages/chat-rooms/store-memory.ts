// In-memory ChatRoomStore for tests. Same contract as the Postgres store.

import { randomUUID } from "node:crypto";

import type {
  ChatConfirmationRecord,
  ChatMessageRecord,
  ChatRoomRecord,
  ChatRoomStore,
  ChatTurnRecord,
} from "./store";

export type MemoryChatRoomStore = ChatRoomStore & {
  rooms: Map<string, ChatRoomRecord>;
  messages: Map<string, ChatMessageRecord>;
  turns: Map<string, ChatTurnRecord>;
  confirmations: Map<string, ChatConfirmationRecord>;
  reads: Map<string, number>;
  users: Map<string, { displayName: string; email: string | null }>;
};

export function memoryChatRoomStore(users: Record<string, { displayName: string; email?: string | null }> = {}): MemoryChatRoomStore {
  const rooms = new Map<string, ChatRoomRecord>();
  const messages = new Map<string, ChatMessageRecord>();
  const turns = new Map<string, ChatTurnRecord>();
  const confirmations = new Map<string, ChatConfirmationRecord>();
  const reads = new Map<string, number>();
  const people = new Map(Object.entries(users).map(([id, user]) => [id, { displayName: user.displayName, email: user.email ?? null }]));
  const roomMessages = (roomId: string) => [...messages.values()].filter((message) => message.roomId === roomId).sort((a, b) => a.seq - b.seq);
  let clock = Date.parse("2026-10-18T12:00:00Z");
  const tick = () => new Date((clock += 1000));

  return {
    rooms,
    messages,
    turns,
    confirmations,
    reads,
    users: people,
    async findRoom(id) {
      return rooms.get(id) ?? null;
    },
    async getOrCreateRoom(input) {
      const existing = [...rooms.values()].find(
        (room) => room.routeId === input.routeId && room.kind === input.kind && room.ownerUserId === input.ownerUserId,
      );
      if (existing) return existing;
      const room: ChatRoomRecord = { ...input, id: randomUUID(), lastSeq: 0 };
      rooms.set(room.id, room);
      return room;
    },
    async insertMessage(input) {
      if (input.clientMessageId && input.authorUserId) {
        const existing = roomMessages(input.room.id).find(
          (message) => message.authorUserId === input.authorUserId && message.clientMessageId === input.clientMessageId,
        );
        if (existing) return { message: existing, created: false };
      }
      const room = rooms.get(input.room.id);
      if (!room) throw new Error("room not found");
      room.lastSeq += 1;
      const message: ChatMessageRecord = {
        id: randomUUID(),
        roomId: room.id,
        organizationId: room.organizationId,
        seq: room.lastSeq,
        authorType: input.authorType,
        authorUserId: input.authorUserId,
        authorName: input.authorName,
        authorRole: input.authorRole,
        body: input.body,
        parts: input.parts,
        status: input.status,
        source: input.source,
        clientMessageId: input.clientMessageId,
        anchor: input.anchor,
        turnId: input.turnId,
        createdAt: tick(),
        editedAt: null,
        deletedAt: null,
      };
      messages.set(message.id, message);
      return { message, created: true };
    },
    async updateMessage(id, patch) {
      const message = messages.get(id);
      if (!message) return null;
      const next = { ...message, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) } as ChatMessageRecord;
      messages.set(id, next);
      return next;
    },
    async getMessage(id) {
      return messages.get(id) ?? null;
    },
    async listMessages(roomId, query) {
      const all = roomMessages(roomId);
      if (query.afterSeq !== undefined) return all.filter((message) => message.seq > query.afterSeq!).slice(0, query.limit);
      const before = query.beforeSeq;
      const filtered = before !== undefined ? all.filter((message) => message.seq < before) : all;
      return filtered.slice(-query.limit);
    },
    async listAuthors(roomId) {
      const seen = new Map<string, { userId: string; displayName: string; role: "member" | "guest" }>();
      for (const message of roomMessages(roomId)) {
        if (message.authorType !== "user" || !message.authorUserId) continue;
        seen.set(message.authorUserId, {
          userId: message.authorUserId,
          displayName: message.authorName,
          role: message.authorRole === "guest" ? "guest" : "member",
        });
      }
      return [...seen.values()];
    },
    async getLastRead(roomId, userId) {
      return reads.get(`${roomId}:${userId}`) ?? 0;
    },
    async setLastRead(roomId, userId, seq) {
      const key = `${roomId}:${userId}`;
      reads.set(key, Math.max(reads.get(key) ?? 0, seq));
    },
    async insertTurn(input) {
      const turn: ChatTurnRecord = {
        ...input,
        id: randomUUID(),
        replyMessageId: null,
        runId: null,
        state: {},
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        costUsd: null,
        toolCalls: 0,
        error: null,
        startedAt: null,
        finishedAt: null,
        createdAt: tick(),
      };
      turns.set(turn.id, turn);
      return turn;
    },
    async getTurn(id) {
      const turn = turns.get(id);
      return turn ? structuredClone(turn) : null;
    },
    async updateTurn(id, patch) {
      const turn = turns.get(id);
      if (!turn) return null;
      const next = { ...turn, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) } as ChatTurnRecord;
      turns.set(id, structuredClone(next));
      return structuredClone(next);
    },
    async listOpenTurns(roomId) {
      return [...turns.values()].filter(
        (turn) => turn.roomId === roomId && (turn.status === "queued" || turn.status === "running" || turn.status === "waiting_confirmation"),
      );
    },
    async insertConfirmation(input) {
      const confirmation: ChatConfirmationRecord = { ...input, id: randomUUID(), status: "pending", decidedAt: null };
      confirmations.set(confirmation.id, confirmation);
      return confirmation;
    },
    async getConfirmation(id) {
      return confirmations.get(id) ?? null;
    },
    async decideConfirmation(id, status, at) {
      const confirmation = confirmations.get(id);
      if (!confirmation || confirmation.status !== "pending") return null;
      const next = { ...confirmation, status, decidedAt: at };
      confirmations.set(id, next);
      return next;
    },
    async findUserDisplay(userId) {
      return people.get(userId) ?? null;
    },
  };
}
