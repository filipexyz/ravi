/**
 * prox.city Calls — Post-Call Webhook Handler
 *
 * Processes terminal call outcomes from ElevenLabs post-call webhooks.
 * This handler can be wired into any HTTP route or event consumer that
 * receives the ElevenLabs post_call_transcription or call_initiation_failure
 * payloads.
 *
 * No HTTP server is created here — the caller is responsible for routing
 * the raw payload to handlePostCallWebhook(). See WEBHOOK_ROUTE_NOTE below.
 */

import { getDb } from "../../router/router-db.js";
import {
  getCallRun,
  getCallRequest,
  updateCallRunStatus,
  updateCallRequestStatus,
  createCallEvent,
  createCallResult,
} from "./calls-db.js";
import type { CallRunStatus, CallResultOutcome } from "./types.js";

// ---------------------------------------------------------------------------
// Payload shapes (subset of ElevenLabs webhook fields we consume)
// ---------------------------------------------------------------------------

export interface PostCallTranscriptionPayload {
  type: "post_call_transcription";
  conversation_id: string;
  call_sid?: string;
  call_successful: boolean;
  call_duration_secs?: number;
  transcript?: string;
  call_summary?: string;
  call_analysis?: Record<string, unknown>;
  recording_url?: string;
}

export interface CallInitiationFailurePayload {
  type: "call_initiation_failure";
  conversation_id?: string;
  call_sid?: string;
  error_message?: string;
}

export type CallWebhookPayload = PostCallTranscriptionPayload | CallInitiationFailurePayload;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

function findRunByProviderIds(conversationId?: string, callSid?: string) {
  if (!conversationId && !callSid) return null;

  // Search recent runs by provider_call_id or twilio_call_sid.
  // This is a bounded scan since runs are tied to specific requests.
  // In a larger deployment, a dedicated index lookup would be added.
  // For MVP, iterate recent runs.

  const db = getDb();

  if (conversationId) {
    const row = db
      .prepare("SELECT id, request_id FROM call_runs WHERE provider_call_id = ? LIMIT 1")
      .get(conversationId) as { id: string; request_id: string } | undefined;
    if (row) {
      return { runId: row.id, requestId: row.request_id };
    }
  }

  if (callSid) {
    const row = db.prepare("SELECT id, request_id FROM call_runs WHERE twilio_call_sid = ? LIMIT 1").get(callSid) as
      | { id: string; request_id: string }
      | undefined;
    if (row) {
      return { runId: row.id, requestId: row.request_id };
    }
  }

  return null;
}

function mapTerminalStatus(payload: CallWebhookPayload): { runStatus: CallRunStatus; outcome: CallResultOutcome } {
  if (payload.type === "call_initiation_failure") {
    return { runStatus: "failed", outcome: "failed_provider" };
  }

  // post_call_transcription
  const p = payload as PostCallTranscriptionPayload;
  if (p.call_successful) {
    return { runStatus: "completed", outcome: "answered" };
  }

  // Heuristics for non-successful terminal states
  const summary = (p.call_summary ?? "").toLowerCase();
  if (summary.includes("voicemail")) {
    return { runStatus: "voicemail", outcome: "voicemail" };
  }
  if (summary.includes("caixa postal")) {
    return { runStatus: "voicemail", outcome: "voicemail" };
  }
  if (summary.includes("busy")) {
    return { runStatus: "busy", outcome: "busy" };
  }
  if (summary.includes("ocupado")) {
    return { runStatus: "busy", outcome: "busy" };
  }
  if (
    summary.includes("no answer") ||
    summary.includes("no_answer") ||
    summary.includes("not available") ||
    summary.includes("unavailable") ||
    summary.includes("indispon") ||
    summary.includes("celular estiver disponível") ||
    summary.includes("celular está disponível") ||
    summary.includes("fora de área") ||
    summary.includes("fora de area") ||
    summary.includes("recado")
  ) {
    return { runStatus: "no_answer", outcome: "no_answer" };
  }

  return { runStatus: "failed", outcome: "failed_provider" };
}

