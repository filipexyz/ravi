import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testDir = join(tmpdir(), `ravi-webhook-test-${Date.now()}`);
mkdirSync(testDir, { recursive: true });
process.env.RAVI_STATE_DIR = testDir;

import { handlePostCallWebhook } from "./webhook.js";
import { handleAgoraWebhook, normalizeAgoraWebhookPayload } from "./agora.js";
import type { PostCallTranscriptionPayload, CallInitiationFailurePayload } from "./webhook.js";
import {
  seedDefaultProfiles,
  createCallRequest,
  createCallRun,
  updateCallRunStatus,
  getCallRun,
  getCallRequest,
  getCallResultForRequest,
  listCallEvents,
  resetCallsSchemaFlag,
} from "./calls-db.js";

afterAll(() => {
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {}
});

beforeEach(() => {
  resetCallsSchemaFlag();
  delete process.env.RAVI_CALLS_ORIGIN_NOTIFY_DRY_RUN;
});

describe("handlePostCallWebhook", () => {
  it("returns null when no matching run found", () => {
    seedDefaultProfiles();
    const payload: PostCallTranscriptionPayload = {
      type: "post_call_transcription",
      conversation_id: "nonexistent_conv",
      call_successful: true,
      transcript: "Hello!",
    };
    const result = handlePostCallWebhook(payload);
    expect(result).toBeNull();
  });

  it("processes successful post_call_transcription", () => {
    seedDefaultProfiles();
    const request = createCallRequest({
      profile_id: "checkin",
      target_person_id: "person_wh_1",
      target_phone: "+5511999999999",
      reason: "Webhook test",
    });
    const run = createCallRun({
      request_id: request.id,
      attempt_number: 1,
      provider: "elevenlabs_twilio",
    });
    updateCallRunStatus(run.id, "dialing", {
      provider_call_id: "conv_abc123",
      twilio_call_sid: "CA_xyz789",
    });

    const payload: PostCallTranscriptionPayload = {
      type: "post_call_transcription",
      conversation_id: "conv_abc123",
      call_sid: "CA_xyz789",
      call_successful: true,
      call_duration_secs: 45,
      transcript: "Oi Luis, tudo bem? Queria saber como anda o projeto.",
      call_summary: "Successful check-in call. Luis confirmed project is on track.",
      call_analysis: { sentiment: "positive" },
    };

    const result = handlePostCallWebhook(payload);
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe("answered");
    expect(result!.summary).toContain("Successful check-in");

    // Verify run status updated
    const updatedRun = getCallRun(run.id);
    expect(updatedRun!.status).toBe("completed");

    // Verify request status updated
    const updatedRequest = getCallRequest(request.id);
    expect(updatedRequest!.status).toBe("completed");

    // Verify result created with transcript
    const callResult = getCallResultForRequest(request.id);
    expect(callResult).not.toBeNull();
    expect(callResult!.outcome).toBe("answered");
    expect(callResult!.transcript).toContain("Luis");

    // Verify events
    const events = listCallEvents(request.id);
    const webhookEvents = events.filter((e) => e.source === "prox.calls.webhook");
    expect(webhookEvents.length).toBeGreaterThanOrEqual(1);
  });

  it("notifies the origin session when a terminal result is created", () => {
    process.env.RAVI_CALLS_ORIGIN_NOTIFY_DRY_RUN = "1";
    seedDefaultProfiles();
    const request = createCallRequest({
      profile_id: "checkin",
      target_person_id: "person_notify_1",
      target_phone: "+5511999999999",
      reason: "Notify origin test",
      origin_session_name: "agent:main:dm:notify-test",
    });
    const run = createCallRun({
      request_id: request.id,
      attempt_number: 1,
      provider: "elevenlabs_twilio",
    });
    updateCallRunStatus(run.id, "dialing", {
      provider_call_id: "conv_notify123",
    });

    const result = handlePostCallWebhook({
      type: "post_call_transcription",
      conversation_id: "conv_notify123",
      call_successful: true,
      transcript: "user: funcionou",
      call_summary: "Call completed and confirmed by user.",
    });

    expect(result).not.toBeNull();
    const events = listCallEvents(request.id);
    const notified = events.find((e) => e.event_type === "result.notified");
    expect(notified).toBeDefined();
    expect(notified!.message).toContain("dry run");
    expect(notified!.payload_json?.target_session).toBe("agent:main:dm:notify-test");
  });

  it("does not notify origin when notify_origin is false", () => {
    process.env.RAVI_CALLS_ORIGIN_NOTIFY_DRY_RUN = "1";
    seedDefaultProfiles();
    const request = createCallRequest({
      profile_id: "checkin",
      target_person_id: "person_notify_2",
      target_phone: "+5511999999999",
      reason: "Skip notify origin test",
      origin_session_name: "agent:main:dm:notify-test",
      metadata_json: { notify_origin: false },
    });
    const run = createCallRun({
      request_id: request.id,
      attempt_number: 1,
      provider: "elevenlabs_twilio",
    });
    updateCallRunStatus(run.id, "dialing", {
      provider_call_id: "conv_skip_notify123",
    });

    const result = handlePostCallWebhook({
      type: "post_call_transcription",
      conversation_id: "conv_skip_notify123",
      call_successful: true,
      transcript: "user: ok",
      call_summary: "Call completed.",
    });

    expect(result).not.toBeNull();
    const events = listCallEvents(request.id);
    expect(events.some((e) => e.event_type === "result.notified")).toBe(false);
  });

  it("processes call_initiation_failure", () => {
    seedDefaultProfiles();
    const request = createCallRequest({
      profile_id: "checkin",
      target_person_id: "person_wh_2",
      target_phone: "+5511999999999",
      reason: "Failure webhook test",
    });
    const run = createCallRun({
      request_id: request.id,
      attempt_number: 1,
      provider: "elevenlabs_twilio",
    });
    updateCallRunStatus(run.id, "dialing", {
      provider_call_id: "conv_fail123",
    });

    const payload: CallInitiationFailurePayload = {
      type: "call_initiation_failure",
      conversation_id: "conv_fail123",
      error_message: "Twilio returned 503 Service Unavailable",
    };

    const result = handlePostCallWebhook(payload);
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe("failed_provider");

    const updatedRun = getCallRun(run.id);
    expect(updatedRun!.status).toBe("failed");
    expect(updatedRun!.failure_reason).toBe("Twilio returned 503 Service Unavailable");

    const updatedRequest = getCallRequest(request.id);
    expect(updatedRequest!.status).toBe("failed");
  });

  it("processes unsuccessful call (voicemail heuristic)", () => {
    seedDefaultProfiles();
    const request = createCallRequest({
      profile_id: "checkin",
      target_person_id: "person_wh_3",
      target_phone: "+5511999999999",
      reason: "Voicemail test",
    });
    const run = createCallRun({
      request_id: request.id,
      attempt_number: 1,
      provider: "elevenlabs_twilio",
    });
    updateCallRunStatus(run.id, "dialing", {
      provider_call_id: "conv_vm123",
    });

    const payload: PostCallTranscriptionPayload = {
      type: "post_call_transcription",
      conversation_id: "conv_vm123",
      call_successful: false,
      call_summary: "Call went to voicemail. Left a message.",
    };

    const result = handlePostCallWebhook(payload);
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe("voicemail");

    const updatedRun = getCallRun(run.id);
    expect(updatedRun!.status).toBe("voicemail");
  });

  it("treats conversation analysis failure with user transcript as answered", () => {
    seedDefaultProfiles();
    const request = createCallRequest({
      profile_id: "checkin",
      target_person_id: "person_wh_analysis_failure",
      target_phone: "+5511999999999",
      reason: "Analysis failure should still be answered",
    });
    const run = createCallRun({
      request_id: request.id,
      attempt_number: 1,
      provider: "elevenlabs_twilio",
    });
    updateCallRunStatus(run.id, "dialing", {
      provider_call_id: "conv_analysis_failure",
    });

    const result = handlePostCallWebhook({
      type: "post_call_transcription",
      conversation_id: "conv_analysis_failure",
      call_successful: false,
      transcript: [
        "[0s] agent: Oi, aqui é o Ravi.",
        "[10s] user: A voz vem do agente da ElevenLabs ou do código?",
        "[30s] agent: Não sei responder.",
      ].join("\n"),
      call_summary: "The user asked a technical question and the agent did not answer correctly.",
      call_analysis: {
        call_successful: "failure",
        transcript_summary: "The user asked a technical question and the agent did not answer correctly.",
      },
    });

    expect(result).not.toBeNull();
    expect(result!.outcome).toBe("answered");
    expect(getCallRun(run.id)?.status).toBe("completed");
    expect(getCallRequest(request.id)?.status).toBe("completed");
    expect(getCallResultForRequest(request.id)?.outcome).toBe("answered");
  });

  it("skips already-terminal runs", () => {
    seedDefaultProfiles();
    const request = createCallRequest({
      profile_id: "checkin",
      target_person_id: "person_wh_4",
      target_phone: "+5511999999999",
      reason: "Already terminal test",
    });
    const run = createCallRun({
      request_id: request.id,
      attempt_number: 1,
      provider: "elevenlabs_twilio",
    });
    updateCallRunStatus(run.id, "completed", {
      provider_call_id: "conv_done123",
    });

    const payload: PostCallTranscriptionPayload = {
      type: "post_call_transcription",
      conversation_id: "conv_done123",
      call_successful: true,
    };

    const result = handlePostCallWebhook(payload);
    expect(result).not.toBeNull();
    expect(result!.summary).toBe("already terminal");
  });
});

