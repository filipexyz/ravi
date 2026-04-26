/**
 * prox.city Calls — Public API
 *
 * High-level orchestration functions for the prox calls capability.
 * This is the entry point for agents and CLI commands.
 */

export type {
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
  RulesVerdict,
  RulesEvaluationResult,
  CreateCallRequestInput,
  CreateCallRunInput,
  CreateCallEventInput,
  CreateCallResultInput,
  UpdateCallProfileInput,
  CallProviderAdapter,
  ProviderDialInput,
  ProviderDialResult,
} from "./types.js";

export {
  listCallProfiles,
  getCallProfile,
  seedDefaultProfiles,
  getCallRules,
  getCallRulesById,
  seedDefaultRules,
  createCallRequest,
  getCallRequest,
  listCallRequests,
  updateCallRequestStatus,
  updateCallRequestRulesId,
  createCallRun,
  getCallRun,
  listCallRuns,
  updateCallRunStatus,
  countCallRunsForRequest,
  getLastCallRunEndedAt,
  createCallEvent,
  getCallEvent,
  listCallEvents,
  createCallResult,
  getCallResult,
  getCallResultForRequest,
  updateCallProfile,
  resetCallsSchemaFlag,
} from "./calls-db.js";

export { evaluateCallRules } from "./rules.js";

export {
  StubCallProvider,
  ElevenLabsTwilioCallProvider,
  registerCallProvider,
  getCallProvider,
  hasRealProvider,
  resetProviders,
} from "./provider.js";

export type {
  PostCallTranscriptionPayload,
  CallInitiationFailurePayload,
  CallWebhookPayload,
} from "./webhook.js";

export { handlePostCallWebhook } from "./webhook.js";

import {
  createCallRequest,
  getCallProfile,
  getCallRequest as dbGetCallRequest,
  getCallRules,
  updateCallRequestStatus,
  updateCallRequestRulesId,
  createCallRun,
  updateCallRunStatus,
  createCallEvent,
  createCallResult,
  seedDefaultProfiles,
  seedDefaultRules,
} from "./calls-db.js";
import { evaluateCallRules } from "./rules.js";
import { getCallProvider } from "./provider.js";
import type { CallRequest, CreateCallRequestInput } from "./types.js";

/**
 * Initialize default seed data (profiles + rules).
 * Safe to call multiple times — only seeds if tables are empty.
 */
export function initCallsDefaults(): void {
  seedDefaultProfiles();
  seedDefaultRules();
}

/**
 * Submit a call request, evaluate rules, and (if allowed) start the
 * provider dial. Persists the request before any provider call.
 *
 * Returns the created (and possibly updated) call request.
 */
