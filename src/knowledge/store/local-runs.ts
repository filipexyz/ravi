// Local runs (`kl:<id>`, contract §10.5): which refs a `ravi knowledge`
// search or read returned, for `ravi knowledge why`. Refs, tiers, a query hash
// and issue codes only; never the query or any text.

import { randomUUID } from "node:crypto";
import { executeWrite } from "../../db/write-retry.js";
import { isKnowledgeTrustTier, type KnowledgeTrustTier } from "../types.js";
import { getKnowledgeDb } from "./db.js";

export interface LocalRunRef {
  ref: string;
  trust: KnowledgeTrustTier;
}

export interface LocalRun {
  id: string;
  turnKey: string | null;
  sessionName: string | null;
  consoleRunId: string | null;
  queryHash: string;
  refs: LocalRunRef[];
  lowestTier: KnowledgeTrustTier | null;
  issues: string[];
  createdAt: number;
}

interface LocalRunRow {
  id: string;
  turn_key: string | null;
  session_name: string | null;
  console_run_id: string | null;
  query_hash: string;
  refs_json: string;
  lowest_tier: string | null;
  issues_json: string;
  created_at: number;
}

export function insertLocalRun(input: {
  id?: string;
  turnKey: string | null;
  sessionName: string | null;
  consoleRunId: string | null;
  queryHash: string;
  refs: LocalRunRef[];
  lowestTier: KnowledgeTrustTier | null;
  issues: string[];
  now?: number;
}): LocalRun {
  const run: LocalRun = {
    id: input.id ?? randomUUID(),
    turnKey: input.turnKey,
    sessionName: input.sessionName,
    consoleRunId: input.consoleRunId,
    queryHash: input.queryHash,
    refs: input.refs.map((ref) => ({ ref: ref.ref, trust: ref.trust })),
    lowestTier: input.lowestTier,
    issues: [...input.issues],
    createdAt: input.now ?? Date.now(),
  };
  executeWrite(
    getKnowledgeDb(),
    (db) => {
      db.prepare(
        `INSERT INTO knowledge_local_runs
           (id, turn_key, session_name, console_run_id, query_hash, refs_json, lowest_tier, issues_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        run.id,
        run.turnKey,
        run.sessionName,
        run.consoleRunId,
        run.queryHash,
        JSON.stringify(run.refs),
        run.lowestTier,
        JSON.stringify(run.issues),
        run.createdAt,
      );
    },
    { label: "knowledge_local_run" },
  );
  return run;
}

/** Newest first. */
export function listLocalRuns(input: { turnKey?: string | null; session?: string | null; limit: number }): LocalRun[] {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (input.turnKey) {
    where.push("turn_key = ?");
    params.push(input.turnKey);
  }
  if (input.session) {
    where.push("session_name = ?");
    params.push(input.session);
  }
  const limit = Math.max(1, Math.min(50, Math.trunc(input.limit || 10)));
  const rows = getKnowledgeDb()
    .prepare(
      `SELECT * FROM knowledge_local_runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    .all(...params, limit) as LocalRunRow[];
  return rows.map(toLocalRun);
}

/** By id, with or without the `kl:` prefix. */
export function getLocalRun(id: string): LocalRun | null {
  const bare = id.startsWith("kl:") ? id.slice(3) : id;
  const row = getKnowledgeDb()
    .prepare("SELECT * FROM knowledge_local_runs WHERE id = ?")
    .get(bare) as LocalRunRow | null;
  return row ? toLocalRun(row) : null;
}

function toLocalRun(row: LocalRunRow): LocalRun {
  return {
    id: row.id,
    turnKey: row.turn_key,
    sessionName: row.session_name,
    consoleRunId: row.console_run_id,
    queryHash: row.query_hash,
    refs: parseRefs(row.refs_json),
    lowestTier: isKnowledgeTrustTier(row.lowest_tier) ? row.lowest_tier : null,
    issues: parseStrings(row.issues_json),
    createdAt: row.created_at,
  };
}

function parseRefs(value: string): LocalRunRef[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const record = entry as Record<string, unknown>;
      return typeof record.ref === "string" && isKnowledgeTrustTier(record.trust)
        ? [{ ref: record.ref, trust: record.trust }]
        : [];
    });
  } catch {
    return [];
  }
}

function parseStrings(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}