describe("handleAgoraWebhook", () => {
  it("updates run progress from outbound call state events", () => {
    seedDefaultProfiles();
    const request = createCallRequest({
      profile_id: "checkin",
      target_person_id: "person_agora_progress",
      target_phone: "+5511999999999",
      reason: "Agora progress test",
    });
    const run = createCallRun({
      request_id: request.id,
      attempt_number: 1,
      provider: "agora_sip",
    });
    updateCallRunStatus(run.id, "dialing", {
      provider_call_id: "agent_agora_progress",
    });

    const payload = normalizeAgoraWebhookPayload({
      noticeId: "notice-202",
      productId: 17,
      eventType: 202,
      notifyMs: Date.now(),
      payload: {
        agent_id: "agent_agora_progress",
        channel: "prox-call-test",
        state: "ANSWERED",
        report_ms: Date.now(),
      },
    });

    expect(payload).not.toBeNull();
    const result = handleAgoraWebhook(payload!);
    expect(result).not.toBeNull();
    expect(result!.outcome).toBeNull();
    expect(getCallRun(run.id)?.status).toBe("in_progress");
    expect(listCallEvents(request.id).some((e) => e.source === "prox.calls.webhook.agora")).toBe(true);
  });

  it("creates terminal result from agent history event", () => {
    seedDefaultProfiles();
    const request = createCallRequest({
      profile_id: "checkin",
      target_person_id: "person_agora_history",
      target_phone: "+5511999999999",
      reason: "Agora history test",
    });
    const run = createCallRun({
      request_id: request.id,
      attempt_number: 1,
      provider: "agora_sip",
    });
    updateCallRunStatus(run.id, "in_progress", {
      provider_call_id: "agent_agora_history",
    });

    const result = handleAgoraWebhook({
      noticeId: "notice-103",
      productId: 17,
      eventType: 103,
      payload: {
        agent_id: "agent_agora_history",
        channel: "prox-call-test",
        contents: [
          { role: "assistant", content: "Oi, aqui é o Ravi." },
          { role: "user", content: "Funcionou." },
        ],
        labels: {
          ravi_call_request_id: request.id,
        },
      },
    });

    expect(result).not.toBeNull();
    expect(result!.outcome).toBe("answered");
    expect(getCallRun(run.id)?.status).toBe("completed");
    expect(getCallRequest(request.id)?.status).toBe("completed");
    const callResult = getCallResultForRequest(request.id);
    expect(callResult?.outcome).toBe("answered");
    expect(callResult?.transcript).toContain("user: Funcionou.");
  });
});
