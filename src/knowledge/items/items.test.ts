import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ContractError } from "../../cli/agent-contract.js";
import { saveMessage } from "../../db.js";
import { dbUpsertChat, dbUpsertChatParticipant } from "../../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { DAEMON_KNOWLEDGE_TURN } from "../client.js";
import { getKnowledgeDb } from "../store/db.js";
import { isSubjectForgotten } from "../store/forgotten.js";
import { indexLocalSources, searchLocal } from "../store/local-index.js";
import type { KnowledgeTurn } from "../types.js";
import { confirmKnowledgeDraft, forgetKnowledge, knowledgeItemKey, rememberKnowledgeItem } from "./remember.js";
import { getKnowledgeItem, insertKnowledgeItem, listActiveItemsForSubject } from "./store.js";

let stateDir = "";

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-knowledge-items-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
});

const TERMINAL: KnowledgeTurn = DAEMON_KNOWLEDGE_TURN;
const OWNER_DM: KnowledgeTurn = {
  ...DAEMON_KNOWLEDGE_TURN,
  turnKey: "turn-1",
  sessionName: "dev-luis",
  agentId: "dev",
};
const ANA = { kind: "contact" as const, id: "contact_ana" };
const ANA_JID = "5511999990001@s.whatsapp.net";

function contractCode(run: () => unknown): { code: string; exitCode: number } | null {
  try {
    run();
    return null;
  } catch (error) {
    if (error instanceof ContractError) return { code: error.code, exitCode: error.exitCode };
    throw error;
  }
}

function said(body: string, key: string) {
  return insertKnowledgeItem({
    scope: "contact",
    subjectId: ANA.id,
    agentId: null,
    kind: "fact",
    key,
    body,
    status: "active",
    trust: "said",
    speaker: "contact",
    recordedAt: Date.now(),
    expiresAt: null,
    supersededBy: null,
    createdBy: "curator",
    sources: [{ kind: "message", ref: "km:1", textHash: "h", span: body }],
  });
}

describe("remember", () => {
  it("is active at once on the terminal", () => {
    const result = rememberKnowledgeItem({ text: "Prefere áudio curto", about: ANA, turn: TERMINAL });
    expect(result.activated).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.item.status).toBe("active");
    expect(result.item.trust).toBe("approved");
    expect(result.item.speaker).toBe("operator");
    expect(result.item.key).toBe("prefere-audio-curto");
    expect(knowledgeItemKey("Um dois três quatro cinco seis sete")).toBe("um-dois-tres-quatro-cinco-seis");
  });

  it("is active on the owner's DM when the text is in the newest user message's own words", () => {
    saveMessage(
      "dev-luis",
      "user",
      "[WhatsApp +5511999 Luis mid:1 16/10/2026, 14:32 fri] lembra: a Ana prefere áudio curto",
      null,
      {},
    );
    const result = rememberKnowledgeItem({ text: "a ana prefere AUDIO curto", about: ANA, turn: OWNER_DM });
    expect(result.activated).toBe(true);
    expect(result.item.status).toBe("active");
  });

  it("becomes a draft when the text is only in a quote or a transcript", () => {
    saveMessage(
      "dev-luis",
      "user",
      "[WhatsApp +5511999 Luis mid:1 16/10/2026, 14:32 fri]\n[Replying to Ana mid:0]\nprefiro pix sempre\n[/Replying]\nanota isso",
      null,
      {},
    );
    const quoted = rememberKnowledgeItem({ text: "prefiro pix sempre", about: ANA, turn: OWNER_DM });
    expect(quoted.activated).toBe(false);
    expect(quoted.item.status).toBe("draft");
    expect(quoted.reason).toBe("not in the operator's own words");
    expect(quoted.item.expiresAt).toBeGreaterThan(Date.now() + 6 * 24 * 3600_000);

    saveMessage(
      "dev-luis",
      "user",
      "[WhatsApp +5511999 Luis mid:2 16/10/2026, 14:33 fri] [Audio]\nTranscript:\nentrega só de manhã\nfile: /tmp/a.ogg",
      null,
      {},
    );
    const transcript = rememberKnowledgeItem({ text: "entrega só de manhã", about: ANA, turn: OWNER_DM });
    expect(transcript.activated).toBe(false);
  });

  it("confirms a draft only from the terminal", () => {
    const draft = rememberKnowledgeItem({ text: "cliente desde 2019", about: ANA, turn: OWNER_DM }).item;
    expect(draft.status).toBe("draft");
    expect(contractCode(() => confirmKnowledgeDraft({ id: draft.id, turn: OWNER_DM }))).toEqual({
      code: "KNOWLEDGE_TURN_NOT_OPERATOR",
      exitCode: 3,
    });
    expect(getKnowledgeItem(draft.id)?.status).toBe("draft");
    const confirmed = confirmKnowledgeDraft({ id: `ki:${draft.id}`, turn: TERMINAL });
    expect(confirmed.status).toBe("active");
    expect(confirmed.expiresAt).toBeNull();
    expect(contractCode(() => confirmKnowledgeDraft({ id: "nope", turn: TERMINAL }))?.code).toBe("KNOWLEDGE_NOT_FOUND");
  });

  it("supersedes the same-key item, but a said item never supersedes an approved one", () => {
    const first = rememberKnowledgeItem({ text: "prefere email", key: "canal", about: ANA, turn: TERMINAL }).item;
    const second = rememberKnowledgeItem({ text: "prefere whatsapp", key: "canal", about: ANA, turn: TERMINAL }).item;
    expect(getKnowledgeItem(first.id)?.status).toBe("archived");
    expect(getKnowledgeItem(first.id)?.supersededBy).toBe(second.id);

    const fromCurator = said("prefere telefone", "canal");
    expect(fromCurator.status).toBe("draft");
    expect(getKnowledgeItem(second.id)?.status).toBe("active");
    expect(
      listActiveItemsForSubject({ scope: "contact", subjectId: ANA.id, agentId: "dev", limit: 10 }).map((i) => i.body),
    ).toEqual(["prefere whatsapp"]);

    // said over said supersedes.
    const a = said("gosta de café", "bebida");
    const b = said("gosta de chá", "bebida");
    expect(getKnowledgeItem(a.id)?.supersededBy).toBe(b.id);
  });

  it("refuses empty text and a missing subject", () => {
    expect(contractCode(() => rememberKnowledgeItem({ text: "  ", about: ANA, turn: TERMINAL }))?.exitCode).toBe(2);
    expect(
      contractCode(() => rememberKnowledgeItem({ text: "x", about: { kind: "contact", id: "" }, turn: TERMINAL }))
        ?.exitCode,
    ).toBe(2);
  });
});

