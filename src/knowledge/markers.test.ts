import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { saveMessage } from "../db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { type GuardedSession, isGuardedSession, upsertGuardedSession } from "./egress/guard.js";
import { listGapsByStatus } from "./gaps/store.js";
import { extractKnowledgeMarkers, FORGET_MARKER, GAP_MARKER, handleKnowledgeMarkers } from "./markers.js";

const CHAT = "5511999990000@s.whatsapp.net";

function guardRow(overrides: Partial<GuardedSession> = {}): GuardedSession {
  return {
    sessionName: "kagent-dm-1",
    agentId: "kagent",
    instanceId: "wa-main",
    channel: "whatsapp",
    chatId: CHAT,
    normalizedChatId: CHAT,
    contactId: "contact-1",
    guardedUntil: Date.now() + 30 * 60_000,
    ...overrides,
  };
}

describe("extractKnowledgeMarkers", () => {
  it("strips markers wherever they appear", () => {
    expect(extractKnowledgeMarkers(`Vou confirmar ${GAP_MARKER}`)).toEqual({
      text: "Vou confirmar",
      gap: true,
      forget: false,
    });
    expect(extractKnowledgeMarkers(`Pronto. ${FORGET_MARKER}\n`)).toEqual({
      text: "Pronto.",
      gap: false,
      forget: true,
    });
    expect(extractKnowledgeMarkers(GAP_MARKER).text).toBe("");
    expect(extractKnowledgeMarkers("sem marcador ")).toEqual({ text: "sem marcador ", gap: false, forget: false });
  });
});

describe("handleKnowledgeMarkers", () => {
  let stateDir: string | null = null;

  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-knowledge-markers-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  const target = { channel: "whatsapp", accountId: "wa-main", chatId: CHAT };

  it("inserts a gap whose question is the contact's own last authored text", async () => {
    upsertGuardedSession(guardRow());
    saveMessage(
      "kagent-dm-1",
      "user",
      "[WhatsApp +5511999990000 Maria mid:1 16/10/2026, 14:32 fri]\n[Replying to Loja mid:0]\ncitado\n[/Replying]\nVocês dão desconto pra ONG?",
      null,
    );
    saveMessage("kagent-dm-1", "assistant", "Vou confirmar", null);
    await handleKnowledgeMarkers({ sessionName: "kagent-dm-1", target, gap: true, forget: false });
    const gaps = listGapsByStatus("pending", 10);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({
      question: "Vocês dão desconto pra ONG?",
      instanceId: "wa-main",
      contactId: "contact-1",
      agentId: "kagent",
    });
  });

  it("forgets with redact, drops the contact's open gaps and keeps a guard-only row", async () => {
    upsertGuardedSession(guardRow({ guardedUntil: Date.now() + 1000 }));
    const forget = mock(() => ({ archived: 0, redacted: 2, ftsRowsDeleted: 3 }));
    const dropGaps = mock(() => 1);
    await handleKnowledgeMarkers(
      { sessionName: "kagent-dm-1", target, gap: false, forget: true },
      { forget, dropGaps },
    );
    expect(forget).toHaveBeenCalledWith({ about: { kind: "contact", id: "contact-1" }, redact: true });
    expect(dropGaps).toHaveBeenCalledWith("contact-1");
    // The link guard and marker stripping still apply to this DM.
    const kept = isGuardedSession("kagent-dm-1");
    expect(kept?.contactId).toBe("contact-1");
    expect(kept?.guardedUntil ?? 0).toBeGreaterThan(Date.now() + 25 * 60_000);
  });

  it("keeps no gap for a forgotten contact", async () => {
    upsertGuardedSession(guardRow());
    const insertGap = mock(() => {
      throw new Error("must not run");
    });
    await handleKnowledgeMarkers(
      { sessionName: "kagent-dm-1", target, gap: true, forget: false },
      { insertGap, lastContactText: () => "pergunta", isForgotten: () => true },
    );
    expect(insertGap).not.toHaveBeenCalled();
  });

  it("does nothing for unguarded sessions and never throws", async () => {
    const insertGap = mock(() => {
      throw new Error("boom");
    });
    await handleKnowledgeMarkers({ sessionName: "other", target, gap: true, forget: true }, { insertGap });
    expect(insertGap).not.toHaveBeenCalled();
    upsertGuardedSession(guardRow());
    await handleKnowledgeMarkers(
      { sessionName: "kagent-dm-1", target, gap: true, forget: false },
      { insertGap, lastContactText: () => "pergunta" },
    );
    expect(insertGap).toHaveBeenCalledTimes(1);
  });
});
