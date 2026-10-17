// The local mirror of Ravi Pages routes marked for contacts (contract §13.9,
// §7.5). The Console decides which pages and sections an installation may
// show; this side only keeps the last answer until it expires (24 h), so the
// packet and the egress guard work while the Console is unreachable.

import type { Database } from "bun:sqlite";
import { executeWrite } from "../../db/write-retry.js";
import { getKnowledgeDb, knowledgeFts5Available, readKnowledgeMeta, writeKnowledgeMeta } from "../store/db.js";
import { buildLocalFtsQuery, foldKnowledgeText, knowledgeQueryTerms } from "../text.js";
import type { ConsoleMirror } from "../types.js";

/** Used when the Console sends no ttl (contract §14: marked pages live 24 h). */
export const DEFAULT_MIRROR_TTL_SECONDS = 86_400;
const RAVI_HOSTS_META_KEY = "ravi_hosts";
const MAX_SECTIONS = 200;
const LIKE_SCAN_LIMIT = 500;

export type MarkedSection = {
  id: number;
  url: string;
  anchor: string | null;
  heading: string | null;
  text: string;
  version: number;
};

type StoredRaviHosts = { hosts: string[]; expiresAt: number };

/**
 * Replaces the whole mirror in one transaction: pages, sections, the FTS
 * index and `knowledge_meta.ravi_hosts`. A failure leaves the old mirror.
 * `ttlSeconds` (the Console's) is optional; it defaults to 24 h.
 */
