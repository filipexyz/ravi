import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { prepareThreadFence, registerThreadFenceConnection } from "../threads/schema-fence.js";

/** Isolated fake-PM2 fixture: preparation exists before testing a native restart. */
export function seedPreparedThreadState(stateDir: string): void {
  mkdirSync(stateDir, { recursive: true });
  const db = new Database(join(stateDir, "ravi.db"));
  try {
    registerThreadFenceConnection(db);
    prepareThreadFence(db);
  } finally {
    db.close();
  }
}

export function preparedThreadStateTables(stateDir: string): string[] {
  const db = new Database(join(stateDir, "ravi.db"), { readonly: true, create: false });
  try {
    return (
      db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]
    ).map((row) => row.name);
  } finally {
    db.close();
  }
}
