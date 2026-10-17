import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { configStore } from "../../config-store.js";
import { dbCreateAgent, dbSetSetting, dbUpdateAgent, dbUpsertInstance, getDb } from "../../router/router-db.js";
import type { ResponseMessage } from "../../runtime/message-types.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { saveMessage } from "../../db.js";
import { listGapsByStatus } from "../gaps/store.js";
import { replaceMarkedPages } from "../mirror/store.js";
import { closeKnowledgeDb, getKnowledgeDbPath } from "../store/db.js";
import {
  type EgressGuardContext,
  type GuardedSession,
  guardedSessionForChat,
  guardedSessionForInstanceChat,
  guardEgressText,
  guardTextForGuardedSession,
  isGuardedSession,
  normalizeOutboundJid,
  REMOVED_LINK_TEXT,
  upsertGuardedSession,
} from "./guard.js";
import { existsSync } from "node:fs";

const OMNI_UUID = "11111111-2222-4333-8444-555555555555";
const CHAT = "5511999990000@s.whatsapp.net";

function ctx(overrides: Partial<EgressGuardContext> = {}): EgressGuardContext {
  return {
    instanceId: "wa-main",
    allowHosts: null,
    raviHosts: [],
    markedUrls: [{ host: "acme.ravi.page", path: "/politica" }],
    ...overrides,
  };
}

function guardRow(overrides: Partial<GuardedSession> = {}): GuardedSession {
  return {
    sessionName: "kagent-dm-1",
    agentId: "kagent",
    instanceId: "wa-main",
    channel: "whatsapp",
    chatId: CHAT,
    normalizedChatId: normalizeOutboundJid(CHAT),
    contactId: "contact-1",
    guardedUntil: Date.now() + 30 * 60_000,
    ...overrides,
  };
}

describe("guardEgressText", () => {
  it("replaces an unmarked Ravi page with the removed-link text", () => {
    const result = guardEgressText("veja https://acme.ravi.page/x agora", ctx());
    expect(result.text).toBe(`veja ${REMOVED_LINK_TEXT} agora`);
    expect(result.removed).toEqual(["https://acme.ravi.page/x"]);
  });

  it("keeps a marked URL, with or without a fragment", () => {
    for (const text of [
      "https://acme.ravi.page/politica",
      "https://acme.ravi.page/politica#trocas",
      "https://acme.ravi.page/politica/",
    ]) {
      expect(guardEgressText(`leia ${text}.`, ctx())).toEqual({ text: `leia ${text}.`, removed: [] });
    }
  });

  it("treats a query on a marked page as unmarked", () => {
    expect(guardEgressText("https://acme.ravi.page/politica?x=1", ctx()).text).toBe(REMOVED_LINK_TEXT);
  });

  it("handles a bare domain, a Slack link and a Markdown link", () => {
    expect(guardEgressText("acesse acme.ravi.page/x", ctx()).text).toBe(`acesse ${REMOVED_LINK_TEXT}`);
    expect(guardEgressText("<https://acme.ravi.page/x|aqui>", ctx()).text).toBe(REMOVED_LINK_TEXT);
    expect(guardEgressText("[aqui](https://acme.ravi.page/x)", ctx()).text).toBe(REMOVED_LINK_TEXT);
    expect(guardEgressText("<https://acme.ravi.page/politica|aqui>", ctx()).removed).toEqual([]);
    expect(guardEgressText("[aqui](https://acme.ravi.page/politica)", ctx()).removed).toEqual([]);
  });

  it("catches a bare domain whatever precedes it, with a port, a path or a query", () => {
    const allow = ctx({ allowHosts: ["acme.com"] });
    for (const text of [
      "x/evil.example/a",
      "ftp://evil.example",
      "_evil.example",
      "evil.example:8080/a",
      "evil.example?q=1",
      "(evil.example)",
    ]) {
      expect(guardEgressText(text, allow).removed).toHaveLength(1);
    }
    expect(guardEgressText("acme.ravi.page:8443/politica", ctx()).text).toBe(REMOVED_LINK_TEXT);
    expect(guardEgressText("acme.ravi.page/politica", ctx()).removed).toEqual([]);
    expect(guardEgressText("joao.silva@evil.example", allow).removed).toEqual([]);
  });

  it("removes images", () => {
    const result = guardEgressText("foto: ![logo](https://example.com/a.png) ok", ctx());
    expect(result.text).toBe("foto: ok");
    expect(result.removed).toHaveLength(1);
  });

  it("restricts other hosts to the allow list when one is set", () => {
    const allow = ctx({ allowHosts: ["acme.com"] });
    expect(guardEgressText("https://acme.com/a e https://www.acme.com", allow).removed).toEqual([]);
    expect(guardEgressText("https://evil.example/a", allow).text).toBe(REMOVED_LINK_TEXT);
    expect(guardEgressText("https://evil.example/a", ctx()).removed).toEqual([]);
  });

  it("always removes console.ravi.bot and unmarked links on a mirrored Ravi host", () => {
    const withHosts = ctx({ raviHosts: ["docs.acme.com"] });
    expect(guardEgressText("https://console.ravi.bot/x", withHosts).text).toBe(REMOVED_LINK_TEXT);
    expect(guardEgressText("https://docs.acme.com/secret", withHosts).text).toBe(REMOVED_LINK_TEXT);
  });

  it("leaves plain text and emails alone", () => {
    expect(guardEgressText("Oi, tudo bem? Me escreve em joao@acme.com", ctx({ allowHosts: [] })).removed).toEqual([]);
  });
});