describe("forget", () => {
  it("--about archives the items, deletes the contact's FTS rows (JID chat ids) and records the subject", () => {
    const chat = dbUpsertChat({ channel: "whatsapp", instanceId: "main", platformChatId: ANA_JID, chatType: "dm" });
    dbUpsertChatParticipant({ chatId: chat.id, contactId: ANA.id, source: "test" });
    saveMessage("dev-ana", "user", "meu endereco e rua das flores", null, { channel: "whatsapp", chatId: ANA_JID });
    saveMessage("dev-ana", "assistant", "anotei o endereco", null, {
      agentId: "dev",
      channel: "whatsapp",
      chatId: ANA_JID,
    });
    saveMessage("dev-bruno", "user", "endereco do bruno", null, {
      channel: "whatsapp",
      chatId: "5511999990002@s.whatsapp.net",
    });
    indexLocalSources();
    expect(searchLocal({ query: "endereco", limit: 10 })).toHaveLength(3);
    const item = rememberKnowledgeItem({ text: "mora na rua das flores", about: ANA, turn: TERMINAL }).item;

    const result = forgetKnowledge({ about: ANA, redact: false });
    expect(result).toEqual({ archived: 1, redacted: 0, ftsRowsDeleted: 2 });
    expect(getKnowledgeItem(item.id)?.status).toBe("archived");
    expect(isSubjectForgotten(ANA.id)).toBe(true);
    const db = getKnowledgeDb();
    const ftsRows = db
      .prepare(
        "SELECT COUNT(*) AS n FROM knowledge_local_fts f JOIN knowledge_local_docs d ON d.id = f.rowid WHERE d.chat_id = ?",
      )
      .get(ANA_JID) as { n: number };
    expect(ftsRows.n).toBe(0);
    const docs = db.prepare("SELECT COUNT(*) AS n FROM knowledge_local_docs WHERE chat_id = ?").get(ANA_JID) as {
      n: number;
    };
    expect(docs.n).toBe(0);
    expect(searchLocal({ query: "endereco", limit: 10 }).map((hit) => hit.text)).toEqual(["endereco do bruno"]);

    // A later message of the forgotten contact is never indexed again.
    saveMessage("dev-ana", "user", "novo endereco", null, { channel: "whatsapp", chatId: ANA_JID });
    indexLocalSources();
    expect(searchLocal({ query: "novo", limit: 10 })).toEqual([]);
  });

  it("--redact leaves [redacted] tombstones and clears spans", () => {
    const item = said("prefere áudio curto", "audio");
    const result = forgetKnowledge({ about: ANA, redact: true });
    expect(result.redacted).toBe(1);
    const tomb = getKnowledgeItem(item.id);
    expect(tomb?.status).toBe("redacted");
    expect(tomb?.body).toBe("[redacted]");
    expect(tomb?.key).toBe("[redacted]");
    const span = getKnowledgeDb().prepare("SELECT span FROM knowledge_item_sources WHERE item_id = ?").get(item.id) as {
      span: string | null;
    };
    expect(span.span).toBeNull();
  });

  it("forgets one item by id and refuses an unknown id", () => {
    const item = said("gosta de café", "bebida");
    expect(forgetKnowledge({ id: `ki:${item.id}`, redact: false })).toEqual({
      archived: 1,
      redacted: 0,
      ftsRowsDeleted: 0,
    });
    expect(getKnowledgeItem(item.id)?.status).toBe("archived");
    expect(contractCode(() => forgetKnowledge({ id: "missing", redact: false }))?.code).toBe("KNOWLEDGE_NOT_FOUND");
    expect(contractCode(() => forgetKnowledge({ redact: false }))?.exitCode).toBe(2);
  });
});
