import { constants, Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getDb, getRaviDbPath } from "../router/router-db.js";
import { executeWrite } from "../db/write-retry.js";
import { captureNativeDatabaseBinding, NativeSpecsSafetyError, withNativeDatabaseBinding } from "./native-safe-fs.js";
import type { SpecRecord, SpecsIndexInspection } from "./types.js";

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
    relativePath: relative(row.root_path, row.path),
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

function specsIndexSchemaExists(db: Database): boolean {
  const row = db
    .query("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'specs_index'")
    .get() as { present: number } | null;
  return row?.present === 1;
}

function openImmutableDatabase(databasePath: string): Database {
  const immutableUrl = pathToFileURL(databasePath);
  immutableUrl.searchParams.set("immutable", "1");
  return new Database(immutableUrl.href, constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI);
}

function withSpecsIndexReadonly<T>(databasePath: string, inspect: (db: Database) => T, confirmOpen?: () => void): T {
  const walExists = existsSync(`${databasePath}-wal`);
  const shmExists = existsSync(`${databasePath}-shm`);
  if (walExists !== shmExists) {
    throw new NativeSpecsSafetyError(
      "DB_SIDECAR_STATE_INCOMPLETE",
      databasePath,
      "Readonly specs inspection requires both SQLite WAL sidecars or neither sidecar.",
    );
  }
  if (!walExists) {
    const db = openImmutableDatabase(databasePath);
    try {
      confirmOpen?.();
      return inspect(db);
    } finally {
      db.close();
    }
  }

  if (confirmOpen) {
    const proof = openImmutableDatabase(databasePath);
    try {
      confirmOpen();
    } finally {
      proof.close();
    }
  }

  const snapshotDirectory = mkdtempSync(join(tmpdir(), "ravi-specs-readonly-"));
  const snapshotPath = join(snapshotDirectory, "ravi.db");
  try {
    copyFileSync(databasePath, snapshotPath);
    copyFileSync(`${databasePath}-wal`, `${snapshotPath}-wal`);
    copyFileSync(`${databasePath}-shm`, `${snapshotPath}-shm`);
    const snapshot = new Database(snapshotPath, { readonly: true, create: false });
    try {
      return inspect(snapshot);
    } finally {
      snapshot.close();
    }
  } finally {
    rmSync(snapshotDirectory, { recursive: true, force: true });
  }
}

export function ensureSpecsIndexSchema(): boolean {
  return ensureSpecsIndexSchemaInDb(getDb());
}

function ensureSpecsIndexSchemaInDb(db: Database): boolean {
  const existed = specsIndexSchemaExists(db);
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
  return !existed;
}

function comparableSpec(spec: SpecRecord): string {
  return JSON.stringify({
    rootPath: spec.rootPath,
    id: spec.id,
    path: spec.path,
    kind: spec.kind,
    domain: spec.domain,
    capability: spec.capability ?? null,
    feature: spec.feature ?? null,
    title: spec.title,
    capabilities: spec.capabilities,
    tags: spec.tags,
    appliesTo: spec.appliesTo,
    owners: spec.owners,
    status: spec.status,
    normative: spec.normative,
    mtime: spec.mtime,
  });
}

function sameSpecs(left: SpecRecord[], right: SpecRecord[]): boolean {
  return (
    left.length === right.length && left.every((spec, index) => comparableSpec(spec) === comparableSpec(right[index]!))
  );
}

export interface ReplaceSpecsIndexOptions {
  /** Test seam for a writer that completes before this caller acquires the transaction lock. */
  beforeTransaction?: () => void;
}

function configureSpecsDatabase(db: Database): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
}

function replaceSpecsIndexInDatabase(
  db: Database,
  rootPath: string,
  specs: SpecRecord[],
  options: ReplaceSpecsIndexOptions,
): boolean {
  options.beforeTransaction?.();
  return executeWrite(
    db,
    () => {
      const schemaCreated = ensureSpecsIndexSchemaInDb(db);
      const current = (
        db.prepare("SELECT * FROM specs_index WHERE root_path = ? ORDER BY id ASC").all(rootPath) as SpecIndexRow[]
      ).map(rowToSpec);
      if (!schemaCreated && sameSpecs(current, specs)) return false;
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
      return true;
    },
    { label: "specs:reindex" },
  );
}

