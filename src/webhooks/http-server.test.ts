import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testDir = join(tmpdir(), `ravi-webhook-http-test-${Date.now()}`);
mkdirSync(testDir, { recursive: true });
process.env.RAVI_STATE_DIR = testDir;

import { startWebhookHttpServer } from "./http-server.js";
import {
  createCallRequest,
  createCallRun,
  getCallResultForRequest,
  resetCallsSchemaFlag,
  seedDefaultProfiles,
  updateCallRunStatus,
} from "../prox/calls/calls-db.js";

afterAll(() => {
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {}
});

beforeEach(() => {
  resetCallsSchemaFlag();
});

describe("Webhook HTTP server", () => {
  it("processes enhanced ElevenLabs post-call webhooks", async () => {
    seedDefaultProfiles();
    const request = createCallRequest({
      profile_id: "checkin",
      target_person_id: "person_http_1",
      target_phone: "+5511999999999",
      reason: "HTTP webhook test",
    });
    const run = createCallRun({
      request_id: request.id,
      attempt_number: 1,
      provider: "elevenlabs_twilio",
    });
    updateCallRunStatus(run.id, "dialing", {
      provider_call_id: "conv_http_123",
      twilio_call_sid: "CA_http_123",
    });

    const server = startWebhookHttpServer({
      host: "127.0.0.1",
      port: 0,
      allowUnsignedElevenLabs: true,
    });

    try {
      const response = await fetch(`${server.url}/webhooks/elevenlabs/post-call`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "post_call_transcription",
          event_timestamp: 1739537297,
          data: {
            conversation_id: "conv_http_123",
            status: "done",
            transcript: [
              {
                role: "agent",
                message: "Oi, aqui é o Ravi.",
                time_in_call_secs: 0,
              },
              {
                role: "user",
                message: "Agora não.",
                time_in_call_secs: 4,
              },
            ],
            metadata: {
              call_duration_secs: 8,
              phone_call: { call_sid: "CA_http_123" },
            },
            analysis: {
              call_successful: "success",
              transcript_summary: "User answered and asked to continue later.",
            },
          },
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, matched: true });

      const result = getCallResultForRequest(request.id);
      expect(result?.outcome).toBe("answered");
      expect(result?.summary).toContain("continue later");
      expect(result?.transcript).toContain("[4s] user: Agora não.");
    } finally {
      await server.stop();
    }
  });

  it("rejects unsigned ElevenLabs webhooks unless explicitly allowed", async () => {
    const server = startWebhookHttpServer({
      host: "127.0.0.1",
      port: 0,
    });

    try {
      const response = await fetch(`${server.url}/webhooks/elevenlabs/post-call`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "post_call_transcription", data: { conversation_id: "conv_unsigned" } }),
      });

      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ ok: false, error: "webhook_secret_not_configured" });
    } finally {
      await server.stop();
    }
  });
});
