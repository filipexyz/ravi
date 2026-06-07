import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import type { CommandRegistryEntry, RegistrySnapshot } from "../../cli/registry-snapshot.js";
import { getRegistry } from "../../cli/registry-snapshot.js";
import { getRaviStateDir } from "../../utils/paths.js";
import { buildReturnSchema } from "../client-codegen/registry-shape.js";
import { stableStringify } from "../client-codegen/stable-json.js";
import { UNTYPED_PUBLIC_RETURN_COMMANDS_BASELINE } from "../client-codegen/return-schema-baseline.js";
import { WEAK_PUBLIC_RETURN_COMMANDS_BASELINE } from "../client-codegen/return-schema-quality-baseline.js";
import { currentCliOnlyCommands, currentWeakPublicReturnCommands } from "../client-codegen/return-schema-quality.js";

export const RETURN_SCHEMA_STATUSES = [
  "discovered",
  "in_progress",
  "blocked",
  "typed",
  "validated",
  "reviewed",
  "not_applicable",
  "removed",
] as const;

export const RETURN_SCHEMA_KINDS = ["missing", "json", "binary", "cli_only", "removed"] as const;

export type ReturnSchemaStatus = (typeof RETURN_SCHEMA_STATUSES)[number];
export type ReturnSchemaKind = (typeof RETURN_SCHEMA_KINDS)[number];

export interface ReturnSchemaCommandRecord {
  fullName: string;
  groupPath: string;
  commandName: string;
  className: string;
  methodName: string;
  scope: string;
  returnKind: ReturnSchemaKind;
  status: ReturnSchemaStatus;
  schemaHash: string | null;
  schemaJson: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  updatedAt: string;
  typedAt: string | null;
  validatedAt: string | null;
  reviewedAt: string | null;
  removedAt: string | null;
  owner: string | null;
  taskId: string | null;
  notes: string | null;
}

export interface ReturnSchemaSummary {
  generatedAt: string;
  dbPath: string;
  total: number;
  publicCommands: number;
  cliOnly: number;
  typedPublic: number;
  binaryPublic: number;
  missingPublic: number;
  baselineMissingPublic: number;
  weakPublic: number;
  baselineWeakPublic: number;
  newlyWeak: string[];
  strengthenedButStillListed: string[];
  cliOnlyCommands: string[];
  reviewedPublic: number;
  unreviewedPublic: number;
  unreviewedPublicCommands: string[];
  newlyUntyped: string[];
  resolvedButStillListed: string[];
  byStatus: Record<ReturnSchemaStatus, number>;
  byKind: Record<ReturnSchemaKind, number>;
  topMissingGroups: Array<{ group: string; count: number }>;
}

export interface ReturnSchemaSyncResult {
  summary: ReturnSchemaSummary;
  inserted: number;
  updated: number;
  removed: number;
}

export interface ReturnSchemaListOptions {
  status?: ReturnSchemaStatus | null;
  kind?: ReturnSchemaKind | null;
  group?: string | null;
  search?: string | null;
  limit?: number;
  offset?: number;
}

export interface ReturnSchemaListResult {
  total: number;
  limit: number;
  offset: number;
  items: ReturnSchemaCommandRecord[];
}

export interface ReturnSchemaValidationIssue {
  level: "error" | "warning";
  code: string;
  command?: string;
  message: string;
}

export interface ReturnSchemaValidationResult {
  ok: boolean;
  strict: boolean;
  summary: ReturnSchemaSummary;
  issues: ReturnSchemaValidationIssue[];
}

export interface MarkReturnSchemaCommandInput {
  fullName: string;
  status: ReturnSchemaStatus;
  owner?: string | null;
  taskId?: string | null;
  notes?: string | null;
}

export interface AssignReturnSchemaCommandsInput {
  taskId: string;
  status?: ReturnSchemaStatus;
  owner?: string | null;
  notes?: string | null;
  groups?: string[];
  kind?: ReturnSchemaKind | null;
  onlyUnassigned?: boolean;
}

export interface AssignReturnSchemaCommandsResult {
  taskId: string;
  status: ReturnSchemaStatus;
  matched: number;
  updated: number;
  commands: string[];
}

