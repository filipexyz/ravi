import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { saveMessage } from "../../db.js";
import { LIBRARY_REQUEST_CHANNEL } from "../../library/request-channel.js";
import { dbUpsertChat, dbUpsertChatParticipant } from "../../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { chatIdsForContact } from "../contacts.js";
import { KNOWLEDGE_CURATOR_CHANNEL } from "../types.js";
import { setKnowledgeFts5ForcedOff } from "./db.js";
import { markSubjectForgotten } from "./forgotten.js";
import {
  deleteLocalRowsForChats,
  describeLocalRefs,
  indexLocalSources,
  localIndexStats,
  readLocal,
  searchLocal,
} from "./local-index.js";

let stateDir = "";

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-knowledge-index-");
});

afterEach(async () => {
  setKnowledgeFts5ForcedOff(false);
  await cleanupIsolatedRaviState(stateDir);
});

const ANA_JID = "5511999990001@s.whatsapp.net";
const BRUNO_JID = "5511999990002@s.whatsapp.net";

function dmChat(jid: string, contactId: string) {
  const chat = dbUpsertChat({ channel: "whatsapp", instanceId: "main", platformChatId: jid, chatType: "dm" });
  dbUpsertChatParticipant({ chatId: chat.id, contactId, source: "test" });
  return chat;
}

function writeTranscript(key: string, segments: Array<{ text: string; speaker?: string; startSec?: number }>) {
  const dir = join(stateDir, "meetings", key);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "transcription.json"),
    JSON.stringify({ meeting: { startedAt: "2026-10-01T12:00:00.000Z" }, segments }),
  );
}

