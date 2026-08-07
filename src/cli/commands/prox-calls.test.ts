import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContractError } from "../agent-contract.js";
import { redactCommandAccessInput } from "../command-access.js";
import { runWithContext } from "../context.js";
import { getCommandAccessMetadata } from "../decorators.js";
import { getDb } from "../../router/router-db.js";
import { attachTagSlugsToAsset } from "../../tags/helpers.js";
import {
  ProxCallsCommands,
  ProxCallsProfileCommands,
  ProxCallsToolCommands,
  ProxCallsVoiceAgentCommands,
} from "./prox-calls.js";

const testDir = join(tmpdir(), `ravi-prox-calls-cli-test-${Date.now()}`);
mkdirSync(testDir, { recursive: true });
process.env.RAVI_STATE_DIR = testDir;
const originalFetch = globalThis.fetch;

afterAll(() => {
  mock.restore();
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {}
});

afterEach(() => {
  globalThis.fetch = originalFetch;
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
  delete process.env.AGORA_APP_ID;
  delete process.env.AGORA_APP_CERTIFICATE;
  delete process.env.AGORA_CUSTOMER_ID;
  delete process.env.AGORA_CUSTOMER_SECRET;
  delete process.env.AGORA_SIP_DOMAIN;
  delete process.env.RAVI_AGORA_FROM_NUMBER;
});

function initCallsDefaultsForDialing(): void {
  initCallsDefaults();
  getDb()
    .prepare("UPDATE call_rules SET quiet_hours_json = NULL, cooldown_seconds = 0 WHERE id = 'rules-global-default'")
    .run();
}

