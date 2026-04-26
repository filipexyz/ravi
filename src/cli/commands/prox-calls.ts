/**
 * prox calls — CLI commands for prox.city voice follow-up capability.
 *
 * Namespace: ravi prox calls
 */

import "reflect-metadata";
import { Arg, Command, Group, Option } from "../decorators.js";
import { fail, getContext } from "../context.js";
import {
  listCallProfiles,
  getCallProfile,
  updateCallProfile,
  getCallRules,
  getCallRequest,
  listCallEvents,
  listCallRuns,
  getCallResultForRequest,
  initCallsDefaults,
  submitCallRequest,
  cancelCallRequest,
  hasRealProvider,
  type CallRequest,
  type CallProfile,
  type CallEvent,
  type CallRules as CallRulesType,
  type VoicemailPolicy,
} from "../../prox/calls/index.js";

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function formatTime(ts?: number | null): string {
  if (!ts) return "-";
  return new Date(ts).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function statusColor(status: string): string {
  switch (status) {
    case "completed":
    case "answered":
    case "allow":
      return `\x1b[32m${status}\x1b[0m`;
    case "pending":
    case "scheduled":
    case "queued":
      return `\x1b[33m${status}\x1b[0m`;
    case "running":
    case "dialing":
    case "ringing":
    case "in_progress":
      return `\x1b[36m${status}\x1b[0m`;
    case "failed":
    case "canceled":
    case "blocked":
      return `\x1b[31m${status}\x1b[0m`;
    case "snoozed":
      return `\x1b[35m${status}\x1b[0m`;
    default:
      return status;
  }
}

function serializeProfile(profile: CallProfile) {
  return {
    id: profile.id,
    name: profile.name,
    provider: profile.provider,
    provider_agent_id: profile.provider_agent_id,
    twilio_number_id: profile.twilio_number_id,
    language: profile.language,
    prompt: profile.prompt,
    extraction_schema: profile.extraction_schema_json,
    voicemail_policy: profile.voicemail_policy,
    enabled: profile.enabled,
    created_at: profile.created_at,
    updated_at: profile.updated_at,
  };
}

function serializeRequest(request: CallRequest) {
  return {
    id: request.id,
    status: request.status,
    profile_id: request.profile_id,
    rules_id: request.rules_id,
    target_person_id: request.target_person_id,
    target_contact_id: request.target_contact_id,
    target_phone: request.target_phone,
    origin_session_name: request.origin_session_name,
    origin_agent_name: request.origin_agent_name,
    origin_channel: request.origin_channel,
    origin_message_id: request.origin_message_id,
    reason: request.reason,
    priority: request.priority,
    deadline_at: request.deadline_at,
    scheduled_for: request.scheduled_for,
    metadata: request.metadata_json,
    created_at: request.created_at,
    updated_at: request.updated_at,
  };
}

function serializeRules(rules: CallRulesType) {
  return {
    id: rules.id,
    scope_type: rules.scope_type,
    scope_id: rules.scope_id,
    quiet_hours: rules.quiet_hours_json,
    max_attempts: rules.max_attempts,
    cooldown_seconds: rules.cooldown_seconds,
    snooze_until: rules.snooze_until,
    cancel_on_inbound_reply: rules.cancel_on_inbound_reply,
    require_approval: rules.require_approval,
    enabled: rules.enabled,
    created_at: rules.created_at,
    updated_at: rules.updated_at,
  };
}

function serializeEvent(event: CallEvent) {
  return {
    id: event.id,
    request_id: event.request_id,
    run_id: event.run_id,
    event_type: event.event_type,
    status: event.status,
    message: event.message,
    payload: event.payload_json,
    source: event.source,
    created_at: event.created_at,
  };
}

// ---------------------------------------------------------------------------
// Profiles subcommand group: ravi prox calls profiles
// ---------------------------------------------------------------------------

@Group({
  name: "prox.calls.profiles",
  description: "Manage call profiles",
  scope: "open",
})
export class ProxCallsProfileCommands {
  @Command({ name: "list", description: "List available call profiles" })
  list(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    initCallsDefaults();
    const profiles = listCallProfiles();

    if (asJson) {
      printJson({ total: profiles.length, profiles: profiles.map(serializeProfile) });
      return;
    }

    if (profiles.length === 0) {
      console.log("\nNo call profiles found.\n");
      return;
    }

    console.log(`\nCall profiles (${profiles.length})\n`);
    console.log("  ID                  NAME                PROVIDER     LANGUAGE  VOICEMAIL");
    console.log("  ------------------  ------------------  -----------  --------  ---------");
    for (const p of profiles) {
      console.log(
        `  ${p.id.padEnd(18)}  ${p.name.padEnd(18)}  ${p.provider.padEnd(11)}  ${p.language.padEnd(8)}  ${p.voicemail_policy}`,
      );
    }
    console.log();
  }

  @Command({ name: "show", description: "Show a call profile by ID" })
  show(
    @Arg("profile_id") profileId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    initCallsDefaults();
    const profile = getCallProfile(profileId);
    if (!profile) {
      fail(`Call profile not found: ${profileId}`);
    }

    if (asJson) {
      printJson(serializeProfile(profile));
      return;
    }

    console.log(`\nCall Profile: ${profile.name}\n`);
    console.log(`  ID:              ${profile.id}`);
    console.log(`  Provider:        ${profile.provider}`);
    console.log(`  Agent ID:        ${profile.provider_agent_id || "-"}`);
    console.log(`  Twilio Number:   ${profile.twilio_number_id || "-"}`);
    console.log(`  Language:        ${profile.language}`);
    console.log(`  Voicemail:       ${profile.voicemail_policy}`);
    console.log(`  Enabled:         ${profile.enabled ? "yes" : "no"}`);
    console.log(`  Prompt:          ${profile.prompt.slice(0, 80)}${profile.prompt.length > 80 ? "…" : ""}`);
    console.log(`  Created:         ${formatTime(profile.created_at)}`);
    console.log();
  }

  @Command({ name: "configure", description: "Configure a call profile's provider settings" })
  configure(
    @Arg("profile_id") profileId: string,
    @Option({ flags: "--provider <name>", description: "Provider name (e.g. elevenlabs_twilio, stub)" })
    provider?: string,
    @Option({ flags: "--agent-id <id>", description: "ElevenLabs agent ID" }) agentId?: string,
    @Option({ flags: "--twilio-number-id <id>", description: "Twilio phone number ID" }) twilioNumberId?: string,
    @Option({ flags: "--language <lang>", description: "Language code (e.g. pt-BR, en-US)" }) language?: string,
    @Option({ flags: "--prompt <text>", description: "Call prompt text" }) prompt?: string,
    @Option({ flags: "--voicemail-policy <policy>", description: "Voicemail policy: leave_message, hangup, skip" })
    voicemailPolicy?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    initCallsDefaults();

    if (!profileId) fail("profile_id is required");

    const existing = getCallProfile(profileId);
    if (!existing) {
      fail(`Call profile not found: ${profileId}`);
    }

    const validVoicemailPolicies = new Set(["leave_message", "hangup", "skip"]);
    if (voicemailPolicy && !validVoicemailPolicies.has(voicemailPolicy)) {
      fail(`Invalid voicemail policy: ${voicemailPolicy}. Use leave_message|hangup|skip.`);
    }

    const updated = updateCallProfile(profileId, {
      ...(provider !== undefined ? { provider } : {}),
      ...(agentId !== undefined ? { provider_agent_id: agentId } : {}),
      ...(twilioNumberId !== undefined ? { twilio_number_id: twilioNumberId } : {}),
      ...(language !== undefined ? { language } : {}),
      ...(prompt !== undefined ? { prompt } : {}),
      ...(voicemailPolicy !== undefined ? { voicemail_policy: voicemailPolicy as VoicemailPolicy } : {}),
    });

    if (!updated) {
      fail(`Failed to update profile: ${profileId}`);
    }

    if (asJson) {
      printJson(serializeProfile(updated));
      return;
    }

    console.log(`\nProfile ${profileId} updated.\n`);
    console.log(`  Provider:        ${updated.provider}`);
    console.log(`  Agent ID:        ${updated.provider_agent_id || "-"}`);
    console.log(`  Twilio Number:   ${updated.twilio_number_id || "-"}`);
    console.log(`  Language:        ${updated.language}`);
    console.log(`  Voicemail:       ${updated.voicemail_policy}`);
    console.log();
  }
}

// ---------------------------------------------------------------------------
// Main calls command group: ravi prox calls
// ---------------------------------------------------------------------------

@Group({
  name: "prox.calls",
  description: "Voice follow-up / activation for prox.city",
  scope: "open",
})
export class ProxCallsCommands {
  @Command({ name: "rules", description: "Show active call rules" })
  rules(
    @Option({ flags: "--scope <scope>", description: "Rule scope type (global, project, person, profile, agent)" })
    scope?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    initCallsDefaults();
    const rules = getCallRules(scope);
    if (!rules) {
      if (asJson) {
        printJson({ rules: null, message: "No active rules found" });
        return;
      }
      console.log("\nNo active call rules found.\n");
      return;
    }

    if (asJson) {
      printJson(serializeRules(rules));
      return;
    }

    console.log(`\nCall Rules: ${rules.scope_type}/${rules.scope_id}\n`);
    console.log(`  ID:                      ${rules.id}`);
    console.log(`  Scope:                   ${rules.scope_type} / ${rules.scope_id}`);
    const qh = rules.quiet_hours_json;
    console.log(`  Quiet Hours:             ${qh ? `${qh.start}–${qh.end} (${qh.timezone})` : "-"}`);
    console.log(`  Max Attempts:            ${rules.max_attempts}`);
    console.log(`  Cooldown:                ${rules.cooldown_seconds}s`);
    console.log(`  Snooze Until:            ${rules.snooze_until ? formatTime(rules.snooze_until) : "-"}`);
    console.log(`  Cancel on Inbound Reply: ${rules.cancel_on_inbound_reply ? "yes" : "no"}`);
    console.log(`  Require Approval:        ${rules.require_approval ? "yes" : "no"}`);
    console.log(`  Enabled:                 ${rules.enabled ? "yes" : "no"}`);
    console.log();
  }

  @Command({ name: "request", description: "Request a call to a person" })
  async request(
    @Option({ flags: "--profile <profile_id>", description: "Call profile ID" }) profileId: string,
    @Option({ flags: "--person <person_id>", description: "Target person ID" }) personId: string,
    @Option({ flags: "--reason <text>", description: "Reason for the call" }) reason: string,
    @Option({
      flags: "--phone <e164>",
      description: "Target phone number in E.164 format (temporary MVP, e.g. +5511999999999)",
    })
    phone?: string,
    @Option({ flags: "--priority <level>", description: "Priority level (low, normal, high, urgent)" })
    priority?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (!profileId) fail("--profile is required");
    if (!personId) fail("--person is required");
    if (!reason) fail("--reason is required");

    const validPriorities = new Set(["low", "normal", "high", "urgent"]);
    if (priority && !validPriorities.has(priority)) {
      fail(`Invalid priority: ${priority}. Use low|normal|high|urgent.`);
    }

    initCallsDefaults();

    const ctx = getContext();
    const usingStub = !hasRealProvider();

    const result = await submitCallRequest({
      profile_id: profileId,
      target_person_id: personId,
      target_phone: phone ?? null,
      reason,
      priority: (priority as "low" | "normal" | "high" | "urgent") ?? "normal",
      origin_session_name: ctx?.sessionName ?? null,
      origin_agent_name: ctx?.agentId ?? null,
      origin_channel: ctx?.source?.channel ?? null,
      origin_message_id: null,
    });

    if (asJson) {
      printJson({
        request: serializeRequest(result.request),
        blocked: result.blocked,
        block_reason: result.blockReason,
        provider_mode: usingStub ? "stub" : "live",
        hint: "The originating session will be notified when the call reaches a terminal state.",
      });
      return;
    }

    if (result.blocked) {
      console.log(`\n\x1b[31mCall blocked:\x1b[0m ${result.blockReason}`);
      console.log(`  Request ID: ${result.request.id}`);
      console.log(`  Status:     ${statusColor(result.request.status)}`);
    } else {
      console.log(`\nCall request created.`);
      console.log(`  Request ID: ${result.request.id}`);
      console.log(`  Status:     ${statusColor(result.request.status)}`);
      console.log(`  Profile:    ${profileId}`);
      console.log(`  Person:     ${personId}`);
      if (usingStub) {
        console.log(`  Provider:   \x1b[33mstub\x1b[0m (no real call placed — configure provider for live dialing)`);
      }
      console.log(`\n  The originating session will be notified when the call reaches a terminal state.`);
    }
    console.log();
  }

  @Command({ name: "show", description: "Show details of a call request" })
  show(
    @Arg("call_request_id") callRequestId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    initCallsDefaults();
    const request = getCallRequest(callRequestId);
    if (!request) {
      fail(`Call request not found: ${callRequestId}`);
    }

    const runs = listCallRuns(request.id);
    const result = getCallResultForRequest(request.id);

    if (asJson) {
      printJson({
        request: serializeRequest(request),
        runs: runs.map((r) => ({
          id: r.id,
          status: r.status,
          attempt_number: r.attempt_number,
          provider: r.provider,
          provider_call_id: r.provider_call_id,
          twilio_call_sid: r.twilio_call_sid,
          started_at: r.started_at,
          answered_at: r.answered_at,
          ended_at: r.ended_at,
          failure_reason: r.failure_reason,
        })),
        result: result
          ? {
              id: result.id,
              outcome: result.outcome,
              summary: result.summary,
              transcript: result.transcript,
              extraction: result.extraction_json,
              next_action: result.next_action,
              created_at: result.created_at,
            }
          : null,
      });
      return;
    }

    console.log(`\nCall Request: ${request.id}\n`);
    console.log(`  Status:      ${statusColor(request.status)}`);
    console.log(`  Profile:     ${request.profile_id}`);
    console.log(`  Person:      ${request.target_person_id}`);
    console.log(`  Reason:      ${request.reason}`);
    console.log(`  Priority:    ${request.priority}`);
    console.log(`  Rules:       ${request.rules_id ?? "-"}`);
    console.log(`  Origin:      ${request.origin_session_name ?? "-"} / ${request.origin_agent_name ?? "-"}`);
    console.log(`  Channel:     ${request.origin_channel ?? "-"}`);
    console.log(`  Created:     ${formatTime(request.created_at)}`);
    console.log(`  Updated:     ${formatTime(request.updated_at)}`);

    if (runs.length > 0) {
      console.log(`\n  Runs (${runs.length}):`);
      for (const run of runs) {
        console.log(
          `    #${run.attempt_number}  ${statusColor(run.status)}  ${run.provider}  started=${formatTime(run.started_at)}  ended=${formatTime(run.ended_at)}${run.failure_reason ? `  error=${run.failure_reason}` : ""}`,
        );
      }
    }

    if (result) {
      console.log(`\n  Result:`);
      console.log(`    Outcome:     ${statusColor(result.outcome)}`);
      console.log(`    Summary:     ${result.summary ?? "-"}`);
      console.log(`    Next Action: ${result.next_action}`);
      if (result.transcript) {
        console.log(`    Transcript:  ${result.transcript.slice(0, 100)}${result.transcript.length > 100 ? "…" : ""}`);
      }
    }
    console.log();
  }

  @Command({ name: "events", description: "Show event timeline for a call request" })
  events(
    @Arg("call_request_id") callRequestId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    initCallsDefaults();
    const request = getCallRequest(callRequestId);
    if (!request) {
      fail(`Call request not found: ${callRequestId}`);
    }

    const events = listCallEvents(request.id);

    if (asJson) {
      printJson({
        request_id: request.id,
        total: events.length,
        events: events.map(serializeEvent),
      });
      return;
    }

    if (events.length === 0) {
      console.log(`\nNo events for request ${callRequestId}.\n`);
      return;
    }

    console.log(`\nEvents for ${request.id} (${events.length})\n`);
    console.log("  TIME            TYPE                  STATUS              MESSAGE");
    console.log("  --------------  --------------------  ------------------  --------------------------------");
    for (const e of events) {
      console.log(
        `  ${formatTime(e.created_at).padEnd(14)}  ${e.event_type.padEnd(20)}  ${statusColor(e.status).padEnd(28)}  ${(e.message ?? "-").slice(0, 40)}`,
      );
    }
    console.log();
  }

  @Command({ name: "cancel", description: "Cancel a pending call request" })
  cancel(
    @Arg("call_request_id") callRequestId: string,
    @Option({ flags: "--reason <text>", description: "Cancellation reason" }) reason?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    initCallsDefaults();
    const result = cancelCallRequest(callRequestId, reason);

    if (asJson) {
      printJson({
        success: result.success,
        message: result.message,
        request_id: callRequestId,
      });
      return;
    }

    if (result.success) {
      console.log(`\n${result.message}`);
    } else {
      console.log(`\n\x1b[31mError:\x1b[0m ${result.message}`);
    }
    console.log();
  }
}
