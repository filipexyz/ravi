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
  CallVoiceAgent,
  CreateCallVoiceAgentInput,
  UpdateCallVoiceAgentInput,
  CallTool,
  CallToolExecutorType,
  CallToolSideEffect,
  CreateCallToolInput,
  UpdateCallToolInput,
  CallToolBinding,
  CallToolBindingScopeType,
  CallToolPolicy,
  CallToolRun,
  CallToolRunStatus,
  CreateCallToolRunInput,
} from "./types.js";

// ---------------------------------------------------------------------------
// Row types (raw SQLite rows)
// ---------------------------------------------------------------------------

interface CallProfileRow {
  id: string;
  name: string;
  voice_agent_id: string | null;
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

interface CallVoiceAgentRow {
  id: string;
  name: string;
  description: string;
  provider: string;
  provider_agent_id: string | null;
  voice_id: string | null;
  language: string;
  system_prompt: string | null;
  system_prompt_path: string | null;
  first_message_template: string | null;
  dynamic_variables_schema_json: string | null;
  default_tools_json: string | null;
  provider_config_json: string | null;
  version: number;
  enabled: number;
  created_at: number;
  updated_at: number;
}

interface CallToolRow {
  id: string;
  name: string;
  description: string;
  input_schema_json: string;
  output_schema_json: string | null;
  executor_type: string;
  executor_config_json: string | null;
  side_effect: string;
  timeout_ms: number;
  enabled: number;
  created_at: number;
  updated_at: number;
}

interface CallToolBindingRow {
  id: string;
  tool_id: string;
  scope_type: string;
  scope_id: string;
  provider_tool_name: string;
  enabled: number;
  tool_prompt: string | null;
  required: number;
  created_at: number;
  updated_at: number;
}

interface CallToolPolicyRow {
  id: string;
  tool_id: string;
  scope_type: string;
  scope_id: string;
  allowed: number;
  max_calls_per_run: number | null;
  require_confirmation: number;
  require_context_key: number;
  created_at: number;
  updated_at: number;
}

interface CallToolRunRow {
  id: string;
  request_id: string;
  run_id: string | null;
  tool_id: string;
  binding_id: string | null;
  provider_tool_name: string;
  input_json: string | null;
  output_json: string | null;
  status: string;
  error_message: string | null;
  started_at: number;
  completed_at: number | null;
  duration_ms: number | null;
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
      voice_agent_id TEXT,
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

