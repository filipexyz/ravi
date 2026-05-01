/**
 * prox calls — CLI commands for prox.city voice follow-up capability.
 *
 * Namespace: ravi prox calls
 */

import "reflect-metadata";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
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
  syncCallRequestFromElevenLabs,
  syncElevenLabsAgentProfile,
  cancelCallRequest,
  hasRealProvider,
  listCallVoiceAgents,
  getCallVoiceAgent,
  createCallVoiceAgent,
  updateCallVoiceAgent,
  listCallTools,
  getCallTool,
  createCallTool,
  updateCallTool,
  listCallToolBindings,
  getCallToolBinding,
  createCallToolBinding,
  deleteCallToolBinding,
  evaluateCallToolPolicy,
  listCallToolRuns,
  type CallRequest,
  type CallProfile,
  type CallEvent,
  type CallRules as CallRulesType,
  type CallVoiceAgent,
  type CallTool,
  type CallToolBinding,
  type CallToolRun,
  type CallToolSideEffect,
  type CallToolExecutorType,
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
    first_message: profile.first_message,
    system_prompt_path: profile.system_prompt_path,
    dynamic_variables: profile.dynamic_variables_json,
    extraction_schema: profile.extraction_schema_json,
    voicemail_policy: profile.voicemail_policy,
    enabled: profile.enabled,
    created_at: profile.created_at,
    updated_at: profile.updated_at,
  };
}

function loadSystemPromptPath(rawPath: string): { path: string; prompt: string } {
  const resolved = resolve(process.cwd(), rawPath);
  if (!existsSync(resolved)) {
    fail(`System prompt file not found: ${resolved}`);
  }
  const prompt = readFileSync(resolved, "utf8").trim();
  if (!prompt) {
    fail(`System prompt file is empty: ${resolved}`);
  }
  return { path: resolved, prompt };
}

