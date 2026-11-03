import { readFileSync } from "node:fs";
import { constants } from "node:os";
import type { Sql } from "postgres";

export const INBOX_BASELINE_WHEN = 1_778_880_220_472;
export const INBOX_INSTALLATION_REQUIRED_WHEN = 1_778_971_040_001;

type SnapshotColumn = {
  name: string;
  type: string;
  typeSchema?: string;
  primaryKey: boolean;
  notNull: boolean;
  default?: string | number;
};
type SnapshotTable = {
  columns: Record<string, SnapshotColumn>;
  foreignKeys: Record<string, {
    tableTo: string;
    columnsFrom: string[];
    columnsTo: string[];
    onDelete: string;
    onUpdate: string;
  }>;
  indexes: Record<string, {
    isUnique: boolean;
    method: string;
    columns: { expression: string; isExpression: boolean; asc: boolean; nulls: string }[];
    where?: string;
  }>;
};
type Snapshot = {
  tables: Record<string, SnapshotTable>;
  enums: Record<string, { values: string[] }>;
};

// These snapshots describe the missing historical SQL, not a newly generated
// schema baseline. All the normal migrations still run through Drizzle.
const snapshot = JSON.parse(readFileSync(
  new URL("../../drizzle/meta/0008_snapshot.json", import.meta.url), "utf8",
)) as Snapshot;
const requiredSnapshot = JSON.parse(readFileSync(
  new URL("../../drizzle/meta/0011_snapshot.json", import.meta.url), "utf8",
)) as Snapshot;
const tableNames = [
  "agent_inbox_items", "agent_inbox_subscriptions", "agent_inbox_receipts", "agent_inbox_watermarks",
] as const;
const enumNames = Object.keys(snapshot.enums)
  .filter((name) => name.startsWith("public.agent_inbox_"))
  .map((name) => name.slice("public.".length));

export type InboxCatalogState = {
  latestMigration: number | null;
  publicTableCount: number;
  tables: Record<string, {
    columns: Record<string, {
      type: string;
      typeSchema: string;
      notNull: boolean;
      primaryKey: boolean;
      default: string | null;
      ownedSequence: boolean;
    }>;
    foreignKeys: Record<string, {
      tableTo: string;
      schemaTo: string;
      columnsFrom: string[];
      columnsTo: string[];
      onDelete: string;
      onUpdate: string;
      validated: boolean;
      deferrable: boolean;
      matchType: string;
    }>;
    indexes: Record<string, {
      unique: boolean;
      method: string;
      columns: { name: string | null; asc: boolean; nulls: string }[];
      predicate: string | null;
      valid: boolean;
      ready: boolean;
      includeCount: number;
    }>;
  }>;
  enums: Record<string, string[]>;
};