export function replaceSpecsIndex(
  rootPath: string,
  specs: SpecRecord[],
  options: ReplaceSpecsIndexOptions = {},
): boolean {
  const db = getDb();
  return replaceSpecsIndexInDatabase(db, rootPath, specs, options);
}

export function replaceSpecsIndexBound(
  rootPath: string,
  specs: SpecRecord[],
  databasePath: string,
  expectedBinding: string,
  options: ReplaceSpecsIndexOptions & { beforeOpen?: () => void; beforeCallback?: (safePath: string) => void } = {},
): boolean {
  return withNativeDatabaseBinding(
    {
      databasePath,
      expectedBinding,
      write: true,
      create: true,
      ...(options.beforeOpen ? { beforeOpen: options.beforeOpen } : {}),
      ...(options.beforeCallback ? { beforeCallback: options.beforeCallback } : {}),
    },
    (safePath, confirmOpen) => {
      const db = new Database(safePath, { create: false, readwrite: true });
      try {
        confirmOpen();
        configureSpecsDatabase(db);
        return replaceSpecsIndexInDatabase(db, rootPath, specs, options);
      } finally {
        db.close();
      }
    },
  );
}

export function listIndexedSpecs(rootPath: string): SpecRecord[] {
  ensureSpecsIndexSchema();
  const rows = getDb()
    .prepare("SELECT * FROM specs_index WHERE root_path = ? ORDER BY id ASC")
    .all(rootPath) as SpecIndexRow[];
  return rows.map(rowToSpec);
}

export function inspectSpecsIndex(
  rootPath: string,
  specs: SpecRecord[],
  databasePath = resolve(getRaviDbPath()),
): SpecsIndexInspection {
  const dbPath = resolve(databasePath);
  const empty = {
    dbPath,
    schemaExists: false,
    matches: false,
    indexedTotal: 0,
    sourceTotal: specs.length,
    indexedIds: [] as string[],
    sourceIds: specs.map((spec) => spec.id),
  };
  if (!existsSync(dbPath)) return empty;

  return withSpecsIndexReadonly(dbPath, (db) => {
    if (!specsIndexSchemaExists(db)) return empty;
    const indexed = (
      db.query("SELECT * FROM specs_index WHERE root_path = ? ORDER BY id ASC").all(rootPath) as SpecIndexRow[]
    ).map(rowToSpec);
    return {
      dbPath,
      schemaExists: true,
      matches: sameSpecs(indexed, specs),
      indexedTotal: indexed.length,
      sourceTotal: specs.length,
      indexedIds: indexed.map((spec) => spec.id),
      sourceIds: specs.map((spec) => spec.id),
    };
  });
}

export function inspectSpecsIndexBound(
  rootPath: string,
  specs: SpecRecord[],
  databasePath: string,
  expectedBinding = captureNativeDatabaseBinding(databasePath).binding,
): SpecsIndexInspection {
  const empty = {
    dbPath: databasePath,
    schemaExists: false,
    matches: false,
    indexedTotal: 0,
    sourceTotal: specs.length,
    indexedIds: [] as string[],
    sourceIds: specs.map((spec) => spec.id),
  };
  try {
    return withNativeDatabaseBinding(
      { databasePath, expectedBinding, write: false, create: false },
      (safePath, confirmOpen) =>
        withSpecsIndexReadonly(
          safePath,
          (db) => {
            if (!specsIndexSchemaExists(db)) return empty;
            const indexed = (
              db.query("SELECT * FROM specs_index WHERE root_path = ? ORDER BY id ASC").all(rootPath) as SpecIndexRow[]
            ).map(rowToSpec);
            return {
              dbPath: databasePath,
              schemaExists: true,
              matches: sameSpecs(indexed, specs),
              indexedTotal: indexed.length,
              sourceTotal: specs.length,
              indexedIds: indexed.map((spec) => spec.id),
              sourceIds: specs.map((spec) => spec.id),
            };
          },
          confirmOpen,
        ),
    );
  } catch (error) {
    if (error instanceof NativeSpecsSafetyError && error.code === "DB_NOT_FOUND") return empty;
    throw error;
  }
}