/**
 * Process a post-call webhook payload from ElevenLabs.
 *
 * Returns a summary of what was persisted, or null if the run could not be found.
 */
export function handlePostCallWebhook(payload: CallWebhookPayload): {
  request_id: string;
  run_id: string;
  outcome: CallResultOutcome;
  summary: string | null;
} | null {
  const conversationId = "conversation_id" in payload ? payload.conversation_id : undefined;
  const callSid = "call_sid" in payload ? payload.call_sid : undefined;

  const match = findRunByProviderIds(conversationId, callSid);
  if (!match) return null;

  const { runId, requestId } = match;
  const run = getCallRun(runId);
  if (!run) return null;

  const request = getCallRequest(requestId);
  if (!request) return null;

  // Skip if run is already in a terminal state
  const terminalStatuses = new Set(["completed", "no_answer", "busy", "voicemail", "failed", "canceled"]);
  if (terminalStatuses.has(run.status)) {
    return {
      request_id: requestId,
      run_id: runId,
      outcome: run.status as CallResultOutcome,
      summary: "already terminal",
    };
  }

  const { runStatus, outcome } = mapTerminalStatus(payload);

  const failureReason =
    payload.type === "call_initiation_failure"
      ? ((payload as CallInitiationFailurePayload).error_message ?? "Call initiation failed")
      : undefined;

  const transcript =
    payload.type === "post_call_transcription" ? ((payload as PostCallTranscriptionPayload).transcript ?? null) : null;

  const callSummary =
    payload.type === "post_call_transcription"
      ? ((payload as PostCallTranscriptionPayload).call_summary ?? null)
      : (failureReason ?? null);

  const extraction =
    payload.type === "post_call_transcription"
      ? ((payload as PostCallTranscriptionPayload).call_analysis ?? null)
      : null;

  // Update run
  updateCallRunStatus(runId, runStatus, {
    failure_reason: failureReason,
  });

  // Update request
  const requestStatus = runStatus === "completed" ? "completed" : "failed";
  updateCallRequestStatus(requestId, requestStatus);

  // Event
  const eventType = runStatus === "completed" ? "run.completed" : "run.failed";
  createCallEvent({
    request_id: requestId,
    run_id: runId,
    event_type: eventType,
    status: runStatus,
    message: callSummary ?? `Call ${runStatus}`,
    payload_json: {
      webhook_type: payload.type,
      conversation_id: conversationId,
      call_sid: callSid,
    },
    source: "prox.calls.webhook",
  });

  // Result
  createCallResult({
    request_id: requestId,
    run_id: runId,
    outcome,
    summary: callSummary,
    transcript,
    extraction_json: extraction,
    next_action: outcome === "answered" ? "none" : "retry",
  });

  createCallEvent({
    request_id: requestId,
    run_id: runId,
    event_type: "result.created",
    status: outcome,
    message: callSummary,
    source: "prox.calls.webhook",
  });

  return { request_id: requestId, run_id: runId, outcome, summary: callSummary };
}

/**
 * WEBHOOK_ROUTE_NOTE:
 *
 * Ravi does not currently expose an HTTP server for external webhooks.
 * To receive ElevenLabs post-call webhooks in production:
 *
 * 1. Add an HTTP route (e.g. POST /api/webhooks/elevenlabs/post-call) in
 *    the daemon or a sidecar, parse the JSON body, and call
 *    handlePostCallWebhook(payload).
 *
 * 2. Configure the ElevenLabs agent's post-call webhook URL to point to
 *    the public URL of that route.
 *
 * 3. Until the HTTP route exists, terminal call state can be synced
 *    manually by calling handlePostCallWebhook() with the payload
 *    from the ElevenLabs conversation history API.
 *
 * File: src/prox/calls/webhook.ts
 */
