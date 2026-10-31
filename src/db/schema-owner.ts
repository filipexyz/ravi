import type { Database } from "bun:sqlite";
import { version } from "../../package.json";
import { isSchemaConsumer, type DatabaseBoundaryOptions } from "./state-boundary.js";

// A channel runner must use the exact release whose daemon prepared the stores.
export const STATE_SCHEMA_VERSION = `1:${version}`;
const initialized = new WeakMap<Database, Set<string>>();

export class StateSchemaNotReadyError extends Error {
  readonly code = "STATE_SCHEMA_NOT_READY";
  constructor(component: string) {
    super(
      `STATE_SCHEMA_NOT_READY: ${component} is not initialized for this release. Start the installed daemon first, then start ravi-channels with the same release. The channel runner will not migrate state.`,
    );
  }
}

export function assertStateSchemaReady(db: Database, component: string): void {
  try {
    const row = db.query("SELECT version FROM state_schema_versions WHERE component = ?").get(component) as {
      version: string;
    } | null;
    if (row?.version === STATE_SCHEMA_VERSION) return;
  } catch {
    // Missing marker/table means the owner has not completed initialization.
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
  if (initialized.get(db)?.has(component)) return;
  if (isSchemaConsumer(boundary)) {
    assertStateSchemaReady(db, component);
  } else {
    // Invalidate before migrating: a failed/partial initialization cannot look ready.
    db.exec("CREATE TABLE IF NOT EXISTS state_schema_versions (component TEXT PRIMARY KEY, version TEXT NOT NULL)");
    db.query("DELETE FROM state_schema_versions WHERE component = ?").run(component);
    initialize();
    db.query("INSERT INTO state_schema_versions (component, version) VALUES (?, ?)").run(
      component,
      STATE_SCHEMA_VERSION,
    );
  }
  const components = initialized.get(db) ?? new Set<string>();
  components.add(component);
  initialized.set(db, components);
}
