import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testDir = join(tmpdir(), `ravi-provider-test-${Date.now()}`);
mkdirSync(testDir, { recursive: true });
process.env.RAVI_STATE_DIR = testDir;
const originalFetch = globalThis.fetch;

import {
  StubCallProvider,
  ElevenLabsTwilioCallProvider,
  registerCallProvider,
  getCallProvider,
  hasRealProvider,
  resetProviders,
  syncElevenLabsAgentProfile,
} from "./provider.js";
import { resetCallsSchemaFlag } from "./calls-db.js";
import type { ProviderDialInput, CallProfile, CallRequest, CallRun } from "./types.js";

afterAll(() => {
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {}
});

beforeEach(() => {
  resetProviders();
  resetCallsSchemaFlag();
  process.env.RAVI_CALLS_DISABLE_ENV_FILE = "1";
  delete process.env.ELEVENLABS_API_KEY;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeDialInput(
  overrides?: Partial<{ profile: Partial<CallProfile>; request: Partial<CallRequest>; phone: string }>,
): ProviderDialInput {
  return {
    profile: {
      id: "checkin",
      name: "Check-in",
      provider: "elevenlabs_twilio",
      provider_agent_id: "agent_abc123",
      twilio_number_id: "pn_xyz789",
      language: "pt-BR",
      prompt: "test prompt",
      first_message: null,
      system_prompt_path: null,
      dynamic_variables_json: null,
      extraction_schema_json: null,
      voicemail_policy: "hangup",
      enabled: true,
      created_at: Date.now(),
      updated_at: Date.now(),
      ...overrides?.profile,
    } as CallProfile,
    request: {
      id: "cr_test123",
      status: "running",
      profile_id: "checkin",
      rules_id: null,
      target_person_id: "person_luis",
      target_contact_id: null,
      target_platform_identity_id: null,
      target_phone: "+5511999999999",
      origin_session_name: "agent:main:main",
      origin_agent_name: "main",
      origin_channel: "whatsapp",
      origin_message_id: null,
      reason: "Check in on project status",
      priority: "normal",
      deadline_at: null,
      scheduled_for: null,
      metadata_json: null,
      created_at: Date.now(),
      updated_at: Date.now(),
      ...overrides?.request,
    } as CallRequest,
    run: {
      id: "run_test123",
      request_id: "cr_test123",
      status: "queued",
      attempt_number: 1,
      provider: "elevenlabs_twilio",
      provider_call_id: null,
      twilio_call_sid: null,
      started_at: null,
      answered_at: null,
      ended_at: null,
      failure_reason: null,
      metadata_json: null,
    } as CallRun,
    target_phone: overrides?.phone ?? "+5511999999999",
  };
}

// ---------------------------------------------------------------------------
// StubCallProvider
// ---------------------------------------------------------------------------

describe("StubCallProvider", () => {
  it("returns completed status with simulated IDs", async () => {
    const stub = new StubCallProvider();
    expect(stub.name).toBe("stub");
    const result = await stub.dial(makeDialInput());
    expect(result.status).toBe("completed");
    expect(result.provider_call_id).toMatch(/^stub_/);
    expect(result.twilio_call_sid).toBeNull();
    expect(result.failure_reason).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ElevenLabsTwilioCallProvider — config validation
// ---------------------------------------------------------------------------

describe("ElevenLabsTwilioCallProvider config validation", () => {
  it("fails when provider_agent_id is missing", async () => {
    const provider = new ElevenLabsTwilioCallProvider({ apiKey: "test-key" });
    const input = makeDialInput({ profile: { provider_agent_id: "" } });
    const result = await provider.dial(input);
    expect(result.status).toBe("failed");
    expect(result.failure_reason).toContain("Missing provider_agent_id");
  });

  it("fails when twilio_number_id is missing", async () => {
    const provider = new ElevenLabsTwilioCallProvider({ apiKey: "test-key" });
    const input = makeDialInput({ profile: { twilio_number_id: "" } });
    const result = await provider.dial(input);
    expect(result.status).toBe("failed");
    expect(result.failure_reason).toContain("Missing twilio_number_id");
  });

  it("fails when target_phone is missing", async () => {
    const provider = new ElevenLabsTwilioCallProvider({ apiKey: "test-key" });
    const input = makeDialInput({ phone: "" });
    const result = await provider.dial(input);
    expect(result.status).toBe("failed");
    expect(result.failure_reason).toContain("Missing target phone");
  });

  it("has correct provider name", () => {
    const provider = new ElevenLabsTwilioCallProvider({ apiKey: "test-key" });
    expect(provider.name).toBe("elevenlabs_twilio");
  });
});

// ---------------------------------------------------------------------------
// Provider registry
// ---------------------------------------------------------------------------

describe("Provider registry", () => {
  it("returns stub when no provider registered and name not specified", () => {
    const provider = getCallProvider();
    expect(provider.name).toBe("stub");
  });

  it("returns stub explicitly", () => {
    const provider = getCallProvider("stub");
    expect(provider.name).toBe("stub");
  });

  it("throws when named provider is not registered", () => {
    expect(() => getCallProvider("elevenlabs_twilio")).toThrow("not registered");
  });

  it("auto-registers elevenlabs_twilio when ELEVENLABS_API_KEY is set", () => {
    process.env.ELEVENLABS_API_KEY = "test-key-abc";
    const provider = getCallProvider("elevenlabs_twilio");
    expect(provider.name).toBe("elevenlabs_twilio");
    delete process.env.ELEVENLABS_API_KEY;
  });

  it("hasRealProvider returns false with no adapters", () => {
    expect(hasRealProvider()).toBe(false);
  });

  it("hasRealProvider returns true when elevenlabs_twilio is registered", () => {
    registerCallProvider(new ElevenLabsTwilioCallProvider({ apiKey: "test" }));
    expect(hasRealProvider()).toBe(true);
  });

  it("prefers real adapter over stub when name is omitted", () => {
    registerCallProvider(new ElevenLabsTwilioCallProvider({ apiKey: "test" }));
    const provider = getCallProvider();
    expect(provider.name).toBe("elevenlabs_twilio");
  });

  it("returns named adapter when registered", () => {
    registerCallProvider(new ElevenLabsTwilioCallProvider({ apiKey: "test" }));
    const provider = getCallProvider("elevenlabs_twilio");
    expect(provider.name).toBe("elevenlabs_twilio");
  });
});

// ---------------------------------------------------------------------------
// Explicit stub mode
// ---------------------------------------------------------------------------

describe("Explicit stub mode", () => {
  it("stub mode is explicit in output when no real provider", async () => {
    const provider = getCallProvider();
    expect(provider.name).toBe("stub");
    const result = await provider.dial(makeDialInput());
    expect(result.status).toBe("completed");
    expect(result.provider_call_id).toMatch(/^stub_/);
  });

  it("does not silently fall back to stub for elevenlabs provider", () => {
    // When profile.provider is 'elevenlabs' (or elevenlabs_twilio) but not registered
    expect(() => getCallProvider("elevenlabs")).toThrow("not registered");
  });
});

// ---------------------------------------------------------------------------
// ElevenLabs agent profile sync
// ---------------------------------------------------------------------------

describe("syncElevenLabsAgentProfile", () => {
  it("patches raw conversation_config without SDK enum serialization", async () => {
    process.env.ELEVENLABS_API_KEY = "test-key";
    const calls: Array<{ url: string; method: string | undefined; body: unknown }> = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      calls.push({
        url: String(input),
        method: init?.method,
        body: init?.body,
      });

      if (init?.method === "GET") {
        return new Response(
          JSON.stringify({
            conversation_config: {
              asr: {
                provider: "scribe_v2_turbo",
              },
              agent: {
                first_message: "old first message",
                dynamic_variables: {
                  dynamic_variable_placeholders: {
                    person_name: "Person",
                  },
                },
                prompt: {
                  prompt: "old system prompt",
                  llm: "preserved nested setting",
                },
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (init?.method === "PATCH") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ detail: "unexpected request" }), { status: 500 });
    }) as typeof fetch;

    const result = await syncElevenLabsAgentProfile(makeDialInput().profile, {
      firstMessage: "new first message",
      systemPrompt: "new system prompt",
      dynamicVariablePlaceholders: {
        opening_line: "default opening",
      },
    });

    expect(result).toEqual({
      agentId: "agent_abc123",
      firstMessageSynced: true,
      systemPromptSynced: true,
      dynamicVariablesSynced: true,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[1]?.method).toBe("PATCH");

    const patchBody = JSON.parse(String(calls[1]?.body));
    expect(patchBody.conversation_config.asr.provider).toBe("scribe_v2_turbo");
    expect(patchBody.conversation_config.agent.first_message).toBe("new first message");
    expect(patchBody.conversation_config.agent.prompt.prompt).toBe("new system prompt");
    expect(patchBody.conversation_config.agent.prompt.llm).toBe("preserved nested setting");
    expect(patchBody.conversation_config.agent.dynamic_variables.dynamic_variable_placeholders.person_name).toBe(
      "Person",
    );
    expect(patchBody.conversation_config.agent.dynamic_variables.dynamic_variable_placeholders.opening_line).toBe(
      "default opening",
    );
  });
});
