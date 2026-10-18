// Brief audit rows (contract §13.6): which items and marked sections a contact
// packet carried. Hashes and ids only, never text.

import { randomUUID } from "node:crypto";
import { executeWrite } from "../../db/write-retry.js";
import { getKnowledgeDb } from "../store/db.js";

export function insertKnowledgeBrief(
  input: {
    sessionName: string;
    agentId: string;
    contactId: string;
    packetHash: string;
    itemIds: string[];
    sectionIds: number[];
  },
  options: { now?: number } = {},
): void {
  const now = options.now ?? Date.now();
  executeWrite(
    getKnowledgeDb(),
    (db) => {
      db.prepare(
        `INSERT INTO knowledge_briefs (id, session_name, agent_id, contact_id, packet_hash, item_ids_json, section_ids_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        randomUUID(),
        input.sessionName,
        input.agentId,
        input.contactId,
        input.packetHash,
        JSON.stringify(input.itemIds),
        JSON.stringify(input.sectionIds),
        now,
      );
    },
    { label: "knowledge_brief_insert" },
  );
}
