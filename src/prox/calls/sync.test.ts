import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testDir = join(tmpdir(), `ravi-prox-calls-sync-test-${Date.now()}`);
mkdirSync(testDir, { recursive: true });
process.env.RAVI_STATE_DIR = testDir;

afterAll(() => {
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {}
});

import {
  createCallRequest,
  createCallRun,
  getCallRequest,
  getCallResultForRequest,
  getCallRun,
  initCallsDefaults,
  resetCallsSchemaFlag,
  updateCallRunStatus,
} from "./index.js";
import { syncCallRequestFromElevenLabs } from "./sync.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeRequestWithProviderRun(conversationId: string) {
  initCallsDefaults();
  const request = createCallRequest({
    profile_id: "checkin",
    target_person_id: "luis",
    target_phone: "+5511999999999",
    reason: "Sync test",
  });
  const run = createCallRun({
    request_id: request.id,
    attempt_number: 1,
    provider: "elevenlabs_twilio",
  });
  updateCallRunStatus(run.id, "dialing", {
    provider_call_id: conversationId,
    twilio_call_sid: "CA_test",
  });
  return { request, run };
}

beforeEach(() => {
  resetCallsSchemaFlag();
  delete process.env.ELEVENLABS_API_KEY;
});

describe("syncCallRequestFromElevenLabs", () => {
  it("syncs completed answered calls into run, request and result transcript", async () => {
    const { request, run } = makeRequestWithProviderRun("conv_answered");

    const synced = await syncCallRequestFromElevenLabs(request.id, {
      apiKey: "sk_test",
      fetchImpl: async () =>
        jsonResponse({
          status: "done",
          metadata: {
            call_duration_secs: 31,
            termination_reason: "end_call tool was called.",
            phone_call: { call_sid: "CA_test" },
          },
          transcript: [
            { role: "agent", time_in_call_secs: 0, message: "Oi, aqui é o Ravi!" },
            { role: "user", time_in_call_secs: 5, message: "Agora não." },
          ],
          analysis: {
            transcript_summary: "The user said now is not a good time.",
            call_summary_title: "Not now",
            call_successful: "unknown",
          },
        }),
    });

    expect(synced.terminal).toBe(true);
    expect(synced.persisted?.outcome).toBe("answered");
    expect(getCallRun(run.id)?.status).toBe("completed");
    expect(getCallRequest(request.id)?.status).toBe("completed");
    const result = getCallResultForRequest(request.id);
    expect(result?.outcome).toBe("answered");
    expect(result?.transcript).toContain("user: Agora não.");
  });

  it("maps carrier unavailable messages to no_answer", async () => {
    const { request, run } = makeRequestWithProviderRun("conv_unavailable");

    const synced = await syncCallRequestFromElevenLabs(request.id, {
      apiKey: "sk_test",
      fetchImpl: async () =>
        jsonResponse({
          status: "done",
          metadata: {
            call_duration_secs: 12,
            termination_reason: "Call ended by remote party",
            phone_call: { call_sid: "CA_test" },
          },
          transcript: [
            { role: "agent", time_in_call_secs: 0, message: "Oi, aqui é o Ravi!" },
            {
              role: "user",
              time_in_call_secs: 6,
              message: "Vamos entregar o seu recado assim que o celular estiver disponível.",
            },
          ],
          analysis: {
            transcript_summary: "The phone was unavailable and a carrier message was played.",
            call_summary_title: "Celular indisponível",
            call_successful: "unknown",
          },
        }),
    });

    expect(synced.persisted?.outcome).toBe("no_answer");
    expect(getCallRun(run.id)?.status).toBe("no_answer");
    expect(getCallRequest(request.id)?.status).toBe("failed");
    expect(getCallResultForRequest(request.id)?.next_action).toBe("retry");
  });
});
