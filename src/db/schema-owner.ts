import type { Database } from "bun:sqlite";
import packageInfo from "../../package.json" with { type: "json" };
import { isSchemaConsumer, type DatabaseBoundaryOptions } from "./state-boundary.js";
import { withSchemaMigrationLock } from "./schema-lock.js";

// A channel runner must use the exact release whose daemon prepared the stores.
export const STATE_SCHEMA_VERSION = `1:${packageInfo.version}`;
const initialized = new WeakMap<Database, Set<string>>();

/** Journal changes participate in schema exclusion, including first-file boot. */
export function configureStateJournalMode(db: Database): void {
  if (isSchemaConsumer()) return;
  withSchemaMigrationLock(db, () => db.exec("PRAGMA journal_mode = WAL"));
}

export class StateSchemaNotReadyError extends Error {
  readonly code = "STATE_SCHEMA_NOT_READY";
  constructor(component: string, options?: ErrorOptions) {
    super(
      `STATE_SCHEMA_NOT_READY: ${component} is not initialized for this release. Start the installed daemon first, then start ravi-channels with the same release. The channel runner will not migrate state.`,
      options,
    );
  }
}

export function assertStateSchemaReady(db: Database, component: string): void {
  try {
    const row = db.query("SELECT version FROM state_schema_versions WHERE component = ?").get(component) as {
      version: string;
    } | null;
    if (row?.version === STATE_SCHEMA_VERSION) return;
  } catch (error) {
    throw new StateSchemaNotReadyError(component, { cause: error });
  }
  throw new StateSchemaNotReadyError(component);
}

/** Called only after guarded open. The consumer never executes the callback. */
export function initializeStateSchema(
  db: Database,
  component: string,
  initialize: () => void,
  boundary?: DatabaseBoundaryOptions,
): void {
  if (isSchemaConsumer(boundary)) {
    assertStateSchemaReady(db, component);
    return;
  }
  if (initialized.get(db)?.has(component)) return;
  withSchemaMigrationLock(db, () => {
    // Invalidate under the same lock as migration and readiness publication.
    // No outer SQL transaction: migrations own their BEGIN/COMMIT and FK mode.
    db.exec("CREATE TABLE IF NOT EXISTS state_schema_versions (component TEXT PRIMARY KEY, version TEXT NOT NULL)");
    db.query("DELETE FROM state_schema_versions WHERE component = ?").run(component);
    initialize();
    db.query(`INSERT INTO state_schema_versions (component, version) VALUES (?, ?)
      ON CONFLICT(component) DO UPDATE SET version = excluded.version`).run(component, STATE_SCHEMA_VERSION);
  });
  const components = initialized.get(db) ?? new Set<string>();
  components.add(component);
  initialized.set(db, components);
}
