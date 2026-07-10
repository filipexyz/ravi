/**
 * Runtime model preset store
 *
 * Centrally managed, named model selectors that agents reference indirectly via
 * `agents.model_preset_id`. Presets are never materialized/copied into agent
 * rows: agents keep a reference and the effective model is resolved at runtime.
 *
 * Persisted model/enabled mutations increment a monotonic version exactly once.
 * The preset provider is immutable in this first version.
 */

import type { SQLQueryBindings } from "bun:sqlite";
import { getDb } from "../router/router-db.js";
import { executeWrite } from "../db/write-retry.js";
import { normalizeLimitOffsetPage, type ListPage } from "../utils/pagination.js";
import { validateRuntimeModelSelector } from "./model-validation.js";

export interface RuntimeModelPreset {
  id: string;
  provider: string;
  model: string;
  description: string | null;
  enabled: boolean;
  version: number;
  createdAt: number;
  updatedAt: number;
}

interface RuntimeModelPresetRow {
  id: string;
  provider: string;
  model: string;
  description: string | null;
  enabled: number;
  version: number;
  created_at: number;
  updated_at: number;
}

export interface CreateRuntimeModelPresetInput {
  id: string;
  provider: string;
  model: string;
  description?: string | null;
  enabled?: boolean;
}

export interface ListRuntimeModelPresetsOptions {
  provider?: string;
  enabled?: boolean;
  includeDisabled?: boolean;
  limit?: number | string | null;
  offset?: number | string | null;
}

export interface RuntimeModelPresetImpactAgent {
  agentId: string;
  name: string | null;
  provider: string;
  effectiveModel: string;
  modelSource: "agent_preset";
  shadowingSessions: number;
}

export interface RuntimeModelPresetImpact {
  presetId: string;
  version: number;
  provider: string;
  model: string;
  enabled: boolean;
  referencingAgentsTotal: number;
  shadowingSessionsTotal: number;
  agents: RuntimeModelPresetImpactAgent[];
  limit: number;
  offset: number;
  referenced: boolean;
  correctionCommand: string | null;
}

const PRESET_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$|^[a-z0-9]$/;

export class RuntimeModelPresetError extends Error {
  constructor(
    message: string,
    readonly nextCommand?: string,
  ) {
    super(message);
    this.name = "RuntimeModelPresetError";
  }
}

export function ensureRuntimeModelPresetTables(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_model_presets (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      description TEXT,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
      version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_runtime_model_presets_provider ON runtime_model_presets(provider);
    CREATE INDEX IF NOT EXISTS idx_runtime_model_presets_enabled ON runtime_model_presets(enabled);
  `);
}

function normalizePresetId(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    throw new RuntimeModelPresetError("Preset id cannot be empty.");
  }
  if (!PRESET_ID_PATTERN.test(normalized)) {
    throw new RuntimeModelPresetError(
      `Invalid preset id '${value}'. Use a stable slug: lowercase letters, digits, and single hyphens (e.g. fast-sonnet).`,
    );
  }
  return normalized;
}

function assertValidPresetModel(provider: string, model: string): string {
  const normalized = model.trim();
  const result = validateRuntimeModelSelector(provider, normalized);
  if (!result.ok) {
    throw new RuntimeModelPresetError(result.error ?? `Invalid model: ${model}`);
  }
  return normalized;
}

export function createRuntimeModelPreset(input: CreateRuntimeModelPresetInput): RuntimeModelPreset {
  ensureRuntimeModelPresetTables();
  const id = normalizePresetId(input.id);
  const provider = input.provider.trim();
  if (!provider) {
    throw new RuntimeModelPresetError("Preset provider cannot be empty.");
  }
  const model = assertValidPresetModel(provider, input.model);
  const description = input.description?.trim() || null;
  const enabled = input.enabled ?? true;
  const now = Date.now();

  const existing = getRuntimeModelPreset(id);
  if (existing) {
    throw new RuntimeModelPresetError(
      `Model preset already exists: ${id}.`,
      `ravi runtime presets show ${id}`,
    );
  }

  executeWrite(
    getDb(),
    (db) => {
      db.prepare(
        `INSERT INTO runtime_model_presets (id, provider, model, description, enabled, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      ).run(id, provider, model, description, enabled ? 1 : 0, now, now);
    },
    { label: "runtime-model-preset-create" },
  );

  return getRuntimeModelPreset(id) ?? failMissingPreset(id);
}

