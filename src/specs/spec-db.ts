import { getDb } from "../router/router-db.js";
import type { SpecRecord } from "./types.js";

interface SpecIndexRow {
  root_path: string;
  id: string;
  path: string;
  kind: SpecRecord["kind"];
  domain: string;
  capability: string | null;
  feature: string | null;
  title: string;
  capabilities_json: string;
  tags_json: string;
  applies_to_json: string;
  owners_json: string;
  status: SpecRecord["status"];
  normative: number;
  mtime: number;
  updated_at: number;
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function rowToSpec(row: SpecIndexRow): SpecRecord {
  return {
    rootPath: row.root_path,
    id: row.id,
    path: row.path,
    relativePath: row.path.startsWith(`${row.root_path}/`) ? row.path.slice(row.root_path.length + 1) : row.path,
    kind: row.kind,
    domain: row.domain,
    ...(row.capability ? { capability: row.capability } : {}),
    ...(row.feature ? { feature: row.feature } : {}),
    title: row.title,
    capabilities: parseJsonArray(row.capabilities_json),
    tags: parseJsonArray(row.tags_json),
    appliesTo: parseJsonArray(row.applies_to_json),
    owners: parseJsonArray(row.owners_json),
    status: row.status,
    normative: row.normative === 1,
    mtime: row.mtime,
    updatedAt: row.updated_at,
  };
}

export function ensureSpecsIndexSchema(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS specs_index (
      root_path TEXT NOT NULL,
      id TEXT NOT NULL,
      path TEXT NOT NULL,
      kind TEXT NOT NULL,
      domain TEXT NOT NULL,
      capability TEXT,
      feature TEXT,
      title TEXT NOT NULL,
      capabilities_json TEXT NOT NULL DEFAULT '[]',
      tags_json TEXT NOT NULL DEFAULT '[]',
      applies_to_json TEXT NOT NULL DEFAULT '[]',
      owners_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL,
      normative INTEGER NOT NULL DEFAULT 1,
      mtime INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (root_path, id)
    );

    CREATE INDEX IF NOT EXISTS idx_specs_index_domain_kind ON specs_index(root_path, domain, kind);
    CREATE INDEX IF NOT EXISTS idx_specs_index_status ON specs_index(root_path, status);
  `);
}

export function replaceSpecsIndex(rootPath: string, specs: SpecRecord[]): void {
  ensureSpecsIndexSchema();
  const db = getDb();
  const now = Date.now();
  const insert = db.prepare(`
    INSERT INTO specs_index (
      root_path,
      id,
      path,
      kind,
      domain,
      capability,
      feature,
      title,
      capabilities_json,
      tags_json,
      applies_to_json,
      owners_json,
      status,
      normative,
      mtime,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.transaction(() => {
    db.prepare("DELETE FROM specs_index WHERE root_path = ?").run(rootPath);
    for (const spec of specs) {
      insert.run(
        spec.rootPath,
        spec.id,
        spec.path,
        spec.kind,
        spec.domain,
        spec.capability ?? null,
        spec.feature ?? null,
        spec.title,
        JSON.stringify(spec.capabilities),
        JSON.stringify(spec.tags),
        JSON.stringify(spec.appliesTo),
        JSON.stringify(spec.owners),
        spec.status,
        spec.normative ? 1 : 0,
        spec.mtime,
        now,
      );
    }
  })();
}

export function listIndexedSpecs(rootPath: string): SpecRecord[] {
  ensureSpecsIndexSchema();
  const rows = getDb()
    .prepare("SELECT * FROM specs_index WHERE root_path = ? ORDER BY id ASC")
    .all(rootPath) as SpecIndexRow[];
  return rows.map(rowToSpec);
}