for (const mode of ["fts5", "like"] as const) {
  describe(`local index (${mode})`, () => {
    beforeEach(() => {
      setKnowledgeFts5ForcedOff(mode === "like");
    });

    it("indexes once per message (idempotent watermark)", () => {
      saveMessage("dev-main", "user", "pagamento do boleto atrasado", null, { channel: "whatsapp", chatId: ANA_JID });
      saveMessage("dev-main", "assistant", "vou verificar o boleto", null, {
        agentId: "dev",
        channel: "whatsapp",
        chatId: ANA_JID,
      });
      expect(indexLocalSources().messages).toBe(2);
      expect(indexLocalSources().messages).toBe(0);
      saveMessage("dev-main", "user", "boleto pago", null, { channel: "whatsapp", chatId: ANA_JID });
      expect(indexLocalSources().messages).toBe(1);
      expect(searchLocal({ query: "boleto", limit: 10 })).toHaveLength(3);
      expect(localIndexStats().chatRows).toBe(3);
      const assistant = searchLocal({ query: "verificar", limit: 1 })[0];
      expect(assistant?.speaker).toBe("dev");
    });

    it("skips curator and Library request sessions and non-chat roles", () => {
      saveMessage("dev-curator", "user", "segredo do curador", null, { channel: KNOWLEDGE_CURATOR_CHANNEL });
      saveMessage("agent:dev:knowledge-curator:x", "user", "segredo pela chave", null, { channel: "whatsapp" });
      saveMessage("dev-library", "user", "segredo da biblioteca", null, { channel: LIBRARY_REQUEST_CHANNEL });
      saveMessage("dev-main", "user", "segredo normal", null, { channel: "whatsapp", chatId: ANA_JID });
      indexLocalSources();
      expect(searchLocal({ query: "segredo", limit: 10 }).map((hit) => hit.text)).toEqual(["segredo normal"]);
    });

    it("skips forgotten subjects, by chat and by contact", () => {
      dmChat(ANA_JID, "contact_ana");
      markSubjectForgotten({ scope: "contact", subjectId: "contact_ana" });
      markSubjectForgotten({ scope: "chat", subjectId: "group-x@g.us" });
      saveMessage("dev-ana", "user", "endereco da ana", null, { channel: "whatsapp", chatId: ANA_JID });
      saveMessage("dev-group", "user", "endereco do grupo", null, { channel: "whatsapp", chatId: "group-x@g.us" });
      saveMessage("dev-bruno", "user", "endereco do bruno", null, { channel: "whatsapp", chatId: BRUNO_JID });
      expect(indexLocalSources().messages).toBe(1);
      expect(searchLocal({ query: "endereco", limit: 10 }).map((hit) => hit.text)).toEqual(["endereco do bruno"]);
    });

    it("indexes local transcripts with start_sec and skips cloud meetings", () => {
      writeTranscript("2026-10-01-weekly", [
        { text: "precisamos revisar o cronograma", speaker: "Ana", startSec: 12.5 },
        { text: "concordo com o cronograma", speaker: "Bruno", startSec: 30 },
        { text: "proximo assunto", speaker: "Ana", startSec: 61 },
      ]);
      writeTranscript("cloud", [{ text: "cronograma da nuvem", speaker: "X", startSec: 1 }]);
      const result = indexLocalSources();
      expect(result.transcripts).toBe(3);
      expect(indexLocalSources().transcripts).toBe(0);
      const hits = searchLocal({ query: "cronograma", limit: 10 });
      expect(hits.map((hit) => hit.ref).sort()).toEqual(["kt:2026-10-01-weekly:0", "kt:2026-10-01-weekly:1"]);
      const first = hits.find((hit) => hit.ref === "kt:2026-10-01-weekly:0");
      expect(first?.startSec).toBe(12.5);
      expect(first?.speaker).toBe("Ana");
      expect(first?.kind).toBe("transcript");
      expect(searchLocal({ query: "cronograma", who: "bruno", limit: 10 }).map((hit) => hit.ref)).toEqual([
        "kt:2026-10-01-weekly:1",
      ]);
      const read = readLocal("kt:2026-10-01-weekly:1", 1);
      expect(read?.rows.map((row) => row.ref)).toEqual([
        "kt:2026-10-01-weekly:0",
        "kt:2026-10-01-weekly:1",
        "kt:2026-10-01-weekly:2",
      ]);
      expect(read?.rows.filter((row) => row.focus).map((row) => row.ref)).toEqual(["kt:2026-10-01-weekly:1"]);
      expect(localIndexStats().transcriptRows).toBe(3);
    });

    it("`about` restricts to the contact's DM chats (JID in chat.db, chats.id in participants)", () => {
      const ana = dmChat(ANA_JID, "contact_ana");
      dmChat(BRUNO_JID, "contact_bruno");
      // The participant row carries the semantic chats.id, never the JID.
      expect(ana.id).not.toBe(ANA_JID);
      saveMessage("dev-ana", "user", "proposta comercial da ana", null, { channel: "whatsapp", chatId: ANA_JID });
      saveMessage("dev-bruno", "user", "proposta comercial do bruno", null, {
        channel: "whatsapp",
        chatId: BRUNO_JID,
      });
      indexLocalSources();
      const chatIds = chatIdsForContact("contact_ana");
      expect(chatIds).toContain(ANA_JID);
      expect(chatIds).not.toContain(BRUNO_JID);
      const hits = searchLocal({ query: "proposta", about: { chatIds }, limit: 10 });
      expect(hits.map((hit) => hit.text)).toEqual(["proposta comercial da ana"]);
      expect(searchLocal({ query: "proposta", about: { chatIds: [] }, limit: 10 })).toEqual([]);
      expect(searchLocal({ query: "proposta", limit: 10 })).toHaveLength(2);
    });

    it("reads neighbours in the same session and deletes rows by chat", () => {
      saveMessage("dev-main", "user", "primeira mensagem", null, { channel: "whatsapp", chatId: ANA_JID });
      saveMessage("dev-other", "user", "outra sessao", null, { channel: "whatsapp", chatId: BRUNO_JID });
      saveMessage("dev-main", "assistant", "segunda mensagem", null, { channel: "whatsapp", chatId: ANA_JID });
      saveMessage("dev-main", "user", "terceira mensagem", null, { channel: "whatsapp", chatId: ANA_JID });
      indexLocalSources();
      const focus = searchLocal({ query: "segunda", limit: 1 })[0];
      expect(focus).toBeDefined();
      const read = readLocal(focus?.ref ?? "", 2);
      expect(read?.rows.map((row) => row.text)).toEqual(["primeira mensagem", "segunda mensagem", "terceira mensagem"]);
      expect(describeLocalRefs([focus?.ref ?? ""]).get(focus?.ref ?? "")?.text).toBe("");
      expect(deleteLocalRowsForChats([ANA_JID])).toBe(3);
      expect(searchLocal({ query: "mensagem", limit: 10 })).toEqual([]);
      expect(readLocal(focus?.ref ?? "", 0)).toBeNull();
    });
  });
}