function optionList(value?: string | string[]): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function parseDynamicVariableOptions(raw?: string | string[]): Record<string, string> | null {
  const entries = optionList(raw);
  if (entries.length === 0) return null;

  const variables: Record<string, string> = {};
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator <= 0) {
      fail(`Invalid dynamic variable: ${entry}. Use key=value.`);
    }
    const key = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      fail(`Invalid dynamic variable key: ${key}. Use letters, numbers and underscores, starting with a letter or _.`);
    }
    variables[key] = value;
  }
  return variables;
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
  skillGate: "ravi-system-prox-calls",
})
export class ProxCallsProfileCommands {
  @Command({ name: "list", description: "List available call profiles" })
  list(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    initCallsDefaults();
    const profiles = listCallProfiles();
    const payload = { total: profiles.length, profiles: profiles.map(serializeProfile) };

    if (asJson) {
      printJson(payload);
    } else if (profiles.length === 0) {
      console.log("\nNo call profiles found.\n");
    } else {
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
    return payload;
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

    const payload = serializeProfile(profile);

    if (asJson) {
      printJson(payload);
    } else {
      console.log(`\nCall Profile: ${profile.name}\n`);
      console.log(`  ID:              ${profile.id}`);
      console.log(`  Provider:        ${profile.provider}`);
      console.log(`  Agent ID:        ${profile.provider_agent_id || "-"}`);
      console.log(`  Twilio Number:   ${profile.twilio_number_id || "-"}`);
      console.log(`  Language:        ${profile.language}`);
      console.log(`  First Message:   ${profile.first_message ?? "-"}`);
      console.log(`  System Prompt:   ${profile.system_prompt_path ?? "-"}`);
      console.log(
        `  Dynamic Vars:    ${profile.dynamic_variables_json ? Object.keys(profile.dynamic_variables_json).join(", ") : "-"}`,
      );
      console.log(`  Voicemail:       ${profile.voicemail_policy}`);
      console.log(`  Enabled:         ${profile.enabled ? "yes" : "no"}`);
      console.log(`  Prompt:          ${profile.prompt.slice(0, 80)}${profile.prompt.length > 80 ? "…" : ""}`);
      console.log(`  Created:         ${formatTime(profile.created_at)}`);
      console.log();
    }
    return payload;
  }

  @Command({ name: "configure", description: "Configure a call profile's provider settings" })
  async configure(
    @Arg("profile_id") profileId: string,
    @Option({ flags: "--provider <name>", description: "Provider name (e.g. elevenlabs_twilio, agora_sip, stub)" })
    provider?: string,
    @Option({ flags: "--agent-id <id>", description: "Provider agent ID (ElevenLabs agent ID or Agora pipeline_id)" })
    agentId?: string,
    @Option({
      flags: "--twilio-number-id <id>",
      description: "Outbound number reference (ElevenLabs phone ID or Agora E.164 caller number)",
    })
    twilioNumberId?: string,
    @Option({ flags: "--language <lang>", description: "Language code (e.g. pt-BR, en-US)" }) language?: string,
    @Option({ flags: "--prompt <text>", description: "Call prompt text" }) prompt?: string,
    @Option({ flags: "--first-message <text>", description: "Provider greeting/first message for this profile" })
    firstMessage?: string,
    @Option({ flags: "--system-prompt-path <path>", description: "Path to a system prompt file to sync to ElevenLabs" })
    systemPromptPath?: string,
    @Option({
      flags: "--dynamic-placeholder <key=value...>",
      description: "Declare/update provider dynamic variable placeholders for this profile",
    })
    dynamicPlaceholderOptions?: string[] | string,
    @Option({
      flags: "--skip-provider-sync",
      description: "Persist profile changes without syncing provider agent config",
    })
    skipProviderSync?: boolean,
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
    if (prompt !== undefined && systemPromptPath !== undefined) {
      fail("Use either --prompt or --system-prompt-path, not both.");
    }

    const promptFile = systemPromptPath !== undefined ? loadSystemPromptPath(systemPromptPath) : null;
    const nextPrompt = promptFile?.prompt ?? prompt;
    const dynamicPlaceholders = parseDynamicVariableOptions(dynamicPlaceholderOptions);
    const nextDynamicVariables = dynamicPlaceholders
      ? {
          ...(existing.dynamic_variables_json ?? {}),
          ...dynamicPlaceholders,
        }
      : undefined;

    const updated = updateCallProfile(profileId, {
      ...(provider !== undefined ? { provider } : {}),
      ...(agentId !== undefined ? { provider_agent_id: agentId } : {}),
      ...(twilioNumberId !== undefined ? { twilio_number_id: twilioNumberId } : {}),
      ...(language !== undefined ? { language } : {}),
      ...(nextPrompt !== undefined ? { prompt: nextPrompt } : {}),
      ...(firstMessage !== undefined ? { first_message: firstMessage } : {}),
      ...(promptFile ? { system_prompt_path: promptFile.path } : {}),
      ...(nextDynamicVariables !== undefined ? { dynamic_variables_json: nextDynamicVariables } : {}),
      ...(voicemailPolicy !== undefined ? { voicemail_policy: voicemailPolicy as VoicemailPolicy } : {}),
    });

    if (!updated) {
      fail(`Failed to update profile: ${profileId}`);
    }

    let providerSync: Awaited<ReturnType<typeof syncElevenLabsAgentProfile>> | null = null;
    if (
      !skipProviderSync &&
      (firstMessage !== undefined || nextPrompt !== undefined || nextDynamicVariables !== undefined)
    ) {
      try {
        providerSync = await syncElevenLabsAgentProfile(updated, {
          ...(firstMessage !== undefined ? { firstMessage } : {}),
          ...(nextPrompt !== undefined ? { systemPrompt: nextPrompt } : {}),
          ...(nextDynamicVariables !== undefined ? { dynamicVariablePlaceholders: nextDynamicVariables } : {}),
        });
      } catch (error) {
        fail(`Profile persisted, but provider sync failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const payload = { profile: serializeProfile(updated), provider_sync: providerSync };

    if (asJson) {
      printJson(payload);
    } else {
      console.log(`\nProfile ${profileId} updated.\n`);
      console.log(`  Provider:        ${updated.provider}`);
      console.log(`  Agent ID:        ${updated.provider_agent_id || "-"}`);
      console.log(`  Twilio Number:   ${updated.twilio_number_id || "-"}`);
      console.log(`  Language:        ${updated.language}`);
      console.log(`  First Message:   ${updated.first_message ?? "-"}`);
      console.log(`  System Prompt:   ${updated.system_prompt_path ?? "-"}`);
      console.log(
        `  Dynamic Vars:    ${updated.dynamic_variables_json ? Object.keys(updated.dynamic_variables_json).join(", ") : "-"}`,
      );
      console.log(`  Voicemail:       ${updated.voicemail_policy}`);
      if (providerSync) {
        console.log(`  Provider Sync:   ${providerSync.agentId}`);
      }
      console.log();
    }
    return payload;
  }
}

// ---------------------------------------------------------------------------
// Main calls command group: ravi prox calls
// ---------------------------------------------------------------------------

@Group({
  name: "prox.calls",
  description: "Voice follow-up / activation for prox.city",
  scope: "open",
  skillGate: "ravi-system-prox-calls",
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
      const emptyPayload = { rules: null, message: "No active rules found" };
      if (asJson) {
        printJson(emptyPayload);
      } else {
        console.log("\nNo active call rules found.\n");
      }
      return emptyPayload;
    }

    const payload = serializeRules(rules);

    if (asJson) {
      printJson(payload);
    } else {
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
    return payload;
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
    @Option({
      flags: "--var <key=value...>",
      description: "Dynamic variable sent to the voice agent; accepts repeated key=value pairs",
    })
    dynamicVars?: string[] | string,
    @Option({
      flags: "--skip-origin-notify",
      description: "Do not inform the originating session when the call reaches a terminal state",
    })
    skipOriginNotify?: boolean,
    @Option({
      flags: "--force",
      description: "Bypass call rules for an explicit operator-requested live call",
    })
    force?: boolean,
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
    const dynamicVariables = parseDynamicVariableOptions(dynamicVars);
    const metadata: Record<string, unknown> = {};
    if (dynamicVariables) {
      metadata.dynamic_variables = dynamicVariables;
    }
    if (skipOriginNotify) {
      metadata.notify_origin = false;
    }
    if (force) {
      metadata.rules_override = true;
      metadata.rules_override_reason = "Explicit operator-requested call";
    }
    const notifyHint = skipOriginNotify
      ? "Origin session notification is disabled for this request."
      : "The originating session will be notified when the call reaches a terminal state.";

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
      metadata_json: Object.keys(metadata).length ? metadata : null,
    });

    const payload = {
      request: serializeRequest(result.request),
      blocked: result.blocked,
      block_reason: result.blockReason,
      provider_mode: (usingStub ? "stub" : "live") as "stub" | "live",
      hint: notifyHint,
    };

    if (asJson) {
      printJson(payload);
    } else {
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
        console.log(`\n  ${notifyHint}`);
      }
      console.log();
    }
    return payload;
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

    const payload = {
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
    };

    if (asJson) {
      printJson(payload);
    } else {
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
          console.log(
            `    Transcript:  ${result.transcript.slice(0, 100)}${result.transcript.length > 100 ? "…" : ""}`,
          );
        }
      }
      console.log();
    }
    return payload;
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
    const payload = {
      request_id: request.id,
      total: events.length,
      events: events.map(serializeEvent),
    };

    if (asJson) {
      printJson(payload);
    } else if (events.length === 0) {
      console.log(`\nNo events for request ${callRequestId}.\n`);
    } else {
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
    return payload;
  }

  @Command({ name: "transcript", description: "Show call transcript, syncing provider state when needed" })
  async transcript(
    @Arg("call_request_id") callRequestId: string,
    @Option({ flags: "--sync", description: "Force provider sync before reading transcript" }) sync?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    initCallsDefaults();
    let result = getCallResultForRequest(callRequestId);
    if (sync || !result?.transcript) {
      const request = getCallRequest(callRequestId);
      if (!request) fail(`Call request not found: ${callRequestId}`);
      const profile = getCallProfile(request.profile_id);
      const canSyncElevenLabs = profile?.provider === "elevenlabs" || profile?.provider === "elevenlabs_twilio";
      if (canSyncElevenLabs) {
        await syncCallRequestFromElevenLabs(callRequestId);
        result = getCallResultForRequest(callRequestId);
      } else if (sync) {
        fail(
          `Manual transcript sync is not available for provider '${profile?.provider ?? "unknown"}'. Agora transcripts arrive through /webhooks/agora/convoai event 103.`,
        );
      }
    }

    const request = getCallRequest(callRequestId);
    if (!request) fail(`Call request not found: ${callRequestId}`);
    if (!result?.transcript) fail(`No transcript found for call request: ${callRequestId}`);

    const payload = {
      request_id: callRequestId,
      outcome: result.outcome,
      summary: result.summary,
      transcript: result.transcript,
    };

    if (asJson) {
      printJson(payload);
    } else {
      console.log(`\nTranscript for ${callRequestId}`);
      console.log(`  Outcome: ${result.outcome}`);
      if (result.summary) console.log(`  Summary: ${result.summary}`);
      console.log();
      console.log(result.transcript);
      console.log();
    }
    return payload;
  }

  @Command({ name: "cancel", description: "Cancel a pending call request" })
  cancel(
    @Arg("call_request_id") callRequestId: string,
    @Option({ flags: "--reason <text>", description: "Cancellation reason" }) reason?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    initCallsDefaults();
    const result = cancelCallRequest(callRequestId, reason);
    const payload = {
      success: result.success,
      message: result.message,
      request_id: callRequestId,
    };

    if (asJson) {
      printJson(payload);
    } else {
      if (result.success) {
        console.log(`\n${result.message}`);
      } else {
        console.log(`\n\x1b[31mError:\x1b[0m ${result.message}`);
      }
      console.log();
    }
    return payload;
  }
}

// ---------------------------------------------------------------------------
// Serializers for new entities
// ---------------------------------------------------------------------------

function serializeVoiceAgent(agent: CallVoiceAgent) {
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    provider: agent.provider,
    provider_agent_id: agent.provider_agent_id,
    voice_id: agent.voice_id,
    language: agent.language,
    system_prompt: agent.system_prompt,
    system_prompt_path: agent.system_prompt_path,
    first_message_template: agent.first_message_template,
    dynamic_variables_schema: agent.dynamic_variables_schema_json,
    default_tools: agent.default_tools_json,
    provider_config: agent.provider_config_json,
    version: agent.version,
    enabled: agent.enabled,
    created_at: agent.created_at,
    updated_at: agent.updated_at,
  };
}

function serializeCallTool(tool: CallTool) {
  return {
    id: tool.id,
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema_json,
    output_schema: tool.output_schema_json,
    executor_type: tool.executor_type,
    executor_config: tool.executor_config_json,
    side_effect: tool.side_effect,
    timeout_ms: tool.timeout_ms,
    enabled: tool.enabled,
    created_at: tool.created_at,
    updated_at: tool.updated_at,
  };
}

function serializeToolBinding(binding: CallToolBinding) {
  return {
    id: binding.id,
    tool_id: binding.tool_id,
    scope_type: binding.scope_type,
    scope_id: binding.scope_id,
    provider_tool_name: binding.provider_tool_name,
    tool_prompt: binding.tool_prompt,
    required: binding.required,
    enabled: binding.enabled,
    created_at: binding.created_at,
    updated_at: binding.updated_at,
  };
}

function serializeToolRun(run: CallToolRun) {
  return {
    id: run.id,
    request_id: run.request_id,
    run_id: run.run_id,
    tool_id: run.tool_id,
    binding_id: run.binding_id,
    status: run.status,
    input: run.input_json,
    output: run.output_json,
    message: run.error_message,
    started_at: run.started_at,
    ended_at: run.completed_at,
    duration_ms: run.duration_ms,
  };
}

// ---------------------------------------------------------------------------
// Voice Agents subcommand group: ravi prox calls voice-agents
// ---------------------------------------------------------------------------

@Group({
  name: "prox.calls.voice-agents",
  description: "Manage call voice agents",
  scope: "open",
  skillGate: "ravi-system-prox-calls",
})
export class ProxCallsVoiceAgentCommands {
  @Command({ name: "list", description: "List voice agents" })
  list(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    initCallsDefaults();
    const agents = listCallVoiceAgents();
    const payload = { total: agents.length, voice_agents: agents.map(serializeVoiceAgent) };

    if (asJson) {
      printJson(payload);
    } else if (agents.length === 0) {
      console.log("\nNo voice agents found.\n");
    } else {
      console.log(`\nVoice agents (${agents.length})\n`);
      console.log("  ID                      NAME                    PROVIDER     LANGUAGE  V  ENABLED");
      console.log("  -----------------------  ----------------------  -----------  --------  -  -------");
      for (const a of agents) {
        console.log(
          `  ${a.id.padEnd(23)}  ${a.name.padEnd(22)}  ${a.provider.padEnd(11)}  ${a.language.padEnd(8)}  ${String(a.version).padEnd(1)}  ${a.enabled ? "yes" : "no"}`,
        );
      }
      console.log();
    }
    return payload;
  }

  @Command({ name: "show", description: "Show a voice agent by ID" })
  show(
    @Arg("voice_agent_id") voiceAgentId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    initCallsDefaults();
    const agent = getCallVoiceAgent(voiceAgentId);
    if (!agent) {
      fail(`Voice agent not found: ${voiceAgentId}`);
    }

    const payload = serializeVoiceAgent(agent);

    if (asJson) {
      printJson(payload);
    } else {
      console.log(`\nVoice Agent: ${agent.name}\n`);
      console.log(`  ID:              ${agent.id}`);
      console.log(`  Description:     ${agent.description || "-"}`);
      console.log(`  Provider:        ${agent.provider}`);
      console.log(`  Agent ID:        ${agent.provider_agent_id ?? "-"}`);
      console.log(`  Voice ID:        ${agent.voice_id ?? "-"}`);
      console.log(`  Language:        ${agent.language}`);
      console.log(
        `  System Prompt:   ${agent.system_prompt ? agent.system_prompt.slice(0, 80) + (agent.system_prompt.length > 80 ? "…" : "") : "-"}`,
      );
      console.log(`  Prompt Path:     ${agent.system_prompt_path ?? "-"}`);
      console.log(`  First Message:   ${agent.first_message_template ?? "-"}`);
      console.log(`  Default Tools:   ${agent.default_tools_json?.join(", ") ?? "-"}`);
      console.log(`  Version:         ${agent.version}`);
      console.log(`  Enabled:         ${agent.enabled ? "yes" : "no"}`);
      console.log(`  Created:         ${formatTime(agent.created_at)}`);
      console.log();
    }
    return payload;
  }

  @Command({ name: "create", description: "Create a new voice agent" })
  create(
    @Arg("voice_agent_id") voiceAgentId: string,
    @Option({ flags: "--name <name>", description: "Voice agent display name" }) name: string,
    @Option({ flags: "--provider <provider>", description: "Provider (e.g. elevenlabs, agora_sip)" }) provider: string,
    @Option({ flags: "--system-prompt-path <path>", description: "Path to system prompt file" })
    systemPromptPath?: string,
    @Option({ flags: "--voice-id <id>", description: "Provider voice ID" }) voiceId?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (!voiceAgentId) fail("voice_agent_id is required");
    if (!name) fail("--name is required");
    if (!provider) fail("--provider is required");

    initCallsDefaults();

    const existing = getCallVoiceAgent(voiceAgentId);
    if (existing) {
      fail(`Voice agent already exists: ${voiceAgentId}`);
    }

    let systemPrompt: string | null = null;
    let resolvedPath: string | null = null;
    if (systemPromptPath) {
      const loaded = loadSystemPromptPath(systemPromptPath);
      systemPrompt = loaded.prompt;
      resolvedPath = loaded.path;
    }

    const agent = createCallVoiceAgent({
      id: voiceAgentId,
      name,
      provider,
      system_prompt: systemPrompt,
      system_prompt_path: resolvedPath,
      voice_id: voiceId ?? null,
    });

    const payload = serializeVoiceAgent(agent);

    if (asJson) {
      printJson(payload);
    } else {
      console.log(`\nVoice agent created: ${agent.id}`);
      console.log(`  Name:     ${agent.name}`);
      console.log(`  Provider: ${agent.provider}`);
      console.log();
    }
    return payload;
  }

  @Command({ name: "configure", description: "Configure a voice agent" })
  configure(
    @Arg("voice_agent_id") voiceAgentId: string,
    @Option({ flags: "--system-prompt-path <path>", description: "Path to system prompt file" })
    systemPromptPath?: string,
    @Option({ flags: "--first-message <text>", description: "First message template" }) firstMessage?: string,
    @Option({ flags: "--voice-id <id>", description: "Provider voice ID" }) voiceId?: string,
    @Option({ flags: "--provider-agent-id <id>", description: "Provider-side agent/pipeline ID" })
    providerAgentId?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (!voiceAgentId) fail("voice_agent_id is required");
    initCallsDefaults();

    const existing = getCallVoiceAgent(voiceAgentId);
    if (!existing) {
      fail(`Voice agent not found: ${voiceAgentId}`);
    }

    let systemPrompt: string | undefined;
    let resolvedPath: string | undefined;
    if (systemPromptPath) {
      const loaded = loadSystemPromptPath(systemPromptPath);
      systemPrompt = loaded.prompt;
      resolvedPath = loaded.path;
    }

    const updated = updateCallVoiceAgent(voiceAgentId, {
      ...(systemPrompt !== undefined ? { system_prompt: systemPrompt } : {}),
      ...(resolvedPath !== undefined ? { system_prompt_path: resolvedPath } : {}),
      ...(firstMessage !== undefined ? { first_message_template: firstMessage } : {}),
      ...(voiceId !== undefined ? { voice_id: voiceId } : {}),
      ...(providerAgentId !== undefined ? { provider_agent_id: providerAgentId } : {}),
    });

    if (!updated) {
      fail(`Failed to update voice agent: ${voiceAgentId}`);
    }

    const payload = serializeVoiceAgent(updated);

    if (asJson) {
      printJson(payload);
    } else {
      console.log(`\nVoice agent ${voiceAgentId} updated (v${updated.version}).`);
      console.log(`  Voice ID:        ${updated.voice_id ?? "-"}`);
      console.log(`  Agent ID:        ${updated.provider_agent_id ?? "-"}`);
      console.log(`  First Message:   ${updated.first_message_template ?? "-"}`);
      console.log(`  System Prompt:   ${updated.system_prompt_path ?? "-"}`);
      console.log();
    }
    return payload;
  }

  @Command({ name: "bind-tool", description: "Bind a tool to a voice agent" })
  bindTool(
    @Arg("voice_agent_id") voiceAgentId: string,
    @Arg("tool_id") toolId: string,
    @Option({ flags: "--provider-tool-name <name>", description: "Provider-facing tool name" })
    providerToolName?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (!voiceAgentId) fail("voice_agent_id is required");
    if (!toolId) fail("tool_id is required");
    initCallsDefaults();

    const agent = getCallVoiceAgent(voiceAgentId);
    if (!agent) fail(`Voice agent not found: ${voiceAgentId}`);
    const tool = getCallTool(toolId);
    if (!tool) fail(`Tool not found: ${toolId}`);

    const existing = getCallToolBinding(toolId, "voice_agent", voiceAgentId);
    if (existing) fail(`Tool ${toolId} is already bound to voice agent ${voiceAgentId}`);

    const binding = createCallToolBinding(toolId, "voice_agent", voiceAgentId, {
      provider_tool_name: providerToolName,
    });

    const payload = serializeToolBinding(binding);

    if (asJson) {
      printJson(payload);
    } else {
      console.log(`\nTool ${toolId} bound to voice agent ${voiceAgentId}.`);
      console.log();
    }
    return payload;
  }

  @Command({ name: "unbind-tool", description: "Unbind a tool from a voice agent" })
  unbindTool(
    @Arg("voice_agent_id") voiceAgentId: string,
    @Arg("tool_id") toolId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (!voiceAgentId) fail("voice_agent_id is required");
    if (!toolId) fail("tool_id is required");
    initCallsDefaults();

    const removed = deleteCallToolBinding(toolId, "voice_agent", voiceAgentId);
    if (!removed) fail(`No binding found for tool ${toolId} on voice agent ${voiceAgentId}`);

    const payload = { success: true as const, voice_agent_id: voiceAgentId, tool_id: toolId };

    if (asJson) {
      printJson(payload);
    } else {
      console.log(`\nTool ${toolId} unbound from voice agent ${voiceAgentId}.`);
      console.log();
    }
    return payload;
  }

  @Command({ name: "sync", description: "Sync voice agent to provider (dry-run by default)" })
  sync(
    @Arg("voice_agent_id") voiceAgentId: string,
    @Option({ flags: "--provider", description: "Push changes to provider" }) pushProvider?: boolean,
    @Option({ flags: "--dry-run", description: "Show intended changes without mutating" }) dryRun?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (!voiceAgentId) fail("voice_agent_id is required");
    initCallsDefaults();

    const agent = getCallVoiceAgent(voiceAgentId);
    if (!agent) fail(`Voice agent not found: ${voiceAgentId}`);

    const bindings = listCallToolBindings("voice_agent", voiceAgentId);
    const tools = bindings.map((b) => getCallTool(b.tool_id)).filter((t): t is CallTool => t !== null);

    const changes = {
      voice_agent_id: voiceAgentId,
      provider: agent.provider,
      provider_agent_id: agent.provider_agent_id,
      dry_run: dryRun !== false,
      intended_changes: {
        system_prompt: (agent.system_prompt ? "set" : "unchanged") as "set" | "unchanged",
        first_message_template: (agent.first_message_template ? "set" : "unchanged") as "set" | "unchanged",
        voice_id: agent.voice_id ?? "unchanged",
        tools_count: tools.length,
        tools: tools.map((t) => ({ id: t.id, name: t.name })),
      },
      provider_sync: (dryRun === false && pushProvider ? "would_push" : "skipped") as "would_push" | "skipped",
    };

    if (asJson) {
      printJson(changes);
    } else {
      console.log(`\nSync for voice agent: ${voiceAgentId} (${dryRun !== false ? "DRY RUN" : "LIVE"})\n`);
      console.log(`  Provider:        ${agent.provider}`);
      console.log(`  Agent ID:        ${agent.provider_agent_id ?? "-"}`);
      console.log(`  System Prompt:   ${changes.intended_changes.system_prompt}`);
      console.log(`  First Message:   ${changes.intended_changes.first_message_template}`);
      console.log(`  Voice ID:        ${changes.intended_changes.voice_id}`);
      console.log(`  Tools (${tools.length}):`);
      for (const t of tools) {
        console.log(`    - ${t.id} (${t.name})`);
      }
      if (dryRun !== false) {
        console.log(`\n  No changes made (dry-run). Use --no-dry-run to apply.`);
      }
      console.log();
    }
    return changes;
  }
}

// ---------------------------------------------------------------------------
// Tools subcommand group: ravi prox calls tools
// ---------------------------------------------------------------------------

const VALID_EXECUTORS = new Set(["native", "bash", "http", "context"]);
const VALID_SIDE_EFFECTS = new Set([
  "read_only",
  "write_internal",
  "external_message",
  "external_call",
  "external_irreversible",
]);

@Group({
  name: "prox.calls.tools",
  description: "Manage call tools and tool execution",
  scope: "open",
  skillGate: "ravi-system-prox-calls",
})
export class ProxCallsToolCommands {
  @Command({ name: "list", description: "List call tools" })
  list(
    @Option({ flags: "--profile <profile_id>", description: "Filter tools by profile binding" }) profileId?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    initCallsDefaults();
    const tools = listCallTools(profileId);
    const payload = { total: tools.length, tools: tools.map(serializeCallTool) };

    if (asJson) {
      printJson(payload);
    } else if (tools.length === 0) {
      console.log("\nNo call tools found.\n");
    } else {
      console.log(`\nCall tools (${tools.length})${profileId ? ` for profile ${profileId}` : ""}\n`);
      console.log("  ID                       NAME                    EXECUTOR  SIDE-EFFECT           ENABLED");
      console.log("  -------------------------  ----------------------  --------  --------------------  -------");
      for (const t of tools) {
        console.log(
          `  ${t.id.padEnd(25)}  ${t.name.padEnd(22)}  ${t.executor_type.padEnd(8)}  ${t.side_effect.padEnd(20)}  ${t.enabled ? "yes" : "no"}`,
        );
      }
      console.log();
    }
    return payload;
  }

  @Command({ name: "show", description: "Show a call tool by ID" })
  show(
    @Arg("tool_id") toolId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    initCallsDefaults();
    const tool = getCallTool(toolId);
    if (!tool) fail(`Tool not found: ${toolId}`);

    const payload = serializeCallTool(tool);

    if (asJson) {
      printJson(payload);
    } else {
      console.log(`\nCall Tool: ${tool.name}\n`);
      console.log(`  ID:           ${tool.id}`);
      console.log(`  Description:  ${tool.description || "-"}`);
      console.log(`  Executor:     ${tool.executor_type}`);
      console.log(`  Side-Effect:  ${tool.side_effect}`);
      console.log(`  Timeout:      ${tool.timeout_ms}ms`);
      console.log(`  Enabled:      ${tool.enabled ? "yes" : "no"}`);
      if (tool.input_schema_json) {
        console.log(`  Input Schema: ${JSON.stringify(tool.input_schema_json).slice(0, 80)}…`);
      }
      console.log(`  Created:      ${formatTime(tool.created_at)}`);
      console.log();
    }
    return payload;
  }

  @Command({ name: "create", description: "Create a new call tool" })
  create(
    @Arg("tool_id") toolId: string,
    @Option({ flags: "--name <name>", description: "Tool display name" }) name: string,
    @Option({ flags: "--description <text>", description: "Tool description for voice agents" }) description: string,
    @Option({ flags: "--executor <type>", description: "Executor type: native|bash|http|context" }) executor: string,
    @Option({
      flags: "--side-effect <kind>",
      description: "Side-effect class: read_only|write_internal|external_message|external_call|external_irreversible",
    })
    sideEffect: string,
    @Option({ flags: "--input-schema <path>", description: "Path to JSON input schema file" }) inputSchemaPath?: string,
    @Option({ flags: "--output-schema <path>", description: "Path to JSON output schema file" })
    outputSchemaPath?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (!toolId) fail("tool_id is required");
    if (!name) fail("--name is required");
    if (!description) fail("--description is required");
    if (!executor) fail("--executor is required");
    if (!sideEffect) fail("--side-effect is required");
    if (!VALID_EXECUTORS.has(executor)) fail(`Invalid executor: ${executor}. Use native|bash|http|context.`);
    if (!VALID_SIDE_EFFECTS.has(sideEffect))
      fail(
        `Invalid side-effect: ${sideEffect}. Use read_only|write_internal|external_message|external_call|external_irreversible.`,
      );

    initCallsDefaults();

    const existing = getCallTool(toolId);
    if (existing) fail(`Tool already exists: ${toolId}`);

    let inputSchema: Record<string, unknown> | null = null;
    let outputSchema: Record<string, unknown> | null = null;

    if (inputSchemaPath) {
      const resolved = resolve(process.cwd(), inputSchemaPath);
      if (!existsSync(resolved)) fail(`Input schema file not found: ${resolved}`);
      try {
        inputSchema = JSON.parse(readFileSync(resolved, "utf8"));
      } catch {
        fail(`Invalid JSON in input schema: ${resolved}`);
      }
    }
    if (outputSchemaPath) {
      const resolved = resolve(process.cwd(), outputSchemaPath);
      if (!existsSync(resolved)) fail(`Output schema file not found: ${resolved}`);
      try {
        outputSchema = JSON.parse(readFileSync(resolved, "utf8"));
      } catch {
        fail(`Invalid JSON in output schema: ${resolved}`);
      }
    }

    const tool = createCallTool({
      id: toolId,
      name,
      description,
      executor_type: executor as CallToolExecutorType,
      side_effect: sideEffect as CallToolSideEffect,
      input_schema_json: inputSchema,
      output_schema_json: outputSchema,
    });

    const payload = serializeCallTool(tool);

    if (asJson) {
      printJson(payload);
    } else {
      console.log(`\nTool created: ${tool.id}`);
      console.log(`  Name:        ${tool.name}`);
      console.log(`  Executor:    ${tool.executor_type}`);
      console.log(`  Side-Effect: ${tool.side_effect}`);
      console.log();
    }
    return payload;
  }

  @Command({ name: "configure", description: "Configure a call tool" })
  configure(
    @Arg("tool_id") toolId: string,
    @Option({ flags: "--timeout-ms <ms>", description: "Execution timeout in milliseconds" }) timeoutMs?: string,
    @Option({ flags: "--enabled <value>", description: "Enable or disable (true|false)" }) enabled?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (!toolId) fail("tool_id is required");
    initCallsDefaults();

    const existing = getCallTool(toolId);
    if (!existing) fail(`Tool not found: ${toolId}`);

    const updated = updateCallTool(toolId, {
      ...(timeoutMs !== undefined ? { timeout_ms: parseInt(timeoutMs, 10) } : {}),
      ...(enabled !== undefined ? { enabled: enabled === "true" } : {}),
    });

    if (!updated) fail(`Failed to update tool: ${toolId}`);

    const payload = serializeCallTool(updated);

    if (asJson) {
      printJson(payload);
    } else {
      console.log(`\nTool ${toolId} updated.`);
      console.log(`  Timeout:  ${updated.timeout_ms}ms`);
      console.log(`  Enabled:  ${updated.enabled ? "yes" : "no"}`);
      console.log();
    }
    return payload;
  }

  @Command({ name: "bind", description: "Bind a tool to a profile" })
  bind(
    @Arg("profile_id") profileId: string,
    @Arg("tool_id") toolId: string,
    @Option({ flags: "--provider-tool-name <name>", description: "Provider-facing tool name" })
    providerToolName?: string,
    @Option({ flags: "--required", description: "Mark tool as required for the profile" }) required?: boolean,
    @Option({ flags: "--tool-prompt <text>", description: "Profile-specific prompt for this tool" })
    toolPrompt?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (!profileId) fail("profile_id is required");
    if (!toolId) fail("tool_id is required");
    initCallsDefaults();

    const profile = getCallProfile(profileId);
    if (!profile) fail(`Profile not found: ${profileId}`);
    const tool = getCallTool(toolId);
    if (!tool) fail(`Tool not found: ${toolId}`);

    const existing = getCallToolBinding(toolId, "profile", profileId);
    if (existing) fail(`Tool ${toolId} is already bound to profile ${profileId}`);

    const binding = createCallToolBinding(toolId, "profile", profileId, {
      provider_tool_name: providerToolName,
      tool_prompt: toolPrompt,
      required,
    });

    const payload = serializeToolBinding(binding);

    if (asJson) {
      printJson(payload);
    } else {
      console.log(`\nTool ${toolId} bound to profile ${profileId}.`);
      console.log();
    }
    return payload;
  }

  @Command({ name: "unbind", description: "Unbind a tool from a profile" })
  unbind(
    @Arg("profile_id") profileId: string,
    @Arg("tool_id") toolId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (!profileId) fail("profile_id is required");
    if (!toolId) fail("tool_id is required");
    initCallsDefaults();

    const removed = deleteCallToolBinding(toolId, "profile", profileId);
    if (!removed) fail(`No binding found for tool ${toolId} on profile ${profileId}`);

    const payload = { success: true as const, profile_id: profileId, tool_id: toolId };

    if (asJson) {
      printJson(payload);
    } else {
      console.log(`\nTool ${toolId} unbound from profile ${profileId}.`);
      console.log();
    }
    return payload;
  }

  @Command({ name: "runs", description: "List tool runs for a call request" })
  runs(
    @Arg("call_request_id") callRequestId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    initCallsDefaults();
    const request = getCallRequest(callRequestId);
    if (!request) fail(`Call request not found: ${callRequestId}`);

    const runs = listCallToolRuns(callRequestId);
    const payload = { request_id: callRequestId, total: runs.length, tool_runs: runs.map(serializeToolRun) };

    if (asJson) {
      printJson(payload);
    } else if (runs.length === 0) {
      console.log(`\nNo tool runs for request ${callRequestId}.\n`);
    } else {
      console.log(`\nTool runs for ${callRequestId} (${runs.length})\n`);
      console.log("  ID                    TOOL                    STATUS      MESSAGE");
      console.log("  --------------------  ----------------------  ----------  --------------------------------");
      for (const r of runs) {
        console.log(
          `  ${r.id.padEnd(20)}  ${r.tool_id.padEnd(22)}  ${statusColor(r.status).padEnd(20)}  ${(r.error_message ?? "-").slice(0, 40)}`,
        );
      }
      console.log();
    }
    return payload;
  }

  @Command({ name: "run", description: "Execute a tool (dry-run validates without side effects)" })
  run(
    @Arg("tool_id") toolId: string,
    @Option({ flags: "--input <json-or-path>", description: "Tool input as JSON string or path to JSON file" })
    inputRaw: string,
    @Option({ flags: "--profile <profile_id>", description: "Profile context for policy evaluation" })
    profileId?: string,
    @Option({ flags: "--dry-run", description: "Validate without executing" }) dryRun?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (!toolId) fail("tool_id is required");
    if (!inputRaw) fail("--input is required");
    initCallsDefaults();

    const tool = getCallTool(toolId);
    if (!tool) fail(`Tool not found: ${toolId}`);
    if (!tool.enabled) fail(`Tool is disabled: ${toolId}`);

    // Parse input
    let input: Record<string, unknown>;
    try {
      const resolved = resolve(process.cwd(), inputRaw);
      if (existsSync(resolved)) {
        input = JSON.parse(readFileSync(resolved, "utf8"));
      } else {
        input = JSON.parse(inputRaw);
      }
    } catch {
      fail(`Invalid input: must be valid JSON string or path to JSON file.`);
    }

    // Validate input schema
    if (tool.input_schema_json) {
      const schema = tool.input_schema_json;
      const requiredFields = (schema.required as string[] | undefined) ?? [];
      const properties = (schema.properties as Record<string, unknown> | undefined) ?? {};

      for (const field of requiredFields) {
        if (!(field in input)) {
          const result = {
            ok: false as const,
            error: "schema_validation_failed" as const,
            message: `Missing required field: ${field}`,
            tool_id: toolId,
            input,
          };
          if (asJson) {
            printJson(result);
            return result;
          }
          fail(`Schema validation failed: missing required field '${field}'.`);
        }
      }

      for (const key of Object.keys(input)) {
        if (!(key in properties)) {
          const result = {
            ok: false as const,
            error: "schema_validation_failed" as const,
            message: `Unknown field: ${key}`,
            tool_id: toolId,
            input,
          };
          if (asJson) {
            printJson(result);
            return result;
          }
          fail(`Schema validation failed: unknown field '${key}'.`);
        }
      }
    }

    // Evaluate policy
    const policyResult = evaluateCallToolPolicy(toolId, tool.side_effect, {
      profile_id: profileId,
    });

    if (!policyResult.allowed) {
      const blockedResult = {
        ok: false as const,
        error: "policy_blocked" as const,
        message: policyResult.reason,
        tool_id: toolId,
        side_effect: tool.side_effect,
        dry_run: !!dryRun,
      };

      if (asJson) {
        printJson(blockedResult);
        return blockedResult;
      }
      fail(`Policy blocked: ${policyResult.reason}`);
    }

    // Dry-run: validate only, no execution
    if (dryRun) {
      const dryRunResult = {
        ok: true as const,
        dry_run: true as const,
        message: "Validation passed. Tool would execute with the given input.",
        tool_id: toolId,
        executor_type: tool.executor_type,
        side_effect: tool.side_effect,
        timeout_ms: tool.timeout_ms,
        input,
        policy: { allowed: true, reason: policyResult.reason },
      };

      if (asJson) {
        printJson(dryRunResult);
      } else {
        console.log(`\nDry-run validation passed for ${toolId}.`);
        console.log(`  Executor:    ${tool.executor_type}`);
        console.log(`  Side-Effect: ${tool.side_effect}`);
        console.log(`  Timeout:     ${tool.timeout_ms}ms`);
        console.log(`  Policy:      ${policyResult.reason}`);
        console.log(`  Input:       ${JSON.stringify(input)}`);
        console.log(`\n  No side effects. Use without --dry-run to execute.`);
        console.log();
      }
      return dryRunResult;
    }

    // Live execution is blocked for now — native tools need runtime implementation
    const liveBlockResult = {
      ok: false as const,
      error: "execution_not_implemented" as const,
      message: `Live execution of ${tool.executor_type} tools is not yet implemented. Use --dry-run to validate.`,
      tool_id: toolId,
      executor_type: tool.executor_type,
      input,
    };

    if (asJson) {
      printJson(liveBlockResult);
      return liveBlockResult;
    }
    fail(`Live execution of ${tool.executor_type} tools is not yet implemented. Use --dry-run to validate.`);
  }
}
