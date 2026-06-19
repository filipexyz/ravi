import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { normalizeConsoleUrl } from "../cloud-auth/client.js";
import { CloudAuthError } from "../cloud-auth/errors.js";
import { getRaviStateDir } from "../utils/paths.js";
import {
  CONSOLE_SCOPE_KINDS,
  type ConsoleScopeDefault,
  type ConsoleScopeKind,
  type ConsoleScopeOrganization,
  type ConsoleScopeProject,
  type ConsoleScopeTarget,
} from "./types.js";

interface ConsoleScopeDefaultRow {
  scope_kind: string;
  scope_key: string;
  console_url: string;
  organization_ref: string;
  organization_id: string | null;
  organization_slug: string | null;
  organization_name: string | null;
  project_id: string | null;
  project_slug: string | null;
  project_name: string | null;
  source_note: string | null;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
}

interface ConsoleScopeDbHandle {
  db: Database;
  path: string;
}

let handle: ConsoleScopeDbHandle | null = null;

export interface ConsoleScopeStoreOptions {
  env?: NodeJS.ProcessEnv;
  organization?: ConsoleScopeOrganization | null;
}

export interface UpsertConsoleScopeDefaultInput extends ConsoleScopeTarget {
  consoleUrl: string;
  organization?: ConsoleScopeDefault["organization"];
  project?: ConsoleScopeProject | null;
  sourceNote?: string | null;
  metadata?: Record<string, unknown> | null;
}

export function getConsoleScopeDefault(
  target: ConsoleScopeTarget,
  consoleUrl: string,
  options: ConsoleScopeStoreOptions = {},
): ConsoleScopeDefault | null {
  const row = getDb(options)
    .prepare(
      `SELECT * FROM console_scope_defaults
       WHERE scope_kind = ? AND scope_key = ? AND console_url = ? AND organization_ref = ?`,
    )
    .get(
      normalizeScopeKind(target.scopeKind),
      normalizeScopeKey(target),
      normalizeConsoleUrl(consoleUrl),
      normalizeOrganizationRef(options.organization),
    ) as ConsoleScopeDefaultRow | null;
  return row ? defaultFromRow(row) : null;
}

export function listConsoleScopeDefaultsForTargets(
  targets: ConsoleScopeTarget[],
  consoleUrl: string,
  options: ConsoleScopeStoreOptions = {},
): ConsoleScopeDefault[] {
  return targets
    .map((target) => getConsoleScopeDefault(target, consoleUrl, options))
    .filter((item): item is ConsoleScopeDefault => item !== null);
}

export function upsertConsoleScopeDefault(
  input: UpsertConsoleScopeDefaultInput,
  options: ConsoleScopeStoreOptions = {},
): ConsoleScopeDefault {
  const now = Date.now();
  const scopeKind = normalizeScopeKind(input.scopeKind);
  const scopeKey = normalizeScopeKey(input);
  const consoleUrl = normalizeConsoleUrl(input.consoleUrl);
  const organizationRef = normalizeOrganizationRef(input.organization ?? options.organization ?? null);
  const existing = getConsoleScopeDefault({ scopeKind, scopeKey }, consoleUrl, {
    ...options,
    organization: input.organization ?? options.organization ?? null,
  });
  const project = normalizeProjectForStorage(input.project);

  getDb(options)
    .prepare(
      `INSERT INTO console_scope_defaults (
        scope_kind, scope_key, console_url, organization_ref,
        organization_id, organization_slug, organization_name,
        project_id, project_slug, project_name,
        source_note, metadata_json, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope_kind, scope_key, console_url, organization_ref) DO UPDATE SET
        organization_id = excluded.organization_id,
        organization_slug = excluded.organization_slug,
        organization_name = excluded.organization_name,
        project_id = excluded.project_id,
        project_slug = excluded.project_slug,
        project_name = excluded.project_name,
        source_note = excluded.source_note,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at`,
    )
    .run(
      scopeKind,
      scopeKey,
      consoleUrl,
      organizationRef,
      input.organization?.id ?? null,
      input.organization?.slug ?? null,
      input.organization?.name ?? null,
      project?.id ?? null,
      project?.slug ?? null,
      project?.name ?? null,
      input.sourceNote ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      existing?.createdAt ?? now,
      now,
    );

  const saved = getConsoleScopeDefault({ scopeKind, scopeKey }, consoleUrl, {
    ...options,
    organization: input.organization ?? options.organization ?? null,
  });
  if (!saved) throw new CloudAuthError("SERVER_UNAVAILABLE", "Failed to save Console scope default.");
  return saved;
}

export function deleteConsoleScopeDefault(
  target: ConsoleScopeTarget,
  consoleUrl: string,
  options: ConsoleScopeStoreOptions = {},
): boolean {
  const result = getDb(options)
    .prepare(
      `DELETE FROM console_scope_defaults
       WHERE scope_kind = ? AND scope_key = ? AND console_url = ? AND organization_ref = ?`,
    )
    .run(
      normalizeScopeKind(target.scopeKind),
      normalizeScopeKey(target),
      normalizeConsoleUrl(consoleUrl),
      normalizeOrganizationRef(options.organization),
    );
  return result.changes > 0;
}

