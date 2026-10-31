import { randomUUID } from "node:crypto";
import { executeWrite } from "../db/write-retry.js";
import { getDb } from "../router/router-db.js";
import { DecisionError, normalizeDecisionKey, parseDecisionOwner } from "./model.js";
import type { Decision, DecisionAsk, DecisionOrigin } from "./types.js";

export interface DecisionRow {
  id: string;
  origin_type: DecisionOrigin["type"];
  origin_id: string;
  chat_id: string | null;
  session_key: string | null;
  key: string;
  status: Decision["status"];
  owner_type: Decision["ownerType"];
  owner_id: string | null;
  ask: string;
  asked_by: string | null;
  asked_at: number;
  answer: string | null;
  answered_by: string | null;
  answered_at: number | null;
  blocks: number;
  revision: number;
  created_at: number;
  updated_at: number;
}

export function decisionFromRow(row: DecisionRow): Decision {
  return {
    id: row.id,
    origin: { type: row.origin_type, id: row.origin_id, chatId: row.chat_id, sessionKey: row.session_key },
    key: row.key,
    status: row.status,
    ownerType: row.owner_type,
    ownerId: row.owner_id,
    ask: row.ask,
    askedBy: row.asked_by,
    askedAt: row.asked_at,
    answer: row.answer,
    answeredBy: row.answered_by,
    answeredAt: row.answered_at,
    blocks: row.blocks === 1,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getDecision(id: string): Decision | null {
  const row = getDb().query("SELECT * FROM decisions WHERE id=?").get(id) as DecisionRow | null;
  return row ? decisionFromRow(row) : null;
}

export function listDecisions(origin?: Pick<DecisionOrigin, "type" | "id">, openOnly = false): Decision[] {
  const where = ["1=1"];
  const params: string[] = [];
  if (origin) {
    where.push("origin_type=? AND origin_id=?");
    params.push(origin.type, origin.id);
  }
  if (openOnly) where.push("status='open'");
  return (
    getDb()
      .query(`SELECT * FROM decisions WHERE ${where.join(" AND ")} ORDER BY status='open' DESC,asked_at,id`)
      .all(...params) as DecisionRow[]
  ).map(decisionFromRow);
}

export function validateDecisionAsk(input: DecisionAsk): DecisionAsk {
  const key = normalizeDecisionKey(input.key);
  const ask = input.ask?.trim();
  if (!ask) throw new DecisionError("DECISION_INVALID_ASK", "A non-empty question is required.", { exitCode: 2 });
  const owner = parseDecisionOwner(
    input.ownerType && input.ownerType !== "unassigned" ? `${input.ownerType}:${input.ownerId ?? ""}` : "unassigned",
  );
  return { ...input, ...owner, key, ask };
}

export function validateDecisionAnswer(answer: string): string {
  const text = answer?.trim();
  if (!text) throw new DecisionError("DECISION_INVALID_ANSWER", "A non-empty answer is required.", { exitCode: 2 });
  return text;
}

export function askDecisionRecord(origin: DecisionOrigin, raw: DecisionAsk): { decision: Decision; created: boolean } {
  const input = validateDecisionAsk(raw);
  return decisionWrite((db) => {
    const existing = listDecisions(origin, true).find((d) => d.key === input.key);
    if (existing && (existing.origin.chatId !== origin.chatId || existing.origin.sessionKey !== origin.sessionKey))
      throw new DecisionError("DECISION_ORIGIN_MISMATCH", "Decision origin changed.");
    const now = Date.now();
    const id = existing?.id ?? `dec_${randomUUID().replaceAll("-", "")}`;
    if (
      existing &&
      existing.ask === input.ask &&
      existing.ownerType === input.ownerType &&
      existing.ownerId === (input.ownerId ?? null) &&
      existing.blocks === Boolean(input.blocks)
    ) {
      return { decision: existing, created: false };
    }
    if (existing) {
      db.query(
        "UPDATE decisions SET ask=?,owner_type=?,owner_id=?,blocks=?,updated_at=?,revision=revision+1 WHERE id=?",
      ).run(input.ask, input.ownerType!, input.ownerId ?? null, input.blocks ? 1 : 0, now, id);
    } else {
      db.query(`INSERT INTO decisions(id,origin_type,origin_id,chat_id,session_key,key,status,owner_type,owner_id,ask,asked_by,asked_at,blocks,created_at,updated_at)
        VALUES (?,?,?,?,?,?,'open',?,?,?,?,?,?,?,?)`).run(
        id,
        origin.type,
        origin.id,
        origin.chatId,
        origin.sessionKey,
        input.key,
        input.ownerType!,
        input.ownerId ?? null,
        input.ask,
        input.actor ?? null,
        now,
        input.blocks ? 1 : 0,
        now,
        now,
      );
    }
    const decision = getDecision(id)!;
    appendHistory(decision, "asked", input.actor);
    if (origin.type === "thread") enqueueDelivery(decision, "question");
    return { decision, created: !existing };
  });
}

export function answerDecisionRecord(id: string, raw: string, actor?: string): Decision {
  const answer = validateDecisionAnswer(raw);
  return decisionWrite((db) => {
    const old = getDecision(id);
    if (!old) throw new DecisionError("DECISION_NOT_FOUND", "Decision not found.");
    if (old.status !== "open") throw new DecisionError("DECISION_NOT_OPEN", "Answered decisions are immutable.");
    const now = Date.now();
    db.query(
      "UPDATE decisions SET status='answered',answer=?,answered_by=?,answered_at=?,updated_at=?,revision=revision+1 WHERE id=? AND status='open'",
    ).run(answer, actor ?? null, now, now, id);
    const decision = getDecision(id)!;
    appendHistory(decision, "answered", actor);
    if (old.origin.type === "thread") enqueueDelivery(decision, "answer");
    return decision;
  });
}

function appendHistory(decision: Decision, type: "asked" | "answered", actor?: string): void {
  getDb()
    .query("INSERT INTO decision_history(decision_id,type,actor,snapshot_json,created_at) VALUES (?,?,?,?,?)")
    .run(decision.id, type, actor ?? null, JSON.stringify(decision), Date.now());
}

function enqueueDelivery(decision: Decision, kind: "question" | "answer"): void {
  getDb()
    .query("INSERT INTO decision_deliveries(id,decision_id,kind,revision,created_at) VALUES (?,?,?,?,?)")
    .run(`decision:${decision.id}:${kind}:${decision.revision}`, decision.id, kind, decision.revision, Date.now());
}

export function decisionWrite<T>(fn: (db: ReturnType<typeof getDb>) => T): T {
  const db = getDb();
  return db.inTransaction ? fn(db) : executeWrite(db, fn);
}