export interface ReturnSchemaTaskPlan {
  id: string;
  title: string;
  groups: string[];
  missingPublic: number;
  commands: string[];
}

export interface ReturnSchemaTaskPlanResult {
  generatedAt: string;
  totalMissingPublic: number;
  tasks: ReturnSchemaTaskPlan[];
}

export interface ReturnSchemaWorkflowOptions {
  dbPath?: string;
  env?: NodeJS.ProcessEnv;
  registry?: RegistrySnapshot;
  now?: Date;
  strict?: boolean;
}

interface DbRow {
  full_name: string;
  group_path: string;
  command_name: string;
  class_name: string;
  method_name: string;
  scope: string;
  return_kind: ReturnSchemaKind;
  status: ReturnSchemaStatus;
  schema_hash: string | null;
  schema_json: string | null;
  first_seen_at: string;
  last_seen_at: string;
  updated_at: string;
  typed_at: string | null;
  validated_at: string | null;
  reviewed_at: string | null;
  removed_at: string | null;
  owner: string | null;
  task_id: string | null;
  notes: string | null;
}

interface LiveCommandProjection {
  fullName: string;
  groupPath: string;
  commandName: string;
  className: string;
  methodName: string;
  scope: string;
  returnKind: ReturnSchemaKind;
  schemaHash: string | null;
  schemaJson: string | null;
  cliOnly: boolean;
}

const TABLE = "cli_return_schema_commands";
const BINARY_SCHEMA_JSON = stableStringify({ type: "string", format: "binary" }, 0);

export function getReturnSchemaDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getRaviStateDir(env), "cli-return-schemas.db");
}

