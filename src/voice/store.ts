/**
 * voice.db: calls, stored call events, turns, profiles, devices, daily usage and
 * short-lived synthesized clips. Owned by the daemon like every runtime store.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Database } from "bun:sqlite";
import { configureStateJournalMode, initializeStateSchema } from "../db/schema-owner.js";
import { assertDatabaseTargetAllowed, openStateDatabase } from "../db/state-boundary.js";
import { executeWrite } from "../db/write-retry.js";
import { getRaviStateDir } from "../utils/paths.js";
import {
  DEFAULT_VOICE_LIMITS,
  DEFAULT_VOICE_PROFILE_ID,
  emptyVoiceUsage,
  type VoiceAgentState,
  type VoiceCall,
  type VoiceCallState,
  type VoiceDevice,
  type VoiceEvent,
  type VoiceEventType,
  type VoiceProfile,
  type VoiceSpeaker,
  type VoiceTurn,
  type VoiceUsage,
} from "./types.js";

let db: Database | null = null;
let dbPath: string | null = null;

export function getVoiceDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getRaviStateDir(env), "voice.db");
}

function getVoiceDb(): Database {
  const path = getVoiceDbPath();
  assertDatabaseTargetAllowed(path);
  if (db && dbPath === path) return db;
  closeVoiceDb();
  mkdirSync(dirname(path), { recursive: true });
  const opened = openStateDatabase(path);
  try {
    configureStateJournalMode(opened);
    opened.exec("PRAGMA busy_timeout = 5000");
    opened.exec("PRAGMA foreign_keys = ON");
  } catch (error) {
    try {
      opened.close();
    } catch {
      // no-cause: Cleanup must not replace the setup error rethrown below; the handle was never cached.
    }
    throw error;
  }
  db = opened;
  dbPath = path;
  return db;
}

export function closeVoiceDb(): void {
  if (!db) return;
  db.close();
  db = null;
  dbPath = null;
}

export function ensureVoiceSchema(): void {
  initializeStateSchema(getVoiceDb(), "voice", migrateVoiceSchema);
}

function migrateVoiceSchema(): void {
  getVoiceDb().exec(`
    CREATE TABLE IF NOT EXISTS voice_calls (
      id TEXT PRIMARY KEY,
      session_key TEXT NOT NULL,
      session_name TEXT NOT NULL,
      agent_id TEXT,
      mode TEXT NOT NULL,
      engine TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      state TEXT NOT NULL,
      agent_state TEXT NOT NULL,
      speaker_json TEXT NOT NULL,
      caller_context_id TEXT,
      turn_origin_json TEXT,
      connection_kind TEXT NOT NULL,
      provider_ref TEXT,
      usage_json TEXT NOT NULL,
      ended_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      ended_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_voice_calls_session ON voice_calls(session_key, state);
    CREATE TABLE IF NOT EXISTS voice_events (
      call_id TEXT NOT NULL REFERENCES voice_calls(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      data_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (call_id, seq)
    );
    CREATE TABLE IF NOT EXISTS voice_turns (
      id TEXT PRIMARY KEY,
      call_id TEXT NOT NULL REFERENCES voice_calls(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      speaker_json TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_voice_turns_call ON voice_turns(call_id, created_at);
    CREATE TABLE IF NOT EXISTS voice_profiles (
      id TEXT PRIMARY KEY,
      json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS voice_devices (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      contact_id TEXT NOT NULL,
      sessions_json TEXT NOT NULL,
      context_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER,
      last_seen_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS voice_usage_daily (
      day TEXT PRIMARY KEY,
      cost_usd REAL NOT NULL DEFAULT 0,
      seconds REAL NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS voice_audio (
      call_id TEXT NOT NULL REFERENCES voice_calls(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL,
      mime TEXT NOT NULL,
      bytes BLOB NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (call_id, item_id)
    );
  `);
}

function store(): Database {
  ensureVoiceSchema();
  return getVoiceDb();
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

interface CallRow {
  id: string;
  session_key: string;
  session_name: string;
  agent_id: string | null;
  mode: string;
  engine: string;
  profile_id: string;
  state: string;
  agent_state: string;
  speaker_json: string;
  caller_context_id: string | null;
  turn_origin_json: string | null;
  connection_kind: string;
  provider_ref: string | null;
  usage_json: string;
  ended_reason: string | null;
  created_at: number;
  updated_at: number;
  ended_at: number | null;
}

function rowToCall(row: CallRow): VoiceCall {
  return {
    id: row.id,
    sessionKey: row.session_key,
    sessionName: row.session_name,
    ...(row.agent_id ? { agentId: row.agent_id } : {}),
    mode: row.mode as VoiceCall["mode"],
    engine: row.engine as VoiceCall["engine"],
    profileId: row.profile_id,
    state: row.state as VoiceCallState,
    agentState: row.agent_state as VoiceAgentState,
    speaker: parseJson<VoiceSpeaker>(row.speaker_json, { kind: "operator", id: "operator" }),
    ...(row.caller_context_id ? { callerContextId: row.caller_context_id } : {}),
    ...(row.turn_origin_json ? { turnOrigin: parseJson<Record<string, unknown>>(row.turn_origin_json, {}) } : {}),
    connectionKind: row.connection_kind as VoiceCall["connectionKind"],
    ...(row.provider_ref ? { providerRef: row.provider_ref } : {}),
    usage: { ...emptyVoiceUsage(), ...parseJson<Partial<VoiceUsage>>(row.usage_json, {}) },
    ...(row.ended_reason ? { endedReason: row.ended_reason } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.ended_at ? { endedAt: row.ended_at } : {}),
  };
}

export function newVoiceCallId(): string {
  return `vc_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export function insertVoiceCall(call: VoiceCall): VoiceCall {
  const database = store();
  executeWrite(
    database,
    () => {
      database
        .prepare(
          `INSERT INTO voice_calls (id, session_key, session_name, agent_id, mode, engine, profile_id, state, agent_state,
            speaker_json, caller_context_id, turn_origin_json, connection_kind, provider_ref, usage_json, ended_reason,
            created_at, updated_at, ended_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          call.id,
          call.sessionKey,
          call.sessionName,
          call.agentId ?? null,
          call.mode,
          call.engine,
          call.profileId,
          call.state,
          call.agentState,
          JSON.stringify(call.speaker),
          call.callerContextId ?? null,
          call.turnOrigin ? JSON.stringify(call.turnOrigin) : null,
          call.connectionKind,
          call.providerRef ?? null,
          JSON.stringify(call.usage),
          call.endedReason ?? null,
          call.createdAt,
          call.updatedAt,
          call.endedAt ?? null,
        );
    },
    { label: "voice:insertCall" },
  );
  return call;
}

export function getVoiceCall(id: string): VoiceCall | null {
  const row = store().prepare("SELECT * FROM voice_calls WHERE id = ?").get(id) as CallRow | null;
  return row ? rowToCall(row) : null;
}

export function listVoiceCalls(
  options: { activeOnly?: boolean; sessionKey?: string; limit?: number } = {},
): VoiceCall[] {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (options.activeOnly) where.push("state != 'ended'");
  if (options.sessionKey) {
    where.push("session_key = ?");
    params.push(options.sessionKey);
  }
  params.push(Math.max(1, Math.min(options.limit ?? 50, 500)));
  const rows = store()
    .prepare(
      `SELECT * FROM voice_calls ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`,
    )
    .all(...params) as CallRow[];
  return rows.map(rowToCall);
}

export type VoiceCallPatch = Partial<
  Pick<VoiceCall, "state" | "agentState" | "connectionKind" | "providerRef" | "usage" | "endedReason" | "endedAt">
>;

export function updateVoiceCall(id: string, patch: VoiceCallPatch, now = Date.now()): VoiceCall | null {
  const current = getVoiceCall(id);
  if (!current) return null;
  const next: VoiceCall = { ...current, ...patch, updatedAt: now };
  const database = store();
  executeWrite(
    database,
    () => {
      database
        .prepare(
          `UPDATE voice_calls SET state = ?, agent_state = ?, connection_kind = ?, provider_ref = ?, usage_json = ?,
            ended_reason = ?, ended_at = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          next.state,
          next.agentState,
          next.connectionKind,
          next.providerRef ?? null,
          JSON.stringify(next.usage),
          next.endedReason ?? null,
          next.endedAt ?? null,
          next.updatedAt,
          id,
        );
    },
    { label: "voice:updateCall" },
  );
  return next;
}

/** Active call for one (session, speaker): the spec allows one. */
export function findActiveVoiceCall(sessionKey: string, speakerId: string): VoiceCall | null {
  return (
    listVoiceCalls({ activeOnly: true, sessionKey, limit: 50 }).find((call) => call.speaker.id === speakerId) ?? null
  );
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

interface EventRow {
  call_id: string;
  seq: number;
  type: string;
  data_json: string;
  created_at: number;
}

function rowToEvent(row: EventRow): VoiceEvent {
  return {
    callId: row.call_id,
    seq: row.seq,
    type: row.type as VoiceEventType,
    data: parseJson<Record<string, unknown>>(row.data_json, {}),
    createdAt: row.created_at,
  };
}

export function appendVoiceEvent(
  callId: string,
  type: VoiceEventType,
  data: Record<string, unknown>,
  now = Date.now(),
): VoiceEvent {
  const database = store();
  return executeWrite(
    database,
    () => {
      const row = database
        .prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM voice_events WHERE call_id = ?")
        .get(callId) as {
        seq: number;
      };
      const seq = row.seq + 1;
      database
        .prepare("INSERT INTO voice_events (call_id, seq, type, data_json, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(callId, seq, type, JSON.stringify(data), now);
      return { callId, seq, type, data, createdAt: now };
    },
    { label: "voice:appendEvent" },
  );
}

export function listVoiceEvents(callId: string, options: { after?: number; limit?: number } = {}): VoiceEvent[] {
  const rows = store()
    .prepare("SELECT * FROM voice_events WHERE call_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?")
    .all(callId, Math.max(0, options.after ?? 0), Math.max(1, Math.min(options.limit ?? 500, 5000))) as EventRow[];
  return rows.map(rowToEvent);
}

export function lastVoiceEventSeq(callId: string): number {
  const row = store()
    .prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM voice_events WHERE call_id = ?")
    .get(callId) as {
    seq: number;
  };
  return row.seq;
}

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

interface TurnRow {
  id: string;
  call_id: string;
  text: string;
  speaker_json: string;
  state: string;
  created_at: number;
  completed_at: number | null;
}

function rowToTurn(row: TurnRow): VoiceTurn {
  return {
    id: row.id,
    callId: row.call_id,
    text: row.text,
    speaker: parseJson<VoiceSpeaker>(row.speaker_json, { kind: "operator", id: "operator" }),
    state: row.state as VoiceTurn["state"],
    createdAt: row.created_at,
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
  };
}

export function insertVoiceTurn(turn: VoiceTurn): VoiceTurn {
  const database = store();
  executeWrite(
    database,
    () => {
      database
        .prepare(
          "INSERT INTO voice_turns (id, call_id, text, speaker_json, state, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          turn.id,
          turn.callId,
          turn.text,
          JSON.stringify(turn.speaker),
          turn.state,
          turn.createdAt,
          turn.completedAt ?? null,
        );
    },
    { label: "voice:insertTurn" },
  );
  return turn;
}

export function updateVoiceTurnState(id: string, state: VoiceTurn["state"], now = Date.now()): void {
  const database = store();
  const terminal = state === "done" || state === "failed" || state === "cancelled";
  executeWrite(
    database,
    () => {
      database
        .prepare("UPDATE voice_turns SET state = ?, completed_at = COALESCE(completed_at, ?) WHERE id = ?")
        .run(state, terminal ? now : null, id);
    },
    { label: "voice:updateTurn" },
  );
}

export function getVoiceTurn(id: string): VoiceTurn | null {
  const row = store().prepare("SELECT * FROM voice_turns WHERE id = ?").get(id) as TurnRow | null;
  return row ? rowToTurn(row) : null;
}

export function listVoiceTurns(callId: string): VoiceTurn[] {
  const rows = store()
    .prepare("SELECT * FROM voice_turns WHERE call_id = ? ORDER BY created_at ASC")
    .all(callId) as TurnRow[];
  return rows.map(rowToTurn);
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

export function defaultVoiceProfile(now = Date.now()): VoiceProfile {
  return {
    id: DEFAULT_VOICE_PROFILE_ID,
    label: "Padrão",
    mode: "push",
    language: "pt",
    delivery: "speak",
    allowGuests: false,
    ...DEFAULT_VOICE_LIMITS,
    createdAt: now,
    updatedAt: now,
  };
}

export function getVoiceProfile(id: string): VoiceProfile | null {
  const row = store().prepare("SELECT json FROM voice_profiles WHERE id = ?").get(id) as { json: string } | null;
  if (row) return { ...defaultVoiceProfile(0), ...parseJson<Partial<VoiceProfile>>(row.json, {}), id };
  return id === DEFAULT_VOICE_PROFILE_ID ? defaultVoiceProfile(0) : null;
}

export function listVoiceProfiles(): VoiceProfile[] {
  const rows = store().prepare("SELECT id, json FROM voice_profiles ORDER BY id").all() as Array<{
    id: string;
    json: string;
  }>;
  const profiles = rows.map((row) => ({
    ...defaultVoiceProfile(0),
    ...parseJson<Partial<VoiceProfile>>(row.json, {}),
    id: row.id,
  }));
  if (!profiles.some((profile) => profile.id === DEFAULT_VOICE_PROFILE_ID)) profiles.unshift(defaultVoiceProfile(0));
  return profiles;
}

export function saveVoiceProfile(profile: VoiceProfile): VoiceProfile {
  const database = store();
  executeWrite(
    database,
    () => {
      database
        .prepare(
          `INSERT INTO voice_profiles (id, json, created_at, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
        )
        .run(profile.id, JSON.stringify(profile), profile.createdAt, profile.updatedAt);
    },
    { label: "voice:saveProfile" },
  );
  return profile;
}

export function deleteVoiceProfile(id: string): boolean {
  const database = store();
  return executeWrite(database, () => database.prepare("DELETE FROM voice_profiles WHERE id = ?").run(id).changes > 0, {
    label: "voice:deleteProfile",
  });
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

interface DeviceRow {
  id: string;
  label: string;
  contact_id: string;
  sessions_json: string;
  context_id: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  last_seen_at: number | null;
}

function rowToDevice(row: DeviceRow): VoiceDevice {
  return {
    id: row.id,
    label: row.label,
    contactId: row.contact_id,
    sessions: parseJson<string[]>(row.sessions_json, []),
    contextId: row.context_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
    ...(row.last_seen_at ? { lastSeenAt: row.last_seen_at } : {}),
  };
}

export function newVoiceDeviceId(): string {
  return `vd_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export function insertVoiceDevice(device: VoiceDevice): VoiceDevice {
  const database = store();
  executeWrite(
    database,
    () => {
      database
        .prepare(
          `INSERT INTO voice_devices (id, label, contact_id, sessions_json, context_id, created_at, expires_at, revoked_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          device.id,
          device.label,
          device.contactId,
          JSON.stringify(device.sessions),
          device.contextId,
          device.createdAt,
          device.expiresAt,
          device.revokedAt ?? null,
          device.lastSeenAt ?? null,
        );
    },
    { label: "voice:insertDevice" },
  );
  return device;
}

export function getVoiceDevice(id: string): VoiceDevice | null {
  const row = store().prepare("SELECT * FROM voice_devices WHERE id = ?").get(id) as DeviceRow | null;
  return row ? rowToDevice(row) : null;
}

export function getVoiceDeviceByContextId(contextId: string): VoiceDevice | null {
  const row = store().prepare("SELECT * FROM voice_devices WHERE context_id = ?").get(contextId) as DeviceRow | null;
  return row ? rowToDevice(row) : null;
}

export function listVoiceDevices(options: { includeRevoked?: boolean } = {}): VoiceDevice[] {
  const rows = store()
    .prepare(
      `SELECT * FROM voice_devices ${options.includeRevoked ? "" : "WHERE revoked_at IS NULL"} ORDER BY created_at DESC`,
    )
    .all() as DeviceRow[];
  return rows.map(rowToDevice);
}

export function markVoiceDeviceRevoked(id: string, now = Date.now()): VoiceDevice | null {
  const database = store();
  executeWrite(
    database,
    () => {
      database.prepare("UPDATE voice_devices SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?").run(now, id);
    },
    { label: "voice:revokeDevice" },
  );
  return getVoiceDevice(id);
}

export function touchVoiceDevice(id: string, now = Date.now()): void {
  const database = store();
  executeWrite(
    database,
    () => {
      database.prepare("UPDATE voice_devices SET last_seen_at = ? WHERE id = ?").run(now, id);
    },
    { label: "voice:touchDevice" },
  );
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export function voiceUsageDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function addVoiceDailyUsage(costUsd: number, seconds: number, now = Date.now()): void {
  if (costUsd <= 0 && seconds <= 0) return;
  const database = store();
  executeWrite(
    database,
    () => {
      database
        .prepare(
          `INSERT INTO voice_usage_daily (day, cost_usd, seconds) VALUES (?, ?, ?)
           ON CONFLICT(day) DO UPDATE SET cost_usd = cost_usd + excluded.cost_usd, seconds = seconds + excluded.seconds`,
        )
        .run(voiceUsageDay(now), Math.max(0, costUsd), Math.max(0, seconds));
    },
    { label: "voice:addDailyUsage" },
  );
}

export function getVoiceDailyUsage(now = Date.now()): { day: string; costUsd: number; seconds: number } {
  const day = voiceUsageDay(now);
  const row = store().prepare("SELECT cost_usd, seconds FROM voice_usage_daily WHERE day = ?").get(day) as {
    cost_usd: number;
    seconds: number;
  } | null;
  return { day, costUsd: row?.cost_usd ?? 0, seconds: row?.seconds ?? 0 };
}

// ---------------------------------------------------------------------------
// Synthesized clips (kept only while the call lives)
// ---------------------------------------------------------------------------

export function saveVoiceAudio(
  callId: string,
  itemId: string,
  mime: string,
  bytes: Uint8Array,
  now = Date.now(),
): void {
  const database = store();
  executeWrite(
    database,
    () => {
      database
        .prepare(
          "INSERT OR REPLACE INTO voice_audio (call_id, item_id, mime, bytes, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(callId, itemId, mime, bytes, now);
    },
    { label: "voice:saveAudio" },
  );
}

export function getVoiceAudio(callId: string, itemId: string): { mime: string; bytes: Uint8Array } | null {
  const row = store()
    .prepare("SELECT mime, bytes FROM voice_audio WHERE call_id = ? AND item_id = ?")
    .get(callId, itemId) as {
    mime: string;
    bytes: Uint8Array;
  } | null;
  return row ? { mime: row.mime, bytes: new Uint8Array(row.bytes) } : null;
}

export function deleteVoiceAudioForCall(callId: string): void {
  const database = store();
  executeWrite(
    database,
    () => {
      database.prepare("DELETE FROM voice_audio WHERE call_id = ?").run(callId);
    },
    { label: "voice:deleteAudio" },
  );
}
