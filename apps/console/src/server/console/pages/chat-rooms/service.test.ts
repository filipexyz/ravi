import { describe, expect, test } from "bun:test";

import { ConsoleApiError } from "@/server/console/api-error";
import type { PagesResolveRoute, PagesResolveSite, PagesRouteResolveRepository } from "@/server/console/pages/resolve";

import {
  decideChatConfirmation,
  deleteChatMessage,
  listChatMessages,
  mirrorPageCommentIntoRoom,
  openChatRoom,
  readChatRoom,
  sendChatMessage,
  type ChatServiceDeps,
} from "./service";
import { memoryChatRoomStore } from "./store-memory";
import type { RoomEvent } from "./types";

const HOST = "acme-site.ravi.page";
const MEMBER = "11111111-1111-4111-8111-111111111111";
const GUEST = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const ROUTE_ID = "44444444-4444-4444-8444-444444444444";

const site: PagesResolveSite = {
  id: "55555555-5555-4555-8555-555555555555",
  organizationId: "66666666-6666-4666-8666-666666666666",
  projectId: "77777777-7777-4777-8777-777777777777",
  defaultHostname: HOST,
  defaultVisibility: "private",
  activeReleaseId: "88888888-8888-4888-8888-888888888888",
  status: "active",
};

const route: PagesResolveRoute = {
  id: "99999999-9999-4999-8999-999999999999",
  routeId: ROUTE_ID,
  path: "/",
  matchType: "exact",
  priority: 0,
  artifactId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  artifactVersionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  entrypoint: "index.html",
  assetBase: "",
  visibility: "private",
};

const repository: PagesRouteResolveRepository = {
  findSiteByHost: async (host) => (host === HOST ? site : null),
  getActiveRelease: async () => ({ id: site.activeReleaseId!, releaseNumber: 1, status: "active" }),
  listReleaseRoutes: async () => [route],
  getArtifactVersionFile: async () => null,
};

type Harness = {
  deps: ChatServiceDeps;
  events: RoomEvent[];
  started: string[];
  resumed: Array<{ id: string; decision: string }>;
  store: ReturnType<typeof memoryChatRoomStore>;
};

function harness(options: { settings?: Record<string, unknown>; guestGiven?: boolean; allowed?: boolean } = {}): Harness {
  const store = memoryChatRoomStore({
    [MEMBER]: { displayName: "Ana", email: "ana@acme.test" },
    [OTHER]: { displayName: "Bruno", email: "bruno@acme.test" },
    [GUEST]: { displayName: "Carla", email: "carla@fora.test" },
  });
  const events: RoomEvent[] = [];
  const started: string[] = [];
  const resumed: Array<{ id: string; decision: string }> = [];
  const projected: string[] = [];
  const sessions: Record<string, { userId: string; member: boolean; orgRole?: string }> = {
    "session-ana": { userId: MEMBER, member: true, orgRole: "owner" },
    "session-bruno": { userId: OTHER, member: true, orgRole: "developer" },
    "session-carla": { userId: GUEST, member: false },
  };
  const deps: ChatServiceDeps = {
    store,
    routeRepository: repository,
    loadSiteMetadata: async () => ({ pageChat: options.settings ?? {} }),
    humanSessionId: async (token) => (sessions[token] ? `${token}-id` : null),
    verifyMember: async ({ pagesSession }) => {
      const session = sessions[pagesSession];
      return session?.member ? { userId: session.userId, orgRole: session.orgRole ?? "developer" } : null;
    },
    verifyGuest: async ({ pagesSession }) => {
      const session = sessions[pagesSession];
      return session && !session.member ? { userId: session.userId } : null;
    },
    canGuestViewRoute: async () => options.guestGiven ?? true,
    featureOn: async () => true,
    publish: async ({ events: batch }) => {
      events.push(...batch);
    },
    isRateLimited: () => false,
    project: (job) => {
      projected.push(job.deletedMessageId ? `delete:${job.deletedMessageId}` : job.roomId);
    },
    startTurn: async (turnId) => {
      started.push(turnId);
      return `run-${turnId}`;
    },
    resumeConfirmation: async (id, decision) => {
      resumed.push({ id, decision });
    },
    allowance: async () => (options.allowed === false ? { allowed: false, reason: "org_budget_exhausted" } : { allowed: true, monthSpentUsd: 0, budgetUsd: 50 }),
  };
  return { deps, events, started, resumed, store };
}

async function open(h: Harness, pagesSession: string, kind: "shared" | "private" = "shared") {
  return openChatRoom({ host: HOST, path: "/", pagesSession, kind }, "req", h.deps);
}

async function send(h: Harness, pagesSession: string, roomId: string, text: string, clientMessageId = crypto.randomUUID()) {
  return sendChatMessage({ host: HOST, pagesSession, roomId, clientMessageId, text }, "req", h.deps);
}

