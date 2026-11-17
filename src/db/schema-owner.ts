import type { Database } from "bun:sqlite";
import packageInfo from "../../package.json" with { type: "json" };
import { isInstalledOperatorCli, isSchemaConsumerOf, type DatabaseBoundaryOptions } from "./state-boundary.js";
import { PREPARE_STATE_COMMAND } from "./state-readiness.js";
import { withSchemaMigrationLock } from "./schema-lock.js";
import {
  assertThreadFenceSchemaWriteAllowed,
  installThreadFenceTriggers,
  prepareRegisteredThreadFence,
  runThreadMutation,
  usesThreadSchemaFence,
} from "../threads/schema-fence.js";

// A channel runner must use the exact release whose daemon prepared the stores.
export const STATE_SCHEMA_VERSION = `1:${packageInfo.version}`;
const initialized = new WeakMap<Database, Set<string>>();

/** Journal changes participate in schema exclusion, including first-file boot. */
export function configureStateJournalMode(db: Database, boundary?: DatabaseBoundaryOptions): void {
  if (isSchemaConsumerOf(db.filename, boundary)) return;
  withSchemaMigrationLock(db, () => {
    prepareRegisteredThreadFence(db);
    assertThreadFenceSchemaWriteAllowed(db);
    db.exec("PRAGMA journal_mode = WAL");
  });
}

export class StateSchemaNotReadyError extends Error {
  readonly code = "STATE_SCHEMA_NOT_READY";
  constructor(component: string, options?: ErrorOptions & { operatorCli?: boolean }) {
    super(
      options?.operatorCli
        ? `STATE_SCHEMA_NOT_READY: ${component} is not prepared for this release. The installed daemon prepares state when it starts: run \`${PREPARE_STATE_COMMAND}\`, then retry. The CLI never migrates state.`
        : `STATE_SCHEMA_NOT_READY: ${component} is not initialized for this release. Start the installed daemon first, then start ravi-channels with the same release. The channel runner will not migrate state.`,
      options,
    );
  }
}

export function assertStateSchemaReady(db: Database, component: string, boundary?: DatabaseBoundaryOptions): void {
  assertThreadFenceSchemaWriteAllowed(db);
  // Who is told what to do next: the operator at a terminal, or whoever starts the channel runner.
  const operatorCli = isInstalledOperatorCli(boundary);
  try {
    const row = db.query("SELECT version FROM state_schema_versions WHERE component = ?").get(component) as {
      version: string;
    } | null;
    if (row?.version === STATE_SCHEMA_VERSION) return;
  } catch (error) {
    throw new StateSchemaNotReadyError(component, { cause: error, operatorCli });
  }
  throw new StateSchemaNotReadyError(component, { operatorCli });
}

/** Called only after guarded open. The consumer never executes the callback. */
export function initializeStateSchema(
  db: Database,
  component: string,
  initialize: () => void,
  boundary?: DatabaseBoundaryOptions,
): void {
  if (isSchemaConsumerOf(db.filename, boundary)) {
    assertStateSchemaReady(db, component, boundary);
    return;
  }
  prepareRegisteredThreadFence(db);
  assertThreadFenceSchemaWriteAllowed(db);
  if (initialized.get(db)?.has(component)) return;
  withSchemaMigrationLock(db, () => {
    assertThreadFenceSchemaWriteAllowed(db);
    // Invalidate under the same lock as migration and readiness publication.
    // No outer SQL transaction: migrations own their BEGIN/COMMIT and FK mode.
    db.exec("CREATE TABLE IF NOT EXISTS state_schema_versions (component TEXT PRIMARY KEY, version TEXT NOT NULL)");
    installThreadFenceTriggers(db);
    const markerWrite = (sql: string, ...values: string[]) =>
      usesThreadSchemaFence(db) ? runThreadMutation(db, sql, ...values) : db.query(sql).run(...values);
    markerWrite("DELETE FROM state_schema_versions WHERE component = ?", component);
    try {
      initialize();
    } finally {
      // A failed initializer may have created tables before throwing. Keep
      // those tables fenced too, while leaving the ready marker absent.
      installThreadFenceTriggers(db);
    }
    markerWrite(
      `INSERT INTO state_schema_versions (component, version) VALUES (?, ?)
      ON CONFLICT(component) DO UPDATE SET version = excluded.version`,
      component,
      STATE_SCHEMA_VERSION,
    );
  });
  const components = initialized.get(db) ?? new Set<string>();
  components.add(component);
  initialized.set(db, components);
}