export function syncReturnSchemaWorkflow(options: ReturnSchemaWorkflowOptions = {}): ReturnSchemaSyncResult {
  const dbPath = resolveDbPath(options);
  const now = isoNow(options.now);
  const registry = options.registry ?? getRegistry();
  const db = openDb(dbPath);
  try {
    ensureSchema(db);
    const live = projectLiveCommands(registry);
    const liveByName = new Map(live.map((cmd) => [cmd.fullName, cmd]));
    const existing = listAllRows(db);
    const existingByName = new Map(existing.map((row) => [row.fullName, row]));
    let inserted = 0;
    let updated = 0;
    let removed = 0;

    const insertStmt = db.prepare(
      `INSERT INTO ${TABLE} (
        full_name, group_path, command_name, class_name, method_name, scope,
        return_kind, status, schema_hash, schema_json,
        first_seen_at, last_seen_at, updated_at,
        typed_at, validated_at, reviewed_at, removed_at,
        owner, task_id, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const updateStmt = db.prepare(
      `UPDATE ${TABLE} SET
        group_path = ?,
        command_name = ?,
        class_name = CASE WHEN ? != 'unknown' THEN ? ELSE class_name END,
        method_name = ?,
        scope = ?,
        return_kind = ?,
        status = ?,
        schema_hash = ?,
        schema_json = ?,
        last_seen_at = ?,
        updated_at = ?,
        typed_at = ?,
        validated_at = ?,
        reviewed_at = ?,
        removed_at = ?
      WHERE full_name = ?`,
    );

    for (const liveCommand of live) {
      const row = existingByName.get(liveCommand.fullName);
      if (!row) {
        const status = initialStatus(liveCommand);
        insertStmt.run(
          liveCommand.fullName,
          liveCommand.groupPath,
          liveCommand.commandName,
          liveCommand.className,
          liveCommand.methodName,
          liveCommand.scope,
          liveCommand.returnKind,
          status,
          liveCommand.schemaHash,
          liveCommand.schemaJson,
          now,
          now,
          now,
          status === "typed" ? now : null,
          null,
          null,
          null,
          null,
          null,
          null,
        );
        inserted++;
        continue;
      }

      const next = nextLiveState(row, liveCommand, now);
      if (rowNeedsUpdate(row, liveCommand, next)) {
        updateStmt.run(
          liveCommand.groupPath,
          liveCommand.commandName,
          liveCommand.className,
          liveCommand.className,
          liveCommand.methodName,
          liveCommand.scope,
          liveCommand.returnKind,
          next.status,
          liveCommand.schemaHash,
          liveCommand.schemaJson,
          now,
          now,
          next.typedAt,
          next.validatedAt,
          next.reviewedAt,
          null,
          liveCommand.fullName,
        );
        updated++;
      }
    }

    const removeStmt = db.prepare(
      `UPDATE ${TABLE} SET return_kind = 'removed', status = 'removed', updated_at = ?, removed_at = ? WHERE full_name = ?`,
    );
    for (const row of existing) {
      if (liveByName.has(row.fullName) || row.status === "removed") continue;
      removeStmt.run(now, now, row.fullName);
      removed++;
    }

    return {
      summary: summarizeReturnSchemaWorkflow({ ...options, dbPath, registry, now: options.now }),
      inserted,
      updated,
      removed,
    };
  } finally {
    db.close();
  }
}

export function summarizeReturnSchemaWorkflow(options: ReturnSchemaWorkflowOptions = {}): ReturnSchemaSummary {
  const dbPath = resolveDbPath(options);
  const now = isoNow(options.now);
  const registry = options.registry ?? getRegistry();
  const db = openDb(dbPath);
  try {
    ensureSchema(db);
    const rows = listAllRows(db);
    const publicCommands = registry.commands.filter((cmd) => !cmd.cliOnly);
    const missingPublic = currentUntypedPublicCommands(registry);
    const weakPublic = currentWeakPublicReturnCommands(registry);
    const cliOnlyCommands = currentCliOnlyCommands(registry);
    const baseline: string[] = [...(UNTYPED_PUBLIC_RETURN_COMMANDS_BASELINE as ReadonlyArray<string>)];
    baseline.sort((a, b) => a.localeCompare(b));
    const baselineSet = new Set<string>(baseline);
    const missingSet = new Set(missingPublic);
    const weakBaseline: string[] = [...(WEAK_PUBLIC_RETURN_COMMANDS_BASELINE as ReadonlyArray<string>)];
    weakBaseline.sort((a, b) => a.localeCompare(b));
    const weakBaselineSet = new Set<string>(weakBaseline);
    const weakSet = new Set(weakPublic);

    const byStatus = emptyStatusCounts();
    const byKind = emptyKindCounts();
    for (const row of rows) {
      byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
      byKind[row.returnKind] = (byKind[row.returnKind] ?? 0) + 1;
    }
    const unreviewedPublicCommands = rows
      .filter((row) => row.returnKind === "json" || row.returnKind === "binary")
      .filter((row) => row.status !== "reviewed")
      .map((row) => row.fullName)
      .sort((a, b) => a.localeCompare(b));
    const reviewedPublic = rows.filter(
      (row) => (row.returnKind === "json" || row.returnKind === "binary") && row.status === "reviewed",
    ).length;

    return {
      generatedAt: now,
      dbPath,
      total: rows.length,
      publicCommands: publicCommands.length,
      cliOnly: registry.commands.length - publicCommands.length,
      typedPublic: publicCommands.filter((cmd) => Boolean(cmd.returns)).length,
      binaryPublic: publicCommands.filter((cmd) => cmd.binary === true).length,
      missingPublic: missingPublic.length,
      baselineMissingPublic: baseline.length,
      weakPublic: weakPublic.length,
      baselineWeakPublic: weakBaseline.length,
      newlyWeak: weakPublic.filter((name) => !weakBaselineSet.has(name)),
      strengthenedButStillListed: weakBaseline.filter((name) => !weakSet.has(name)),
      cliOnlyCommands,
      reviewedPublic,
      unreviewedPublic: unreviewedPublicCommands.length,
      unreviewedPublicCommands,
      newlyUntyped: missingPublic.filter((name) => !baselineSet.has(name)),
      resolvedButStillListed: baseline.filter((name) => !missingSet.has(name)),
      byStatus,
      byKind,
      topMissingGroups: topMissingGroups(missingPublic),
    };
  } finally {
    db.close();
  }
}

export function listReturnSchemaCommands(
  options: ReturnSchemaWorkflowOptions & ReturnSchemaListOptions = {},
): ReturnSchemaListResult {
  const dbPath = resolveDbPath(options);
  const limit = normalizeLimit(options.limit);
  const offset = normalizeOffset(options.offset);
  const where: string[] = [];
  const params: SQLQueryBindings[] = [];

  if (options.status) {
    assertStatus(options.status);
    where.push("status = ?");
    params.push(options.status);
  }
  if (options.kind) {
    assertKind(options.kind);
    where.push("return_kind = ?");
    params.push(options.kind);
  }
  if (options.group?.trim()) {
    where.push("(group_path = ? OR group_path LIKE ?)");
    const group = options.group.trim();
    params.push(group, `${group}.%`);
  }
  if (options.search?.trim()) {
    where.push("(full_name LIKE ? OR notes LIKE ? OR task_id LIKE ?)");
    const pattern = `%${options.search.trim()}%`;
    params.push(pattern, pattern, pattern);
  }

  const db = openDb(dbPath);
  try {
    ensureSchema(db);
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const totalRow = db.prepare(`SELECT COUNT(*) AS total FROM ${TABLE} ${whereSql}`).get(...params) as
      | { total: number }
      | undefined;
    const rows = db
      .prepare(
        `SELECT * FROM ${TABLE} ${whereSql}
         ORDER BY
          CASE status
            WHEN 'discovered' THEN 0
            WHEN 'in_progress' THEN 1
            WHEN 'blocked' THEN 2
            WHEN 'typed' THEN 3
            WHEN 'validated' THEN 4
            WHEN 'reviewed' THEN 5
            WHEN 'not_applicable' THEN 6
            ELSE 7
          END,
          full_name ASC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as DbRow[];
    return {
      total: totalRow?.total ?? 0,
      limit,
      offset,
      items: rows.map(mapRow),
    };
  } finally {
    db.close();
  }
}

export function getReturnSchemaCommand(
  fullName: string,
  options: ReturnSchemaWorkflowOptions = {},
): ReturnSchemaCommandRecord | null {
  const dbPath = resolveDbPath(options);
  const db = openDb(dbPath);
  try {
    ensureSchema(db);
    const row = db.prepare(`SELECT * FROM ${TABLE} WHERE full_name = ?`).get(fullName) as DbRow | undefined;
    return row ? mapRow(row) : null;
  } finally {
    db.close();
  }
}

export function markReturnSchemaCommand(
  input: MarkReturnSchemaCommandInput,
  options: ReturnSchemaWorkflowOptions = {},
): ReturnSchemaCommandRecord {
  assertStatus(input.status);
  const dbPath = resolveDbPath(options);
  const now = isoNow(options.now);
  const db = openDb(dbPath);
  try {
    ensureSchema(db);
    const row = db.prepare(`SELECT * FROM ${TABLE} WHERE full_name = ?`).get(input.fullName) as DbRow | undefined;
    if (!row) {
      throw new Error(`Return schema command not found: ${input.fullName}. Run \`ravi sdk returns sync\` first.`);
    }
    if ((input.status === "validated" || input.status === "reviewed") && row.return_kind === "missing") {
      throw new Error(`Cannot mark ${input.fullName} as ${input.status}: it still lacks @Returns.`);
    }
    if (input.status === "typed" && row.return_kind === "missing") {
      throw new Error(`Cannot mark ${input.fullName} as typed: it still lacks @Returns.`);
    }

    db.prepare(
      `UPDATE ${TABLE} SET
        status = ?,
        owner = COALESCE(?, owner),
        task_id = COALESCE(?, task_id),
        notes = COALESCE(?, notes),
        updated_at = ?,
        typed_at = CASE WHEN ? IN ('typed', 'validated', 'reviewed') THEN COALESCE(typed_at, ?) ELSE typed_at END,
        validated_at = CASE WHEN ? IN ('validated', 'reviewed') THEN COALESCE(validated_at, ?) ELSE validated_at END,
        reviewed_at = CASE WHEN ? = 'reviewed' THEN COALESCE(reviewed_at, ?) ELSE reviewed_at END
      WHERE full_name = ?`,
    ).run(
      input.status,
      cleanOptional(input.owner),
      cleanOptional(input.taskId),
      cleanOptional(input.notes),
      now,
      input.status,
      now,
      input.status,
      now,
      input.status,
      now,
      input.fullName,
    );

    const updated = db.prepare(`SELECT * FROM ${TABLE} WHERE full_name = ?`).get(input.fullName) as DbRow | undefined;
    if (!updated) throw new Error(`Return schema command not found after update: ${input.fullName}`);
    return mapRow(updated);
  } finally {
    db.close();
  }
}

export function assignReturnSchemaCommands(
  input: AssignReturnSchemaCommandsInput,
  options: ReturnSchemaWorkflowOptions = {},
): AssignReturnSchemaCommandsResult {
  const taskId = cleanOptional(input.taskId);
  if (!taskId) throw new Error("--task <id> is required.");
  const status = input.status ?? "in_progress";
  assertStatus(status);
  const kind = input.kind ?? "missing";
  assertKind(kind);
  const groups = (input.groups ?? []).map((group) => group.trim()).filter(Boolean);
  const dbPath = resolveDbPath(options);
  const now = isoNow(options.now);
  const db = openDb(dbPath);
  try {
    ensureSchema(db);
    const where: string[] = ["return_kind = ?"];
    const params: SQLQueryBindings[] = [kind];
    if (groups.length > 0) {
      const groupClauses = groups.map(() => "(group_path = ? OR group_path LIKE ?)").join(" OR ");
      where.push(`(${groupClauses})`);
      for (const group of groups) {
        params.push(group, `${group}.%`);
      }
    }
    if (input.onlyUnassigned !== false) {
      where.push("task_id IS NULL");
    }
    const whereSql = `WHERE ${where.join(" AND ")}`;
    const rows = db.prepare(`SELECT * FROM ${TABLE} ${whereSql} ORDER BY full_name ASC`).all(...params) as DbRow[];
    const update = db.prepare(
      `UPDATE ${TABLE} SET
        status = ?,
        task_id = ?,
        owner = COALESCE(?, owner),
        notes = COALESCE(?, notes),
        updated_at = ?
      WHERE full_name = ?`,
    );
    let updated = 0;
    for (const row of rows) {
      const info = update.run(
        status,
        taskId,
        cleanOptional(input.owner),
        cleanOptional(input.notes),
        now,
        row.full_name,
      );
      updated += info.changes;
    }
    return {
      taskId,
      status,
      matched: rows.length,
      updated,
      commands: rows.map((row) => row.full_name),
    };
  } finally {
    db.close();
  }
}

export function validateReturnSchemaWorkflow(options: ReturnSchemaWorkflowOptions = {}): ReturnSchemaValidationResult {
  const summary = summarizeReturnSchemaWorkflow(options);
  const strict = options.strict === true;
  const registry = options.registry ?? getRegistry();
  const rows = listReturnSchemaCommands({ ...options, limit: Number.MAX_SAFE_INTEGER }).items;
  const rowByName = new Map(rows.map((row) => [row.fullName, row]));
  const issues: ReturnSchemaValidationIssue[] = [];
  const weakBaselineSet = new Set<string>(WEAK_PUBLIC_RETURN_COMMANDS_BASELINE as ReadonlyArray<string>);
  const currentWeak = currentWeakPublicReturnCommands(registry);

  for (const cmd of registry.commands) {
    const row = rowByName.get(cmd.fullName);
    if (!row) {
      issues.push({
        level: "error",
        code: "MISSING_TRACKING_ROW",
        command: cmd.fullName,
        message: "Command is present in the registry but missing from cli_return_schema_commands.",
      });
      continue;
    }
    if (!cmd.cliOnly && !cmd.binary && !cmd.returns && row.returnKind !== "missing") {
      issues.push({
        level: "error",
        code: "KIND_MISMATCH",
        command: cmd.fullName,
        message: "Command lacks @Returns but the tracking row is not marked missing.",
      });
    }
    if (!cmd.cliOnly && (cmd.binary || cmd.returns) && row.returnKind === "missing") {
      issues.push({
        level: "error",
        code: "KIND_MISMATCH",
        command: cmd.fullName,
        message: "Command is typed in the registry but the tracking row is still marked missing.",
      });
    }
    if (row.status === "reviewed" && row.schemaHash !== projectCommand(cmd).schemaHash) {
      issues.push({
        level: "warning",
        code: "REVIEW_SCHEMA_DRIFT",
        command: cmd.fullName,
        message: "Reviewed command schema hash no longer matches the live registry.",
      });
    }
  }

  for (const name of summary.newlyUntyped) {
    issues.push({
      level: "error",
      code: "NEW_UNTYPED_PUBLIC_COMMAND",
      command: name,
      message: "Public command lacks @Returns and is not in the approved debt baseline.",
    });
  }
  for (const name of summary.resolvedButStillListed) {
    issues.push({
      level: "warning",
      code: "BASELINE_CAN_SHRINK",
      command: name,
      message: "Command no longer lacks @Returns; remove it from return-schema-baseline.ts.",
    });
  }
  for (const name of summary.newlyWeak) {
    issues.push({
      level: "error",
      code: "NEW_WEAK_PUBLIC_RETURN_SCHEMA",
      command: name,
      message: "Public command has a weak @Returns schema and is not in the approved quality debt baseline.",
    });
  }
  for (const name of summary.strengthenedButStillListed) {
    issues.push({
      level: "warning",
      code: "WEAK_BASELINE_CAN_SHRINK",
      command: name,
      message: "Command no longer has a weak return schema; remove it from return-schema-quality-baseline.ts.",
    });
  }
  if (strict) {
    for (const name of summary.cliOnlyCommands) {
      issues.push({
        level: "error",
        code: "CLI_ONLY_COMMAND",
        command: name,
        message:
          "@CliOnly hides the command from OpenAPI/docs/SDK; strict validation treats it as an exception that must be removed or explicitly justified in code review.",
      });
    }
    for (const name of currentWeak.filter((command) => weakBaselineSet.has(command))) {
      issues.push({
        level: "error",
        code: "WEAK_PUBLIC_RETURN_SCHEMA",
        command: name,
        message: "Strict validation rejects weak return-schema baseline debt.",
      });
    }
    for (const name of summary.unreviewedPublicCommands) {
      issues.push({
        level: "error",
        code: "UNREVIEWED_PUBLIC_RETURN_SCHEMA",
        command: name,
        message: "Strict validation requires typed public return schemas to be marked reviewed.",
      });
    }
  }

  return {
    ok: issues.every((issue) => issue.level !== "error"),
    strict,
    summary,
    issues,
  };
}

export function buildReturnSchemaTaskPlan(options: ReturnSchemaWorkflowOptions = {}): ReturnSchemaTaskPlanResult {
  const generatedAt = isoNow(options.now);
  const registry = options.registry ?? getRegistry();
  const missing = registry.commands
    .filter((cmd) => !cmd.cliOnly && !cmd.binary && !cmd.returns)
    .sort((a, b) => a.fullName.localeCompare(b.fullName));
  const buckets = [
    {
      id: "cli-returns-messaging",
      title: "Tipar retornos de messaging/contexto",
      groups: ["sessions", "contacts", "chats", "instances", "whatsapp", "context"],
    },
    {
      id: "cli-returns-runtime",
      title: "Tipar retornos de runtime/controle",
      groups: ["permissions", "daemon", "runtime", "triggers", "cron", "events", "watch", "hooks"],
    },
    {
      id: "cli-returns-work",
      title: "Tipar retornos de tasks/projects/workflows",
      groups: ["tasks", "projects", "workflows", "threads", "commands", "skills", "specs"],
    },
    {
      id: "cli-returns-domains",
      title: "Tipar retornos de domínios operacionais",
      groups: ["crm", "inbox", "mail", "calendar", "prox", "artifacts", "audio", "image", "video"],
    },
    {
      id: "cli-returns-rest",
      title: "Tipar retornos restantes",
      groups: [],
    },
  ];

  const assigned = new Set<string>();
  const tasks: ReturnSchemaTaskPlan[] = [];
  for (const bucket of buckets) {
    const commands = missing
      .filter((cmd) => {
        if (assigned.has(cmd.fullName)) return false;
        if (bucket.groups.length === 0) return true;
        return bucket.groups.some((group) => cmd.groupPath === group || cmd.groupPath.startsWith(`${group}.`));
      })
      .map((cmd) => cmd.fullName);
    for (const command of commands) assigned.add(command);
    if (commands.length === 0) continue;
    tasks.push({
      id: bucket.id,
      title: bucket.title,
      groups: bucket.groups,
      missingPublic: commands.length,
      commands,
    });
  }

  return {
    generatedAt,
    totalMissingPublic: missing.length,
    tasks,
  };
}

function resolveDbPath(options: ReturnSchemaWorkflowOptions): string {
  return options.dbPath ?? getReturnSchemaDbPath(options.env ?? process.env);
}

function openDb(dbPath: string): Database {
  mkdirSync(join(dbPath, ".."), { recursive: true });
  const db = new Database(dbPath);
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
  return db;
}

function ensureSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      full_name TEXT PRIMARY KEY,
      group_path TEXT NOT NULL,
      command_name TEXT NOT NULL,
      class_name TEXT NOT NULL,
      method_name TEXT NOT NULL,
      scope TEXT NOT NULL,
      return_kind TEXT NOT NULL CHECK (return_kind IN ('missing', 'json', 'binary', 'cli_only', 'removed')),
      status TEXT NOT NULL CHECK (status IN ('discovered', 'in_progress', 'blocked', 'typed', 'validated', 'reviewed', 'not_applicable', 'removed')),
      schema_hash TEXT,
      schema_json TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      typed_at TEXT,
      validated_at TEXT,
      reviewed_at TEXT,
      removed_at TEXT,
      owner TEXT,
      task_id TEXT,
      notes TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_cli_return_schema_status ON ${TABLE}(status);
    CREATE INDEX IF NOT EXISTS idx_cli_return_schema_kind ON ${TABLE}(return_kind);
    CREATE INDEX IF NOT EXISTS idx_cli_return_schema_group ON ${TABLE}(group_path);
  `);
}

function projectLiveCommands(registry: RegistrySnapshot): LiveCommandProjection[] {
  return registry.commands.map(projectCommand).sort((a, b) => a.fullName.localeCompare(b.fullName));
}

function projectCommand(cmd: CommandRegistryEntry): LiveCommandProjection {
  const schemaJson = schemaJsonForCommand(cmd);
  return {
    fullName: cmd.fullName,
    groupPath: cmd.groupPath,
    commandName: cmd.command,
    className: stableClassName(cmd.cls.name),
    methodName: cmd.method,
    scope: cmd.scope,
    returnKind: returnKindForCommand(cmd),
    schemaHash: schemaJson ? hashString(schemaJson) : null,
    schemaJson,
    cliOnly: cmd.cliOnly === true,
  };
}

function returnKindForCommand(cmd: CommandRegistryEntry): ReturnSchemaKind {
  if (cmd.cliOnly) return "cli_only";
  if (cmd.binary) return "binary";
  if (cmd.returns) return "json";
  return "missing";
}

function schemaJsonForCommand(cmd: CommandRegistryEntry): string | null {
  if (cmd.cliOnly) return null;
  if (cmd.binary) return BINARY_SCHEMA_JSON;
  const schema = buildReturnSchema(cmd);
  return schema ? stableStringify(schema, 0) : null;
}

function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function initialStatus(command: LiveCommandProjection): ReturnSchemaStatus {
  if (command.returnKind === "cli_only") return "not_applicable";
  if (command.returnKind === "missing") return "discovered";
  return "typed";
}

function nextLiveState(
  row: ReturnSchemaCommandRecord,
  command: LiveCommandProjection,
  now: string,
): { status: ReturnSchemaStatus; typedAt: string | null; validatedAt: string | null; reviewedAt: string | null } {
  if (command.returnKind === "cli_only") {
    return { status: "not_applicable", typedAt: row.typedAt, validatedAt: row.validatedAt, reviewedAt: row.reviewedAt };
  }
  if (command.returnKind === "missing") {
    const status = row.status === "in_progress" || row.status === "blocked" ? row.status : "discovered";
    return { status, typedAt: row.typedAt, validatedAt: null, reviewedAt: null };
  }
  if ((row.status === "validated" || row.status === "reviewed") && row.schemaHash === command.schemaHash) {
    return {
      status: row.status,
      typedAt: row.typedAt ?? now,
      validatedAt: row.validatedAt,
      reviewedAt: row.reviewedAt,
    };
  }
  return { status: "typed", typedAt: row.typedAt ?? now, validatedAt: null, reviewedAt: null };
}

function rowNeedsUpdate(
  row: ReturnSchemaCommandRecord,
  command: LiveCommandProjection,
  next: { status: ReturnSchemaStatus; typedAt: string | null; validatedAt: string | null; reviewedAt: string | null },
): boolean {
  return (
    row.groupPath !== command.groupPath ||
    row.commandName !== command.commandName ||
    shouldUpdateClassName(row.className, command.className) ||
    row.methodName !== command.methodName ||
    row.scope !== command.scope ||
    row.returnKind !== command.returnKind ||
    row.status !== next.status ||
    row.schemaHash !== command.schemaHash ||
    row.schemaJson !== command.schemaJson ||
    row.typedAt !== next.typedAt ||
    row.validatedAt !== next.validatedAt ||
    row.reviewedAt !== next.reviewedAt ||
    row.removedAt !== null
  );
}

function stableClassName(name: string | undefined): string {
  if (!name || name.length <= 2 || name.startsWith("$")) return "unknown";
  return name;
}

function shouldUpdateClassName(current: string, next: string): boolean {
  if (next === "unknown") return false;
  return current !== next;
}

function listAllRows(db: Database): ReturnSchemaCommandRecord[] {
  const rows = db.prepare(`SELECT * FROM ${TABLE} ORDER BY full_name ASC`).all() as DbRow[];
  return rows.map(mapRow);
}

function mapRow(row: DbRow): ReturnSchemaCommandRecord {
  return {
    fullName: row.full_name,
    groupPath: row.group_path,
    commandName: row.command_name,
    className: row.class_name,
    methodName: row.method_name,
    scope: row.scope,
    returnKind: row.return_kind,
    status: row.status,
    schemaHash: row.schema_hash,
    schemaJson: row.schema_json,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    updatedAt: row.updated_at,
    typedAt: row.typed_at,
    validatedAt: row.validated_at,
    reviewedAt: row.reviewed_at,
    removedAt: row.removed_at,
    owner: row.owner,
    taskId: row.task_id,
    notes: row.notes,
  };
}

function currentUntypedPublicCommands(registry: RegistrySnapshot): string[] {
  return registry.commands
    .filter((cmd) => !cmd.cliOnly && !cmd.binary && !cmd.returns)
    .map((cmd) => cmd.fullName)
    .sort((a, b) => a.localeCompare(b));
}

function topMissingGroups(missingCommands: string[]): Array<{ group: string; count: number }> {
  const counts = new Map<string, number>();
  for (const name of missingCommands) {
    const group = name.split(".")[0] ?? name;
    counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([group, count]) => ({ group, count }))
    .sort((a, b) => b.count - a.count || a.group.localeCompare(b.group))
    .slice(0, 20);
}

function emptyStatusCounts(): Record<ReturnSchemaStatus, number> {
  return Object.fromEntries(RETURN_SCHEMA_STATUSES.map((status) => [status, 0])) as Record<ReturnSchemaStatus, number>;
}

function emptyKindCounts(): Record<ReturnSchemaKind, number> {
  return Object.fromEntries(RETURN_SCHEMA_KINDS.map((kind) => [kind, 0])) as Record<ReturnSchemaKind, number>;
}

function isoNow(now?: Date): string {
  return (now ?? new Date()).toISOString();
}

function normalizeLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || !limit || limit <= 0) return 50;
  return Math.min(Math.floor(limit), 1000);
}

function normalizeOffset(offset: number | undefined): number {
  if (!Number.isFinite(offset) || !offset || offset < 0) return 0;
  return Math.floor(offset);
}

function cleanOptional(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function assertStatus(value: string): asserts value is ReturnSchemaStatus {
  if (!RETURN_SCHEMA_STATUSES.includes(value as ReturnSchemaStatus)) {
    throw new Error(`Invalid return schema status: ${value}`);
  }
}

function assertKind(value: string): asserts value is ReturnSchemaKind {
  if (!RETURN_SCHEMA_KINDS.includes(value as ReturnSchemaKind)) {
    throw new Error(`Invalid return schema kind: ${value}`);
  }
}