describe("guard rows", () => {
  let stateDir: string | null = null;

  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-knowledge-guard-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("finds nothing and never creates knowledge.db when the file does not exist", () => {
    expect(isGuardedSession("kagent-dm-1")).toBeNull();
    expect(guardedSessionForChat("whatsapp", CHAT)).toBeNull();
    expect(guardedSessionForInstanceChat(OMNI_UUID, CHAT)).toBeNull();
    expect(existsSync(getKnowledgeDbPath())).toBe(false);
  });

  it("looks rows up by session, by chat and by Omni UUID plus normalized JID", () => {
    dbUpsertInstance({ name: "wa-main", instanceId: OMNI_UUID, channel: "whatsapp" });
    upsertGuardedSession(guardRow());
    closeKnowledgeDb();
    expect(isGuardedSession("kagent-dm-1")?.instanceId).toBe("wa-main");
    expect(guardedSessionForChat("whatsapp", CHAT)?.sessionName).toBe("kagent-dm-1");
    expect(guardedSessionForChat("slack", CHAT)).toBeNull();
    expect(guardedSessionForInstanceChat(OMNI_UUID, CHAT)?.sessionName).toBe("kagent-dm-1");
    expect(guardedSessionForInstanceChat("99999999-2222-4333-8444-555555555555", CHAT)).toBeNull();
  });

  it("ignores expired rows", () => {
    upsertGuardedSession(guardRow({ guardedUntil: Date.now() - 1 }));
    expect(isGuardedSession("kagent-dm-1")).toBeNull();
  });

  it("matches a mirror page keyed by the instance name, not the Omni UUID", () => {
    replaceMarkedPages(
      {
        raviHosts: ["acme.ravi.page"],
        pages: [
          {
            routeId: "r1",
            url: "https://acme.ravi.page/politica",
            host: "acme.ravi.page",
            path: "/politica",
            title: "Política",
            documentId: "d1",
            version: 3,
            approvedAt: null,
            instances: ["wa-main"],
            sections: [],
          },
        ],
      },
      Date.now(),
    );
    const guarded = guardRow();
    expect(guardTextForGuardedSession("https://acme.ravi.page/politica#a", guarded).removed).toEqual([]);
    expect(
      guardTextForGuardedSession("https://acme.ravi.page/politica", guardRow({ instanceId: OMNI_UUID })).text,
    ).toBe(REMOVED_LINK_TEXT);
  });

  it("uses the knowledge.egress.allow setting for other hosts", () => {
    dbSetSetting("knowledge.egress.allow", JSON.stringify({ "wa-main": ["acme.com"] }));
    expect(guardTextForGuardedSession("https://acme.com e https://evil.example", guardRow()).text).toBe(
      `https://acme.com e ${REMOVED_LINK_TEXT}`,
    );
  });

  it("fails closed when the settings or the mirror cannot be read", () => {
    const failing = () => {
      throw new Error("boom");
    };
    const result = guardTextForGuardedSession("https://acme.com", guardRow(), {
      allowHosts: failing,
      raviHosts: failing,
      markedUrls: failing,
    });
    expect(result.text).toBe(REMOVED_LINK_TEXT);
  });
});