function withoutLogs<T>(run: () => T): T {
  const originalLog = console.log;
  console.log = () => {};

  try {
    return run();
  } finally {
    console.log = originalLog;
  }
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

describe("prox calls CLI tag filters", () => {
  it("filters profile, voice-agent, and tool catalogs through canonical tags", () => {
    initCallsDefaults();
    attachTagSlugsToAsset({
      assetType: "call_profile",
      assetId: "checkin",
      tags: ["ops-profile"],
      source: "test",
    });
    attachTagSlugsToAsset({
      assetType: "call_voice_agent",
      assetId: "ravi-followup",
      tags: ["ops-voice"],
      source: "test",
    });
    attachTagSlugsToAsset({
      assetType: "call_tool",
      assetId: "call.end",
      tags: ["ops-tool"],
      source: "test",
    });

    const profiles = withoutLogs(() => new ProxCallsProfileCommands().list(true, "ops-profile"));
    const voiceAgents = withoutLogs(() => new ProxCallsVoiceAgentCommands().list(true, "ops-voice"));
    const tools = withoutLogs(() => new ProxCallsToolCommands().list(undefined, true, "ops-tool"));
    const unfilteredProfiles = withoutLogs(() => new ProxCallsProfileCommands().list(true));

    expect(profiles).toMatchObject({
      total: 1,
      filters: { tag: "ops-profile" },
      profiles: [expect.objectContaining({ id: "checkin" })],
    });
    expect(voiceAgents).toMatchObject({
      total: 1,
      filters: { tag: "ops-voice" },
      voice_agents: [expect.objectContaining({ id: "ravi-followup" })],
    });
    expect(tools).toMatchObject({
      total: 1,
      filters: { tag: "ops-tool" },
      tools: [expect.objectContaining({ id: "call.end" })],
    });
    expect(unfilteredProfiles).not.toHaveProperty("filters");
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
      expect(["native", "bash", "http", "context"]).toContain(tool.executor_type);
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

  it("call.end is external_call with explicit allow policy", () => {
    initCallsDefaults();
    const tool = getCallTool("call.end");
    expect(tool).not.toBeNull();
    expect(tool!.side_effect).toBe("external_call");
  });
});

describe("call tool CRUD", () => {
  it("create adds a new tool", () => {
    initCallsDefaults();
    const tool = createCallTool({
      id: "test.tool",
      name: "Test Tool",
      description: "A test tool",
      executor_type: "native",
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
    const result = evaluateCallToolPolicy("call.end", "external_call");
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
    expect(toolRun.error_message).toContain("blocked");
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

// ---------------------------------------------------------------------------
// Agent-first contract (Manual v2): write brake, not-found envelopes, --fields
// ---------------------------------------------------------------------------

/**
 * Contract helpers throw ContractError (instead of process.exit) only when a
 * tool context is present; runWithContext provides one without env mutation.
 */
async function expectContractError(
  run: () => Promise<unknown> | unknown,
  code: string,
  exitCode: number,
): Promise<InstanceType<typeof ContractError>> {
  let caught: unknown;
  await runWithContext({ sessionKey: "prox-test", sessionName: "prox-test", agentId: "prox-test" }, async () => {
    await withoutLogsAsync(async () => {
      try {
        await run();
      } catch (error) {
        caught = error;
      }
    });
  });
  expect(caught).toBeInstanceOf(ContractError);
  const contractError = caught as InstanceType<typeof ContractError>;
  expect(contractError.code).toBe(code);
  expect(contractError.exitCode).toBe(exitCode);
  return contractError;
}

async function withoutLogsAsync<T>(run: () => Promise<T> | T): Promise<T> {
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await run();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function installElevenLabsProfileFetch(): Array<{ method?: string; url: string }> {
  const calls: Array<{ method?: string; url: string }> = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    calls.push({ method: init?.method, url: String(input) });
    if (init?.method === "GET") {
      return new Response(
        JSON.stringify({
          conversation_config: {
            agent: {
              first_message: "old provider greeting",
              prompt: { prompt: "old provider prompt" },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return calls;
}

function configureCheckinProfile(options: {
  profileId?: string;
  provider?: string;
  agentId?: string;
  firstMessage: string;
  dynamicPlaceholder?: string | string[];
  skipProviderSync?: boolean;
  execute?: boolean;
}) {
  return new ProxCallsProfileCommands().configure(
    options.profileId ?? "checkin",
    options.provider,
    options.agentId,
    undefined,
    undefined,
    undefined,
    options.firstMessage,
    undefined,
    options.dynamicPlaceholder,
    options.skipProviderSync,
    undefined,
    true,
    options.execute,
  );
}

async function withFreshCallsState<T>(name: string, run: () => Promise<T>): Promise<T> {
  const previousStateDir = process.env.RAVI_STATE_DIR;
  const freshStateDir = join(testDir, name);
  mkdirSync(freshStateDir, { recursive: true });
  process.env.RAVI_STATE_DIR = freshStateDir;
  resetCallsSchemaFlag();

  try {
    return await run();
  } finally {
    process.env.RAVI_STATE_DIR = previousStateDir;
    resetCallsSchemaFlag();
  }
}

describe("prox calls agent-first contract", () => {
  it("redacts sensitive request and profile configuration inputs from audit metadata", () => {
    const requestAccess = getCommandAccessMetadata(ProxCallsCommands).get("request");
    const configureAccess = getCommandAccessMetadata(ProxCallsProfileCommands).get("configure");

    expect(
      redactCommandAccessInput(requestAccess, {
        profileId: "checkin",
        phone: "PHONE_AUDIT_SENTINEL",
        reason: "REASON_AUDIT_SENTINEL",
        var: ["account=DYNAMIC_AUDIT_SENTINEL"],
      }),
    ).toEqual({
      profileId: "checkin",
      phone: "[REDACTED]",
      reason: "[REDACTED]",
      var: "[REDACTED]",
    });
    expect(
      redactCommandAccessInput(configureAccess, {
        profileId: "checkin",
        prompt: "PROMPT_AUDIT_SENTINEL",
        firstMessage: "FIRST_MESSAGE_AUDIT_SENTINEL",
        systemPromptPath: "SYSTEM_PROMPT_PATH_AUDIT_SENTINEL",
        dynamicPlaceholder: ["account=DYNAMIC_PLACEHOLDER_AUDIT_SENTINEL"],
      }),
    ).toEqual({
      profileId: "checkin",
      prompt: "[REDACTED]",
      firstMessage: "[REDACTED]",
      systemPromptPath: "[REDACTED]",
      dynamicPlaceholder: "[REDACTED]",
    });
  });

  it("request dry-run exposes only safe indicators and persists no call request", async () => {
    const phoneSentinel = "+5511987654321";
    const reasonSentinel = "REASON_PLAN_SENTINEL";
    const dynamicValueSentinels = ["DYNAMIC_VALUE_Z_SENTINEL", "DYNAMIC_VALUE_A_SENTINEL"];

    const error = await expectContractError(
      () =>
        new ProxCallsCommands().request(
          "checkin",
          "person_brake_1",
          reasonSentinel,
          phoneSentinel,
          "normal",
          [`zeta=${dynamicValueSentinels[0]}`, `alpha=${dynamicValueSentinels[1]}`],
          undefined,
          undefined,
          true,
          undefined,
        ),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );

    expect(error.details.dryRun).toBe(true);
    expect(error.details.plan).toEqual({
      profileId: "checkin",
      profileProvider: "elevenlabs",
      personId: "person_brake_1",
      phoneProvided: true,
      reasonProvided: true,
      priority: "normal",
      dynamicVariableCount: 2,
      skipOriginNotify: false,
      force: false,
      profileResolution: "built-in-default",
      providerMode: "stub",
    });
    const serializedPlan = JSON.stringify(error.details.plan);
    expect(serializedPlan).not.toContain(phoneSentinel);
    expect(serializedPlan).not.toContain(reasonSentinel);
    for (const sentinel of dynamicValueSentinels) expect(serializedPlan).not.toContain(sentinel);
    expect(serializedPlan).not.toContain("alpha");
    expect(serializedPlan).not.toContain("zeta");
    const row = getDb()
      .prepare("SELECT COUNT(*) AS c FROM call_requests WHERE target_person_id = ?")
      .get("person_brake_1") as { c: number };
    expect(row.c).toBe(0);
  });

  it("request dry-run does not initialize call schema or seed defaults", async () => {
    await withFreshCallsState("virgin-request-dry-run", async () => {
      const error = await expectContractError(
        () =>
          new ProxCallsCommands().request(
            "checkin",
            "person_virgin_dry_run",
            "SENTINEL_CALL_REASON_DO_NOT_LEAK",
            "+5511999999999",
            undefined,
            ["token=SENTINEL_CALL_VARIABLE_DO_NOT_LEAK"],
            undefined,
            undefined,
            true,
            undefined,
          ),
        "WRITE_REQUIRES_EXECUTE",
        3,
      );

      expect(JSON.stringify(error.details.plan)).not.toContain("SENTINEL_CALL_REASON_DO_NOT_LEAK");
      expect(JSON.stringify(error.details.plan)).not.toContain("SENTINEL_CALL_VARIABLE_DO_NOT_LEAK");
      const tables = getDb()
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table'
             AND name IN ('call_profiles', 'call_rules', 'call_voice_agents', 'call_tools', 'call_requests')`,
        )
        .all() as Array<{ name: string }>;
      expect(tables).toEqual([]);
    });
  });

  it("request resolves an unknown profile before the brake without initializing call state", async () => {
    await withFreshCallsState("virgin-request-unknown-profile", async () => {
      const error = await expectContractError(
        () =>
          new ProxCallsCommands().request(
            "missing-profile",
            "person_virgin_dry_run",
            "reason",
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            true,
            undefined,
          ),
        "CALL_PROFILE_NOT_FOUND",
        1,
      );

      expect(error.details.suggestions).toEqual(expect.arrayContaining(["checkin", "followup", "urgent-approval"]));
      const tables = getDb()
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'call_profiles'")
        .all();
      expect(tables).toEqual([]);
    });
  });

  it("request rejects a disabled profile before returning a confirmation plan", async () => {
    initCallsDefaultsForDialing();
    updateCallProfile("checkin", { enabled: false });

    const error = await expectContractError(
      () =>
        new ProxCallsCommands().request(
          "checkin",
          "person_disabled_profile",
          "reason",
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          true,
          undefined,
        ),
      "CALL_PROFILE_DISABLED",
      1,
    );

    expect(error.details.suggestedAction).toContain("Enable 'checkin'");
  });

  it("request rejects an invalid dynamic variable without echoing its value", async () => {
    const secret = "SENTINEL_DYNAMIC_VARIABLE_DO_NOT_LEAK";
    let caught: unknown;
    await runWithContext({ sessionKey: "prox-test", sessionName: "prox-test", agentId: "prox-test" }, async () => {
      try {
        await new ProxCallsCommands().request(
          "checkin",
          "person_invalid_var",
          "reason",
          undefined,
          undefined,
          [secret],
          undefined,
          undefined,
          true,
          undefined,
        );
      } catch (error) {
        caught = error;
      }
    });

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("Invalid dynamic variable format");
    expect((caught as Error).message).not.toContain(secret);
  });

  it("request with --execute submits the call request (stub provider)", async () => {
    initCallsDefaultsForDialing();
    updateCallProfile("checkin", { provider: "stub" });

    const payload = await runWithContext(
      { sessionKey: "prox-test", sessionName: "prox-test", agentId: "prox-test" },
      () =>
        withoutLogsAsync(() =>
          new ProxCallsCommands().request(
            "checkin",
            "person_brake_2",
            "Teste com execute",
            "+5511999999999",
            undefined,
            undefined,
            undefined,
            undefined,
            true,
            true,
          ),
        ),
    );

    expect(payload.request.target_person_id).toBe("person_brake_2");
    expect(getCallRequest(payload.request.id as string)).not.toBeNull();
  });

  it("profiles configure dry-run blocks before local persistence and provider I/O", async () => {
    initCallsDefaults();
    updateCallProfile("checkin", {
      provider: "elevenlabs",
      provider_agent_id: "agent_contract_dry_run",
      first_message: "local greeting before dry-run",
    });
    getDb().prepare("DELETE FROM call_rules WHERE id = 'rules-global-default'").run();
    const rulesBefore = getDb().prepare("SELECT COUNT(*) AS c FROM call_rules").get() as { c: number };
    expect(rulesBefore.c).toBe(0);
    process.env.ELEVENLABS_API_KEY = "test-key";
    const providerCalls = installElevenLabsProfileFetch();
    const dynamicKeySentinel = "SENTINEL_PRIVATE_DYNAMIC_KEY";

    let caught: unknown;
    try {
      await withoutLogsAsync(() =>
        configureCheckinProfile({
          firstMessage: "must not be persisted without execute",
          dynamicPlaceholder: `${dynamicKeySentinel}=value`,
        }),
      );
    } catch (error) {
      caught = error;
    }

    expect(providerCalls).toHaveLength(0);
    const rulesAfter = getDb().prepare("SELECT COUNT(*) AS c FROM call_rules").get() as { c: number };
    expect(rulesAfter.c).toBe(0);
    expect(getCallProfile("checkin")?.first_message).toBe("local greeting before dry-run");
    expect(caught).toBeInstanceOf(ContractError);
    const contractError = caught as InstanceType<typeof ContractError>;
    expect(contractError.code).toBe("WRITE_REQUIRES_EXECUTE");
    expect(contractError.exitCode).toBe(3);
    expect(contractError.details.plan).toMatchObject({
      profileId: "checkin",
      provider: "elevenlabs",
      providerAgentConfigured: true,
      firstMessageChanged: true,
      dynamicVariableCount: 1,
    });
    expect(JSON.stringify(contractError.details.plan)).not.toContain(dynamicKeySentinel);
  });

  it("profiles configure dry-run recognizes a default profile without seeding virgin state", async () => {
    await withFreshCallsState("virgin-profile-dry-run", async () => {
      process.env.ELEVENLABS_API_KEY = "test-key";
      const providerCalls = installElevenLabsProfileFetch();

      const error = await expectContractError(
        () =>
          configureCheckinProfile({
            profileId: "followup",
            provider: "elevenlabs",
            agentId: "agent_virgin_dry_run",
            firstMessage: "virgin dry-run greeting",
          }),
        "WRITE_REQUIRES_EXECUTE",
        3,
      );

      expect(error.details.plan).toMatchObject({ profileId: "followup", provider: "elevenlabs" });
      expect(providerCalls).toHaveLength(0);
      for (const table of ["call_profiles", "call_rules", "call_voice_agents", "call_tools"]) {
        const row = getDb().prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number };
        expect(row.c).toBe(0);
      }
    });
  });

  it("profiles configure keeps a default profile's local-only first use unbraked", async () => {
    await withFreshCallsState("virgin-profile-local", async () => {
      const providerCalls = installElevenLabsProfileFetch();

      const payload = await withoutLogsAsync(() =>
        configureCheckinProfile({
          profileId: "followup",
          provider: "stub",
          firstMessage: "virgin local greeting",
        }),
      );

      expect(providerCalls).toHaveLength(0);
      expect(getCallProfile("followup")).toMatchObject({
        provider: "stub",
        first_message: "virgin local greeting",
      });
      expect(payload.provider_sync).toBeNull();
    });
  });

  it("profiles configure --execute seeds and synchronizes a default profile in virgin state", async () => {
    await withFreshCallsState("virgin-profile-execute", async () => {
      process.env.ELEVENLABS_API_KEY = "test-key";
      const providerCalls = installElevenLabsProfileFetch();

      const payload = await withoutLogsAsync(() =>
        configureCheckinProfile({
          profileId: "followup",
          provider: "elevenlabs",
          agentId: "agent_virgin_execute",
          firstMessage: "virgin executed greeting",
          execute: true,
        }),
      );

      expect(providerCalls.map((call) => call.method)).toEqual(["GET", "PATCH"]);
      expect(getCallProfile("followup")).toMatchObject({
        provider: "elevenlabs",
        provider_agent_id: "agent_virgin_execute",
        first_message: "virgin executed greeting",
      });
      expect(payload.provider_sync).toMatchObject({ agentId: "agent_virgin_execute", firstMessageSynced: true });
    });
  });

  it("profiles configure rejects an unknown profile before a dry-run in virgin state", async () => {
    await withFreshCallsState("virgin-profile-unknown", async () => {
      const error = await expectContractError(
        () =>
          configureCheckinProfile({
            profileId: "unknown-profile",
            provider: "elevenlabs",
            agentId: "agent_unknown",
            firstMessage: "must not reach a dry-run",
          }),
        "CALL_PROFILE_NOT_FOUND",
        1,
      );

      expect(error.details.suggestions).toEqual([]);
      const profiles = getDb().prepare("SELECT COUNT(*) AS c FROM call_profiles").get() as { c: number };
      expect(profiles.c).toBe(0);
    });
  });

  it("profiles configure with --execute persists and synchronizes the external provider", async () => {
    initCallsDefaults();
    updateCallProfile("checkin", {
      provider: "elevenlabs",
      provider_agent_id: "agent_contract_execute",
      first_message: "local greeting before execute",
    });
    process.env.ELEVENLABS_API_KEY = "test-key";
    const providerCalls = installElevenLabsProfileFetch();

    const payload = await withoutLogsAsync(() =>
      configureCheckinProfile({ firstMessage: "persisted with execute", execute: true }),
    );

    expect(providerCalls.map((call) => call.method)).toEqual(["GET", "PATCH"]);
    expect(getCallProfile("checkin")?.first_message).toBe("persisted with execute");
    expect(payload.provider_sync).toMatchObject({
      agentId: "agent_contract_execute",
      firstMessageSynced: true,
    });
  });

  it("profiles configure --skip-provider-sync remains an unbraked local write", async () => {
    initCallsDefaults();
    updateCallProfile("checkin", {
      provider: "elevenlabs",
      provider_agent_id: "agent_contract_skip",
      first_message: "local greeting before skip",
    });
    process.env.ELEVENLABS_API_KEY = "test-key";
    const providerCalls = installElevenLabsProfileFetch();

    const payload = await withoutLogsAsync(() =>
      configureCheckinProfile({ firstMessage: "persisted without provider sync", skipProviderSync: true }),
    );

    expect(providerCalls).toHaveLength(0);
    expect(getCallProfile("checkin")?.first_message).toBe("persisted without provider sync");
    expect(payload.provider_sync).toBeNull();
  });

  it("request on an unknown profile exits 1 with CALL_PROFILE_NOT_FOUND before the brake", async () => {
    initCallsDefaultsForDialing();
    const error = await expectContractError(
      () =>
        new ProxCallsCommands().request(
          "checkin-typo",
          "person_brake_3",
          "Perfil errado",
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          true,
          undefined,
        ),
      "CALL_PROFILE_NOT_FOUND",
      1,
    );
    expect(error.details.suggestions).toContain("checkin");
  });

  it("show and events on an unknown request exit 1 with CALL_REQUEST_NOT_FOUND", async () => {
    initCallsDefaults();
    const showError = await expectContractError(
      () => new ProxCallsCommands().show("cr_nope", true),
      "CALL_REQUEST_NOT_FOUND",
      1,
    );
    expect(showError.details.suggestedAction).toContain("ravi prox calls request");
    await expectContractError(() => new ProxCallsCommands().events("cr_nope", true), "CALL_REQUEST_NOT_FOUND", 1);
  });

  it("profiles/voice-agents/tools show unknown ids return typed envelopes with local suggestions", async () => {
    initCallsDefaults();
    const profileError = await expectContractError(
      () => new ProxCallsProfileCommands().show("checkinn", true),
      "CALL_PROFILE_NOT_FOUND",
      1,
    );
    expect(profileError.details.suggestions).toContain("checkin");

    const agentError = await expectContractError(
      () => new ProxCallsVoiceAgentCommands().show("ravi-follow", true),
      "VOICE_AGENT_NOT_FOUND",
      1,
    );
    expect(agentError.details.suggestions).toContain("ravi-followup");

    const toolError = await expectContractError(
      () => new ProxCallsToolCommands().show("call.endd", true),
      "CALL_TOOL_NOT_FOUND",
      1,
    );
    expect(toolError.details.suggestions).toContain("call.end");
  });

  it("cancel is declared UNBRAKED (damage stop): it cancels without --execute", async () => {
    initCallsDefaultsForDialing();
    const request = createCallRequest({
      profile_id: "checkin",
      target_person_id: "person_cancel_unbraked",
      reason: "Cancel contract test",
    });

    const payload = withoutLogs(() => new ProxCallsCommands().cancel(request.id, "parada de dano", true));

    expect(payload.success).toBe(true);
    expect(getCallRequest(request.id)!.status).toBe("canceled");
  });

  it("profiles list --fields narrows items and the profiles alias equally", () => {
    initCallsDefaults();
    const payload = withoutLogs(() =>
      new ProxCallsProfileCommands().list(true, undefined, undefined, undefined, "id,name"),
    );

    expect(payload.items.length).toBeGreaterThan(0);
    for (const item of payload.items as Array<Record<string, unknown>>) {
      expect(Object.keys(item).sort()).toEqual(["id", "name"]);
    }
    expect(payload.profiles).toEqual(payload.items);
  });

  it("tools run --dry-run stays the documented write-brake equivalent (exit 0, no side effects)", () => {
    initCallsDefaults();
    const payload = withoutLogs(() =>
      new ProxCallsToolCommands().run("person.lookup", '{"person_id":"p1"}', undefined, true, true),
    );

    expect(payload).toMatchObject({ ok: true, dry_run: true, tool_id: "person.lookup" });
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
      executor_type: "bash",
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

    expect(tool.executor_type).toBe("bash");
    const config = tool.executor_config_json as Record<string, unknown>;
    expect(config.cwd).toBe("/tmp");
    expect(config.command).toBe("/usr/bin/echo");
    expect(config.timeout_ms).toBe(5000);
    expect(config.stdout_limit).toBe(4096);
    expect(Array.isArray(config.argv_template)).toBe(true);
    expect(Array.isArray(config.env_allowlist)).toBe(true);
  });
});
