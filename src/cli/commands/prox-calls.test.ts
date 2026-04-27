import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDb } from "../../router/router-db.js";

const testDir = join(tmpdir(), `ravi-prox-calls-cli-test-${Date.now()}`);
mkdirSync(testDir, { recursive: true });
process.env.RAVI_STATE_DIR = testDir;

afterAll(() => {
  mock.restore();
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {}
});

import {
  initCallsDefaults,
  listCallProfiles,
  getCallProfile,
  updateCallProfile,
  getCallRules,
  getCallRequest,
  listCallEvents,
  createCallRequest,
  createCallEvent,
  createCallResult,
  updateCallRequestStatus,
  cancelCallRequest,
  submitCallRequest,
  resetCallsSchemaFlag,
  hasRealProvider,
  resetProviders,
  listCallVoiceAgents,
  getCallVoiceAgent,
  createCallVoiceAgent,
  updateCallVoiceAgent,
  listCallTools,
  getCallTool,
  createCallTool,
  updateCallTool,
  listCallToolBindings,
  createCallToolBinding,
  deleteCallToolBinding,
  evaluateCallToolPolicy,
  createCallToolRun,
  listCallToolRuns,
} from "../../prox/calls/index.js";

beforeEach(() => {
  resetCallsSchemaFlag();
  resetProviders();
  process.env.RAVI_CALLS_DISABLE_ENV_FILE = "1";
  delete process.env.ELEVENLABS_API_KEY;
});

function initCallsDefaultsForDialing(): void {
  initCallsDefaults();
  getDb()
    .prepare("UPDATE call_rules SET quiet_hours_json = NULL, cooldown_seconds = 0 WHERE id = 'rules-global-default'")
    .run();
}

describe("prox calls storage integration", () => {
  it("initCallsDefaults seeds profiles and rules", () => {
    initCallsDefaults();
    const profiles = listCallProfiles();
    expect(profiles.length).toBe(3);
    const rules = getCallRules();
    expect(rules).not.toBeNull();
    expect(rules!.scope_type).toBe("global");
  });

  it("profiles list returns stable JSON", () => {
    initCallsDefaults();
    const profiles = listCallProfiles();
    const json = profiles.map((p) => ({
      id: p.id,
      name: p.name,
      provider: p.provider,
      language: p.language,
      enabled: p.enabled,
    }));
    expect(json).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "checkin", name: "Check-in", provider: "elevenlabs", enabled: true }),
        expect.objectContaining({ id: "followup", name: "Follow-up" }),
        expect.objectContaining({ id: "urgent-approval", name: "Urgent Approval" }),
      ]),
    );
  });

  it("profiles show returns full profile details", () => {
    initCallsDefaults();
    const profile = getCallProfile("checkin");
    expect(profile).not.toBeNull();
    expect(profile!.id).toBe("checkin");
    expect(profile!.voicemail_policy).toBe("hangup");
  });

  it("rules show returns global rules by default", () => {
    initCallsDefaults();
    const rules = getCallRules();
    expect(rules).not.toBeNull();
    expect(rules!.max_attempts).toBe(3);
    expect(rules!.cooldown_seconds).toBe(3600);
    expect(rules!.cancel_on_inbound_reply).toBe(true);
  });
});

