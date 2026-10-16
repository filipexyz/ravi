/**
 * Library pins in `ravi.db` (spec skills/library).
 *
 * `library_pins` holds the pins of this installation as the last successful
 * sync returned them, one row per (agent, Library id). `library_pin_state`
 * (one row) holds the installation, the Console revision, the fingerprint of
 * what was applied and the generated plugin directory. A sync replaces every
 * row at once; a failed sync never touches them.
 */

import { getDb } from "../router/router-db.js";
import type { LibraryItem } from "./types.js";

export interface LibraryPinRow {
  agentId: string;
  /** `org:<slug>` or `project:<projectSlug>:<slug>`. */
  libraryId: string;
  /** `org/<slug>` or `<projectSlug>/<slug>`. */
  ref: string;
  /** Directory and frontmatter name of the skill in the generated `ravi-library` plugin. */
  skillName: string;
  version: number;
  contentHash: string | null;
  externalAllowed: boolean;
  item: LibraryItem;
  syncedAt: number;
}

export interface LibraryPinState {
  consoleUrl: string | null;
  organizationId: string | null;
  installationId: string | null;
  installationName: string | null;
  /** The Console's revision of the pins applied. */
  revision: string | null;
  /** Hash of what was applied (agent, id, version, content hash, externalAllowed per pin). */
  fingerprint: string | null;
  /** The generated plugin generation directory, or null when there are no pins. */
  pluginDir: string | null;
  /** Last successful sync (pins applied or confirmed unchanged). */
  syncedAt: number | null;
  /** Last attempt, successful or not. */
  checkedAt: number | null;
  lastErrorCode: string | null;
  lastErrorAt: number | null;
}

interface PinRow {
  agent_id: string;
  library_id: string;
  ref: string;
  skill_name: string;
  version: number;
  content_hash: string | null;
  external_allowed: number;
  item_json: string;
  synced_at: number;
}

interface StateRow {
  console_url: string | null;
  organization_id: string | null;
  installation_id: string | null;
  installation_name: string | null;
  revision: string | null;
  fingerprint: string | null;
  plugin_dir: string | null;
  synced_at: number | null;
  checked_at: number | null;
  last_error_code: string | null;
  last_error_at: number | null;
}

function rowToPin(row: PinRow): LibraryPinRow | null {
  let item: LibraryItem;
  try {
    item = JSON.parse(row.item_json) as LibraryItem;
  } catch {
    return null;
  }
  return {
    agentId: row.agent_id,
    libraryId: row.library_id,
    ref: row.ref,
    skillName: row.skill_name,
    version: row.version,
    contentHash: row.content_hash,
    externalAllowed: row.external_allowed === 1,
    item,
    syncedAt: row.synced_at,
  };
}

export function dbListLibraryPins(): LibraryPinRow[] {
  const rows = getDb().prepare("SELECT * FROM library_pins ORDER BY agent_id, library_id").all() as PinRow[];
  return rows.map(rowToPin).filter((row): row is LibraryPinRow => row !== null);
}

export function dbListLibraryPinsForAgent(agentId: string): LibraryPinRow[] {
  const id = agentId?.trim();
  if (!id) return [];
  const rows = getDb().prepare("SELECT * FROM library_pins WHERE agent_id = ? ORDER BY library_id").all(id) as PinRow[];
  return rows.map(rowToPin).filter((row): row is LibraryPinRow => row !== null);
}

/**
 * The agent's pins for authorization and the skill allowlist: the Library ids
 * (they authorize like a grant) and the plugin skill names. Never throws: an
 * unreadable table means no pins.
 */
export function readAgentLibraryPins(agentId: string): { libraryIds: string[]; skillNames: string[] } {
  try {
    const rows = dbListLibraryPinsForAgent(agentId);
    return {
      libraryIds: [...new Set(rows.map((row) => row.libraryId))],
      skillNames: [...new Set(rows.map((row) => row.skillName))],
    };
  } catch {
    return { libraryIds: [], skillNames: [] };
  }
}

export function dbGetLibraryPinState(): LibraryPinState | null {
  const row = getDb().prepare("SELECT * FROM library_pin_state WHERE id = 1").get() as StateRow | null;
  if (!row) return null;
  return {
    consoleUrl: row.console_url,
    organizationId: row.organization_id,
    installationId: row.installation_id,
    installationName: row.installation_name,
    revision: row.revision,
    fingerprint: row.fingerprint,
    pluginDir: row.plugin_dir,
    syncedAt: row.synced_at,
    checkedAt: row.checked_at,
    lastErrorCode: row.last_error_code,
    lastErrorAt: row.last_error_at,
  };
}

export interface ReplaceLibraryPinsInput {
  consoleUrl: string;
  organizationId: string;
  installationId: string;
  installationName: string | null;
  revision: string;
  fingerprint: string;
  pluginDir: string | null;
  pins: Array<Omit<LibraryPinRow, "syncedAt">>;
  now?: number;
}

/** Replace every pin and the state row in one transaction. */
export function dbReplaceLibraryPins(input: ReplaceLibraryPinsInput): void {
  const db = getDb();
  const now = input.now ?? Date.now();
  const insert = db.prepare(
    `INSERT INTO library_pins
       (agent_id, library_id, ref, skill_name, version, content_hash, external_allowed, item_json, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    db.prepare("DELETE FROM library_pins").run();
    for (const pin of input.pins) {
      insert.run(
        pin.agentId,
        pin.libraryId,
        pin.ref,
        pin.skillName,
        pin.version,
        pin.contentHash,
        pin.externalAllowed ? 1 : 0,
        JSON.stringify(pin.item),
        now,
      );
    }
    db.prepare(
      `INSERT INTO library_pin_state
         (id, console_url, organization_id, installation_id, installation_name, revision, fingerprint,
          plugin_dir, synced_at, checked_at, last_error_code, last_error_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
       ON CONFLICT(id) DO UPDATE SET
         console_url = excluded.console_url,
         organization_id = excluded.organization_id,
         installation_id = excluded.installation_id,
         installation_name = excluded.installation_name,
         revision = excluded.revision,
         fingerprint = excluded.fingerprint,
         plugin_dir = excluded.plugin_dir,
         synced_at = excluded.synced_at,
         checked_at = excluded.checked_at,
         last_error_code = NULL,
         last_error_at = NULL`,
    ).run(
      input.consoleUrl,
      input.organizationId,
      input.installationId,
      input.installationName,
      input.revision,
      input.fingerprint,
      input.pluginDir,
      now,
      now,
    );
  })();
}

/** A sync that found nothing new: only the timestamps (and the installation name) move. */
export function dbTouchLibraryPinState(input: { installationName?: string | null; now?: number }): void {
  const now = input.now ?? Date.now();
  getDb()
    .prepare(
      `UPDATE library_pin_state
          SET synced_at = ?, checked_at = ?, last_error_code = NULL, last_error_at = NULL,
              installation_name = COALESCE(?, installation_name)
        WHERE id = 1`,
    )
    .run(now, now, input.installationName ?? null);
}

/** A failed sync: the pins stay as they are; only the error is recorded. */
export function dbRecordLibraryPinError(code: string, now = Date.now()): void {
  getDb()
    .prepare(
      `INSERT INTO library_pin_state (id, checked_at, last_error_code, last_error_at)
       VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         checked_at = excluded.checked_at,
         last_error_code = excluded.last_error_code,
         last_error_at = excluded.last_error_at`,
    )
    .run(now, code, now);
}