export function normalizeConsoleScopeTarget(target: ConsoleScopeTarget): ConsoleScopeTarget {
  return {
    scopeKind: normalizeScopeKind(target.scopeKind),
    scopeKey: normalizeScopeKey(target),
  };
}

export function normalizeWorkspaceScopeKey(path: string): string {
  return resolve(path);
}

export function closeConsoleScopeStore(): void {
  handle?.db.close();
  handle = null;
}

function getDb(options: ConsoleScopeStoreOptions = {}): Database {
  const path = join(getRaviStateDir(options.env), "ravi.db");
  if (handle?.path === path) return handle.db;
  handle?.db.close();
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  ensureSchema(db);
  handle = { db, path };
  return db;
}

function ensureSchema(db: Database): void {
  migrateLegacySchema(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS console_scope_defaults (
      scope_kind TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      console_url TEXT NOT NULL,
      organization_ref TEXT NOT NULL,
      organization_id TEXT,
      organization_slug TEXT,
      organization_name TEXT,
      project_id TEXT,
      project_slug TEXT,
      project_name TEXT,
      source_note TEXT,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (scope_kind, scope_key, console_url, organization_ref)
    );
    CREATE INDEX IF NOT EXISTS idx_console_scope_defaults_console
      ON console_scope_defaults(console_url, organization_ref);
  `);
}

function migrateLegacySchema(db: Database): void {
  const existing = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'console_scope_defaults'")
    .get() as { name: string } | null;
  if (!existing) return;

  const columns = db.prepare("PRAGMA table_info(console_scope_defaults)").all() as Array<{
    name: string;
    pk: number;
  }>;
  const hasOrganizationRef = columns.some((column) => column.name === "organization_ref");
  const primaryKey = columns
    .filter((column) => column.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((column) => column.name);
  if (hasOrganizationRef && primaryKey.includes("organization_ref")) return;

  const legacyTable = `console_scope_defaults_legacy_${process.pid}_${Date.now()}`;
  db.exec(`
    ALTER TABLE console_scope_defaults RENAME TO ${legacyTable};
    CREATE TABLE IF NOT EXISTS console_scope_defaults (
      scope_kind TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      console_url TEXT NOT NULL,
      organization_ref TEXT NOT NULL,
      organization_id TEXT,
      organization_slug TEXT,
      organization_name TEXT,
      project_id TEXT,
      project_slug TEXT,
      project_name TEXT,
      source_note TEXT,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (scope_kind, scope_key, console_url, organization_ref)
    );
    INSERT OR REPLACE INTO console_scope_defaults (
      scope_kind, scope_key, console_url, organization_ref,
      organization_id, organization_slug, organization_name,
      project_id, project_slug, project_name,
      source_note, metadata_json, created_at, updated_at
    )
    SELECT
      scope_kind, scope_key, console_url,
      COALESCE(NULLIF(organization_id, ''), NULLIF(organization_slug, ''), 'none') AS organization_ref,
      organization_id, organization_slug, organization_name,
      project_id, project_slug, project_name,
      source_note, metadata_json, created_at, updated_at
    FROM ${legacyTable};
    DROP TABLE ${legacyTable};
  `);
}

function normalizeScopeKind(kind: ConsoleScopeKind): ConsoleScopeKind {
  if ((CONSOLE_SCOPE_KINDS as readonly string[]).includes(kind)) return kind;
  throw new CloudAuthError("PAYLOAD_INVALID", `Invalid scope kind: ${kind}.`);
}

function normalizeScopeKey(target: ConsoleScopeTarget): string {
  const raw = target.scopeKind === "workspace" ? normalizeWorkspaceScopeKey(target.scopeKey) : target.scopeKey.trim();
  if (!raw) throw new CloudAuthError("PAYLOAD_INVALID", `Missing ${target.scopeKind} scope key.`);
  return raw;
}

function normalizeProjectForStorage(project: ConsoleScopeProject | null | undefined): ConsoleScopeProject | null {
  if (!project) return null;
  const ref = text(project.ref) ?? text(project.slug) ?? text(project.id) ?? text(project.name);
  if (!ref) return null;
  return {
    id: text(project.id),
    slug: text(project.slug) ?? ref,
    name: text(project.name),
    ref,
  };
}

function normalizeOrganizationRef(organization: ConsoleScopeOrganization | null | undefined): string {
  return text(organization?.id) ?? text(organization?.slug) ?? "none";
}

function defaultFromRow(row: ConsoleScopeDefaultRow): ConsoleScopeDefault {
  return {
    scopeKind: normalizeScopeKind(row.scope_kind as ConsoleScopeKind),
    scopeKey: row.scope_key,
    consoleUrl: row.console_url,
    organization:
      row.organization_id || row.organization_slug || row.organization_name
        ? {
            id: row.organization_id,
            slug: row.organization_slug,
            name: row.organization_name,
          }
        : null,
    project:
      row.project_id || row.project_slug || row.project_name
        ? {
            id: row.project_id,
            slug: row.project_slug,
            name: row.project_name,
            ref: row.project_slug ?? row.project_id ?? row.project_name ?? "project",
          }
        : null,
    sourceNote: row.source_note,
    metadata: parseJsonRecord(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseJsonRecord(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
