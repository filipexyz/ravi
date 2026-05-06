import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testDir = join(tmpdir(), `ravi-webhook-http-test-${Date.now()}`);
mkdirSync(testDir, { recursive: true });
process.env.RAVI_STATE_DIR = testDir;
const originalFetch = globalThis.fetch;

import { startWebhookHttpServer } from "./http-server.js";
import {
  createCallRequest,
  createCallRun,
  listCallEvents,
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
  process.env.RAVI_CALLS_DISABLE_ENV_FILE = "1";
  delete process.env.AGORA_APP_ID;
  delete process.env.AGORA_APP_CERTIFICATE;
  delete process.env.AGORA_CUSTOMER_ID;
  delete process.env.AGORA_CUSTOMER_SECRET;
  delete process.env.RAVI_AGORA_TOOL_SECRET;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
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

  it("processes Agora ConvoAI history webhooks", async () => {
    seedDefaultProfiles();
    const request = createCallRequest({
      profile_id: "checkin",
      target_person_id: "person_http_agora",
      target_phone: "+5511999999999",
      reason: "Agora HTTP webhook test",
    });
    const run = createCallRun({
      request_id: request.id,
      attempt_number: 1,
      provider: "agora_sip",
    });
    updateCallRunStatus(run.id, "in_progress", {
      provider_call_id: "agent_http_agora",
    });

    const server = startWebhookHttpServer({
      host: "127.0.0.1",
      port: 0,
      allowUnsignedAgora: true,
    });

    try {
      const response = await fetch(`${server.url}/webhooks/agora/convoai`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          noticeId: "notice-http-agora",
          productId: 17,
          eventType: 103,
          notifyMs: Date.now(),
          payload: {
            agent_id: "agent_http_agora",
            channel: "prox-call-http",
            contents: [
              { role: "assistant", content: "Oi." },
              { role: "user", content: "Funcionou via webhook." },
            ],
          },
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, matched: true });
      const result = getCallResultForRequest(request.id);
      expect(result?.outcome).toBe("answered");
      expect(result?.transcript).toContain("Funcionou via webhook.");
    } finally {
      await server.stop();
    }
  });

  it("verifies Agora webhook signatures when secret is configured", async () => {
    const server = startWebhookHttpServer({
      host: "127.0.0.1",
      port: 0,
      agoraWebhookSecret: "agora-secret",
    });
    const rawBody = JSON.stringify({
      noticeId: "notice-signed",
      productId: 17,
      eventType: 202,
      payload: {
        agent_id: "unknown",
        state: "CALLING",
      },
    });
    const signature = createHmac("sha256", "agora-secret").update(rawBody).digest("hex");

    try {
      const response = await fetch(`${server.url}/webhooks/agora/convoai`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "agora-signature-v2": signature,
        },
        body: rawBody,
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, matched: false });
    } finally {
      await server.stop();
    }
  });

  it("serves end_call tool via canonical bridge route", async () => {
    seedDefaultProfiles();
    process.env.AGORA_APP_ID = "0".repeat(32);
    process.env.AGORA_APP_CERTIFICATE = "1".repeat(32);
    process.env.AGORA_CUSTOMER_ID = "customer-id";
    process.env.AGORA_CUSTOMER_SECRET = "customer-secret";
    process.env.RAVI_AGORA_TOOL_SECRET = "tool-secret";

    const request = createCallRequest({
      profile_id: "checkin",
      target_person_id: "person_canonical_bridge",
      target_phone: "+5511999999999",
      reason: "Canonical bridge test",
    });
    const run = createCallRun({
      request_id: request.id,
      attempt_number: 1,
      provider: "agora_sip",
    });
    updateCallRunStatus(run.id, "in_progress", {
      provider_call_id: "agent_canonical_bridge",
    });

    const server = startWebhookHttpServer({
      host: "127.0.0.1",
      port: 0,
      allowUnsignedAgora: true,
    });
    const agoraCalls: Array<{ url: string }> = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = String(input);
      if (url.startsWith(server.url)) return originalFetch(input, init);
      agoraCalls.push({ url });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    try {
      // Test through canonical route
      const callResponse = await fetch(`${server.url}/webhooks/prox/calls/tools?request_id=${request.id}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer tool-secret",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "end_call", arguments: { reason: "canonical" } },
        }),
      });
      expect(callResponse.status).toBe(200);
      expect(await callResponse.json()).toMatchObject({
        result: { isError: false, content: [{ type: "text" }] },
      });
      expect(agoraCalls).toHaveLength(1);
      expect(agoraCalls[0]?.url).toContain("/calls/agent_canonical_bridge/hangup");
      expect(listCallEvents(request.id).some((event) => event.status === "hangup_requested")).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it("Agora alias and canonical route share the same executor", async () => {
    seedDefaultProfiles();
    process.env.AGORA_APP_ID = "0".repeat(32);
    process.env.AGORA_APP_CERTIFICATE = "1".repeat(32);
    process.env.AGORA_CUSTOMER_ID = "customer-id";
    process.env.AGORA_CUSTOMER_SECRET = "customer-secret";
    process.env.RAVI_AGORA_TOOL_SECRET = "tool-secret";

    const server = startWebhookHttpServer({
      host: "127.0.0.1",
      port: 0,
      allowUnsignedAgora: true,
    });

    try {
      // Both routes should return the same initialize response
      const canonicalInit = await fetch(`${server.url}/webhooks/prox/calls/tools?request_id=cr_test`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer tool-secret",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      });

      const agoraInit = await fetch(`${server.url}/webhooks/agora/tools?request_id=cr_test`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer tool-secret",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize" }),
      });

      expect(canonicalInit.status).toBe(200);
      expect(agoraInit.status).toBe(200);

      const canonicalBody = (await canonicalInit.json()) as Record<string, unknown>;
      const agoraBody = (await agoraInit.json()) as Record<string, unknown>;

      // Both should have the same server info
      expect((canonicalBody.result as Record<string, unknown>).serverInfo).toEqual(
        (agoraBody.result as Record<string, unknown>).serverInfo,
      );
    } finally {
      await server.stop();
    }
  });

  it("rejects tool bridge requests without auth", async () => {
    process.env.RAVI_AGORA_TOOL_SECRET = "tool-secret";
    const server = startWebhookHttpServer({
      host: "127.0.0.1",
      port: 0,
    });

    try {
      const response = await fetch(`${server.url}/webhooks/prox/calls/tools?request_id=cr_test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
      expect(response.status).toBe(401);

      // Same for Agora alias
      const agoraResponse = await fetch(`${server.url}/webhooks/agora/tools?request_id=cr_test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
      expect(agoraResponse.status).toBe(401);
    } finally {
      await server.stop();
    }
  });

  it("serves Agora MCP end_call tool and hangs up through the Agora API", async () => {
    seedDefaultProfiles();
    process.env.AGORA_APP_ID = "0".repeat(32);
    process.env.AGORA_APP_CERTIFICATE = "1".repeat(32);
    process.env.AGORA_CUSTOMER_ID = "customer-id";
    process.env.AGORA_CUSTOMER_SECRET = "customer-secret";
    process.env.RAVI_AGORA_TOOL_SECRET = "tool-secret";

    const request = createCallRequest({
      profile_id: "checkin",
      target_person_id: "person_http_agora_tool",
      target_phone: "+5511999999999",
      reason: "Agora MCP tool test",
    });
    const run = createCallRun({
      request_id: request.id,
      attempt_number: 1,
      provider: "agora_sip",
    });
    updateCallRunStatus(run.id, "in_progress", {
      provider_call_id: "agent_http_agora_tool",
    });

    const server = startWebhookHttpServer({
      host: "127.0.0.1",
      port: 0,
      allowUnsignedAgora: true,
    });
    const agoraCalls: Array<{ url: string; body: Record<string, unknown>; auth: string | null }> = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = String(input);
      if (url.startsWith(server.url)) return originalFetch(input, init);
      agoraCalls.push({
        url,
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        auth:
          init?.headers instanceof Headers
            ? init.headers.get("authorization")
            : (init?.headers as Record<string, string>).authorization,
      });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    try {
      const listResponse = await fetch(`${server.url}/webhooks/agora/tools?request_id=${request.id}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer tool-secret",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(listResponse.status).toBe(200);
      expect(await listResponse.json()).toMatchObject({
        result: { tools: [{ name: "end_call" }] },
      });

      const callResponse = await fetch(`${server.url}/webhooks/agora/tools?request_id=${request.id}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer tool-secret",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "end_call", arguments: { reason: "test complete" } },
        }),
      });
      expect(callResponse.status).toBe(200);
      expect(await callResponse.json()).toMatchObject({
        result: { isError: false },
      });

      expect(agoraCalls).toHaveLength(1);
      expect(agoraCalls[0]?.url).toContain("/calls/agent_http_agora_tool/hangup");
      expect(agoraCalls[0]?.auth).toMatch(/^Basic /);
      expect(agoraCalls[0]?.body).toEqual({ reason: "test complete" });
      expect(listCallEvents(request.id).some((event) => event.status === "hangup_requested")).toBe(true);

      const duplicateResponse = await fetch(`${server.url}/webhooks/agora/tools?request_id=${request.id}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer tool-secret",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "end_call", arguments: { reason: "duplicate" } },
        }),
      });
      expect(duplicateResponse.status).toBe(200);
      expect(await duplicateResponse.json()).toMatchObject({
        result: { isError: false },
      });
      expect(agoraCalls).toHaveLength(1);
    } finally {
      await server.stop();
    }
  });
});