// ---------------------------------------------------------------------------
// Gateway entry points

describe("gateway egress", () => {
  let stateDir: string | null = null;

  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-knowledge-gateway-egress-");
    dbUpsertInstance({ name: "wa-main", instanceId: OMNI_UUID, channel: "whatsapp" });
    dbCreateAgent({ id: "kagent", cwd: "/tmp/kagent" });
    dbUpdateAgent("kagent", { defaults: { tts_auto: true } });
    const now = Date.now();
    getDb()
      .prepare(
        "INSERT OR IGNORE INTO sessions (session_key, name, agent_id, agent_cwd, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("agent:kagent:dm:contact-1", "kagent-dm-1", "kagent", "/tmp/kagent", now, now);
    configStore.refresh();
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  async function makeGateway() {
    const { Gateway } = await import("../../gateway.js");
    const emitted: Array<[string, Record<string, unknown>]> = [];
    const send = mock(async (_instance: string, _to: string, _text: string, _options?: unknown) => ({
      messageId: "omni-1",
    }));
    const sendMedia = mock(async (..._args: unknown[]) => ({ messageId: "omni-media-1" }));
    const editMessage = mock(async (_instance: string, _to: string, _id: string, _text: string) => {});
    const gateway = new Gateway({
      omniSender: {
        send,
        sendMedia,
        editMessage,
        sendTyping: mock(async () => {}),
        sendReaction: mock(async () => {}),
        deleteMessage: mock(async () => {}),
        sendSticker: mock(async () => ({})),
        markRead: mock(async () => {}),
      } as never,
      omniConsumer: {
        getActiveTarget: () => undefined,
        clearActiveTarget: () => {},
        renewActiveTarget: mock(async () => false),
      } as never,
      emitEvent: mock(async (topic: string, payload: Record<string, unknown>) => {
        emitted.push([topic, payload]);
      }),
    });
    const internals = gateway as unknown as {
      handleResponseEvent(sessionName: string, response: ResponseMessage): Promise<void>;
      handleDirectSendEvent(data: Record<string, unknown>): Promise<void>;
      handleMessageEditEvent(data: Record<string, unknown>): Promise<void>;
      handleMediaSendEvent(data: Record<string, unknown>): Promise<void>;
    };
    return { gateway: internals, emitted, send, sendMedia, editMessage };
  }

  const target = { channel: "whatsapp", accountId: "wa-main", chatId: CHAT };

  it("guards every response part before delivery and before TTS", async () => {
    upsertGuardedSession(guardRow());
    const { gateway, emitted, send } = await makeGateway();
    await gateway.handleResponseEvent("kagent-dm-1", {
      _emitId: "emit-1",
      response: "Veja https://acme.ravi.page/segredo",
      target,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[2]).toBe(`Veja ${REMOVED_LINK_TEXT}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const tts = emitted.find(([topic]) => topic === "ravi.tts");
    expect(tts?.[1].text).toBe(`Veja ${REMOVED_LINK_TEXT}`);
  });

  it("keeps unguarded sessions unchanged, markers included", async () => {
    const { gateway, send } = await makeGateway();
    await gateway.handleResponseEvent("kagent-dm-1", {
      _emitId: "emit-2",
      response: "Veja https://acme.ravi.page/segredo ⟦gap⟧",
      target,
    });
    expect(send.mock.calls[0]?.[2]).toBe("Veja https://acme.ravi.page/segredo ⟦gap⟧");
  });

  it('delivers "Vou confirmar ⟦gap⟧" as "Vou confirmar" and records the contact\'s question', async () => {
    upsertGuardedSession(guardRow());
    saveMessage(
      "kagent-dm-1",
      "user",
      "[WhatsApp +5511999990000 Maria mid:1 16/10/2026, 14:32 fri] Tem desconto?",
      null,
    );
    const { gateway, send } = await makeGateway();
    await gateway.handleResponseEvent("kagent-dm-1", { _emitId: "emit-5", response: "Vou confirmar ⟦gap⟧", target });
    expect(send.mock.calls[0]?.[2]).toBe("Vou confirmar");
    expect(listGapsByStatus("pending", 10).map((gap) => gap.question)).toEqual(["Tem desconto?"]);
  });

  it("strips markers and drops a reply that was only a marker", async () => {
    upsertGuardedSession(guardRow());
    const { gateway, send, emitted } = await makeGateway();
    await gateway.handleResponseEvent("kagent-dm-1", { _emitId: "emit-3", response: "⟦forget⟧", target });
    expect(send).not.toHaveBeenCalled();
    expect(emitted.some(([, payload]) => payload.status === "dropped")).toBe(true);
    // ⟦forget⟧ keeps a guard-only row: links and markers stay guarded in this DM.
    expect(isGuardedSession("kagent-dm-1")?.contactId).toBe("contact-1");
  });

  it("drops the curator channel", async () => {
    const { gateway, send, emitted } = await makeGateway();
    await gateway.handleResponseEvent("kagent-dm-1", {
      _emitId: "emit-4",
      response: "{}",
      target: { channel: "knowledge-curator", accountId: "", chatId: "x" },
    });
    expect(send).not.toHaveBeenCalled();
    expect(emitted.some(([, payload]) => payload.reason === "knowledge_curator")).toBe(true);
  });

  it("guards direct sends, polls, media captions and message edits", async () => {
    upsertGuardedSession(guardRow());
    const { gateway, send, sendMedia, editMessage } = await makeGateway();
    await gateway.handleDirectSendEvent({
      channel: "whatsapp",
      accountId: "wa-main",
      to: CHAT,
      text: "https://acme.ravi.page/x",
    });
    await gateway.handleDirectSendEvent({
      channel: "whatsapp",
      accountId: "wa-main",
      to: CHAT,
      poll: { name: "Qual? https://acme.ravi.page/a", values: ["https://acme.ravi.page/b", "outro"] },
    });
    await gateway.handleMediaSendEvent({
      channel: "whatsapp",
      accountId: "wa-main",
      chatId: CHAT,
      filePath: "/tmp/none.png",
      mimetype: "image/png",
      type: "image",
      filename: "none.png",
      caption: "https://acme.ravi.page/c",
    });
    await gateway.handleMessageEditEvent({
      channel: "whatsapp",
      accountId: "wa-main",
      chatId: CHAT,
      messageId: "m1",
      text: "corrigido: https://acme.ravi.page/d",
    });
    expect(send.mock.calls[0]?.[2]).toBe(REMOVED_LINK_TEXT);
    expect(send.mock.calls[1]?.[2]).toBe(`Qual? ${REMOVED_LINK_TEXT}\n1. ${REMOVED_LINK_TEXT}\n2. outro`);
    expect(sendMedia.mock.calls[0]?.[5]).toBe(REMOVED_LINK_TEXT);
    expect(editMessage.mock.calls[0]?.[3]).toBe(`corrigido: ${REMOVED_LINK_TEXT}`);
  });

  it("guards a TTS request bound to a guarded session", async () => {
    upsertGuardedSession(guardRow());
    const { guardKnowledgeTtsRequest } = await import("../../gateway.js");
    expect(guardKnowledgeTtsRequest({ text: "https://acme.ravi.page/x", sessionName: "kagent-dm-1" })).toEqual({
      text: REMOVED_LINK_TEXT,
      sessionName: "kagent-dm-1",
    });
    expect(guardKnowledgeTtsRequest({ text: "https://acme.ravi.page/x", sessionName: "other" })).toEqual({
      text: "https://acme.ravi.page/x",
      sessionName: "other",
    });
  });
});
