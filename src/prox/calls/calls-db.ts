/**
 * prox.city Calls — Storage Layer
 *
 * SQLite-backed persistence for call_profile, call_rules, call_request,
 * call_run, call_event, and call_result. Follows Ravi's existing
 * CREATE TABLE IF NOT EXISTS + lazy migration pattern.
 */

import { randomUUID } from "node:crypto";
import { getDb, getRaviDbPath } from "../../router/router-db.js";
import type {
  CallProfile,
  CallRules,
  CallRequest,
  CallRequestStatus,
  CallRequestPriority,
  CallRun,
  CallRunStatus,
  CallEvent,
  CallEventType,
  CallResult,
  CallResultOutcome,
  CallResultNextAction,
  CallRulesScopeType,
  QuietHoursShape,
  VoicemailPolicy,
  CreateCallRequestInput,
  CreateCallRunInput,
  CreateCallEventInput,
  CreateCallResultInput,
  UpdateCallProfileInput,
} from "./types.js";

// ---------------------------------------------------------------------------
// Row types (raw SQLite rows)
// ---------------------------------------------------------------------------

interface CallProfileRow {
  id: string;
  name: string;
  provider: string;
  provider_agent_id: string;
  twilio_number_id: string;
  language: string;
  prompt: string;
  first_message: string | null;
  system_prompt_path: string | null;
  dynamic_variables_json: string | null;
  extraction_schema_json: string | null;
  voicemail_policy: string;
  enabled: number;
  created_at: number;
  updated_at: number;
}

interface CallRulesRow {
  id: string;
  scope_type: string;
  scope_id: string;
  quiet_hours_json: string | null;
  max_attempts: number;
  cooldown_seconds: number;
  snooze_until: number | null;
  cancel_on_inbound_reply: number;
  require_approval: number;
  enabled: number;
  created_at: number;
  updated_at: number;
}

interface CallRequestRow {
  id: string;
  status: string;
  profile_id: string;
  rules_id: string | null;
  target_person_id: string;
  target_contact_id: string | null;
  target_platform_identity_id: string | null;
  target_phone: string | null;
  origin_session_name: string | null;
  origin_agent_name: string | null;
  origin_channel: string | null;
  origin_message_id: string | null;
  reason: string;
  priority: string;
  deadline_at: number | null;
  scheduled_for: number | null;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
}

interface CallRunRow {
  id: string;
  request_id: string;
  status: string;
  attempt_number: number;
  provider: string;
  provider_call_id: string | null;
  twilio_call_sid: string | null;
  started_at: number | null;
  answered_at: number | null;
  ended_at: number | null;
  failure_reason: string | null;
  metadata_json: string | null;
}

interface CallEventRow {
  id: number;
  request_id: string;
  run_id: string | null;
  event_type: string;
  status: string;
  message: string | null;
  payload_json: string | null;
  source: string | null;
  created_at: number;
}

interface CallResultRow {
  id: string;
  request_id: string;
  run_id: string | null;
  outcome: string;
  summary: string | null;
  transcript: string | null;
  extraction_json: string | null;
  next_action: string;
  artifact_id: string | null;
  created_at: number;
}

// ---------------------------------------------------------------------------
// Schema initialization
// ---------------------------------------------------------------------------

let schemaReady = false;
let schemaDbPath: string | null = null;

