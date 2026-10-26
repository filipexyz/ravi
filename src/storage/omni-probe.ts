/**
 * Omni status@broadcast probe.
 *
 * The matcher needs the canonical Omni message rows: which `external_id` was a
 * status@broadcast media item and where Omni stored it. Omni exposes no HTTP
 * listing for arbitrary media paths, so the probe reads its PostgreSQL
 * database **read-only**. Any failure (missing config, unreachable database,
 * malformed row) returns an error and the storage engine preserves every file.
 *
 * The async loader runs once in the CLI; the scan itself stays synchronous and
 * receives a plain view of the rows. Tests inject the same view without a
 * database.
 */

import { existsSync, readFileSync } from "node:fs";
import { SQL } from "bun";
import type { StoragePolicy } from "./policy.js";
import type { OmniBroadcastMedia, OmniBroadcastProbe, OmniBroadcastProbeResult } from "./types.js";

export function staticOmniProbe(result: OmniBroadcastProbeResult): OmniBroadcastProbe {
  return { listStatusBroadcastMedia: () => result };
}

interface RawRow {
  external_id?: unknown;
  media_local_path?: unknown;
  platform_timestamp?: unknown;
  externalId?: unknown;
  localPath?: unknown;
  postedAt?: unknown;
}

function coerceRow(row: RawRow): OmniBroadcastMedia | null {
  const externalId = String(row.external_id ?? row.externalId ?? "").trim();
  const localPath = String(row.media_local_path ?? row.localPath ?? "")
    .trim()
    .replace(/^\.\//, "");
  const rawStamp = row.platform_timestamp ?? row.postedAt;
  const postedAt =
    rawStamp instanceof Date
      ? rawStamp.getTime()
      : typeof rawStamp === "number"
        ? rawStamp
        : typeof rawStamp === "string"
          ? new Date(rawStamp).getTime()
          : Number.NaN;
  if (!externalId || !localPath || !Number.isFinite(postedAt)) return null;
  return { externalId, localPath, postedAt };
}

function readFixtureRows(path: string): OmniBroadcastProbeResult {
  try {
    if (!existsSync(path)) return { rows: [], error: `fixture not found (${path})` };
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const list = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { rows?: unknown }).rows)
        ? (parsed as { rows: unknown[] }).rows
        : null;
    if (!list) return { rows: [], error: "fixture is not an array of rows" };
    const rows = list.map((row) => coerceRow(row as RawRow)).filter((row): row is OmniBroadcastMedia => row !== null);
    return { rows };
  } catch (error) {
    return { rows: [], error: error instanceof Error ? error.message : String(error) };
  }
}

/** Read the Omni database URL from the canonical Omni config file. */
export function readOmniDatabaseUrl(configPath: string | null): string | null {
  if (!configPath) return null;
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as {
      server?: { databaseUrl?: unknown };
      databaseUrl?: unknown;
    };
    const url = parsed.server?.databaseUrl ?? parsed.databaseUrl;
    return typeof url === "string" && url.trim() ? url.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Load the status@broadcast media rows. Never throws: an unavailable source is
 * an error in the result, which the engine turns into "preserve everything".
 */
export async function loadOmniBroadcastMedia(
  policy: StoragePolicy,
  env: NodeJS.ProcessEnv = process.env,
): Promise<OmniBroadcastProbeResult> {
  if (policy.fixtureMode) {
    const fixture = env.RAVI_STORAGE_FIXTURE_OMNI_DB_JSON?.trim();
    if (!fixture) return { rows: [] };
    return readFixtureRows(fixture);
  }

  const url = readOmniDatabaseUrl(policy.omniConfigPath);
  if (!url) return { rows: [], error: "Omni database URL not configured" };

  const sql = new SQL(url, { max: 1, idleTimeout: 5, connectionTimeout: 5 });
  try {
    const rows = (await sql`
      SELECT m.external_id AS external_id,
             m.media_local_path AS media_local_path,
             m.platform_timestamp AS platform_timestamp
      FROM messages m
      JOIN chats c ON c.id = m.chat_id
      WHERE c.external_id = 'status@broadcast'
        AND m.media_local_path IS NOT NULL
        AND m.media_local_path <> ''
    `) as RawRow[];
    return {
      rows: rows.map((row) => coerceRow(row)).filter((row): row is OmniBroadcastMedia => row !== null),
    };
  } catch (error) {
    return { rows: [], error: error instanceof Error ? error.message : String(error) };
  } finally {
    await sql.close().catch(() => undefined);
  }
}