export function replaceMarkedPages(
  mirror: Pick<ConsoleMirror, "pages" | "raviHosts"> & { ttlSeconds?: number },
  now: number,
): void {
  const ttlSeconds =
    typeof mirror.ttlSeconds === "number" && Number.isFinite(mirror.ttlSeconds) && mirror.ttlSeconds > 0
      ? mirror.ttlSeconds
      : DEFAULT_MIRROR_TTL_SECONDS;
  const expiresAt = now + ttlSeconds * 1000;
  const db = getKnowledgeDb();
  const fts = knowledgeFts5Available();
  executeWrite(
    db,
    (tx) => {
      clearMirror(tx, fts);
      const insertPage = tx.prepare(
        `INSERT INTO knowledge_marked_pages (route_id, url, host, path, title, document_id, version, approved_at, instances_json, fetched_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertSection = tx.prepare(
        "INSERT INTO knowledge_marked_sections (route_id, stable_key, heading, anchor, text) VALUES (?, ?, ?, ?, ?)",
      );
      const insertFts = fts ? tx.prepare("INSERT INTO knowledge_marked_fts (rowid, body) VALUES (?, ?)") : null;
      let sections = 0;
      for (const page of mirror.pages) {
        insertPage.run(
          page.routeId,
          page.url,
          page.host.toLowerCase(),
          page.path,
          page.title ?? null,
          page.documentId,
          page.version,
          page.approvedAt ?? null,
          JSON.stringify(page.instances ?? []),
          now,
          expiresAt,
        );
        for (const section of page.sections ?? []) {
          if (sections >= MAX_SECTIONS) break;
          const result = insertSection.run(
            page.routeId,
            section.stableKey,
            section.heading ?? null,
            section.anchor ?? null,
            section.text,
          );
          insertFts?.run(Number(result.lastInsertRowid), sectionBody(section.heading ?? null, section.text));
          sections += 1;
        }
      }
      const hosts = [...new Set((mirror.raviHosts ?? []).map((host) => host.trim().toLowerCase()).filter(Boolean))];
      writeKnowledgeMeta(RAVI_HOSTS_META_KEY, JSON.stringify({ hosts, expiresAt } satisfies StoredRaviHosts), tx);
    },
    { label: "knowledge_mirror_replace" },
  );
}

/** Deletes the mirror when it expired (Console unreachable for longer than the ttl). Returns pages dropped. */
export function dropExpiredMirror(now: number = Date.now()): number {
  const db = getKnowledgeDb();
  const fts = knowledgeFts5Available();
  return executeWrite(
    db,
    (tx) => {
      const expired = tx
        .prepare("SELECT route_id FROM knowledge_marked_pages WHERE expires_at <= ?")
        .all(now) as Array<{
        route_id: string;
      }>;
      for (const row of expired) {
        if (fts) {
          tx.prepare(
            "DELETE FROM knowledge_marked_fts WHERE rowid IN (SELECT id FROM knowledge_marked_sections WHERE route_id = ?)",
          ).run(row.route_id);
        }
        tx.prepare("DELETE FROM knowledge_marked_sections WHERE route_id = ?").run(row.route_id);
        tx.prepare("DELETE FROM knowledge_marked_pages WHERE route_id = ?").run(row.route_id);
      }
      const stored = readStoredRaviHosts(tx);
      if (stored && stored.expiresAt <= now) {
        writeKnowledgeMeta(RAVI_HOSTS_META_KEY, JSON.stringify({ hosts: [], expiresAt: 0 }), tx);
      }
      return expired.length;
    },
    { label: "knowledge_mirror_expire" },
  );
}

/** This org's Ravi hosts from the last mirror; [] once the mirror expired. */
export function listRaviHosts(now: number = Date.now()): string[] {
  const stored = readStoredRaviHosts(getKnowledgeDb());
  if (!stored || stored.expiresAt <= now) return [];
  return stored.hosts;
}

/**
 * Up to `limit` unexpired sections of pages marked for this instance (the OSS
 * instance name) that match the query's terms: AND first, then OR.
 */
export function listMarkedSectionsForInstance(input: {
  instanceId: string;
  query: string;
  limit: number;
  now?: number;
}): MarkedSection[] {
  const limit = Math.max(1, Math.min(MAX_SECTIONS, Math.trunc(input.limit || 3)));
  const now = input.now ?? Date.now();
  const terms = knowledgeQueryTerms(input.query);
  if (terms.length === 0) return [];
  const db = getKnowledgeDb();
  const scope = `p.expires_at > ? AND EXISTS (SELECT 1 FROM json_each(p.instances_json) WHERE value = ?)`;
  if (knowledgeFts5Available()) {
    const match = buildLocalFtsQuery(input.query);
    if (!match) return [];
    const run = (expression: string, exclude: number[]): SectionRow[] => {
      const extra = exclude.length ? ` AND s.id NOT IN (${exclude.map(() => "?").join(", ")})` : "";
      return db
        .prepare(
          `SELECT s.id, s.anchor, s.heading, s.text, p.url, p.version
           FROM knowledge_marked_fts
           JOIN knowledge_marked_sections s ON s.id = knowledge_marked_fts.rowid
           JOIN knowledge_marked_pages p ON p.route_id = s.route_id
           WHERE knowledge_marked_fts MATCH ? AND ${scope}${extra}
           ORDER BY bm25(knowledge_marked_fts) ASC, s.id ASC
           LIMIT ?`,
        )
        .all(expression, now, input.instanceId, ...exclude, limit) as SectionRow[];
    };
    const hits = run(match.and, []);
    const rows =
      hits.length >= limit || match.and === match.or
        ? hits
        : [
            ...hits,
            ...run(
              match.or,
              hits.map((row) => row.id),
            ),
          ];
    return rows.slice(0, limit).map(toSection);
  }
  // LIKE fallback: scan this instance's sections and match folded words.
  const rows = db
    .prepare(
      `SELECT s.id, s.anchor, s.heading, s.text, p.url, p.version
       FROM knowledge_marked_sections s JOIN knowledge_marked_pages p ON p.route_id = s.route_id
       WHERE ${scope} ORDER BY s.id ASC LIMIT ?`,
    )
    .all(now, input.instanceId, LIKE_SCAN_LIMIT) as SectionRow[];
  return rows
    .map((row) => {
      const words = foldKnowledgeText(sectionBody(row.heading, row.text)).split(" ");
      return { row, matched: terms.filter((term) => words.some((word) => word.startsWith(term))).length };
    })
    .filter((entry) => entry.matched > 0)
    .sort((a, b) => b.matched - a.matched || a.row.id - b.row.id)
    .slice(0, limit)
    .map((entry) => toSection(entry.row));
}

/** Host and path of every unexpired page marked for this instance. */
export function listMarkedUrlsForInstance(
  instanceId: string,
  now: number = Date.now(),
): Array<{ host: string; path: string }> {
  return getKnowledgeDb()
    .prepare(
      `SELECT p.host, p.path FROM knowledge_marked_pages p
       WHERE p.expires_at > ? AND EXISTS (SELECT 1 FROM json_each(p.instances_json) WHERE value = ?)
       ORDER BY p.host, p.path`,
    )
    .all(now, instanceId) as Array<{ host: string; path: string }>;
}

/** Whether an unexpired page marked for this instance has this URL (fragment and query ignored). */
export function isUrlMirroredForInstance(url: string, instanceId: string, now: number = Date.now()): boolean {
  const target = parseHostPath(url);
  if (!target) return false;
  return listMarkedUrlsForInstance(instanceId, now).some(
    (page) => page.host === target.host && normalizePath(page.path) === target.path,
  );
}

type SectionRow = {
  id: number;
  anchor: string | null;
  heading: string | null;
  text: string;
  url: string;
  version: number;
};

function toSection(row: SectionRow): MarkedSection {
  return {
    id: row.id,
    url: row.url,
    anchor: row.anchor ?? null,
    heading: row.heading ?? null,
    text: row.text,
    version: row.version,
  };
}

function sectionBody(heading: string | null, text: string): string {
  return heading ? `${heading}\n${text}` : text;
}

function clearMirror(db: Database, fts: boolean): void {
  if (fts) db.exec("DELETE FROM knowledge_marked_fts");
  db.exec("DELETE FROM knowledge_marked_sections");
  db.exec("DELETE FROM knowledge_marked_pages");
}

function readStoredRaviHosts(db: Database): StoredRaviHosts | null {
  const raw = readKnowledgeMeta(RAVI_HOSTS_META_KEY, db);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredRaviHosts>;
    if (!Array.isArray(parsed.hosts) || typeof parsed.expiresAt !== "number") return null;
    return {
      hosts: parsed.hosts.filter((host): host is string => typeof host === "string"),
      expiresAt: parsed.expiresAt,
    };
  } catch {
    return null;
  }
}

function parseHostPath(url: string): { host: string; path: string } | null {
  try {
    const parsed = new URL(url);
    return { host: parsed.hostname.toLowerCase(), path: normalizePath(parsed.pathname) };
  } catch {
    return null;
  }
}

function normalizePath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}