describe("Webhook HTTP server — SDK gateway unification", () => {
  it("mounts /api/v1/_meta/version on the same listener", async () => {
    const server = startWebhookHttpServer({ host: "127.0.0.1", port: 0 });
    try {
      const res = await fetch(`${server.url}/api/v1/_meta/version`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { gateway: string; registryHash: string };
      expect(typeof body.gateway).toBe("string");
      expect(typeof body.registryHash).toBe("string");
      expect(body.registryHash.length).toBeGreaterThan(0);
    } finally {
      await server.stop();
    }
  });

  it("emits OpenAPI on demand at /api/v1/_meta/openapi.json", async () => {
    const server = startWebhookHttpServer({ host: "127.0.0.1", port: 0 });
    try {
      const res = await fetch(`${server.url}/api/v1/_meta/openapi.json`);
      expect(res.status).toBe(200);
      const spec = (await res.json()) as { openapi: string; paths: Record<string, unknown> };
      expect(spec.openapi).toBe("3.1.0");
      expect(Object.keys(spec.paths).length).toBeGreaterThan(0);
    } finally {
      await server.stop();
    }
  });

  it("returns the webhook 404 envelope for /api/v1/* when the gateway is disabled", async () => {
    const server = startWebhookHttpServer({ host: "127.0.0.1", port: 0, gateway: null });
    try {
      const res = await fetch(`${server.url}/api/v1/_meta/version`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
      expect(body.error).toBe("not_found");
    } finally {
      await server.stop();
    }
  });
});
