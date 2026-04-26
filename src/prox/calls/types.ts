/**
 * prox.city Calls — Type Definitions
 *
 * Entity types for the prox calls capability:
 * call_profile, call_rules, call_request, call_run, call_event, call_result.
 */

// ---------------------------------------------------------------------------
// call_profile
// ---------------------------------------------------------------------------

export type VoicemailPolicy = "leave_message" | "hangup" | "skip";

export interface CallProfile {
  id: string;
  name: string;
  provider: string;
  provider_agent_id: string;
  twilio_number_id: string;
  language: string;
  prompt: string;
  extraction_schema_json: Record<string, unknown> | null;
  voicemail_policy: VoicemailPolicy;
  enabled: boolean;
  created_at: number;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// call_rules
// ---------------------------------------------------------------------------

export type CallRulesScopeType = "global" | "project" | "person" | "profile" | "agent";

export interface QuietHoursShape {
  start: string; // HH:mm
  end: string; // HH:mm
  timezone: string;
}

export interface CallRules {
  id: string;
  scope_type: CallRulesScopeType;
  scope_id: string;
  quiet_hours_json: QuietHoursShape | null;
  max_attempts: number;
  cooldown_seconds: number;
  snooze_until: number | null;
  cancel_on_inbound_reply: boolean;
  require_approval: boolean;
  enabled: boolean;
  created_at: number;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// call_request
// ---------------------------------------------------------------------------

export type CallRequestStatus =
  | "pending"
  | "scheduled"
  | "running"
  | "completed"
  | "failed"
  | "canceled"
  | "snoozed"
  | "blocked";

export type CallRequestPriority = "low" | "normal" | "high" | "urgent";

export interface CallRequest {
  id: string;
  status: CallRequestStatus;
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
  priority: CallRequestPriority;
  deadline_at: number | null;
  scheduled_for: number | null;
  metadata_json: Record<string, unknown> | null;
  created_at: number;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// call_run
// ---------------------------------------------------------------------------

export type CallRunStatus =
  | "queued"
  | "dialing"
  | "ringing"
  | "in_progress"
  | "completed"
  | "no_answer"
  | "busy"
  | "voicemail"
  | "failed"
  | "canceled";

export interface CallRun {
  id: string;
  request_id: string;
  status: CallRunStatus;
  attempt_number: number;
  provider: string;
  provider_call_id: string | null;
  twilio_call_sid: string | null;
  started_at: number | null;
  answered_at: number | null;
  ended_at: number | null;
  failure_reason: string | null;
  metadata_json: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// call_event
// ---------------------------------------------------------------------------

export type CallEventType =
  | "request.created"
  | "request.scheduled"
  | "request.blocked"
  | "request.canceled"
  | "request.snoozed"
  | "run.started"
  | "run.progress"
  | "run.completed"
  | "run.failed"
  | "result.created"
  | "rules.evaluated"
  | "provider.error";

export interface CallEvent {
  id: number;
  request_id: string;
  run_id: string | null;
  event_type: CallEventType;
  status: string;
  message: string | null;
  payload_json: Record<string, unknown> | null;
  source: string | null;
  created_at: number;
}

// ---------------------------------------------------------------------------
// call_result
// ---------------------------------------------------------------------------

export type CallResultOutcome =
  | "answered"
  | "no_answer"
  | "voicemail"
  | "busy"
  | "canceled_by_reply"
  | "blocked_by_rules"
  | "failed_provider"
  | "failed_runtime";

export type CallResultNextAction = "none" | "retry" | "escalate" | "notify";

export interface CallResult {
  id: string;
  request_id: string;
  run_id: string | null;
  outcome: CallResultOutcome;
  summary: string | null;
  transcript: string | null;
  extraction_json: Record<string, unknown> | null;
  next_action: CallResultNextAction;
  artifact_id: string | null;
  created_at: number;
}

// ---------------------------------------------------------------------------
// Input types for creation
// ---------------------------------------------------------------------------

export interface CreateCallRequestInput {
  profile_id: string;
  target_person_id: string;
  reason: string;
  priority?: CallRequestPriority;
  origin_session_name?: string | null;
  origin_agent_name?: string | null;
  origin_channel?: string | null;
  origin_message_id?: string | null;
  deadline_at?: number | null;
  scheduled_for?: number | null;
  metadata_json?: Record<string, unknown> | null;
}

export interface CreateCallRunInput {
  request_id: string;
  attempt_number: number;
  provider: string;
}

export interface CreateCallEventInput {
  request_id: string;
  run_id?: string | null;
  event_type: CallEventType;
  status: string;
  message?: string | null;
  payload_json?: Record<string, unknown> | null;
  source?: string | null;
}

export interface CreateCallResultInput {
  request_id: string;
  run_id?: string | null;
  outcome: CallResultOutcome;
  summary?: string | null;
  transcript?: string | null;
  extraction_json?: Record<string, unknown> | null;
  next_action?: CallResultNextAction;
  artifact_id?: string | null;
}

// ---------------------------------------------------------------------------
// Rules evaluation
// ---------------------------------------------------------------------------

export type RulesVerdict = "allow" | "block_quiet_hours" | "block_max_attempts" | "block_cooldown" | "block_snoozed";

export interface RulesEvaluationResult {
  verdict: RulesVerdict;
  rule: CallRules;
  reason: string;
  evaluated_at: number;
}

// ---------------------------------------------------------------------------
// Provider adapter
// ---------------------------------------------------------------------------

export interface ProviderDialInput {
  request: CallRequest;
  run: CallRun;
  profile: CallProfile;
  target_phone: string;
}

export interface ProviderDialResult {
  provider_call_id: string | null;
  twilio_call_sid: string | null;
  status: CallRunStatus;
  failure_reason: string | null;
}

export interface CallProviderAdapter {
  readonly name: string;
  dial(input: ProviderDialInput): Promise<ProviderDialResult>;
}