describe("prox calls request flow", () => {
  it("request creates a persisted call_request before provider call", async () => {
    initCallsDefaultsForDialing();
    // Use stub provider explicitly for test
    updateCallProfile("checkin", { provider: "stub" });
    const result = await submitCallRequest({
      profile_id: "checkin",
      target_person_id: "person_test_1",
      reason: "Slow to respond",
      priority: "normal",
      origin_session_name: "agent:main:dm:test",
      origin_agent_name: "main",
      origin_channel: "whatsapp",
    });

    expect(result.request.id).toMatch(/^cr_/);
    expect(result.request.profile_id).toBe("checkin");
    expect(result.request.target_person_id).toBe("person_test_1");
    expect(result.request.reason).toBe("Slow to respond");

    // Verify persistence
    const persisted = getCallRequest(result.request.id);
    expect(persisted).not.toBeNull();
  });

  it("request emits events timeline", async () => {
    initCallsDefaultsForDialing();
    updateCallProfile("followup", { provider: "stub" });
    const result = await submitCallRequest({
      profile_id: "followup",
      target_person_id: "person_test_2",
      reason: "Follow up on proposal",
    });

    const events = listCallEvents(result.request.id);
    expect(events.length).toBeGreaterThanOrEqual(1);

    const eventTypes = events.map((e) => e.event_type);
    expect(eventTypes).toContain("request.created");
    expect(eventTypes).toContain("rules.evaluated");
  });

  it("request uses stub provider when profile explicitly uses stub", async () => {
    initCallsDefaultsForDialing();
    updateCallProfile("checkin", { provider: "stub" });
    expect(hasRealProvider()).toBe(false);

    const result = await submitCallRequest({
      profile_id: "checkin",
      target_person_id: "person_test_3",
      reason: "Test stub",
    });

    expect(result.blocked).toBe(false);
    // Stub provider completes immediately
    expect(["completed", "running"]).toContain(result.request.status);
  });

  it("request with unregistered real provider creates durable failure", async () => {
    initCallsDefaultsForDialing();
    // Ensure profile has a real provider name that is NOT registered
    updateCallProfile("checkin", { provider: "elevenlabs_twilio" });
    const result = await submitCallRequest({
      profile_id: "checkin",
      target_person_id: "person_test_provider_fail",
      reason: "No provider test",
    });

    expect(result.request.status).toBe("failed");
    const events = listCallEvents(result.request.id);
    expect(events.some((e) => e.event_type === "run.failed")).toBe(true);
  });
});

