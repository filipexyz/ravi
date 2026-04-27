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
  CallToolSideEffectClass,
  CreateCallToolInput,
  UpdateCallToolInput,
  CallToolBinding,
  CallToolBindingScopeType,
  CreateCallToolBindingInput,
  CallToolPolicy,
  CreateCallToolPolicyInput,
  UpdateCallToolPolicyInput,
  CallToolRun,
  CallToolRunStatus,
  CreateCallToolRunInput,
  EffectiveTool,
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
  voice_agent_id: string | null;
  voice_agent_version: number | null;
  voice_agent_snapshot_json: string | null;
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
  voice_agent_id: string | null;
  voice_agent_version: number | null;
  voice_agent_snapshot_json: string | null;
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
  system_prompt: string;
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
  input_schema_json: string | null;
  output_schema_json: string | null;
  executor_type: string;
  executor_config_json: string | null;
  side_effect_class: string;
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
  tool_id: string | null;
  voice_agent_id: string | null;
  profile_id: string | null;
  side_effect_class: string | null;
  scope_type: string | null;
  scope_id: string | null;
  allow: number;
  max_calls_per_run: number | null;
  config_json: string | null;
  enabled: number;
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
  status: string;
  input_json: string | null;
  result_json: string | null;
  error_json: string | null;
  started_at: number;
  completed_at: number | null;
  source: string | null;
  provider_metadata_json: string | null;
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

    CREATE TABLE IF NOT EXISTS call_voice_agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      provider TEXT NOT NULL DEFAULT 'elevenlabs',
      provider_agent_id TEXT,
      voice_id TEXT,
      language TEXT NOT NULL DEFAULT 'pt-BR',
      system_prompt TEXT NOT NULL DEFAULT '',
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
      input_schema_json TEXT,
      output_schema_json TEXT,
      executor_type TEXT NOT NULL DEFAULT 'native',
      executor_config_json TEXT,
      side_effect_class TEXT NOT NULL DEFAULT 'read_only',
      timeout_ms INTEGER NOT NULL DEFAULT 30000,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS call_tool_bindings (
      id TEXT PRIMARY KEY,
      tool_id TEXT NOT NULL,
      scope_type TEXT NOT NULL,
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
      tool_id TEXT,
      voice_agent_id TEXT,
      profile_id TEXT,
      side_effect_class TEXT,
      scope_type TEXT,
      scope_id TEXT,
      allow INTEGER NOT NULL DEFAULT 1,
      max_calls_per_run INTEGER,
      config_json TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS call_tool_runs (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      run_id TEXT,
      tool_id TEXT NOT NULL,
      binding_id TEXT,
      provider_tool_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'started',
      input_json TEXT,
      result_json TEXT,
      error_json TEXT,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      source TEXT,
      provider_metadata_json TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (request_id) REFERENCES call_requests(id) ON DELETE CASCADE,
      FOREIGN KEY (tool_id) REFERENCES call_tools(id)
    );

    CREATE INDEX IF NOT EXISTS idx_call_voice_agents_enabled ON call_voice_agents(enabled);
    CREATE INDEX IF NOT EXISTS idx_call_tools_enabled ON call_tools(enabled);
    CREATE INDEX IF NOT EXISTS idx_call_tool_bindings_scope ON call_tool_bindings(scope_type, scope_id);
    CREATE INDEX IF NOT EXISTS idx_call_tool_bindings_tool ON call_tool_bindings(tool_id);
    CREATE INDEX IF NOT EXISTS idx_call_tool_policies_tool ON call_tool_policies(tool_id);
    CREATE INDEX IF NOT EXISTS idx_call_tool_policies_voice_agent ON call_tool_policies(voice_agent_id);
    CREATE INDEX IF NOT EXISTS idx_call_tool_policies_profile ON call_tool_policies(profile_id);
    CREATE INDEX IF NOT EXISTS idx_call_tool_runs_request ON call_tool_runs(request_id, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_call_tool_runs_run ON call_tool_runs(run_id, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_call_tool_runs_tool ON call_tool_runs(tool_id);
  `);

  // Lazy migrations for existing tables
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

  // Voice-agent snapshot columns on call_requests
  const requestColumns = db.prepare("PRAGMA table_info(call_requests)").all() as Array<{ name: string }>;
  const hasRequestColumn = (name: string) => requestColumns.some((column) => column.name === name);
  if (!hasRequestColumn("voice_agent_id")) {
    db.exec("ALTER TABLE call_requests ADD COLUMN voice_agent_id TEXT");
  }
  if (!hasRequestColumn("voice_agent_version")) {
    db.exec("ALTER TABLE call_requests ADD COLUMN voice_agent_version INTEGER");
  }
  if (!hasRequestColumn("voice_agent_snapshot_json")) {
    db.exec("ALTER TABLE call_requests ADD COLUMN voice_agent_snapshot_json TEXT");
  }

  // Voice-agent snapshot columns on call_runs
  const runColumns = db.prepare("PRAGMA table_info(call_runs)").all() as Array<{ name: string }>;
  const hasRunColumn = (name: string) => runColumns.some((column) => column.name === name);
  if (!hasRunColumn("voice_agent_id")) {
    db.exec("ALTER TABLE call_runs ADD COLUMN voice_agent_id TEXT");
  }
  if (!hasRunColumn("voice_agent_version")) {
    db.exec("ALTER TABLE call_runs ADD COLUMN voice_agent_version INTEGER");
  }
  if (!hasRunColumn("voice_agent_snapshot_json")) {
    db.exec("ALTER TABLE call_runs ADD COLUMN voice_agent_snapshot_json TEXT");
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
    voice_agent_id: row.voice_agent_id ?? null,
    voice_agent_version: row.voice_agent_version ?? null,
    voice_agent_snapshot_json: parseJson<Record<string, unknown>>(row.voice_agent_snapshot_json ?? null),
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
    voice_agent_id: row.voice_agent_id ?? null,
    voice_agent_version: row.voice_agent_version ?? null,
    voice_agent_snapshot_json: parseJson<Record<string, unknown>>(row.voice_agent_snapshot_json ?? null),
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
    INSERT INTO call_requests (id, status, profile_id, rules_id, target_person_id, target_contact_id, target_platform_identity_id, target_phone, origin_session_name, origin_agent_name, origin_channel, origin_message_id, reason, priority, deadline_at, scheduled_for, metadata_json, voice_agent_id, voice_agent_version, voice_agent_snapshot_json, created_at, updated_at)
    VALUES (?, 'pending', ?, NULL, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    input.voice_agent_id ?? null,
    input.voice_agent_version ?? null,
    toJson(input.voice_agent_snapshot_json),
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
    INSERT INTO call_runs (id, request_id, status, attempt_number, provider, started_at, voice_agent_id, voice_agent_version, voice_agent_snapshot_json)
    VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.request_id,
    input.attempt_number,
    input.provider,
    Date.now(),
    input.voice_agent_id ?? null,
    input.voice_agent_version ?? null,
    toJson(input.voice_agent_snapshot_json),
  );

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
// Row → domain converters (voice/tool entities)
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

function rowToTool(row: CallToolRow): CallTool {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    input_schema_json: parseJson<Record<string, unknown>>(row.input_schema_json),
    output_schema_json: parseJson<Record<string, unknown>>(row.output_schema_json),
    executor_type: row.executor_type as CallToolExecutorType,
    executor_config_json: parseJson<Record<string, unknown>>(row.executor_config_json),
    side_effect_class: row.side_effect_class as CallToolSideEffectClass,
    timeout_ms: row.timeout_ms,
    enabled: row.enabled === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToBinding(row: CallToolBindingRow): CallToolBinding {
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

function rowToPolicy(row: CallToolPolicyRow): CallToolPolicy {
  return {
    id: row.id,
    tool_id: row.tool_id,
    voice_agent_id: row.voice_agent_id,
    profile_id: row.profile_id,
    side_effect_class: row.side_effect_class as CallToolSideEffectClass | null,
    scope_type: row.scope_type,
    scope_id: row.scope_id,
    allow: row.allow === 1,
    max_calls_per_run: row.max_calls_per_run,
    config_json: parseJson<Record<string, unknown>>(row.config_json),
    enabled: row.enabled === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToToolRun(row: CallToolRunRow): CallToolRun {
  return {
    id: row.id,
    request_id: row.request_id,
    run_id: row.run_id,
    tool_id: row.tool_id,
    binding_id: row.binding_id,
    provider_tool_name: row.provider_tool_name,
    status: row.status as CallToolRunStatus,
    input_json: parseJson<Record<string, unknown>>(row.input_json),
    result_json: parseJson<Record<string, unknown>>(row.result_json),
    error_json: parseJson<Record<string, unknown>>(row.error_json),
    started_at: row.started_at,
    completed_at: row.completed_at,
    source: row.source,
    provider_metadata_json: parseJson<Record<string, unknown>>(row.provider_metadata_json),
    created_at: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Voice Agents
// ---------------------------------------------------------------------------

export function createCallVoiceAgent(input: CreateCallVoiceAgentInput): CallVoiceAgent {
  ensureCallsSchema();
  const db = getDb();
  const now = Date.now();

  db.prepare(`
    INSERT INTO call_voice_agents (id, name, description, provider, provider_agent_id, voice_id, language, system_prompt, system_prompt_path, first_message_template, dynamic_variables_schema_json, default_tools_json, provider_config_json, version, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
  `).run(
    input.id,
    input.name,
    input.description ?? "",
    input.provider ?? "elevenlabs",
    input.provider_agent_id ?? null,
    input.voice_id ?? null,
    input.language ?? "pt-BR",
    input.system_prompt ?? "",
    input.system_prompt_path ?? null,
    input.first_message_template ?? null,
    toJson(input.dynamic_variables_schema_json),
    toJson(input.default_tools_json),
    toJson(input.provider_config_json),
    input.enabled !== false ? 1 : 0,
    now,
    now,
  );

  return getCallVoiceAgent(input.id)!;
}

export function getCallVoiceAgent(id: string): CallVoiceAgent | null {
  ensureCallsSchema();
  const row = getDb().prepare("SELECT * FROM call_voice_agents WHERE id = ?").get(id) as CallVoiceAgentRow | undefined;
  return row ? rowToVoiceAgent(row) : null;
}

export function listCallVoiceAgents(options?: { enabledOnly?: boolean }): CallVoiceAgent[] {
  ensureCallsSchema();
  const enabledOnly = options?.enabledOnly ?? false;
  const sql = enabledOnly
    ? "SELECT * FROM call_voice_agents WHERE enabled = 1 ORDER BY name ASC"
    : "SELECT * FROM call_voice_agents ORDER BY name ASC";
  const rows = getDb().prepare(sql).all() as CallVoiceAgentRow[];
  return rows.map(rowToVoiceAgent);
}

export function updateCallVoiceAgent(id: string, input: UpdateCallVoiceAgentInput): CallVoiceAgent | null {
  ensureCallsSchema();
  const db = getDb();
  const existing = getCallVoiceAgent(id);
  if (!existing) return null;

  const now = Date.now();
  const fields: string[] = [];
  const values: (string | number | null)[] = [];
  let bumpVersion = false;

  if (input.name !== undefined) {
    fields.push("name = ?");
    values.push(input.name);
  }
  if (input.description !== undefined) {
    fields.push("description = ?");
    values.push(input.description);
  }
  if (input.provider !== undefined) {
    fields.push("provider = ?");
    values.push(input.provider);
  }
  if (input.provider_agent_id !== undefined) {
    fields.push("provider_agent_id = ?");
    values.push(input.provider_agent_id);
  }
  if (input.voice_id !== undefined) {
    fields.push("voice_id = ?");
    values.push(input.voice_id);
    bumpVersion = true;
  }
  if (input.language !== undefined) {
    fields.push("language = ?");
    values.push(input.language);
  }
  if (input.system_prompt !== undefined) {
    fields.push("system_prompt = ?");
    values.push(input.system_prompt);
    bumpVersion = true;
  }
  if (input.system_prompt_path !== undefined) {
    fields.push("system_prompt_path = ?");
    values.push(input.system_prompt_path);
    bumpVersion = true;
  }
  if (input.first_message_template !== undefined) {
    fields.push("first_message_template = ?");
    values.push(input.first_message_template);
    bumpVersion = true;
  }
  if (input.dynamic_variables_schema_json !== undefined) {
    fields.push("dynamic_variables_schema_json = ?");
    values.push(toJson(input.dynamic_variables_schema_json));
    bumpVersion = true;
  }
  if (input.default_tools_json !== undefined) {
    fields.push("default_tools_json = ?");
    values.push(toJson(input.default_tools_json));
    bumpVersion = true;
  }
  if (input.provider_config_json !== undefined) {
    fields.push("provider_config_json = ?");
    values.push(toJson(input.provider_config_json));
    bumpVersion = true;
  }
  if (input.enabled !== undefined) {
    fields.push("enabled = ?");
    values.push(input.enabled ? 1 : 0);
  }

  if (fields.length === 0) return existing;

  if (bumpVersion) {
    fields.push("version = version + 1");
  }

  fields.push("updated_at = ?");
  values.push(now);
  values.push(id);

  db.prepare(`UPDATE call_voice_agents SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  return getCallVoiceAgent(id);
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export function createCallTool(input: CreateCallToolInput): CallTool {
  ensureCallsSchema();
  const db = getDb();
  const now = Date.now();

  db.prepare(`
    INSERT INTO call_tools (id, name, description, input_schema_json, output_schema_json, executor_type, executor_config_json, side_effect_class, timeout_ms, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.name,
    input.description ?? "",
    toJson(input.input_schema_json),
    toJson(input.output_schema_json),
    input.executor_type ?? "native",
    toJson(input.executor_config_json),
    input.side_effect_class ?? "read_only",
    input.timeout_ms ?? 30000,
    input.enabled !== false ? 1 : 0,
    now,
    now,
  );

  return getCallTool(input.id)!;
}

export function getCallTool(id: string): CallTool | null {
  ensureCallsSchema();
  const row = getDb().prepare("SELECT * FROM call_tools WHERE id = ?").get(id) as CallToolRow | undefined;
  return row ? rowToTool(row) : null;
}

export function listCallTools(options?: { enabledOnly?: boolean }): CallTool[] {
  ensureCallsSchema();
  const enabledOnly = options?.enabledOnly ?? false;
  const sql = enabledOnly
    ? "SELECT * FROM call_tools WHERE enabled = 1 ORDER BY id ASC"
    : "SELECT * FROM call_tools ORDER BY id ASC";
  const rows = getDb().prepare(sql).all() as CallToolRow[];
  return rows.map(rowToTool);
}

export function updateCallTool(id: string, input: UpdateCallToolInput): CallTool | null {
  ensureCallsSchema();
  const db = getDb();
  const existing = getCallTool(id);
  if (!existing) return null;

  const now = Date.now();
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
    values.push(toJson(input.input_schema_json));
  }
  if (input.output_schema_json !== undefined) {
    fields.push("output_schema_json = ?");
    values.push(toJson(input.output_schema_json));
  }
  if (input.executor_type !== undefined) {
    fields.push("executor_type = ?");
    values.push(input.executor_type);
  }
  if (input.executor_config_json !== undefined) {
    fields.push("executor_config_json = ?");
    values.push(toJson(input.executor_config_json));
  }
  if (input.side_effect_class !== undefined) {
    fields.push("side_effect_class = ?");
    values.push(input.side_effect_class);
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
  values.push(now);
  values.push(id);

  db.prepare(`UPDATE call_tools SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  return getCallTool(id);
}

// ---------------------------------------------------------------------------
// Tool Bindings
// ---------------------------------------------------------------------------

export function createCallToolBinding(input: CreateCallToolBindingInput): CallToolBinding {
  ensureCallsSchema();
  const db = getDb();
  const id = `bind_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const now = Date.now();

  db.prepare(`
    INSERT INTO call_tool_bindings (id, tool_id, scope_type, scope_id, provider_tool_name, enabled, tool_prompt, required, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.tool_id,
    input.scope_type,
    input.scope_id,
    input.provider_tool_name ?? input.tool_id,
    input.enabled !== false ? 1 : 0,
    input.tool_prompt ?? null,
    input.required ? 1 : 0,
    now,
    now,
  );

  return getCallToolBinding(id)!;
}

export function getCallToolBinding(id: string): CallToolBinding | null {
  ensureCallsSchema();
  const row = getDb().prepare("SELECT * FROM call_tool_bindings WHERE id = ?").get(id) as
    | CallToolBindingRow
    | undefined;
  return row ? rowToBinding(row) : null;
}

export function listCallToolBindings(options?: {
  scope_type?: CallToolBindingScopeType;
  scope_id?: string;
  tool_id?: string;
}): CallToolBinding[] {
  ensureCallsSchema();
  const conditions: string[] = [];
  const params: string[] = [];

  if (options?.scope_type) {
    conditions.push("scope_type = ?");
    params.push(options.scope_type);
  }
  if (options?.scope_id) {
    conditions.push("scope_id = ?");
    params.push(options.scope_id);
  }
  if (options?.tool_id) {
    conditions.push("tool_id = ?");
    params.push(options.tool_id);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = getDb()
    .prepare(`SELECT * FROM call_tool_bindings ${where} ORDER BY created_at ASC`)
    .all(...params) as CallToolBindingRow[];
  return rows.map(rowToBinding);
}

export function updateCallToolBinding(
  id: string,
  input: { enabled?: boolean; tool_prompt?: string | null; required?: boolean; provider_tool_name?: string },
): CallToolBinding | null {
  ensureCallsSchema();
  const db = getDb();
  const existing = getCallToolBinding(id);
  if (!existing) return null;

  const now = Date.now();
  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (input.enabled !== undefined) {
    fields.push("enabled = ?");
    values.push(input.enabled ? 1 : 0);
  }
  if (input.tool_prompt !== undefined) {
    fields.push("tool_prompt = ?");
    values.push(input.tool_prompt);
  }
  if (input.required !== undefined) {
    fields.push("required = ?");
    values.push(input.required ? 1 : 0);
  }
  if (input.provider_tool_name !== undefined) {
    fields.push("provider_tool_name = ?");
    values.push(input.provider_tool_name);
  }

  if (fields.length === 0) return existing;

  fields.push("updated_at = ?");
  values.push(now);
  values.push(id);

  db.prepare(`UPDATE call_tool_bindings SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  return getCallToolBinding(id);
}

// ---------------------------------------------------------------------------
// Tool Policies
// ---------------------------------------------------------------------------

export function createCallToolPolicy(input: CreateCallToolPolicyInput): CallToolPolicy {
  ensureCallsSchema();
  const db = getDb();
  const id = `pol_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const now = Date.now();

  db.prepare(`
    INSERT INTO call_tool_policies (id, tool_id, voice_agent_id, profile_id, side_effect_class, scope_type, scope_id, allow, max_calls_per_run, config_json, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.tool_id ?? null,
    input.voice_agent_id ?? null,
    input.profile_id ?? null,
    input.side_effect_class ?? null,
    input.scope_type ?? null,
    input.scope_id ?? null,
    input.allow !== false ? 1 : 0,
    input.max_calls_per_run ?? null,
    toJson(input.config_json),
    input.enabled !== false ? 1 : 0,
    now,
    now,
  );

  return getCallToolPolicy(id)!;
}

export function getCallToolPolicy(id: string): CallToolPolicy | null {
  ensureCallsSchema();
  const row = getDb().prepare("SELECT * FROM call_tool_policies WHERE id = ?").get(id) as CallToolPolicyRow | undefined;
  return row ? rowToPolicy(row) : null;
}

export function listCallToolPolicies(options?: {
  tool_id?: string;
  voice_agent_id?: string;
  profile_id?: string;
}): CallToolPolicy[] {
  ensureCallsSchema();
  const conditions: string[] = [];
  const params: string[] = [];

  if (options?.tool_id) {
    conditions.push("tool_id = ?");
    params.push(options.tool_id);
  }
  if (options?.voice_agent_id) {
    conditions.push("voice_agent_id = ?");
    params.push(options.voice_agent_id);
  }
  if (options?.profile_id) {
    conditions.push("profile_id = ?");
    params.push(options.profile_id);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = getDb()
    .prepare(`SELECT * FROM call_tool_policies ${where} ORDER BY created_at ASC`)
    .all(...params) as CallToolPolicyRow[];
  return rows.map(rowToPolicy);
}

export function updateCallToolPolicy(id: string, input: UpdateCallToolPolicyInput): CallToolPolicy | null {
  ensureCallsSchema();
  const db = getDb();
  const existing = getCallToolPolicy(id);
  if (!existing) return null;

  const now = Date.now();
  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (input.allow !== undefined) {
    fields.push("allow = ?");
    values.push(input.allow ? 1 : 0);
  }
  if (input.max_calls_per_run !== undefined) {
    fields.push("max_calls_per_run = ?");
    values.push(input.max_calls_per_run);
  }
  if (input.config_json !== undefined) {
    fields.push("config_json = ?");
    values.push(toJson(input.config_json));
  }
  if (input.enabled !== undefined) {
    fields.push("enabled = ?");
    values.push(input.enabled ? 1 : 0);
  }

  if (fields.length === 0) return existing;

  fields.push("updated_at = ?");
  values.push(now);
  values.push(id);

  db.prepare(`UPDATE call_tool_policies SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  return getCallToolPolicy(id);
}

// ---------------------------------------------------------------------------
// Tool Runs
// ---------------------------------------------------------------------------

export function createCallToolRun(input: CreateCallToolRunInput): CallToolRun {
  ensureCallsSchema();
  const db = getDb();
  const id = `tr_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const now = Date.now();

  db.prepare(`
    INSERT INTO call_tool_runs (id, request_id, run_id, tool_id, binding_id, provider_tool_name, status, input_json, result_json, error_json, started_at, completed_at, source, provider_metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'started', ?, NULL, NULL, ?, NULL, ?, ?, ?)
  `).run(
    id,
    input.request_id,
    input.run_id ?? null,
    input.tool_id,
    input.binding_id ?? null,
    input.provider_tool_name,
    toJson(input.input_json),
    now,
    input.source ?? null,
    toJson(input.provider_metadata_json),
    now,
  );

  return getCallToolRun(id)!;
}

export function getCallToolRun(id: string): CallToolRun | null {
  ensureCallsSchema();
  const row = getDb().prepare("SELECT * FROM call_tool_runs WHERE id = ?").get(id) as CallToolRunRow | undefined;
  return row ? rowToToolRun(row) : null;
}

export function listCallToolRuns(options: { request_id?: string; run_id?: string; tool_id?: string }): CallToolRun[] {
  ensureCallsSchema();
  const conditions: string[] = [];
  const params: string[] = [];

  if (options.request_id) {
    conditions.push("request_id = ?");
    params.push(options.request_id);
  }
  if (options.run_id) {
    conditions.push("run_id = ?");
    params.push(options.run_id);
  }
  if (options.tool_id) {
    conditions.push("tool_id = ?");
    params.push(options.tool_id);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = getDb()
    .prepare(`SELECT * FROM call_tool_runs ${where} ORDER BY created_at ASC`)
    .all(...params) as CallToolRunRow[];
  return rows.map(rowToToolRun);
}

export function updateCallToolRunStatus(
  id: string,
  status: CallToolRunStatus,
  extra?: { result_json?: Record<string, unknown>; error_json?: Record<string, unknown> },
): void {
  ensureCallsSchema();
  const db = getDb();
  const now = Date.now();
  db.prepare("UPDATE call_tool_runs SET status = ? WHERE id = ?").run(status, id);

  if (status === "completed" || status === "failed" || status === "blocked" || status === "timed_out") {
    db.prepare("UPDATE call_tool_runs SET completed_at = COALESCE(completed_at, ?) WHERE id = ?").run(now, id);
  }
  if (extra?.result_json !== undefined) {
    db.prepare("UPDATE call_tool_runs SET result_json = ? WHERE id = ?").run(toJson(extra.result_json), id);
  }
  if (extra?.error_json !== undefined) {
    db.prepare("UPDATE call_tool_runs SET error_json = ? WHERE id = ?").run(toJson(extra.error_json), id);
  }
}

// ---------------------------------------------------------------------------
// Effective tool resolution
// ---------------------------------------------------------------------------

export function resolveEffectiveTools(params: { voice_agent_id: string; profile_id: string }): EffectiveTool[] {
  ensureCallsSchema();

  const voiceAgentBindings = listCallToolBindings({ scope_type: "voice_agent", scope_id: params.voice_agent_id });
  const profileBindings = listCallToolBindings({ scope_type: "profile", scope_id: params.profile_id });

  const profileToolSet = new Set(profileBindings.map((b) => b.tool_id));

  const candidateBindings: CallToolBinding[] = [];
  for (const vab of voiceAgentBindings) {
    if (profileToolSet.has(vab.tool_id)) {
      candidateBindings.push(vab);
    }
  }

  for (const pb of profileBindings) {
    if (!candidateBindings.some((b) => b.tool_id === pb.tool_id)) {
      candidateBindings.push(pb);
    }
  }

  const policies = listCallToolPolicies();

  const results: EffectiveTool[] = [];
  for (const binding of candidateBindings) {
    const tool = getCallTool(binding.tool_id);
    if (!tool) continue;

    let blocked = false;
    let blockReason: string | null = null;

    if (!tool.enabled) {
      blocked = true;
      blockReason = "tool disabled";
    }

    if (!blocked && !binding.enabled) {
      blocked = true;
      blockReason = "binding disabled";
    }

    const profileBinding = profileBindings.find((b) => b.tool_id === binding.tool_id);
    if (!blocked && profileBinding && !profileBinding.enabled) {
      blocked = true;
      blockReason = "profile binding disabled";
    }

    if (!blocked) {
      for (const policy of policies) {
        if (!policy.enabled) continue;

        const matchesTool = !policy.tool_id || policy.tool_id === tool.id;
        const matchesVoiceAgent = !policy.voice_agent_id || policy.voice_agent_id === params.voice_agent_id;
        const matchesProfile = !policy.profile_id || policy.profile_id === params.profile_id;
        const matchesSideEffect = !policy.side_effect_class || policy.side_effect_class === tool.side_effect_class;

        if (matchesTool && matchesVoiceAgent && matchesProfile && matchesSideEffect) {
          if (!policy.allow) {
            blocked = true;
            blockReason = `blocked by policy ${policy.id}`;
            break;
          }
        }
      }
    }

    results.push({ tool, binding, blocked, block_reason: blockReason });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Schema reset (for testing)
// ---------------------------------------------------------------------------

export function resetCallsSchemaFlag(): void {
  schemaReady = false;
  schemaDbPath = null;
}