function ensureCallsSchema(): void {
  const currentDbPath = getRaviDbPath();
  if (schemaReady && schemaDbPath === currentDbPath) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS call_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'elevenlabs',
      provider_agent_id TEXT NOT NULL DEFAULT '',
      twilio_number_id TEXT NOT NULL DEFAULT '',
      language TEXT NOT NULL DEFAULT 'pt-BR',
      prompt TEXT NOT NULL DEFAULT '',
      first_message TEXT,
      system_prompt_path TEXT,
      dynamic_variables_json TEXT,
      extraction_schema_json TEXT,
      voicemail_policy TEXT NOT NULL DEFAULT 'hangup',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS call_rules (
      id TEXT PRIMARY KEY,
      scope_type TEXT NOT NULL DEFAULT 'global',
      scope_id TEXT NOT NULL DEFAULT '*',
      quiet_hours_json TEXT,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      cooldown_seconds INTEGER NOT NULL DEFAULT 3600,
      snooze_until INTEGER,
      cancel_on_inbound_reply INTEGER NOT NULL DEFAULT 1,
      require_approval INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS call_requests (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'pending',
      profile_id TEXT NOT NULL,
      rules_id TEXT,
      target_person_id TEXT NOT NULL,
      target_contact_id TEXT,
      target_platform_identity_id TEXT,
      target_phone TEXT,
      origin_session_name TEXT,
      origin_agent_name TEXT,
      origin_channel TEXT,
      origin_message_id TEXT,
      reason TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal',
      deadline_at INTEGER,
      scheduled_for INTEGER,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (profile_id) REFERENCES call_profiles(id)
    );

    CREATE TABLE IF NOT EXISTS call_runs (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      attempt_number INTEGER NOT NULL DEFAULT 1,
      provider TEXT NOT NULL,
      provider_call_id TEXT,
      twilio_call_sid TEXT,
      started_at INTEGER,
      answered_at INTEGER,
      ended_at INTEGER,
      failure_reason TEXT,
      metadata_json TEXT,
      FOREIGN KEY (request_id) REFERENCES call_requests(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS call_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL,
      run_id TEXT,
      event_type TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT,
      payload_json TEXT,
      source TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (request_id) REFERENCES call_requests(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS call_results (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      run_id TEXT,
      outcome TEXT NOT NULL,
      summary TEXT,
      transcript TEXT,
      extraction_json TEXT,
      next_action TEXT NOT NULL DEFAULT 'none',
      artifact_id TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (request_id) REFERENCES call_requests(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_call_requests_status ON call_requests(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_call_requests_person ON call_requests(target_person_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_call_requests_profile ON call_requests(profile_id);
    CREATE INDEX IF NOT EXISTS idx_call_runs_request ON call_runs(request_id, attempt_number);
    CREATE INDEX IF NOT EXISTS idx_call_events_request ON call_events(request_id, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_call_events_run ON call_events(run_id, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_call_results_request ON call_results(request_id);
    CREATE INDEX IF NOT EXISTS idx_call_rules_scope ON call_rules(scope_type, scope_id);
  `);

  const profileColumns = db.prepare("PRAGMA table_info(call_profiles)").all() as Array<{ name: string }>;
  const hasProfileColumn = (name: string) => profileColumns.some((column) => column.name === name);
  if (!hasProfileColumn("first_message")) {
    db.exec("ALTER TABLE call_profiles ADD COLUMN first_message TEXT");
  }
  if (!hasProfileColumn("system_prompt_path")) {
    db.exec("ALTER TABLE call_profiles ADD COLUMN system_prompt_path TEXT");
  }
  if (!hasProfileColumn("dynamic_variables_json")) {
    db.exec("ALTER TABLE call_profiles ADD COLUMN dynamic_variables_json TEXT");
  }

  schemaReady = true;
  schemaDbPath = currentDbPath;
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function toJson(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Row → domain converters
// ---------------------------------------------------------------------------

function rowToProfile(row: CallProfileRow): CallProfile {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    provider_agent_id: row.provider_agent_id,
    twilio_number_id: row.twilio_number_id,
    language: row.language,
    prompt: row.prompt,
    first_message: row.first_message,
    system_prompt_path: row.system_prompt_path,
    dynamic_variables_json: parseJson<Record<string, string>>(row.dynamic_variables_json),
    extraction_schema_json: parseJson<Record<string, unknown>>(row.extraction_schema_json),
    voicemail_policy: row.voicemail_policy as VoicemailPolicy,
    enabled: row.enabled === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToRules(row: CallRulesRow): CallRules {
  return {
    id: row.id,
    scope_type: row.scope_type as CallRulesScopeType,
    scope_id: row.scope_id,
    quiet_hours_json: parseJson<QuietHoursShape>(row.quiet_hours_json),
    max_attempts: row.max_attempts,
    cooldown_seconds: row.cooldown_seconds,
    snooze_until: row.snooze_until,
    cancel_on_inbound_reply: row.cancel_on_inbound_reply === 1,
    require_approval: row.require_approval === 1,
    enabled: row.enabled === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToRequest(row: CallRequestRow): CallRequest {
  return {
    id: row.id,
    status: row.status as CallRequestStatus,
    profile_id: row.profile_id,
    rules_id: row.rules_id,
    target_person_id: row.target_person_id,
    target_contact_id: row.target_contact_id,
    target_platform_identity_id: row.target_platform_identity_id,
    target_phone: row.target_phone,
    origin_session_name: row.origin_session_name,
    origin_agent_name: row.origin_agent_name,
    origin_channel: row.origin_channel,
    origin_message_id: row.origin_message_id,
    reason: row.reason,
    priority: row.priority as CallRequestPriority,
    deadline_at: row.deadline_at,
    scheduled_for: row.scheduled_for,
    metadata_json: parseJson<Record<string, unknown>>(row.metadata_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToRun(row: CallRunRow): CallRun {
  return {
    id: row.id,
    request_id: row.request_id,
    status: row.status as CallRunStatus,
    attempt_number: row.attempt_number,
    provider: row.provider,
    provider_call_id: row.provider_call_id,
    twilio_call_sid: row.twilio_call_sid,
    started_at: row.started_at,
    answered_at: row.answered_at,
    ended_at: row.ended_at,
    failure_reason: row.failure_reason,
    metadata_json: parseJson<Record<string, unknown>>(row.metadata_json),
  };
}

function rowToEvent(row: CallEventRow): CallEvent {
  return {
    id: row.id,
    request_id: row.request_id,
    run_id: row.run_id,
    event_type: row.event_type as CallEventType,
    status: row.status,
    message: row.message,
    payload_json: parseJson<Record<string, unknown>>(row.payload_json),
    source: row.source,
    created_at: row.created_at,
  };
}

function rowToResult(row: CallResultRow): CallResult {
  return {
    id: row.id,
    request_id: row.request_id,
    run_id: row.run_id,
    outcome: row.outcome as CallResultOutcome,
    summary: row.summary,
    transcript: row.transcript,
    extraction_json: parseJson<Record<string, unknown>>(row.extraction_json),
    next_action: row.next_action as CallResultNextAction,
    artifact_id: row.artifact_id,
    created_at: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

export function listCallProfiles(): CallProfile[] {
  ensureCallsSchema();
  const rows = getDb()
    .prepare("SELECT * FROM call_profiles WHERE enabled = 1 ORDER BY name ASC")
    .all() as CallProfileRow[];
  return rows.map(rowToProfile);
}

export function getCallProfile(id: string): CallProfile | null {
  ensureCallsSchema();
  const row = getDb().prepare("SELECT * FROM call_profiles WHERE id = ?").get(id) as CallProfileRow | undefined;
  return row ? rowToProfile(row) : null;
}

export function seedDefaultProfiles(): void {
  ensureCallsSchema();
  const db = getDb();
  const now = Date.now();
  const existing = db.prepare("SELECT COUNT(*) AS count FROM call_profiles").get() as { count: number };
  if (existing.count > 0) return;

  const profiles: Array<{ id: string; name: string; prompt: string }> = [
    {
      id: "checkin",
      name: "Check-in",
      prompt: "Short status check when a person is slow to respond.",
    },
    {
      id: "followup",
      name: "Follow-up",
      prompt: "Polite follow-up after an unanswered message.",
    },
    {
      id: "urgent-approval",
      name: "Urgent Approval",
      prompt: "Higher-priority call asking for an explicit approval or blocker.",
    },
  ];

  const defaultDynamicVariables = {
    person_name: "Luís",
    reason: "Motivo da chamada",
    opening_line: "Oi, aqui é o Ravi.",
    goal: "Entender o que precisa ser feito.",
    context: "",
    expected_output: "Resumo objetivo do resultado da chamada.",
  };

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO call_profiles (id, name, provider, provider_agent_id, twilio_number_id, language, prompt, first_message, system_prompt_path, dynamic_variables_json, voicemail_policy, enabled, created_at, updated_at)
    VALUES (?, ?, 'elevenlabs', '', '', 'pt-BR', ?, NULL, NULL, ?, 'hangup', 1, ?, ?)
  `);
  for (const p of profiles) {
    stmt.run(p.id, p.name, p.prompt, toJson(defaultDynamicVariables), now, now);
  }
}

export function updateCallProfile(id: string, input: UpdateCallProfileInput): CallProfile | null {
  ensureCallsSchema();
  const db = getDb();
  const existing = getCallProfile(id);
  if (!existing) return null;

  const now = Date.now();
  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (input.provider !== undefined) {
    fields.push("provider = ?");
    values.push(input.provider);
  }
  if (input.provider_agent_id !== undefined) {
    fields.push("provider_agent_id = ?");
    values.push(input.provider_agent_id);
  }
  if (input.twilio_number_id !== undefined) {
    fields.push("twilio_number_id = ?");
    values.push(input.twilio_number_id);
  }
  if (input.language !== undefined) {
    fields.push("language = ?");
    values.push(input.language);
  }
  if (input.prompt !== undefined) {
    fields.push("prompt = ?");
    values.push(input.prompt);
  }
  if (input.first_message !== undefined) {
    fields.push("first_message = ?");
    values.push(input.first_message);
  }
  if (input.system_prompt_path !== undefined) {
    fields.push("system_prompt_path = ?");
    values.push(input.system_prompt_path);
  }
  if (input.dynamic_variables_json !== undefined) {
    fields.push("dynamic_variables_json = ?");
    values.push(toJson(input.dynamic_variables_json));
  }
  if (input.voicemail_policy !== undefined) {
    fields.push("voicemail_policy = ?");
    values.push(input.voicemail_policy);
  }
  if (input.enabled !== undefined) {
    fields.push("enabled = ?");
    values.push(input.enabled ? 1 : 0);
  }

  if (fields.length === 0) return existing;

  fields.push("updated_at = ?");
  values.push(now);
  values.push(id);

  db.prepare(`UPDATE call_profiles SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  return getCallProfile(id);
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export function getCallRules(scope_type?: string, scope_id?: string): CallRules | null {
  ensureCallsSchema();
  const db = getDb();
  if (scope_type && scope_id) {
    const row = db
      .prepare("SELECT * FROM call_rules WHERE scope_type = ? AND scope_id = ? AND enabled = 1 LIMIT 1")
      .get(scope_type, scope_id) as CallRulesRow | undefined;
    if (row) return rowToRules(row);
  }
  const global = db.prepare("SELECT * FROM call_rules WHERE scope_type = 'global' AND enabled = 1 LIMIT 1").get() as
    | CallRulesRow
    | undefined;
  return global ? rowToRules(global) : null;
}

export function getCallRulesById(id: string): CallRules | null {
  ensureCallsSchema();
  const row = getDb().prepare("SELECT * FROM call_rules WHERE id = ?").get(id) as CallRulesRow | undefined;
  return row ? rowToRules(row) : null;
}

export function seedDefaultRules(): void {
  ensureCallsSchema();
  const db = getDb();
  const now = Date.now();
  const existing = db.prepare("SELECT COUNT(*) AS count FROM call_rules WHERE scope_type = 'global'").get() as {
    count: number;
  };
  if (existing.count > 0) return;

  db.prepare(`
    INSERT INTO call_rules (id, scope_type, scope_id, quiet_hours_json, max_attempts, cooldown_seconds, snooze_until, cancel_on_inbound_reply, require_approval, enabled, created_at, updated_at)
    VALUES (?, 'global', '*', ?, 3, 3600, NULL, 1, 0, 1, ?, ?)
  `).run(
    "rules-global-default",
    JSON.stringify({ start: "22:00", end: "08:00", timezone: "America/Sao_Paulo" }),
    now,
    now,
  );
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export function createCallRequest(input: CreateCallRequestInput): CallRequest {
  ensureCallsSchema();
  const db = getDb();
  const id = `cr_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const now = Date.now();
  const priority = input.priority ?? "normal";

  db.prepare(`
    INSERT INTO call_requests (id, status, profile_id, rules_id, target_person_id, target_contact_id, target_platform_identity_id, target_phone, origin_session_name, origin_agent_name, origin_channel, origin_message_id, reason, priority, deadline_at, scheduled_for, metadata_json, created_at, updated_at)
    VALUES (?, 'pending', ?, NULL, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.profile_id,
    input.target_person_id,
    input.target_phone ?? null,
    input.origin_session_name ?? null,
    input.origin_agent_name ?? null,
    input.origin_channel ?? null,
    input.origin_message_id ?? null,
    input.reason,
    priority,
    input.deadline_at ?? null,
    input.scheduled_for ?? null,
    toJson(input.metadata_json),
    now,
    now,
  );

  return getCallRequest(id)!;
}

export function getCallRequest(id: string): CallRequest | null {
  ensureCallsSchema();
  const row = getDb().prepare("SELECT * FROM call_requests WHERE id = ?").get(id) as CallRequestRow | undefined;
  return row ? rowToRequest(row) : null;
}

export function listCallRequests(options?: { status?: CallRequestStatus; limit?: number }): CallRequest[] {
  ensureCallsSchema();
  const limit = options?.limit ?? 50;
  if (options?.status) {
    const rows = getDb()
      .prepare("SELECT * FROM call_requests WHERE status = ? ORDER BY updated_at DESC LIMIT ?")
      .all(options.status, limit) as CallRequestRow[];
    return rows.map(rowToRequest);
  }
  const rows = getDb()
    .prepare("SELECT * FROM call_requests ORDER BY updated_at DESC LIMIT ?")
    .all(limit) as CallRequestRow[];
  return rows.map(rowToRequest);
}

export function updateCallRequestStatus(id: string, status: CallRequestStatus): void {
  ensureCallsSchema();
  getDb().prepare("UPDATE call_requests SET status = ?, updated_at = ? WHERE id = ?").run(status, Date.now(), id);
}

export function updateCallRequestRulesId(id: string, rulesId: string): void {
  ensureCallsSchema();
  getDb().prepare("UPDATE call_requests SET rules_id = ?, updated_at = ? WHERE id = ?").run(rulesId, Date.now(), id);
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export function createCallRun(input: CreateCallRunInput): CallRun {
  ensureCallsSchema();
  const db = getDb();
  const id = `run_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

  db.prepare(`
    INSERT INTO call_runs (id, request_id, status, attempt_number, provider, started_at)
    VALUES (?, ?, 'queued', ?, ?, ?)
  `).run(id, input.request_id, input.attempt_number, input.provider, Date.now());

  return getCallRun(id)!;
}

export function getCallRun(id: string): CallRun | null {
  ensureCallsSchema();
  const row = getDb().prepare("SELECT * FROM call_runs WHERE id = ?").get(id) as CallRunRow | undefined;
  return row ? rowToRun(row) : null;
}

export function listCallRuns(requestId: string): CallRun[] {
  ensureCallsSchema();
  const rows = getDb()
    .prepare("SELECT * FROM call_runs WHERE request_id = ? ORDER BY attempt_number ASC")
    .all(requestId) as CallRunRow[];
  return rows.map(rowToRun);
}

export function updateCallRunStatus(
  id: string,
  status: CallRunStatus,
  extra?: { failure_reason?: string; provider_call_id?: string; twilio_call_sid?: string },
): void {
  ensureCallsSchema();
  const db = getDb();
  const now = Date.now();
  db.prepare("UPDATE call_runs SET status = ? WHERE id = ?").run(status, id);

  if (status === "dialing" || status === "ringing" || status === "in_progress") {
    db.prepare("UPDATE call_runs SET started_at = COALESCE(started_at, ?) WHERE id = ?").run(now, id);
  }
  if (status === "in_progress") {
    db.prepare("UPDATE call_runs SET answered_at = COALESCE(answered_at, ?) WHERE id = ?").run(now, id);
  }
  if (["completed", "no_answer", "busy", "voicemail", "failed", "canceled"].includes(status)) {
    db.prepare("UPDATE call_runs SET ended_at = COALESCE(ended_at, ?) WHERE id = ?").run(now, id);
  }
  if (extra?.failure_reason) {
    db.prepare("UPDATE call_runs SET failure_reason = ? WHERE id = ?").run(extra.failure_reason, id);
  }
  if (extra?.provider_call_id) {
    db.prepare("UPDATE call_runs SET provider_call_id = ? WHERE id = ?").run(extra.provider_call_id, id);
  }
  if (extra?.twilio_call_sid) {
    db.prepare("UPDATE call_runs SET twilio_call_sid = ? WHERE id = ?").run(extra.twilio_call_sid, id);
  }
}

export function countCallRunsForRequest(requestId: string): number {
  ensureCallsSchema();
  const row = getDb().prepare("SELECT COUNT(*) AS count FROM call_runs WHERE request_id = ?").get(requestId) as {
    count: number;
  };
  return row.count;
}

export function getLastCallRunEndedAt(personId: string): number | null {
  ensureCallsSchema();
  const row = getDb()
    .prepare(`
      SELECT cr2.ended_at FROM call_requests cr1
      JOIN call_runs cr2 ON cr2.request_id = cr1.id
      WHERE cr1.target_person_id = ? AND cr2.ended_at IS NOT NULL
      ORDER BY cr2.ended_at DESC LIMIT 1
    `)
    .get(personId) as { ended_at: number } | undefined;
  return row?.ended_at ?? null;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export function createCallEvent(input: CreateCallEventInput): CallEvent {
  ensureCallsSchema();
  const db = getDb();
  const now = Date.now();

  const result = db
    .prepare(`
    INSERT INTO call_events (request_id, run_id, event_type, status, message, payload_json, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
    .run(
      input.request_id,
      input.run_id ?? null,
      input.event_type,
      input.status,
      input.message ?? null,
      toJson(input.payload_json),
      input.source ?? null,
      now,
    );

  const id = Number(result.lastInsertRowid);
  return getCallEvent(id)!;
}

export function getCallEvent(id: number): CallEvent | null {
  ensureCallsSchema();
  const row = getDb().prepare("SELECT * FROM call_events WHERE id = ?").get(id) as CallEventRow | undefined;
  return row ? rowToEvent(row) : null;
}

export function listCallEvents(requestId: string): CallEvent[] {
  ensureCallsSchema();
  const rows = getDb()
    .prepare("SELECT * FROM call_events WHERE request_id = ? ORDER BY created_at ASC")
    .all(requestId) as CallEventRow[];
  return rows.map(rowToEvent);
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export function createCallResult(input: CreateCallResultInput): CallResult {
  ensureCallsSchema();
  const db = getDb();
  const id = `res_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const now = Date.now();

  db.prepare(`
    INSERT INTO call_results (id, request_id, run_id, outcome, summary, transcript, extraction_json, next_action, artifact_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.request_id,
    input.run_id ?? null,
    input.outcome,
    input.summary ?? null,
    input.transcript ?? null,
    toJson(input.extraction_json),
    input.next_action ?? "none",
    input.artifact_id ?? null,
    now,
  );

  return getCallResult(id)!;
}

export function getCallResult(id: string): CallResult | null {
  ensureCallsSchema();
  const row = getDb().prepare("SELECT * FROM call_results WHERE id = ?").get(id) as CallResultRow | undefined;
  return row ? rowToResult(row) : null;
}

export function getCallResultForRequest(requestId: string): CallResult | null {
  ensureCallsSchema();
  const row = getDb()
    .prepare("SELECT * FROM call_results WHERE request_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .get(requestId) as CallResultRow | undefined;
  return row ? rowToResult(row) : null;
}

// ---------------------------------------------------------------------------
// Schema reset (for testing)
// ---------------------------------------------------------------------------

export function resetCallsSchemaFlag(): void {
  schemaReady = false;
  schemaDbPath = null;
}