describe("prox calls show", () => {
  it("show returns request with runs and result", async () => {
    initCallsDefaultsForDialing();
    updateCallProfile("checkin", { provider: "stub" });
    const { request } = await submitCallRequest({
      profile_id: "checkin",
      target_person_id: "person_test_4",
      reason: "Show test",
    });

    const fetched = getCallRequest(request.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(request.id);
  });
});

describe("prox calls events", () => {
  it("events command returns ordered timeline", async () => {
    initCallsDefaultsForDialing();
    updateCallProfile("checkin", { provider: "stub" });
    const { request } = await submitCallRequest({
      profile_id: "checkin",
      target_person_id: "person_test_5",
      reason: "Events test",
    });

    const events = listCallEvents(request.id);
    expect(events.length).toBeGreaterThanOrEqual(1);

    // Events should be ordered by created_at ASC
    for (let i = 1; i < events.length; i++) {
      expect(events[i].created_at).toBeGreaterThanOrEqual(events[i - 1].created_at);
    }
  });
});

describe("prox calls cancel", () => {
  it("cancels a pending request", () => {
    initCallsDefaultsForDialing();
    const request = createCallRequest({
      profile_id: "checkin",
      target_person_id: "person_cancel_1",
      reason: "Cancel test",
    });

    const result = cancelCallRequest(request.id, "Person replied on WhatsApp");
    expect(result.success).toBe(true);

    const updated = getCallRequest(request.id);
    expect(updated!.status).toBe("canceled");

    // Cancel event should be persisted
    const events = listCallEvents(request.id);
    expect(events.some((e) => e.event_type === "request.canceled")).toBe(true);
  });

  it("cannot cancel a completed request", async () => {
    initCallsDefaultsForDialing();
    updateCallProfile("checkin", { provider: "stub" });
    const { request } = await submitCallRequest({
      profile_id: "checkin",
      target_person_id: "person_cancel_2",
      reason: "Cancel completed test",
    });

    // Force it to completed status (stub does this)
    if (request.status !== "completed") {
      updateCallRequestStatus(request.id, "completed");
    }

    const result = cancelCallRequest(request.id);
    expect(result.success).toBe(false);
    expect(result.message).toContain("Cannot cancel");
  });

  it("returns error for nonexistent request", () => {
    initCallsDefaultsForDialing();
    const result = cancelCallRequest("cr_nonexistent");
    expect(result.success).toBe(false);
    expect(result.message).toContain("not found");
  });
});

describe("terminal failures are durable", () => {
  it("provider failure creates durable result and event", async () => {
    initCallsDefaultsForDialing();
    const request = createCallRequest({
      profile_id: "checkin",
      target_person_id: "person_fail_1",
      reason: "Failure test",
    });

    // Simulate a terminal failure stored as result
    createCallResult({
      request_id: request.id,
      outcome: "failed_provider",
      summary: "Twilio 503 Service Unavailable",
      next_action: "retry",
    });

    createCallEvent({
      request_id: request.id,
      event_type: "run.failed",
      status: "failed",
      message: "Twilio 503 Service Unavailable",
      source: "prox.calls.provider.elevenlabs",
    });

    // Verify durability
    const result = getCallRequest(request.id);
    expect(result).not.toBeNull();

    const events = listCallEvents(request.id);
    const failEvent = events.find((e) => e.event_type === "run.failed");
    expect(failEvent).toBeDefined();
    expect(failEvent!.message).toBe("Twilio 503 Service Unavailable");
  });
});

describe("JSON output shapes", () => {
  it("request JSON includes all required fields", async () => {
    initCallsDefaultsForDialing();
    updateCallProfile("checkin", { provider: "stub" });
    const { request } = await submitCallRequest({
      profile_id: "checkin",
      target_person_id: "person_json_1",
      reason: "JSON shape test",
      priority: "high",
      origin_session_name: "agent:main:dm:json",
      origin_agent_name: "main",
      origin_channel: "whatsapp",
    });

    const serialized = {
      id: request.id,
      status: request.status,
      profile_id: request.profile_id,
      rules_id: request.rules_id,
      target_person_id: request.target_person_id,
      reason: request.reason,
      priority: request.priority,
      origin_session_name: request.origin_session_name,
      origin_agent_name: request.origin_agent_name,
      origin_channel: request.origin_channel,
      created_at: request.created_at,
      updated_at: request.updated_at,
    };

    expect(serialized.id).toMatch(/^cr_/);
    expect(serialized.profile_id).toBe("checkin");
    expect(serialized.priority).toBe("high");
    expect(typeof serialized.created_at).toBe("number");
    expect(typeof serialized.updated_at).toBe("number");
  });

  it("events JSON includes timeline with proper typing", async () => {
    initCallsDefaultsForDialing();
    updateCallProfile("followup", { provider: "stub" });
    const { request } = await submitCallRequest({
      profile_id: "followup",
      target_person_id: "person_json_2",
      reason: "Events JSON test",
    });

    const events = listCallEvents(request.id);
    const serialized = events.map((e) => ({
      id: e.id,
      request_id: e.request_id,
      event_type: e.event_type,
      status: e.status,
      message: e.message,
      source: e.source,
      created_at: e.created_at,
    }));

    expect(serialized.length).toBeGreaterThanOrEqual(1);
    for (const e of serialized) {
      expect(typeof e.id).toBe("number");
      expect(typeof e.request_id).toBe("string");
      expect(typeof e.event_type).toBe("string");
      expect(typeof e.created_at).toBe("number");
    }
  });
});

describe("profile configure", () => {
  it("updates provider settings on existing profile", () => {
    initCallsDefaults();
    const updated = updateCallProfile("checkin", {
      provider: "elevenlabs_twilio",
      provider_agent_id: "agent_abc123",
      twilio_number_id: "pn_xyz789",
    });

    expect(updated).not.toBeNull();
    expect(updated!.provider).toBe("elevenlabs_twilio");
    expect(updated!.provider_agent_id).toBe("agent_abc123");
    expect(updated!.twilio_number_id).toBe("pn_xyz789");
    // Unchanged fields remain
    expect(updated!.language).toBe("pt-BR");
    expect(updated!.voicemail_policy).toBe("hangup");
  });

  it("returns null for nonexistent profile", () => {
    initCallsDefaults();
    const result = updateCallProfile("nonexistent_profile", { provider: "stub" });
    expect(result).toBeNull();
  });

  it("persists changes across reads", () => {
    initCallsDefaults();
    updateCallProfile("checkin", {
      provider_agent_id: "agent_persist_test",
      twilio_number_id: "pn_persist_test",
    });

    const profile = getCallProfile("checkin");
    expect(profile!.provider_agent_id).toBe("agent_persist_test");
    expect(profile!.twilio_number_id).toBe("pn_persist_test");
  });

  it("show --json exposes configured provider refs without secrets", () => {
    initCallsDefaults();
    updateCallProfile("checkin", {
      provider: "elevenlabs_twilio",
      provider_agent_id: "agent_show_test",
      twilio_number_id: "pn_show_test",
    });

    const profile = getCallProfile("checkin");
    expect(profile).not.toBeNull();
    const serialized = {
      id: profile!.id,
      provider: profile!.provider,
      provider_agent_id: profile!.provider_agent_id,
      twilio_number_id: profile!.twilio_number_id,
    };
    expect(serialized.provider_agent_id).toBe("agent_show_test");
    expect(serialized.twilio_number_id).toBe("pn_show_test");
    // No API keys in profile fields
    expect(JSON.stringify(serialized)).not.toContain("api_key");
    expect(JSON.stringify(serialized)).not.toContain("secret");
  });
});

describe("request with --phone", () => {
  beforeEach(() => {
    resetProviders();
    delete process.env.ELEVENLABS_API_KEY;
  });

  it("persists target_phone on the call request", async () => {
    initCallsDefaultsForDialing();
    updateCallProfile("checkin", { provider: "stub" });
    const { request } = await submitCallRequest({
      profile_id: "checkin",
      target_person_id: "person_phone_1",
      target_phone: "+5511999999999",
      reason: "Phone test",
    });

    expect(request.target_phone).toBe("+5511999999999");
    const persisted = getCallRequest(request.id);
    expect(persisted!.target_phone).toBe("+5511999999999");
  });

  it("persists dynamic variables in request metadata", async () => {
    initCallsDefaultsForDialing();
    updateCallProfile("checkin", { provider: "stub" });
    const { request } = await submitCallRequest({
      profile_id: "checkin",
      target_person_id: "person_dynamic_1",
      target_phone: "+5511999999999",
      reason: "Dynamic variable test",
      metadata_json: {
        dynamic_variables: {
          opening_line: "Oi, teste",
          goal: "validar variaveis dinamicas",
        },
      },
    });

    const persisted = getCallRequest(request.id);
    expect(persisted!.metadata_json).toEqual({
      dynamic_variables: {
        opening_line: "Oi, teste",
        goal: "validar variaveis dinamicas",
      },
    });
  });

  it("persists notify_origin opt-out in request metadata", async () => {
    initCallsDefaultsForDialing();
    updateCallProfile("checkin", { provider: "stub" });
    const { request } = await submitCallRequest({
      profile_id: "checkin",
      target_person_id: "person_notify_opt_out",
      target_phone: "+5511999999999",
      reason: "Notify opt-out test",
      origin_session_name: "agent:main:dm:no-notify",
      metadata_json: {
        notify_origin: false,
      },
    });

    const persisted = getCallRequest(request.id);
    expect(persisted!.metadata_json).toEqual({ notify_origin: false });
  });

  it("request without --phone has null target_phone", async () => {
    initCallsDefaultsForDialing();
    updateCallProfile("checkin", { provider: "stub" });
    const { request } = await submitCallRequest({
      profile_id: "checkin",
      target_person_id: "person_phone_2",
      reason: "No phone test",
    });

    expect(request.target_phone).toBeNull();
  });
});

describe("missing config creates durable failure", () => {
  it("live adapter with missing agent_id creates failed run/event/result", async () => {
    initCallsDefaultsForDialing();
    // Configure profile with provider but no agent_id
    updateCallProfile("checkin", {
      provider: "elevenlabs_twilio",
      provider_agent_id: "",
      twilio_number_id: "pn_test",
    });

    // Register the adapter manually
    resetProviders();
    const { ElevenLabsTwilioCallProvider, registerCallProvider } = await import("../../prox/calls/provider.js");
    registerCallProvider(new ElevenLabsTwilioCallProvider({ apiKey: "test-key" }));

    const { request } = await submitCallRequest({
      profile_id: "checkin",
      target_person_id: "person_fail_config",
      target_phone: "+5511999999999",
      reason: "Config failure test",
    });

    // Should fail due to missing agent_id
    expect(request.status).toBe("failed");

    // Check durable failure artifacts
    const events = listCallEvents(request.id);
    const failEvent = events.find((e) => e.event_type === "run.failed");
    expect(failEvent).toBeDefined();
    expect(failEvent!.message).toContain("Missing provider_agent_id");
  });
});

// ---------------------------------------------------------------------------
// Voice Agent tests
// ---------------------------------------------------------------------------

describe("voice agent seeds", () => {
  it("initCallsDefaults seeds voice agents", () => {
    initCallsDefaults();
    const agents = listCallVoiceAgents();
    expect(agents.length).toBe(4);
  });

  it("seeds expected voice agent ids", () => {
    initCallsDefaults();
    const ids = listCallVoiceAgents().map((a) => a.id);
    expect(ids).toContain("ravi-followup");
    expect(ids).toContain("ravi-interviewer");
    expect(ids).toContain("ravi-urgent-approval");
    expect(ids).toContain("ravi-intake");
  });

  it("voice agents have required fields", () => {
    initCallsDefaults();
    for (const agent of listCallVoiceAgents()) {
      expect(agent.id).toBeTruthy();
      expect(agent.name).toBeTruthy();
      expect(agent.description).toBeTruthy();
      expect(agent.provider).toBe("elevenlabs");
      expect(agent.language).toBe("pt-BR");
      expect(agent.system_prompt).toBeTruthy();
      expect(agent.first_message_template).toBeTruthy();
      expect(agent.version).toBe(1);
      expect(agent.enabled).toBe(true);
      expect(agent.dynamic_variables_schema_json).not.toBeNull();
      expect(agent.default_tools_json).not.toBeNull();
      expect(Array.isArray(agent.default_tools_json)).toBe(true);
    }
  });

  it("voice agents list returns stable JSON", () => {
    initCallsDefaults();
    const agents = listCallVoiceAgents();
    const json = agents.map((a) => ({
      id: a.id,
      name: a.name,
      provider: a.provider,
      language: a.language,
      enabled: a.enabled,
      version: a.version,
    }));
    expect(json).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "ravi-followup", name: "Ravi Follow-up" }),
        expect.objectContaining({ id: "ravi-interviewer", name: "Ravi Interviewer" }),
        expect.objectContaining({ id: "ravi-urgent-approval", name: "Ravi Urgent Approval" }),
        expect.objectContaining({ id: "ravi-intake", name: "Ravi Intake" }),
      ]),
    );
  });
});

