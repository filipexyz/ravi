import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testDir = join(tmpdir(), `ravi-webhook-test-${Date.now()}`);
mkdirSync(testDir, { recursive: true });
process.env.RAVI_STATE_DIR = testDir;

import { handlePostCallWebhook } from "./webhook.js";
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