    CREATE TABLE IF NOT EXISTS call_voice_agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      provider TEXT NOT NULL DEFAULT 'elevenlabs',
      provider_agent_id TEXT,
      voice_id TEXT,
      language TEXT NOT NULL DEFAULT 'pt-BR',
      system_prompt TEXT,
      system_prompt_path TEXT,
      first_message_template TEXT,
      dynamic_variables_schema_json TEXT,
      default_tools_json TEXT,
      provider_config_json TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS call_tools (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      input_schema_json TEXT NOT NULL DEFAULT '{}',
      output_schema_json TEXT,
      executor_type TEXT NOT NULL DEFAULT 'native',
      executor_config_json TEXT,
      side_effect TEXT NOT NULL DEFAULT 'read_only',
      timeout_ms INTEGER NOT NULL DEFAULT 5000,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS call_tool_bindings (
      id TEXT PRIMARY KEY,
      tool_id TEXT NOT NULL,
      scope_type TEXT NOT NULL DEFAULT 'profile',
      scope_id TEXT NOT NULL,
      provider_tool_name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      tool_prompt TEXT,
      required INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (tool_id) REFERENCES call_tools(id)
    );

    CREATE TABLE IF NOT EXISTS call_tool_policies (
      id TEXT PRIMARY KEY,
      tool_id TEXT NOT NULL,
      scope_type TEXT NOT NULL DEFAULT 'global',
      scope_id TEXT NOT NULL DEFAULT '*',
      allowed INTEGER NOT NULL DEFAULT 1,
      max_calls_per_run INTEGER,
      require_confirmation INTEGER NOT NULL DEFAULT 0,
      require_context_key INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (tool_id) REFERENCES call_tools(id)
    );

    CREATE TABLE IF NOT EXISTS call_tool_runs (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      run_id TEXT,
      tool_id TEXT NOT NULL,
      binding_id TEXT,
      provider_tool_name TEXT NOT NULL,
      input_json TEXT,
      output_json TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      error_message TEXT,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      duration_ms INTEGER,
      FOREIGN KEY (request_id) REFERENCES call_requests(id) ON DELETE CASCADE,
      FOREIGN KEY (tool_id) REFERENCES call_tools(id)
    );

    CREATE INDEX IF NOT EXISTS idx_call_tool_bindings_scope ON call_tool_bindings(scope_type, scope_id, provider_tool_name);
    CREATE INDEX IF NOT EXISTS idx_call_voice_agents_enabled ON call_voice_agents(enabled);
    CREATE INDEX IF NOT EXISTS idx_call_tool_policies_tool ON call_tool_policies(tool_id, scope_type, scope_id);
    CREATE INDEX IF NOT EXISTS idx_call_tool_runs_request ON call_tool_runs(request_id, started_at ASC);
    CREATE INDEX IF NOT EXISTS idx_call_tool_runs_run ON call_tool_runs(run_id, started_at ASC);
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
  if (!hasProfileColumn("voice_agent_id")) {
    db.exec("ALTER TABLE call_profiles ADD COLUMN voice_agent_id TEXT");
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
    voice_agent_id: row.voice_agent_id ?? null,
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
// Voice Agents
// ---------------------------------------------------------------------------

function rowToVoiceAgent(row: CallVoiceAgentRow): CallVoiceAgent {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    provider: row.provider,
    provider_agent_id: row.provider_agent_id,
    voice_id: row.voice_id,
    language: row.language,
    system_prompt: row.system_prompt,
    system_prompt_path: row.system_prompt_path,
    first_message_template: row.first_message_template,
    dynamic_variables_schema_json: parseJson<Record<string, unknown>>(row.dynamic_variables_schema_json),
    default_tools_json: parseJson<string[]>(row.default_tools_json),
    provider_config_json: parseJson<Record<string, unknown>>(row.provider_config_json),
    version: row.version,
    enabled: row.enabled === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listCallVoiceAgents(): CallVoiceAgent[] {
  ensureCallsSchema();
  const rows = getDb()
    .prepare("SELECT * FROM call_voice_agents WHERE enabled = 1 ORDER BY name ASC")
    .all() as CallVoiceAgentRow[];
  return rows.map(rowToVoiceAgent);
}

export function getCallVoiceAgent(id: string): CallVoiceAgent | null {
  ensureCallsSchema();
  const row = getDb().prepare("SELECT * FROM call_voice_agents WHERE id = ?").get(id) as CallVoiceAgentRow | undefined;
  return row ? rowToVoiceAgent(row) : null;
}

export function createCallVoiceAgent(input: CreateCallVoiceAgentInput): CallVoiceAgent {
  ensureCallsSchema();
  const db = getDb();
  const now = Date.now();

  db.prepare(`
    INSERT INTO call_voice_agents (id, name, description, provider, provider_agent_id, voice_id, language, system_prompt, system_prompt_path, first_message_template, dynamic_variables_schema_json, default_tools_json, provider_config_json, version, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)
  `).run(
    input.id,
    input.name,
    input.description ?? "",
    input.provider,
    input.provider_agent_id ?? null,
    input.voice_id ?? null,
    input.language ?? "pt-BR",
    input.system_prompt ?? null,
    input.system_prompt_path ?? null,
    input.first_message_template ?? null,
    toJson(input.dynamic_variables_schema_json ?? null),
    toJson(input.default_tools_json ?? null),
    toJson(input.provider_config_json ?? null),
    now,
    now,
  );

  return getCallVoiceAgent(input.id)!;
}

export function updateCallVoiceAgent(id: string, input: UpdateCallVoiceAgentInput): CallVoiceAgent | null {
  ensureCallsSchema();
  const existing = getCallVoiceAgent(id);
  if (!existing) return null;

  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  let bumpsVersion = false;
  const addString = (column: string, value: string | null | undefined, material = false) => {
    if (value === undefined) return;
    fields.push(`${column} = ?`);
    values.push(value);
    if (material) bumpsVersion = true;
  };
  const addJson = (column: string, value: unknown | undefined, material = false) => {
    if (value === undefined) return;
    fields.push(`${column} = ?`);
    values.push(toJson(value));
    if (material) bumpsVersion = true;
  };

  addString("name", input.name);
  addString("description", input.description);
  addString("provider", input.provider, true);
  addString("provider_agent_id", input.provider_agent_id, true);
  addString("voice_id", input.voice_id, true);
  addString("language", input.language, true);
  addString("system_prompt", input.system_prompt, true);
  addString("system_prompt_path", input.system_prompt_path, true);
  addString("first_message_template", input.first_message_template, true);
  addJson("dynamic_variables_schema_json", input.dynamic_variables_schema_json, true);
  addJson("default_tools_json", input.default_tools_json, true);
  addJson("provider_config_json", input.provider_config_json, true);

  if (input.enabled !== undefined) {
    fields.push("enabled = ?");
    values.push(input.enabled ? 1 : 0);
  }

  if (fields.length === 0) return existing;

  if (bumpsVersion) {
    fields.push("version = version + 1");
  }
  fields.push("updated_at = ?");
  values.push(Date.now(), id);

  getDb()
    .prepare(`UPDATE call_voice_agents SET ${fields.join(", ")} WHERE id = ?`)
    .run(...values);
  return getCallVoiceAgent(id);
}

export function seedDefaultVoiceAgents(): void {
  ensureCallsSchema();

  const dynamicVariablesSchema = {
    type: "object",
    properties: {
      person_name: { type: "string", description: "Name of the person being called" },
      reason: { type: "string", description: "Reason for the call" },
      opening_line: { type: "string", description: "Custom opening line override" },
      goal: { type: "string", description: "Call objective" },
      context: { type: "string", description: "Additional context" },
      expected_output: { type: "string", description: "Expected call outcome" },
    },
    required: ["person_name", "reason"],
  };

  const defaults: CreateCallVoiceAgentInput[] = [
    {
      id: "ravi-followup",
      name: "Ravi Follow-up",
      description: "Short, direct follow-up calls when someone has not responded to messages.",
      provider: "elevenlabs",
      system_prompt:
        "You are Ravi, making a brief follow-up call. Be polite, direct, and concise. State the reason, collect the answer, and end the call when the objective is complete.",
      first_message_template:
        "Oi {{person_name}}, aqui é o Ravi. Estou ligando rapidamente para dar um retorno sobre {{reason}}.",
      dynamic_variables_schema_json: dynamicVariablesSchema,
      default_tools_json: ["call.end", "person.lookup", "prox.note.create"],
    },
    {
      id: "ravi-interviewer",
      name: "Ravi Interviewer",
      description: "Structured interview calls that gather useful information.",
      provider: "elevenlabs",
      system_prompt:
        "You are Ravi, conducting a structured interview call. Ask one question at a time, listen carefully, summarize key points, and end the call when the objective is complete.",
      first_message_template:
        "Oi {{person_name}}, aqui é o Ravi. Vou conduzir uma conversa rápida sobre {{reason}}. Pode ser agora?",
      dynamic_variables_schema_json: dynamicVariablesSchema,
      default_tools_json: ["call.end", "person.lookup", "prox.note.create", "task.create"],
    },
    {
      id: "ravi-urgent-approval",
      name: "Ravi Urgent Approval",
      description: "Higher-priority calls asking for an explicit approval or blocker resolution.",
      provider: "elevenlabs",
      system_prompt:
        "You are Ravi, calling to get an urgent approval or decision. State what needs approval, why it matters, and accept yes, no, or a request for more time.",
      first_message_template:
        "Oi {{person_name}}, aqui é o Ravi. Preciso de uma aprovação urgente sobre {{reason}}. Tem um minuto?",
      dynamic_variables_schema_json: dynamicVariablesSchema,
      default_tools_json: ["call.end", "person.lookup", "prox.note.create"],
    },
    {
      id: "ravi-intake",
      name: "Ravi Intake",
      description: "prox.city intake calls for onboarding and initial data collection.",
      provider: "elevenlabs",
      system_prompt:
        "You are Ravi, conducting an intake call for prox.city. Gather information methodically, confirm collected details, and end the call when the intake is complete.",
      first_message_template:
        "Oi {{person_name}}, aqui é o Ravi da prox.city. Vou fazer algumas perguntas para entender melhor o que você precisa. Pode ser?",
      dynamic_variables_schema_json: dynamicVariablesSchema,
      default_tools_json: ["call.end", "person.lookup", "prox.note.create", "prox.followup.schedule", "task.create"],
    },
  ];

  for (const agent of defaults) {
    if (!getCallVoiceAgent(agent.id)) {
      createCallVoiceAgent(agent);
    }
  }
}

// ---------------------------------------------------------------------------
// Call Tools
// ---------------------------------------------------------------------------

function rowToCallTool(row: CallToolRow): CallTool {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    input_schema_json: parseJson<Record<string, unknown>>(row.input_schema_json) ?? {},
    output_schema_json: parseJson<Record<string, unknown>>(row.output_schema_json),
    executor_type: row.executor_type as CallToolExecutorType,
    executor_config_json: parseJson<Record<string, unknown>>(row.executor_config_json),
    side_effect: row.side_effect as CallToolSideEffect,
    timeout_ms: row.timeout_ms,
    enabled: row.enabled === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function getCallTool(id: string): CallTool | null {
  ensureCallsSchema();
  const row = getDb().prepare("SELECT * FROM call_tools WHERE id = ?").get(id) as CallToolRow | undefined;
  return row ? rowToCallTool(row) : null;
}

export function listCallTools(profileId?: string): CallTool[] {
  ensureCallsSchema();
  if (profileId) {
    const rows = getDb()
      .prepare(`
        SELECT ct.* FROM call_tools ct
        JOIN call_tool_bindings ctb ON ctb.tool_id = ct.id
        WHERE ctb.scope_type = 'profile'
          AND ctb.scope_id = ?
          AND ctb.enabled = 1
          AND ct.enabled = 1
        ORDER BY ct.id ASC
      `)
      .all(profileId) as CallToolRow[];
    return rows.map(rowToCallTool);
  }
  const rows = getDb().prepare("SELECT * FROM call_tools WHERE enabled = 1 ORDER BY id ASC").all() as CallToolRow[];
  return rows.map(rowToCallTool);
}

export function upsertCallTool(tool: {
  id: string;
  name: string;
  description: string;
  input_schema_json: Record<string, unknown>;
  output_schema_json?: Record<string, unknown> | null;
  executor_type: CallToolExecutorType;
  executor_config_json?: Record<string, unknown> | null;
  side_effect: CallToolSideEffect;
  timeout_ms: number;
}): CallTool {
  ensureCallsSchema();
  const db = getDb();
  const now = Date.now();
  db.prepare(`
    INSERT INTO call_tools (id, name, description, input_schema_json, output_schema_json, executor_type, executor_config_json, side_effect, timeout_ms, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      input_schema_json = excluded.input_schema_json,
      output_schema_json = excluded.output_schema_json,
      executor_type = excluded.executor_type,
      executor_config_json = excluded.executor_config_json,
      side_effect = excluded.side_effect,
      timeout_ms = excluded.timeout_ms,
      updated_at = excluded.updated_at
  `).run(
    tool.id,
    tool.name,
    tool.description,
    toJson(tool.input_schema_json),
    toJson(tool.output_schema_json ?? null),
    tool.executor_type,
    toJson(tool.executor_config_json ?? null),
    tool.side_effect,
    tool.timeout_ms,
    now,
    now,
  );
  return getCallTool(tool.id)!;
}

export function createCallTool(input: CreateCallToolInput): CallTool {
  if (getCallTool(input.id)) {
    throw new Error(`Call tool already exists: ${input.id}`);
  }
  return upsertCallTool({
    id: input.id,
    name: input.name,
    description: input.description,
    input_schema_json: input.input_schema_json ?? {},
    output_schema_json: input.output_schema_json ?? null,
    executor_type: input.executor_type,
    executor_config_json: input.executor_config_json ?? null,
    side_effect: input.side_effect,
    timeout_ms: input.timeout_ms ?? 10000,
  });
}

export function updateCallTool(id: string, input: UpdateCallToolInput): CallTool | null {
  ensureCallsSchema();
  const existing = getCallTool(id);
  if (!existing) return null;

  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (input.name !== undefined) {
    fields.push("name = ?");
    values.push(input.name);
  }
  if (input.description !== undefined) {
    fields.push("description = ?");
    values.push(input.description);
  }
  if (input.input_schema_json !== undefined) {
    fields.push("input_schema_json = ?");
    values.push(toJson(input.input_schema_json ?? {}));
  }
  if (input.output_schema_json !== undefined) {
    fields.push("output_schema_json = ?");
    values.push(toJson(input.output_schema_json));
  }
  if (input.executor_config_json !== undefined) {
    fields.push("executor_config_json = ?");
    values.push(toJson(input.executor_config_json));
  }
  if (input.timeout_ms !== undefined) {
    fields.push("timeout_ms = ?");
    values.push(input.timeout_ms);
  }
  if (input.enabled !== undefined) {
    fields.push("enabled = ?");
    values.push(input.enabled ? 1 : 0);
  }

  if (fields.length === 0) return existing;

  fields.push("updated_at = ?");
  values.push(Date.now(), id);

  getDb()
    .prepare(`UPDATE call_tools SET ${fields.join(", ")} WHERE id = ?`)
    .run(...values);
  return getCallTool(id);
}

// ---------------------------------------------------------------------------
// Call Tool Bindings
// ---------------------------------------------------------------------------

function rowToCallToolBinding(row: CallToolBindingRow): CallToolBinding {
  return {
    id: row.id,
    tool_id: row.tool_id,
    scope_type: row.scope_type as CallToolBindingScopeType,
    scope_id: row.scope_id,
    provider_tool_name: row.provider_tool_name,
    enabled: row.enabled === 1,
    tool_prompt: row.tool_prompt,
    required: row.required === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function getCallToolBinding(id: string): CallToolBinding | null;
export function getCallToolBinding(
  toolId: string,
  scopeType: CallToolBindingScopeType,
  scopeId: string,
): CallToolBinding | null;
export function getCallToolBinding(
  idOrToolId: string,
  scopeType?: CallToolBindingScopeType,
  scopeId?: string,
): CallToolBinding | null {
  ensureCallsSchema();
  const row =
    scopeType && scopeId
      ? (getDb()
          .prepare("SELECT * FROM call_tool_bindings WHERE tool_id = ? AND scope_type = ? AND scope_id = ? LIMIT 1")
          .get(idOrToolId, scopeType, scopeId) as CallToolBindingRow | undefined)
      : (getDb().prepare("SELECT * FROM call_tool_bindings WHERE id = ?").get(idOrToolId) as
          | CallToolBindingRow
          | undefined);
  return row ? rowToCallToolBinding(row) : null;
}

export function resolveCallToolBindingByProviderName(
  providerToolName: string,
  scopeType: CallToolBindingScopeType,
  scopeId: string,
): CallToolBinding | null {
  ensureCallsSchema();
  const row = getDb()
    .prepare(
      "SELECT * FROM call_tool_bindings WHERE provider_tool_name = ? AND scope_type = ? AND scope_id = ? AND enabled = 1 LIMIT 1",
    )
    .get(providerToolName, scopeType, scopeId) as CallToolBindingRow | undefined;
  return row ? rowToCallToolBinding(row) : null;
}

export function listCallToolBindings(scopeType: CallToolBindingScopeType, scopeId: string): CallToolBinding[] {
  ensureCallsSchema();
  const rows = getDb()
    .prepare(
      "SELECT * FROM call_tool_bindings WHERE scope_type = ? AND scope_id = ? AND enabled = 1 ORDER BY provider_tool_name ASC",
    )
    .all(scopeType, scopeId) as CallToolBindingRow[];
  return rows.map(rowToCallToolBinding);
}

export function upsertCallToolBinding(binding: {
  id: string;
  tool_id: string;
  scope_type: CallToolBindingScopeType;
  scope_id: string;
  provider_tool_name: string;
  tool_prompt?: string | null;
  required?: boolean;
}): CallToolBinding {
  ensureCallsSchema();
  const db = getDb();
  const now = Date.now();
  db.prepare(`
    INSERT INTO call_tool_bindings (id, tool_id, scope_type, scope_id, provider_tool_name, enabled, tool_prompt, required, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      tool_id = excluded.tool_id,
      scope_type = excluded.scope_type,
      scope_id = excluded.scope_id,
      provider_tool_name = excluded.provider_tool_name,
      tool_prompt = excluded.tool_prompt,
      required = excluded.required,
      updated_at = excluded.updated_at
  `).run(
    binding.id,
    binding.tool_id,
    binding.scope_type,
    binding.scope_id,
    binding.provider_tool_name,
    binding.tool_prompt ?? null,
    binding.required ? 1 : 0,
    now,
    now,
  );
  return getCallToolBinding(binding.id)!;
}

export function createCallToolBinding(
  toolId: string,
  scopeType: CallToolBindingScopeType,
  scopeId: string,
  options?: { provider_tool_name?: string | null; tool_prompt?: string | null; required?: boolean },
): CallToolBinding {
  const existing = getCallToolBinding(toolId, scopeType, scopeId);
  if (existing) return existing;
  return upsertCallToolBinding({
    id: `bind_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
    tool_id: toolId,
    scope_type: scopeType,
    scope_id: scopeId,
    provider_tool_name: options?.provider_tool_name ?? toolId,
    tool_prompt: options?.tool_prompt ?? null,
    required: options?.required ?? false,
  });
}

export function deleteCallToolBinding(toolId: string, scopeType: CallToolBindingScopeType, scopeId: string): boolean {
  ensureCallsSchema();
  const result = getDb()
    .prepare("DELETE FROM call_tool_bindings WHERE tool_id = ? AND scope_type = ? AND scope_id = ?")
    .run(toolId, scopeType, scopeId);
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Call Tool Policies
// ---------------------------------------------------------------------------

function rowToCallToolPolicy(row: CallToolPolicyRow): CallToolPolicy {
  return {
    id: row.id,
    tool_id: row.tool_id,
    scope_type: row.scope_type,
    scope_id: row.scope_id,
    allowed: row.allowed === 1,
    max_calls_per_run: row.max_calls_per_run,
    require_confirmation: row.require_confirmation === 1,
    require_context_key: row.require_context_key === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function getCallToolPolicy(toolId: string, scopeType: string, scopeId: string): CallToolPolicy | null {
  ensureCallsSchema();
  const row = getDb()
    .prepare("SELECT * FROM call_tool_policies WHERE tool_id = ? AND scope_type = ? AND scope_id = ? LIMIT 1")
    .get(toolId, scopeType, scopeId) as CallToolPolicyRow | undefined;
  return row ? rowToCallToolPolicy(row) : null;
}

export function getEffectiveCallToolPolicy(toolId: string): CallToolPolicy | null {
  ensureCallsSchema();
  const row = getDb()
    .prepare(
      "SELECT * FROM call_tool_policies WHERE tool_id = ? ORDER BY CASE scope_type WHEN 'global' THEN 1 ELSE 0 END DESC LIMIT 1",
    )
    .get(toolId) as CallToolPolicyRow | undefined;
  return row ? rowToCallToolPolicy(row) : null;
}

export function evaluateCallToolPolicy(
  toolId: string,
  sideEffect: CallToolSideEffect,
  _context?: { voice_agent_id?: string; profile_id?: string },
): { allowed: boolean; reason: string; policy: CallToolPolicy | null } {
  ensureCallsSchema();
  const policy = getEffectiveCallToolPolicy(toolId);
  if (policy) {
    return {
      allowed: policy.allowed,
      reason: policy.allowed ? "Allowed by explicit policy" : "Blocked by explicit policy",
      policy,
    };
  }
  const unsafeSideEffects = new Set<CallToolSideEffect>(["external_message", "external_call", "external_irreversible"]);
  if (unsafeSideEffects.has(sideEffect)) {
    return { allowed: false, reason: `Side-effect class '${sideEffect}' blocked by default policy`, policy: null };
  }
  return { allowed: true, reason: "Allowed by default policy", policy: null };
}

export function upsertCallToolPolicy(policy: {
  id: string;
  tool_id: string;
  scope_type: string;
  scope_id: string;
  allowed: boolean;
  max_calls_per_run?: number | null;
  require_confirmation?: boolean;
  require_context_key?: boolean;
}): CallToolPolicy {
  ensureCallsSchema();
  const db = getDb();
  const now = Date.now();
  db.prepare(`
    INSERT INTO call_tool_policies (id, tool_id, scope_type, scope_id, allowed, max_calls_per_run, require_confirmation, require_context_key, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      allowed = excluded.allowed,
      max_calls_per_run = excluded.max_calls_per_run,
      require_confirmation = excluded.require_confirmation,
      require_context_key = excluded.require_context_key,
      updated_at = excluded.updated_at
  `).run(
    policy.id,
    policy.tool_id,
    policy.scope_type,
    policy.scope_id,
    policy.allowed ? 1 : 0,
    policy.max_calls_per_run ?? null,
    policy.require_confirmation ? 1 : 0,
    policy.require_context_key ? 1 : 0,
    now,
    now,
  );
  return getCallToolPolicy(policy.tool_id, policy.scope_type, policy.scope_id)!;
}

// ---------------------------------------------------------------------------
// Call Tool Runs
// ---------------------------------------------------------------------------

function rowToCallToolRun(row: CallToolRunRow): CallToolRun {
  return {
    id: row.id,
    request_id: row.request_id,
    run_id: row.run_id,
    tool_id: row.tool_id,
    binding_id: row.binding_id,
    provider_tool_name: row.provider_tool_name,
    input_json: parseJson<Record<string, unknown>>(row.input_json),
    output_json: parseJson<Record<string, unknown>>(row.output_json),
    status: row.status as CallToolRunStatus,
    error_message: row.error_message,
    started_at: row.started_at,
    completed_at: row.completed_at,
    duration_ms: row.duration_ms,
  };
}

export function createCallToolRun(input: CreateCallToolRunInput): CallToolRun {
  ensureCallsSchema();
  const db = getDb();
  const id = `trun_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const now = Date.now();
  db.prepare(`
    INSERT INTO call_tool_runs (id, request_id, run_id, tool_id, binding_id, provider_tool_name, input_json, status, started_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.request_id,
    input.run_id ?? null,
    input.tool_id,
    input.binding_id ?? null,
    input.provider_tool_name ?? input.tool_id,
    toJson(input.input_json ?? null),
    input.status ?? "pending",
    now,
  );
  if (input.output_json !== undefined) {
    db.prepare("UPDATE call_tool_runs SET output_json = ? WHERE id = ?").run(toJson(input.output_json), id);
  }
  if (input.message !== undefined && input.message !== null) {
    db.prepare("UPDATE call_tool_runs SET error_message = ? WHERE id = ?").run(input.message, id);
  }
  return getCallToolRun(id)!;
}

export function getCallToolRun(id: string): CallToolRun | null {
  ensureCallsSchema();
  const row = getDb().prepare("SELECT * FROM call_tool_runs WHERE id = ?").get(id) as CallToolRunRow | undefined;
  return row ? rowToCallToolRun(row) : null;
}

export function listCallToolRuns(requestId: string): CallToolRun[] {
  ensureCallsSchema();
  const rows = getDb()
    .prepare("SELECT * FROM call_tool_runs WHERE request_id = ? ORDER BY started_at ASC")
    .all(requestId) as CallToolRunRow[];
  return rows.map(rowToCallToolRun);
}

export function countCallToolRunsForRun(runId: string, toolId: string): number {
  ensureCallsSchema();
  const row = getDb()
    .prepare("SELECT COUNT(*) AS count FROM call_tool_runs WHERE run_id = ? AND tool_id = ?")
    .get(runId, toolId) as { count: number };
  return row.count;
}

export function updateCallToolRunStatus(
  id: string,
  status: CallToolRunStatus,
  extra?: {
    output_json?: Record<string, unknown> | null;
    error_message?: string | null;
  },
): void {
  ensureCallsSchema();
  const db = getDb();
  const now = Date.now();
  const started = getCallToolRun(id)?.started_at ?? now;
  db.prepare("UPDATE call_tool_runs SET status = ?, completed_at = ?, duration_ms = ? WHERE id = ?").run(
    status,
    now,
    now - started,
    id,
  );
  if (extra?.output_json !== undefined) {
    db.prepare("UPDATE call_tool_runs SET output_json = ? WHERE id = ?").run(toJson(extra.output_json), id);
  }
  if (extra?.error_message !== undefined) {
    db.prepare("UPDATE call_tool_runs SET error_message = ? WHERE id = ?").run(extra.error_message, id);
  }
}

// ---------------------------------------------------------------------------
// Default tool seeds
// ---------------------------------------------------------------------------

export function seedDefaultCallTools(): void {
  ensureCallsSchema();

  const tools: Array<Parameters<typeof upsertCallTool>[0]> = [
    {
      id: "call.end",
      name: "end_call",
      description: "End the current prox.city voice call after the objective is complete or the user asks to stop.",
      input_schema_json: {
        type: "object",
        properties: {
          reason: { type: "string", description: "Short reason for ending the call." },
        },
        additionalProperties: false,
      },
      output_schema_json: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          message: { type: "string" },
        },
      },
      executor_type: "native",
      executor_config_json: { handler: "call.end" },
      side_effect: "external_call",
      timeout_ms: 5000,
    },
    {
      id: "person.lookup",
      name: "person_lookup",
      description: "Look up safe context about the person being called.",
      input_schema_json: {
        type: "object",
        properties: {
          person_id: { type: "string", description: "Person identifier" },
          fields: {
            type: "array",
            items: { type: "string" },
            description: "Fields to return, such as name, tags, and last_interaction.",
          },
        },
        required: ["person_id"],
        additionalProperties: false,
      },
      executor_type: "native",
      executor_config_json: { handler: "person.lookup" },
      side_effect: "read_only",
      timeout_ms: 5000,
    },
    {
      id: "prox.note.create",
      name: "prox_note_create",
      description: "Save an internal note or insight from the conversation.",
      input_schema_json: {
        type: "object",
        properties: {
          content: { type: "string", description: "Note content" },
          tags: { type: "array", items: { type: "string" }, description: "Optional tags" },
        },
        required: ["content"],
        additionalProperties: false,
      },
      executor_type: "native",
      executor_config_json: { handler: "prox.note.create" },
      side_effect: "write_internal",
      timeout_ms: 5000,
    },
    {
      id: "prox.followup.schedule",
      name: "prox_followup_schedule",
      description: "Schedule a future follow-up call or message through prox rules.",
      input_schema_json: {
        type: "object",
        properties: {
          person_id: { type: "string", description: "Person to follow up with" },
          reason: { type: "string", description: "Reason for follow-up" },
          delay_minutes: { type: "number", description: "Minutes from now to schedule" },
          channel: { type: "string", enum: ["call", "message"], description: "Follow-up channel" },
        },
        required: ["person_id", "reason"],
        additionalProperties: false,
      },
      executor_type: "native",
      executor_config_json: { handler: "prox.followup.schedule" },
      side_effect: "external_message",
      timeout_ms: 5000,
    },
    {
      id: "task.create",
      name: "task_create",
      description: "Create an internal Ravi task for another agent or runtime after the call.",
      input_schema_json: {
        type: "object",
        properties: {
          title: { type: "string", description: "Task title" },
          description: { type: "string", description: "Task description" },
          assignee: { type: "string", description: "Agent or person to assign to" },
          priority: { type: "string", enum: ["low", "normal", "high", "urgent"], description: "Task priority" },
        },
        required: ["title"],
        additionalProperties: false,
      },
      executor_type: "native",
      executor_config_json: { handler: "task.create" },
      side_effect: "write_internal",
      timeout_ms: 10000,
    },
  ];

  for (const tool of tools) {
    if (!getCallTool(tool.id)) {
      upsertCallTool(tool);
    }
  }

  if (!getCallToolPolicy("call.end", "global", "*")) {
    upsertCallToolPolicy({
      id: "policy-call-end-global",
      tool_id: "call.end",
      scope_type: "global",
      scope_id: "*",
      allowed: true,
    });
  }
  if (!getCallToolPolicy("person.lookup", "global", "*")) {
    upsertCallToolPolicy({
      id: "policy-person-lookup-global",
      tool_id: "person.lookup",
      scope_type: "global",
      scope_id: "*",
      allowed: true,
    });
  }
  if (!getCallToolPolicy("prox.note.create", "global", "*")) {
    upsertCallToolPolicy({
      id: "policy-prox-note-create-global",
      tool_id: "prox.note.create",
      scope_type: "global",
      scope_id: "*",
      allowed: true,
    });
  }
}

export function seedCallToolBindingsForProfile(profileId: string): void {
  ensureCallsSchema();
  seedDefaultCallTools();
  const bindingId = `bind-${profileId}-call-end`;
  const existing = getCallToolBinding(bindingId);
  if (existing) return;
  upsertCallToolBinding({
    id: bindingId,
    tool_id: "call.end",
    scope_type: "profile",
    scope_id: profileId,
    provider_tool_name: "end_call",
  });
}

// ---------------------------------------------------------------------------
// Schema reset (for testing)
// ---------------------------------------------------------------------------

export function resetCallsSchemaFlag(): void {
  schemaReady = false;
  schemaDbPath = null;
}