export function getRuntimeModelPreset(id: string): RuntimeModelPreset | null {
  ensureRuntimeModelPresetTables();
  const normalized = id.trim().toLowerCase();
  const row = getDb().prepare("SELECT * FROM runtime_model_presets WHERE id = ?").get(normalized) as
    | RuntimeModelPresetRow
    | undefined;
  return row ? rowToPreset(row) : null;
}

export function requireRuntimeModelPreset(id: string): RuntimeModelPreset {
  const preset = getRuntimeModelPreset(id);
  if (!preset) {
    throw new RuntimeModelPresetError(
      `Model preset not found: ${id}.`,
      "ravi runtime presets list",
    );
  }
  return preset;
}

export function listRuntimeModelPresets(options: ListRuntimeModelPresetsOptions = {}): ListPage<RuntimeModelPreset> {
  ensureRuntimeModelPresetTables();
  const { limit, offset } = normalizeLimitOffsetPage(options, { defaultLimit: 50, maxLimit: 500 });
  const where: string[] = [];
  const params: SQLQueryBindings[] = [];
  if (options.provider) {
    where.push("provider = ?");
    params.push(options.provider.trim());
  }
  if (options.enabled !== undefined) {
    where.push("enabled = ?");
    params.push(options.enabled ? 1 : 0);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const db = getDb();
  const totalRow = db.prepare(`SELECT COUNT(*) AS total FROM runtime_model_presets ${whereSql}`).get(...params) as
    | { total: number }
    | undefined;
  const rows = db
    .prepare(
      `SELECT * FROM runtime_model_presets ${whereSql} ORDER BY id ASC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as RuntimeModelPresetRow[];
  return {
    items: rows.map(rowToPreset),
    total: totalRow?.total ?? 0,
    limit,
    offset,
  };
}

export function setRuntimeModelPresetModel(
  id: string,
  model: string,
  options: { dryRun?: boolean } = {},
): RuntimeModelPreset {
  const preset = requireRuntimeModelPreset(id);
  const nextModel = assertValidPresetModel(preset.provider, model);
  if (nextModel === preset.model) {
    // No-op update still returns the current preset without bumping the version.
    return preset;
  }
  if (options.dryRun) {
    return { ...preset, model: nextModel, version: preset.version + 1 };
  }
  const now = Date.now();
  executeWrite(
    getDb(),
    (db) => {
      db.prepare(
        "UPDATE runtime_model_presets SET model = ?, version = version + 1, updated_at = ? WHERE id = ?",
      ).run(nextModel, now, preset.id);
    },
    { label: "runtime-model-preset-set-model" },
  );
  return getRuntimeModelPreset(preset.id) ?? failMissingPreset(preset.id);
}

export function setRuntimeModelPresetEnabled(
  id: string,
  enabled: boolean,
  options: { dryRun?: boolean } = {},
): RuntimeModelPreset {
  const preset = requireRuntimeModelPreset(id);
  if (!enabled) {
    assertPresetNotReferenced(preset, "disable");
  }
  if (preset.enabled === enabled) {
    return preset;
  }
  if (options.dryRun) {
    return { ...preset, enabled, version: preset.version + 1 };
  }
  const now = Date.now();
  executeWrite(
    getDb(),
    (db) => {
      db.prepare(
        "UPDATE runtime_model_presets SET enabled = ?, version = version + 1, updated_at = ? WHERE id = ?",
      ).run(enabled ? 1 : 0, now, preset.id);
    },
    { label: "runtime-model-preset-set-enabled" },
  );
  return getRuntimeModelPreset(preset.id) ?? failMissingPreset(preset.id);
}

export function deleteRuntimeModelPreset(id: string, options: { dryRun?: boolean } = {}): RuntimeModelPreset {
  const preset = requireRuntimeModelPreset(id);
  assertPresetNotReferenced(preset, "delete");
  if (options.dryRun) {
    return preset;
  }
  executeWrite(
    getDb(),
    (db) => {
      db.prepare("DELETE FROM runtime_model_presets WHERE id = ?").run(preset.id);
    },
    { label: "runtime-model-preset-delete" },
  );
  return preset;
}

export function countAgentsReferencingPreset(presetId: string): number {
  ensureRuntimeModelPresetTables();
  const row = getDb()
    .prepare("SELECT COUNT(*) AS total FROM agents WHERE model_preset_id = ?")
    .get(presetId.trim().toLowerCase()) as { total: number } | undefined;
  return row?.total ?? 0;
}

export function getRuntimeModelPresetImpact(
  id: string,
  options: { limit?: number | string | null; offset?: number | string | null } = {},
): RuntimeModelPresetImpact {
  const preset = requireRuntimeModelPreset(id);
  const { limit, offset } = normalizeLimitOffsetPage(options, { defaultLimit: 50, maxLimit: 500 });
  const db = getDb();
  const totalRow = db.prepare("SELECT COUNT(*) AS total FROM agents WHERE model_preset_id = ?").get(preset.id) as
    | { total: number }
    | undefined;
  const referencingAgentsTotal = totalRow?.total ?? 0;
  const agentRows = db
    .prepare(
      "SELECT id, name FROM agents WHERE model_preset_id = ? ORDER BY id ASC LIMIT ? OFFSET ?",
    )
    .all(preset.id, limit, offset) as Array<{ id: string; name: string | null }>;

  const shadowingRow = db
    .prepare(
      `SELECT COUNT(*) AS total FROM sessions
       WHERE model_override IS NOT NULL AND model_override != ''
         AND agent_id IN (SELECT id FROM agents WHERE model_preset_id = ?)`,
    )
    .get(preset.id) as { total: number } | undefined;

  const agents: RuntimeModelPresetImpactAgent[] = agentRows.map((agent) => {
    const shadowing = db
      .prepare(
        "SELECT COUNT(*) AS total FROM sessions WHERE agent_id = ? AND model_override IS NOT NULL AND model_override != ''",
      )
      .get(agent.id) as { total: number } | undefined;
    return {
      agentId: agent.id,
      name: agent.name,
      provider: preset.provider,
      effectiveModel: preset.model,
      modelSource: "agent_preset",
      shadowingSessions: shadowing?.total ?? 0,
    };
  });

  const referenced = referencingAgentsTotal > 0;
  const firstAgent = agentRows[0]?.id;
  const correctionCommand = referenced
    ? firstAgent
      ? `ravi agents set ${firstAgent} model <model> (or: ravi agents set ${firstAgent} modelPreset clear) to release preset ${preset.id}`
      : `Reassign referencing agents before disabling or deleting preset ${preset.id}`
    : null;

  return {
    presetId: preset.id,
    version: preset.version,
    provider: preset.provider,
    model: preset.model,
    enabled: preset.enabled,
    referencingAgentsTotal,
    shadowingSessionsTotal: shadowingRow?.total ?? 0,
    agents,
    limit,
    offset,
    referenced,
    correctionCommand,
  };
}

function assertPresetNotReferenced(preset: RuntimeModelPreset, verb: "disable" | "delete"): void {
  const count = countAgentsReferencingPreset(preset.id);
  if (count > 0) {
    throw new RuntimeModelPresetError(
      `Cannot ${verb} model preset '${preset.id}': ${count} agent(s) still reference it. Reassign them first.`,
      `ravi runtime presets impact ${preset.id} --json`,
    );
  }
}

function rowToPreset(row: RuntimeModelPresetRow): RuntimeModelPreset {
  return {
    id: row.id,
    provider: row.provider,
    model: row.model,
    description: row.description,
    enabled: row.enabled === 1,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function failMissingPreset(id: string): never {
  throw new RuntimeModelPresetError(`Model preset not found after write: ${id}`);
}