export async function submitCallRequest(input: CreateCallRequestInput): Promise<{
  request: CallRequest;
  blocked: boolean;
  blockReason: string | null;
}> {
  // 1. Validate profile
  const profile = getCallProfile(input.profile_id);
  if (!profile) {
    throw new Error(`Call profile not found: ${input.profile_id}`);
  }
  if (!profile.enabled) {
    throw new Error(`Call profile is disabled: ${input.profile_id}`);
  }

  // 2. Persist request BEFORE any provider call
  const request = createCallRequest(input);

  // 3. Emit creation event
  createCallEvent({
    request_id: request.id,
    event_type: "request.created",
    status: request.status,
    message: `Call request created for person ${input.target_person_id}`,
    source: "prox.calls",
  });

  // 4. Load and evaluate rules
  const rules = getCallRules();
  if (rules) {
    updateCallRequestRulesId(request.id, rules.id);
    const evaluation = evaluateCallRules(rules, request.id, input.target_person_id);

    createCallEvent({
      request_id: request.id,
      event_type: "rules.evaluated",
      status: evaluation.verdict,
      message: evaluation.reason,
      payload_json: {
        verdict: evaluation.verdict,
        rule_id: rules.id,
        evaluated_at: evaluation.evaluated_at,
      },
      source: "prox.calls.rules",
    });

    if (evaluation.verdict !== "allow") {
      const blockedStatus = evaluation.verdict === "block_snoozed" ? "snoozed" : "blocked";
      updateCallRequestStatus(request.id, blockedStatus);

      createCallEvent({
        request_id: request.id,
        event_type: "request.blocked",
        status: blockedStatus,
        message: evaluation.reason,
        source: "prox.calls.rules",
      });

      return {
        request: { ...request, status: blockedStatus, rules_id: rules.id },
        blocked: true,
        blockReason: evaluation.reason,
      };
    }
  }

  // 5. Attempt provider dial
  let provider;
  try {
    provider = getCallProvider(profile.provider);
  } catch (providerErr) {
    const msg = providerErr instanceof Error ? providerErr.message : String(providerErr);
    updateCallRequestStatus(request.id, "failed");
    createCallEvent({
      request_id: request.id,
      event_type: "run.failed",
      status: "failed",
      message: msg,
      source: "prox.calls.provider",
    });
    createCallResult({
      request_id: request.id,
      outcome: "failed_provider",
      summary: msg,
      next_action: "none",
    });
    return {
      request: { ...request, status: "failed" as const },
      blocked: false,
      blockReason: null,
    };
  }

  const run = createCallRun({
    request_id: request.id,
    attempt_number: 1,
    provider: provider.name,
  });

  updateCallRequestStatus(request.id, "running");

  createCallEvent({
    request_id: request.id,
    run_id: run.id,
    event_type: "run.started",
    status: "dialing",
    message: `Dialing via ${provider.name} (attempt ${run.attempt_number})`,
    source: `prox.calls.provider.${provider.name}`,
  });

  try {
    const dialResult = await provider.dial({
      request: { ...request, status: "running" },
      run,
      profile,
      target_phone: request.target_phone ?? "",
    });

    updateCallRunStatus(run.id, dialResult.status, {
      provider_call_id: dialResult.provider_call_id ?? undefined,
      twilio_call_sid: dialResult.twilio_call_sid ?? undefined,
      failure_reason: dialResult.failure_reason ?? undefined,
    });

    const isTerminal = ["completed", "no_answer", "busy", "voicemail", "failed", "canceled"].includes(
      dialResult.status,
    );

    if (isTerminal) {
      const requestStatus = dialResult.status === "completed" ? "completed" : "failed";
      updateCallRequestStatus(request.id, requestStatus);

      const eventType = dialResult.status === "completed" ? "run.completed" : "run.failed";
      createCallEvent({
        request_id: request.id,
        run_id: run.id,
        event_type: eventType,
        status: dialResult.status,
        message: dialResult.failure_reason ?? `Call ${dialResult.status}`,
        source: `prox.calls.provider.${provider.name}`,
      });

      // Create result
      const outcome =
        dialResult.status === "completed"
          ? "answered"
          : dialResult.status === "no_answer"
            ? "no_answer"
            : dialResult.status === "busy"
              ? "busy"
              : dialResult.status === "voicemail"
                ? "voicemail"
                : "failed_provider";

      const result = createCallResult({
        request_id: request.id,
        run_id: run.id,
        outcome,
        summary: dialResult.failure_reason ?? `Call ${dialResult.status} via ${provider.name}`,
        next_action: outcome === "answered" ? "none" : "retry",
      });

      createCallEvent({
        request_id: request.id,
        run_id: run.id,
        event_type: "result.created",
        status: outcome,
        message: result.summary,
        source: "prox.calls",
      });
    }

    return {
      request: {
        ...request,
        status: isTerminal ? (dialResult.status === "completed" ? "completed" : "failed") : "running",
        rules_id: rules?.id ?? null,
      },
      blocked: false,
      blockReason: null,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    updateCallRunStatus(run.id, "failed", { failure_reason: errorMessage });
    updateCallRequestStatus(request.id, "failed");

    createCallEvent({
      request_id: request.id,
      run_id: run.id,
      event_type: "run.failed",
      status: "failed",
      message: errorMessage,
      source: `prox.calls.provider.${provider.name}`,
    });

    createCallResult({
      request_id: request.id,
      run_id: run.id,
      outcome: "failed_runtime",
      summary: errorMessage,
      next_action: "retry",
    });

    createCallEvent({
      request_id: request.id,
      run_id: run.id,
      event_type: "result.created",
      status: "failed_runtime",
      message: errorMessage,
      source: "prox.calls",
    });

    return {
      request: { ...request, status: "failed", rules_id: rules?.id ?? null },
      blocked: false,
      blockReason: null,
    };
  }
}

/**
 * Cancel a pending/scheduled call request.
 */
export function cancelCallRequest(requestId: string, reason?: string): { success: boolean; message: string } {
  const request = dbGetCallRequest(requestId);
  if (!request) {
    return { success: false, message: `Call request not found: ${requestId}` };
  }

  const cancellable = new Set(["pending", "scheduled", "snoozed", "blocked"]);
  if (!cancellable.has(request.status)) {
    return {
      success: false,
      message: `Cannot cancel request in status '${request.status}'. Only pending/scheduled/snoozed/blocked requests can be canceled.`,
    };
  }

  updateCallRequestStatus(requestId, "canceled");

  createCallEvent({
    request_id: requestId,
    event_type: "request.canceled",
    status: "canceled",
    message: reason ?? "Canceled by user",
    source: "prox.calls.cli",
  });

  createCallResult({
    request_id: requestId,
    outcome: "canceled_by_reply",
    summary: reason ?? "Canceled by user",
    next_action: "none",
  });

  return { success: true, message: `Call request ${requestId} canceled` };
}