describe("voice agent CRUD", () => {
  it("show returns full voice agent details", () => {
    initCallsDefaults();
    const agent = getCallVoiceAgent("ravi-followup");
    expect(agent).not.toBeNull();
    expect(agent!.id).toBe("ravi-followup");
    expect(agent!.name).toBe("Ravi Follow-up");
    expect(agent!.system_prompt).toContain("follow-up");
  });

  it("create adds a new voice agent", () => {
    initCallsDefaults();
    const agent = createCallVoiceAgent({
      id: "test-agent",
      name: "Test Agent",
      provider: "stub",
      description: "A test voice agent",
    });
    expect(agent.id).toBe("test-agent");
    expect(agent.name).toBe("Test Agent");
    expect(agent.version).toBe(1);
    expect(agent.enabled).toBe(true);
  });

  it("update bumps version on material changes", () => {
    initCallsDefaults();
    const updated = updateCallVoiceAgent("ravi-followup", {
      system_prompt: "Updated prompt",
    });
    expect(updated).not.toBeNull();
    expect(updated!.version).toBe(2);
    expect(updated!.system_prompt).toBe("Updated prompt");
  });

  it("update does not bump version on non-material changes", () => {
    initCallsDefaults();
    const before = getCallVoiceAgent("ravi-followup")!;
    const updated = updateCallVoiceAgent("ravi-followup", {
      name: "New Name",
    });
    expect(updated).not.toBeNull();
    expect(updated!.version).toBe(before.version);
    expect(updated!.name).toBe("New Name");
  });

  it("returns null for nonexistent voice agent", () => {
    initCallsDefaults();
    const result = updateCallVoiceAgent("nonexistent", { name: "test" });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Call Tool tests
// ---------------------------------------------------------------------------

describe("call tool seeds", () => {
  it("initCallsDefaults seeds call tools", () => {
    initCallsDefaults();
    const tools = listCallTools();
    expect(tools.length).toBe(5);
  });

  it("seeds expected tool ids", () => {
    initCallsDefaults();
    const ids = listCallTools().map((t) => t.id);
    expect(ids).toContain("call.end");
    expect(ids).toContain("person.lookup");
    expect(ids).toContain("prox.note.create");
    expect(ids).toContain("prox.followup.schedule");
    expect(ids).toContain("task.create");
  });

  it("tools have required fields", () => {
    initCallsDefaults();
    for (const tool of listCallTools()) {
      expect(tool.id).toBeTruthy();
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(["native", "bash", "http", "context"]).toContain(tool.executor);
      expect(["read_only", "write_internal", "external_message", "external_call", "external_irreversible"]).toContain(
        tool.side_effect,
      );
      expect(tool.timeout_ms).toBeGreaterThan(0);
      expect(tool.enabled).toBe(true);
      expect(tool.input_schema_json).not.toBeNull();
    }
  });

  it("person.lookup is read_only", () => {
    initCallsDefaults();
    const tool = getCallTool("person.lookup");
    expect(tool).not.toBeNull();
    expect(tool!.side_effect).toBe("read_only");
  });

  it("call.end is write_internal", () => {
    initCallsDefaults();
    const tool = getCallTool("call.end");
    expect(tool).not.toBeNull();
    expect(tool!.side_effect).toBe("write_internal");
  });
});

describe("call tool CRUD", () => {
  it("create adds a new tool", () => {
    initCallsDefaults();
    const tool = createCallTool({
      id: "test.tool",
      name: "Test Tool",
      description: "A test tool",
      executor: "native",
      side_effect: "read_only",
    });
    expect(tool.id).toBe("test.tool");
    expect(tool.enabled).toBe(true);
  });

  it("update changes tool properties", () => {
    initCallsDefaults();
    const updated = updateCallTool("call.end", { timeout_ms: 3000 });
    expect(updated).not.toBeNull();
    expect(updated!.timeout_ms).toBe(3000);
  });

  it("configure enables/disables tool", () => {
    initCallsDefaults();
    const disabled = updateCallTool("call.end", { enabled: false });
    expect(disabled!.enabled).toBe(false);
    const enabled = updateCallTool("call.end", { enabled: true });
    expect(enabled!.enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tool binding tests
// ---------------------------------------------------------------------------

describe("tool bindings", () => {
  it("bind tool to voice agent", () => {
    initCallsDefaults();
    const binding = createCallToolBinding("call.end", "voice_agent", "ravi-followup", {
      provider_tool_name: "end_call",
    });
    expect(binding.tool_id).toBe("call.end");
    expect(binding.scope_type).toBe("voice_agent");
    expect(binding.scope_id).toBe("ravi-followup");
    expect(binding.provider_tool_name).toBe("end_call");
  });

  it("bind tool to profile", () => {
    initCallsDefaults();
    const binding = createCallToolBinding("person.lookup", "profile", "checkin");
    expect(binding.tool_id).toBe("person.lookup");
    expect(binding.scope_type).toBe("profile");
    expect(binding.scope_id).toBe("checkin");
  });

  it("list bindings by scope", () => {
    initCallsDefaults();
    createCallToolBinding("call.end", "voice_agent", "ravi-interviewer");
    createCallToolBinding("person.lookup", "voice_agent", "ravi-interviewer");
    const bindings = listCallToolBindings("voice_agent", "ravi-interviewer");
    expect(bindings.length).toBe(2);
  });

  it("unbind tool", () => {
    initCallsDefaults();
    createCallToolBinding("call.end", "voice_agent", "ravi-intake");
    const removed = deleteCallToolBinding("call.end", "voice_agent", "ravi-intake");
    expect(removed).toBe(true);
    const bindings = listCallToolBindings("voice_agent", "ravi-intake");
    expect(bindings.length).toBe(0);
  });

  it("unbind returns false for nonexistent binding", () => {
    initCallsDefaults();
    const removed = deleteCallToolBinding("nonexistent", "voice_agent", "ravi-followup");
    expect(removed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Policy and dry-run validation tests
// ---------------------------------------------------------------------------

describe("tool policy evaluation", () => {
  it("read_only tool is allowed by default", () => {
    initCallsDefaults();
    const result = evaluateCallToolPolicy("person.lookup", "read_only");
    expect(result.allowed).toBe(true);
  });

  it("call.end is allowed by explicit policy", () => {
    initCallsDefaults();
    const result = evaluateCallToolPolicy("call.end", "write_internal");
    expect(result.allowed).toBe(true);
  });

  it("external_message is blocked by default", () => {
    initCallsDefaults();
    const result = evaluateCallToolPolicy("some.tool", "external_message");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("blocked");
  });

  it("external_call is blocked by default", () => {
    initCallsDefaults();
    const result = evaluateCallToolPolicy("some.tool", "external_call");
    expect(result.allowed).toBe(false);
  });

  it("external_irreversible is blocked by default", () => {
    initCallsDefaults();
    const result = evaluateCallToolPolicy("some.tool", "external_irreversible");
    expect(result.allowed).toBe(false);
  });
});

describe("dry-run validation", () => {
  it("schema validation fails on missing required field", () => {
    initCallsDefaults();
    const tool = getCallTool("person.lookup");
    expect(tool).not.toBeNull();
    const schema = tool!.input_schema_json!;
    const requiredFields = (schema.required as string[]) ?? [];
    expect(requiredFields).toContain("person_id");

    // Simulate validation: input missing required field
    const input = { fields: ["name"] };
    const missing = requiredFields.filter((f: string) => !(f in input));
    expect(missing.length).toBeGreaterThan(0);
    expect(missing).toContain("person_id");
  });

  it("policy blocks create structured blocked result", () => {
    initCallsDefaults();

    const request = createCallRequest({
      profile_id: "checkin",
      target_person_id: "person_policy_test",
      reason: "Policy test",
    });

    const policyResult = evaluateCallToolPolicy("some.external.tool", "external_message");
    expect(policyResult.allowed).toBe(false);

    const toolRun = createCallToolRun({
      request_id: request.id,
      tool_id: "prox.followup.schedule",
      status: "blocked",
      message: policyResult.reason,
      input_json: { person_id: "test", reason: "test" },
    });

    expect(toolRun.status).toBe("blocked");
    expect(toolRun.message).toContain("blocked");
    expect(toolRun.request_id).toBe(request.id);
  });

  it("tool runs are listed for a request", () => {
    initCallsDefaults();

    const request = createCallRequest({
      profile_id: "checkin",
      target_person_id: "person_runs_test",
      reason: "Runs list test",
    });

    createCallToolRun({
      request_id: request.id,
      tool_id: "call.end",
      status: "completed",
      message: "Call ended",
      input_json: { reason: "done" },
      output_json: { ok: true, message: "Call ended" },
    });

    createCallToolRun({
      request_id: request.id,
      tool_id: "person.lookup",
      status: "completed",
      message: "Lookup complete",
      input_json: { person_id: "p1" },
    });

    const runs = listCallToolRuns(request.id);
    expect(runs.length).toBe(2);
    expect(runs[0].tool_id).toBe("call.end");
    expect(runs[1].tool_id).toBe("person.lookup");
  });
});

describe("safe command rendering for bash tools", () => {
  it("bash executor config has required safety fields", () => {
    initCallsDefaults();
    // All seeded tools are native, but the schema supports bash
    const tool = createCallTool({
      id: "test.bash.tool",
      name: "Test Bash Tool",
      description: "A safe bash tool",
      executor: "bash",
      side_effect: "read_only",
      executor_config_json: {
        cwd: "/tmp",
        command: "/usr/bin/echo",
        argv_template: ["{{message}}"],
        env_allowlist: [],
        timeout_ms: 5000,
        stdout_format: "text",
        stdout_limit: 4096,
        stderr_limit: 1024,
        redact_fields: [],
      },
    });

    expect(tool.executor).toBe("bash");
    const config = tool.executor_config_json as Record<string, unknown>;
    expect(config.cwd).toBe("/tmp");
    expect(config.command).toBe("/usr/bin/echo");
    expect(config.timeout_ms).toBe(5000);
    expect(config.stdout_limit).toBe(4096);
    expect(Array.isArray(config.argv_template)).toBe(true);
    expect(Array.isArray(config.env_allowlist)).toBe(true);
  });
});