export class InboxMigrationDriftError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Inbox migration drift: ${issues.join("; ")}. No automatic repair or migration marker was applied.`);
    this.name = "InboxMigrationDriftError";
  }
}

const pgTypes: Record<string, string> = {
  bigserial: "int8", bigint: "int8", integer: "int4", "timestamp with time zone": "timestamptz",
};

function normalizedDefault(value: string | number) {
  return String(value).replace(/::(?:"?public"?\.)?"?[a-z_][a-z_0-9]*"?(?:\[\])?/gi, "");
}

function sameList(left: unknown[], right: unknown[]) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** PostgreSQL NAMEDATALEN=64: identifiers retain at most 63 complete UTF-8 bytes. */
export function postgresIdentifier(name: string) {
  let bytes = 0;
  let identifier = "";
  for (const character of name) {
    bytes += Buffer.byteLength(character, "utf8");
    if (bytes > 63) break;
    identifier += character;
  }
  return identifier;
}

/** Pure validation: never creates, repairs, deletes or marks any database object. */
export function assertInboxMigrationState(state: InboxCatalogState, phase: "preflight" | "postflight") {
  const issues: string[] = [];
  const latest = state.latestMigration;
  if (latest !== null && (!Number.isSafeInteger(latest) || latest < 0)) {
    throw new InboxMigrationDriftError(["invalid migration high-water mark"]);
  }
  const hasInboxObjects = tableNames.some((name) => !!state.tables[name]) ||
    enumNames.some((name) => !!state.enums[name]);
  if (phase === "preflight" && (latest === null || latest < INBOX_BASELINE_WHEN)) {
    if (latest === null && state.publicTableCount !== 0) {
      issues.push("public tables exist without migration history");
    }
    if (hasInboxObjects) issues.push("inbox objects exist before their pending baseline migration");
    if (issues.length) throw new InboxMigrationDriftError(issues);
    return;
  }
  if (phase === "postflight" && (latest === null || latest < INBOX_INSTALLATION_REQUIRED_WHEN)) {
    issues.push("migration history did not reach the inbox repairs");
  }
  const requireInstallation = phase === "postflight" ||
    (latest !== null && latest >= INBOX_INSTALLATION_REQUIRED_WHEN);
  for (const name of enumNames) {
    if (!sameList(state.enums[name] ?? [], snapshot.enums[`public.${name}`]!.values)) {
      issues.push(`enum public.${name} missing or labels/order differ`);
    }
  }
  for (const name of tableNames) {
    const actual = state.tables[name];
    const expected = snapshot.tables[`public.${name}`]!;
    if (!actual) { issues.push(`table public.${name} missing`); continue; }
    for (const [columnName, column] of Object.entries(expected.columns)) {
      const found = actual.columns[columnName];
      const path = `${name}.${columnName}`;
      if (!found) { issues.push(`column ${path} missing`); continue; }
      if (found.type !== (pgTypes[column.type] ?? column.type) ||
          found.typeSchema !== (column.typeSchema ?? "pg_catalog")) issues.push(`column ${path} type differs`);
      const installationColumn = name === "agent_inbox_subscriptions" && columnName === "local_installation_id";
      const expectedNotNull = installationColumn && requireInstallation
        ? requiredSnapshot.tables[`public.${name}`]!.columns[columnName]!.notNull : column.notNull;
      // A database already tightened before the pending NOT NULL repair is safe.
      if (found.notNull !== expectedNotNull && !(installationColumn && !requireInstallation && found.notNull)) {
        issues.push(`column ${path} nullability differs`);
      }
      if (found.primaryKey !== column.primaryKey) issues.push(`column ${path} primary key differs`);
      if (column.type === "bigserial") {
        if (!found.ownedSequence || !found.default?.startsWith("nextval(")) issues.push(`column ${path} serial sequence missing`);
      } else if (column.default === undefined ? found.default !== null :
        found.default === null || normalizedDefault(found.default) !== normalizedDefault(column.default)) {
        issues.push(`column ${path} default differs`);
      }
    }
    for (const [key, foreignKey] of Object.entries(expected.foreignKeys)) {
      const found = actual.foreignKeys[postgresIdentifier(key)];
      if (!found || found.tableTo !== foreignKey.tableTo || found.schemaTo !== "public" ||
          !sameList(found.columnsFrom, foreignKey.columnsFrom) || !sameList(found.columnsTo, foreignKey.columnsTo) ||
          found.onDelete !== foreignKey.onDelete || found.onUpdate !== foreignKey.onUpdate ||
          !found.validated || found.deferrable || found.matchType !== "s") issues.push(`foreign key ${key} missing or differs`);
    }
    for (const [key, index] of Object.entries(expected.indexes)) {
      const found = actual.indexes[postgresIdentifier(key)];
      if (!found || found.unique !== index.isUnique || found.method !== index.method ||
          found.predicate !== (index.where ?? null) || !found.valid || !found.ready || found.includeCount !== 0 ||
          index.columns.some((column) => column.isExpression) || !sameList(found.columns,
            index.columns.map((column) => ({ name: column.expression, asc: column.asc, nulls: column.nulls })))) {
        issues.push(`index ${key} missing or differs`);
      }
    }
  }
  if (issues.length) throw new InboxMigrationDriftError(issues);
}

/** Read catalog metadata only, using the caller's already-held migration lock. */
export async function readInboxCatalogState(sql: Sql): Promise<InboxCatalogState> {
  const [history] = await sql<{ present: boolean }[]>`
    SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present`;
  const latest = history?.present
    ? (await sql<{ latest: string | null }[]>`SELECT max(created_at)::text AS latest FROM drizzle.__drizzle_migrations`)[0]?.latest
    : null;
  const [count] = await sql<{ count: number }[]>`
    SELECT count(*)::integer AS count FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`;
  const state: InboxCatalogState = {
    latestMigration: latest == null ? null : Number(latest), publicTableCount: count?.count ?? 0, tables: {}, enums: {},
  };
  const tables = await sql<{ name: string }[]>`
    SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname = ANY(${sql.array([...tableNames])})`;
  for (const table of tables) state.tables[table.name] = { columns: {}, foreignKeys: {}, indexes: {} };
  const columns = await sql<({ table: string; name: string } & InboxCatalogState["tables"][string]["columns"][string])[]>`
    SELECT c.relname AS "table", a.attname AS name, t.typname AS type, tn.nspname AS "typeSchema",
      a.attnotnull AS "notNull", pg_get_expr(d.adbin, d.adrelid) AS "default",
      EXISTS (SELECT 1 FROM pg_constraint p WHERE p.conrelid = c.oid AND p.contype = 'p' AND a.attnum = ANY(p.conkey)) AS "primaryKey",
      pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname) IS NOT NULL AS "ownedSequence"
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    JOIN pg_type t ON t.oid = a.atttypid JOIN pg_namespace tn ON tn.oid = t.typnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname = ANY(${sql.array([...tableNames])})`;
  for (const { table, name, ...column } of columns) state.tables[table]!.columns[name] = column;
  const enums = await sql<{ name: string; values: string[] }[]>`
    SELECT t.typname AS name, array_agg(e.enumlabel ORDER BY e.enumsortorder) AS "values"
    FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE n.nspname = 'public' AND t.typname = ANY(${sql.array(enumNames)}) GROUP BY t.typname`;
  for (const value of enums) state.enums[value.name] = value.values;
  const foreignKeys = await sql<({ table: string; name: string } & InboxCatalogState["tables"][string]["foreignKeys"][string])[]>`
    SELECT c.relname AS "table", f.conname AS name, target.relname AS "tableTo", target_ns.nspname AS "schemaTo",
      ARRAY(SELECT a.attname FROM unnest(f.conkey) WITH ORDINALITY k(attnum, pos)
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum ORDER BY k.pos) AS "columnsFrom",
      ARRAY(SELECT a.attname FROM unnest(f.confkey) WITH ORDINALITY k(attnum, pos)
        JOIN pg_attribute a ON a.attrelid = target.oid AND a.attnum = k.attnum ORDER BY k.pos) AS "columnsTo",
      CASE f.confdeltype WHEN 'c' THEN 'cascade' WHEN 'n' THEN 'set null' WHEN 'a' THEN 'no action'
        WHEN 'r' THEN 'restrict' WHEN 'd' THEN 'set default' END AS "onDelete",
      CASE f.confupdtype WHEN 'c' THEN 'cascade' WHEN 'n' THEN 'set null' WHEN 'a' THEN 'no action'
        WHEN 'r' THEN 'restrict' WHEN 'd' THEN 'set default' END AS "onUpdate",
      f.convalidated AS validated, f.condeferrable AS deferrable, f.confmatchtype::text AS "matchType"
    FROM pg_constraint f JOIN pg_class c ON c.oid = f.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_class target ON target.oid = f.confrelid JOIN pg_namespace target_ns ON target_ns.oid = target.relnamespace
    WHERE f.contype = 'f' AND n.nspname = 'public' AND c.relname = ANY(${sql.array([...tableNames])})`;
  for (const { table, name, ...key } of foreignKeys) state.tables[table]!.foreignKeys[name] = key;
  const indexes = await sql<({ table: string; name: string } & InboxCatalogState["tables"][string]["indexes"][string])[]>`
    SELECT c.relname AS "table", ic.relname AS name, i.indisunique AS "unique", am.amname AS method,
      (SELECT json_agg(json_build_object('name', a.attname, 'asc', (i.indoption[k.pos::integer - 1] & 1) = 0,
        'nulls', CASE WHEN (i.indoption[k.pos::integer - 1] & 2) = 0 THEN 'last' ELSE 'first' END) ORDER BY k.pos)
       FROM unnest(i.indkey) WITH ORDINALITY k(attnum, pos)
       LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
       WHERE k.pos <= i.indnkeyatts) AS columns,
      pg_get_expr(i.indpred, i.indrelid) AS predicate, i.indisvalid AS valid, i.indisready AS ready,
      (i.indnatts - i.indnkeyatts)::integer AS "includeCount"
    FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_class ic ON ic.oid = i.indexrelid JOIN pg_am am ON am.oid = ic.relam
    WHERE n.nspname = 'public' AND c.relname = ANY(${sql.array([...tableNames])})`;
  for (const { table, name, ...index } of indexes) state.tables[table]!.indexes[name] = index;
  return state;
}

export class MigrationCommandError extends Error {
  constructor(message: string, public readonly exitCode: number) { super(message); this.name = "MigrationCommandError"; }
}

export function migrationCommandFailure(code: number | null, signal: NodeJS.Signals | null) {
  if (signal) return new MigrationCommandError(`Database migration command terminated by ${signal}.`, 128 + constants.signals[signal]);
  if (code === 0) return null;
  return new MigrationCommandError(`Database migration command exited with ${code ?? "no exit status"}.`, code ?? 1);
}