async function expectError(promise: Promise<unknown>, code: string) {
  try {
    await promise;
    throw new Error("expected a rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(ConsoleApiError);
    expect((error as ConsoleApiError).payload.error).toBe(code);
  }
}

describe("Page chat rooms", () => {
  test("opens one shared room per route and a private room per person", async () => {
    const h = harness();
    const first = await open(h, "session-ana");
    const again = await open(h, "session-bruno");
    expect(again.room.id).toBe(first.room.id);
    expect(first.viewer).toEqual({ userId: MEMBER, displayName: "Ana", role: "member" });
    expect(first.assistantName).toBe("Ravi");
    const mine = await open(h, "session-ana", "private");
    const theirs = await open(h, "session-bruno", "private");
    expect(mine.room.id).not.toBe(first.room.id);
    expect(theirs.room.id).not.toBe(mine.room.id);
  });

  test("refuses no session, a guest not given the route, and a site with the text chat off", async () => {
    await expectError(open(harness(), "nope"), "chat_session_required");
    await expectError(open(harness({ guestGiven: false }), "session-carla"), "chat_forbidden");
    await expectError(open(harness({ settings: { text: false } }), "session-ana"), "chat_disabled_for_site");
  });

  test("a private room is invisible to anyone else", async () => {
    const h = harness();
    const mine = await open(h, "session-ana", "private");
    await expectError(listChatMessages({ host: HOST, pagesSession: "session-bruno", roomId: mine.room.id }, "req", h.deps), "chat_room_not_found");
  });

  test("the agent answers the only person in a shared room, then only when called", async () => {
    const h = harness();
    const { room } = await open(h, "session-ana");
    const alone = await send(h, "session-ana", room.id, "Oi, o que tem nesta página?");
    expect(alone.turn?.status).toBe("queued");
    expect(h.started).toHaveLength(1);

    // Finish that turn so the room has no open turns.
    for (const turn of h.store.turns.values()) turn.status = "complete";

    const second = await send(h, "session-bruno", room.id, "Ana, vi também.");
    expect(second.turn).toBeNull();
    const called = await send(h, "session-bruno", room.id, "@ravi resume para nós?");
    expect(called.turn?.status).toBe("queued");
    expect(h.started).toHaveLength(2);

    const created = h.events.filter((event) => event.type === "message.created");
    expect(created.length).toBeGreaterThanOrEqual(5);
    const reply = created.find((event) => event.type === "message.created" && event.message.author.type === "agent");
    expect(reply && reply.type === "message.created" && reply.message.status).toBe("streaming");
  });

  test("replyPolicy always answers everyone; a repeated clientMessageId is one message", async () => {
    const h = harness({ settings: { replyPolicy: "always" } });
    const { room } = await open(h, "session-ana");
    await send(h, "session-bruno", room.id, "Primeiro.");
    for (const turn of h.store.turns.values()) turn.status = "complete";
    const a = await send(h, "session-ana", room.id, "Segundo.", "same-id");
    const b = await send(h, "session-ana", room.id, "Segundo.", "same-id");
    expect(a.message.id).toBe(b.message.id);
    expect(h.started).toHaveLength(2);
  });

  test("an exhausted budget posts a notice instead of a turn", async () => {
    const h = harness({ allowed: false });
    const { room } = await open(h, "session-ana");
    const sent = await send(h, "session-ana", room.id, "Oi");
    expect(sent.turn).toBeNull();
    const list = await listChatMessages({ host: HOST, pagesSession: "session-ana", roomId: room.id }, "req", h.deps);
    expect(list.messages.at(-1)?.author.type).toBe("system");
  });

  test("a failed start marks the reply failed", async () => {
    const h = harness();
    h.deps.startTurn = async () => {
      throw new Error("no workflow");
    };
    const { room } = await open(h, "session-ana");
    const sent = await send(h, "session-ana", room.id, "Oi");
    expect(sent.turn?.status).toBe("failed");
    const list = await listChatMessages({ host: HOST, pagesSession: "session-ana", roomId: room.id }, "req", h.deps);
    expect(list.messages.at(-1)?.status).toBe("failed");
  });

  test("a button click must be one the agent offered", async () => {
    const h = harness();
    const { room } = await open(h, "session-ana");
    const { message } = await h.store.insertMessage({
      room: h.store.rooms.get(room.id)!,
      authorType: "agent",
      authorUserId: null,
      authorName: "Ravi",
      authorRole: null,
      body: "Escolha",
      parts: [{ type: "ui", block: { kind: "actions", actions: [{ id: "sim", label: "Sim" }] } }],
      status: "complete",
      source: "text",
      clientMessageId: null,
      anchor: null,
      turnId: null,
    });
    const ok = await sendChatMessage(
      { host: HOST, pagesSession: "session-ana", roomId: room.id, clientMessageId: "c1", text: "", action: { actionId: "sim", label: "x", replyToMessageId: message.id } },
      "req",
      h.deps,
    );
    expect(ok.message.parts[0]).toEqual({ type: "action", actionId: "sim", label: "Sim", replyToMessageId: message.id });
    expect(ok.message.text).toBe("Sim");
    await expectError(
      sendChatMessage(
        { host: HOST, pagesSession: "session-ana", roomId: room.id, clientMessageId: "c2", text: "", action: { actionId: "nao", label: "Não", replyToMessageId: message.id } },
        "req",
        h.deps,
      ),
      "payload_invalid",
    );
  });

  test("only the author or an owner deletes; a deleted message keeps its seq without content", async () => {
    const h = harness();
    const { room } = await open(h, "session-ana");
    const sent = await send(h, "session-bruno", room.id, "apaga isso");
    await expectError(
      deleteChatMessage({ host: HOST, pagesSession: "session-carla", roomId: room.id, messageId: sent.message.id }, "req", h.deps),
      "chat_forbidden",
    );
    await deleteChatMessage({ host: HOST, pagesSession: "session-ana", roomId: room.id, messageId: sent.message.id }, "req", h.deps);
    const list = await listChatMessages({ host: HOST, pagesSession: "session-bruno", roomId: room.id }, "req", h.deps);
    const deleted = list.messages.find((message) => message.id === sent.message.id);
    expect(deleted?.text).toBe("");
    expect(deleted?.deletedAt).not.toBeNull();
    expect(h.events.some((event) => event.type === "message.deleted")).toBe(true);
  });

  test("read marks only move forward", async () => {
    const h = harness();
    const { room } = await open(h, "session-ana");
    await send(h, "session-bruno", room.id, "um");
    await readChatRoom({ host: HOST, pagesSession: "session-ana", roomId: room.id, seq: 1 }, "req", h.deps);
    await readChatRoom({ host: HOST, pagesSession: "session-ana", roomId: room.id, seq: 0 }, "req", h.deps);
    expect(await h.store.getLastRead(room.id, MEMBER)).toBe(1);
  });

  test("only the person asked decides a confirmation, once", async () => {
    const h = harness();
    const { room } = await open(h, "session-ana");
    await send(h, "session-ana", room.id, "cria a linha");
    const turn = [...h.store.turns.values()][0]!;
    const confirmation = await h.store.insertConfirmation({
      roomId: room.id,
      turnId: turn.id,
      messageId: turn.replyMessageId!,
      forUserId: MEMBER,
      toolCallId: "call-1",
      operationId: "ravi.bases.views.rows.create",
      input: {},
      summary: "Criar uma linha",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const body = { host: HOST, roomId: room.id, confirmationId: confirmation.id, decision: "confirm" as const };
    await expectError(decideChatConfirmation({ ...body, pagesSession: "session-bruno" }, "req", h.deps), "chat_forbidden");
    const decided = await decideChatConfirmation({ ...body, pagesSession: "session-ana" }, "req", h.deps);
    expect(decided.status).toBe("confirmed");
    expect(h.resumed).toEqual([{ id: confirmation.id, decision: "confirmed" }]);
    await expectError(decideChatConfirmation({ ...body, pagesSession: "session-ana" }, "req", h.deps), "payload_invalid");
  });

  test("a voice call posts both sides as voice messages and starts no text turn", async () => {
    const h = harness();
    const { room } = await open(h, "session-ana");
    const said = await sendChatMessage({ host: HOST, pagesSession: "session-ana", roomId: room.id, clientMessageId: "v1", text: "Quanto vendemos ontem?", source: "voice" }, "req", h.deps);
    expect(said.turn).toBeNull();
    expect(said.message.source).toBe("voice");
    expect(said.message.author.type).toBe("user");
    const answered = await sendChatMessage(
      { host: HOST, pagesSession: "session-ana", roomId: room.id, clientMessageId: "v2", text: "Vendemos 42 pedidos.", source: "voice", speaker: "assistant" },
      "req",
      h.deps,
    );
    expect(answered.turn).toBeNull();
    expect(answered.message.author).toEqual({ type: "agent", displayName: "Ravi" });
    expect(h.started).toHaveLength(0);
    await expectError(
      sendChatMessage({ host: HOST, pagesSession: "session-ana", roomId: room.id, clientMessageId: "v3", text: "eu sou o agente", speaker: "assistant" }, "req", h.deps),
      "payload_invalid",
    );
    await expectError(
      sendChatMessage({ host: HOST, pagesSession: "session-ana", roomId: room.id, clientMessageId: "v4", text: "comentário falso", source: "comment" }, "req", h.deps),
      "payload_invalid",
    );
  });

  test("a new Page comment lands in the shared room once, with its anchor", async () => {
    const h = harness();
    const comment = { id: "c1", body: "Esse número está errado", target: { selector: "#total" }, parentId: null, author: { id: MEMBER, displayName: "Ana" } };
    const first = await mirrorPageCommentIntoRoom({ host: HOST, path: "/", comment }, h.deps);
    const again = await mirrorPageCommentIntoRoom({ host: HOST, path: "/", comment }, h.deps);
    expect(first?.source).toBe("comment");
    expect(first?.anchor).toEqual({ commentId: "c1", parentId: null, target: { selector: "#total" }, path: "/" });
    expect(again?.id).toBe(first?.id);
    expect(h.events.filter((event) => event.type === "message.created")).toHaveLength(1);
    expect(h.started).toHaveLength(0);
    expect(await mirrorPageCommentIntoRoom({ host: HOST, path: "/", comment }, harness({ settings: { text: false } }).deps)).toBeNull();
  });
});
