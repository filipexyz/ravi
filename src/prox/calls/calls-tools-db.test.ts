import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testDir = join(tmpdir(), `ravi-calls-tools-test-${Date.now()}`);
mkdirSync(testDir, { recursive: true });
process.env.RAVI_STATE_DIR = testDir;

import {
  resetCallsSchemaFlag,
  seedDefaultProfiles,
  createCallRequest,
  createCallRun,
  getCallRequest,
  getCallRun,
  // Voice agents
  createCallVoiceAgent,
  getCallVoiceAgent,
  listCallVoiceAgents,
  updateCallVoiceAgent,
  // Tools
  createCallTool,
  getCallTool,
  listCallTools,
  updateCallTool,
  // Bindings
  createCallToolBinding,
  getCallToolBinding,
  listCallToolBindings,
  updateCallToolBinding,
  // Policies
  createCallToolPolicy,
  getCallToolPolicy,
  listCallToolPolicies,
  updateCallToolPolicy,
  // Tool runs
  createCallToolRun,
  getCallToolRun,
  listCallToolRuns,
  updateCallToolRunStatus,
  // Effective resolution
  resolveEffectiveTools,
} from "./calls-db.js";

afterAll(() => {
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {}
});

beforeEach(() => {
  resetCallsSchemaFlag();
});

// ---------------------------------------------------------------------------
// Schema migration
// ---------------------------------------------------------------------------

describe("schema migration", () => {
  it("creates new tables on init", () => {
    const { getDb } = require("../../router/router-db.js");
    resetCallsSchemaFlag();
    // Trigger schema init by calling any helper
    listCallVoiceAgents();
    const db = getDb();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{
      name: string;
    }>;
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain("call_voice_agents");
    expect(tableNames).toContain("call_tools");
    expect(tableNames).toContain("call_tool_bindings");
    expect(tableNames).toContain("call_tool_policies");
    expect(tableNames).toContain("call_tool_runs");
  });

  it("adds voice-agent snapshot columns to call_requests", () => {
    const { getDb } = require("../../router/router-db.js");
    resetCallsSchemaFlag();
    seedDefaultProfiles();
    const db = getDb();
    const cols = db.prepare("PRAGMA table_info(call_requests)").all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("voice_agent_id");
    expect(colNames).toContain("voice_agent_version");
    expect(colNames).toContain("voice_agent_snapshot_json");
  });

  it("adds voice-agent snapshot columns to call_runs", () => {
    const { getDb } = require("../../router/router-db.js");
    resetCallsSchemaFlag();
    seedDefaultProfiles();
    const db = getDb();
    const cols = db.prepare("PRAGMA table_info(call_runs)").all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("voice_agent_id");
    expect(colNames).toContain("voice_agent_version");
    expect(colNames).toContain("voice_agent_snapshot_json");
  });
});

// ---------------------------------------------------------------------------
// call_voice_agent CRUD
// ---------------------------------------------------------------------------

describe("call_voice_agents", () => {
  it("creates and retrieves a voice agent", () => {
    const agent = createCallVoiceAgent({
      id: "ravi-followup",
      name: "Ravi Follow-up",
      description: "Short follow-up calls",
      provider: "elevenlabs",
      language: "pt-BR",
      system_prompt: "You are a follow-up agent.",
    });

    expect(agent.id).toBe("ravi-followup");
    expect(agent.name).toBe("Ravi Follow-up");
    expect(agent.description).toBe("Short follow-up calls");
    expect(agent.provider).toBe("elevenlabs");
    expect(agent.version).toBe(1);
    expect(agent.enabled).toBe(true);
    expect(agent.language).toBe("pt-BR");

    const fetched = getCallVoiceAgent("ravi-followup");
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe("ravi-followup");
  });

  it("lists voice agents", () => {
    createCallVoiceAgent({ id: "va-a", name: "Agent A" });
    createCallVoiceAgent({ id: "va-b", name: "Agent B", enabled: false });

    const all = listCallVoiceAgents();
    expect(all.length).toBeGreaterThanOrEqual(2);

    const enabledOnly = listCallVoiceAgents({ enabledOnly: true });
    expect(enabledOnly.every((a) => a.enabled)).toBe(true);
  });

  it("updates a voice agent and bumps version on material changes", () => {
    createCallVoiceAgent({ id: "va-version", name: "Version Test" });
    const v1 = getCallVoiceAgent("va-version")!;
    expect(v1.version).toBe(1);

    updateCallVoiceAgent("va-version", { system_prompt: "Updated prompt" });
    const v2 = getCallVoiceAgent("va-version")!;
    expect(v2.version).toBe(2);
    expect(v2.system_prompt).toBe("Updated prompt");

    // Non-material change (name) should not bump version
    updateCallVoiceAgent("va-version", { name: "Renamed" });
    const v2b = getCallVoiceAgent("va-version")!;
    expect(v2b.version).toBe(2);
    expect(v2b.name).toBe("Renamed");
  });

  it("persists provider_config_json and default_tools_json", () => {
    createCallVoiceAgent({
      id: "va-json",
      name: "JSON Test",
      provider_config_json: { model: "gpt-4" },
      default_tools_json: ["call.end", "person.lookup"],
    });

    const fetched = getCallVoiceAgent("va-json")!;
    expect(fetched.provider_config_json).toEqual({ model: "gpt-4" });
    expect(fetched.default_tools_json).toEqual(["call.end", "person.lookup"]);
  });

  it("returns null for missing voice agent", () => {
    expect(getCallVoiceAgent("nonexistent")).toBeNull();
  });

  it("returns null when updating nonexistent voice agent", () => {
    expect(updateCallVoiceAgent("nonexistent", { name: "x" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// call_tool CRUD
// ---------------------------------------------------------------------------

describe("call_tools", () => {
  it("creates and retrieves a tool with dot notation id", () => {
    const tool = createCallTool({
      id: "call.end",
      name: "End Call",
      description: "Ends the active call",
      executor_type: "native",
      side_effect_class: "write_internal",
      timeout_ms: 5000,
    });

    expect(tool.id).toBe("call.end");
    expect(tool.name).toBe("End Call");
    expect(tool.executor_type).toBe("native");
    expect(tool.side_effect_class).toBe("write_internal");
    expect(tool.timeout_ms).toBe(5000);
    expect(tool.enabled).toBe(true);

    const fetched = getCallTool("call.end");
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe("call.end");
  });

  it("lists tools with enabledOnly filter", () => {
    createCallTool({ id: "test.enabled", name: "Enabled Tool" });
    createCallTool({ id: "test.disabled", name: "Disabled Tool", enabled: false });

    const all = listCallTools();
    expect(all.length).toBeGreaterThanOrEqual(2);

    const enabled = listCallTools({ enabledOnly: true });
    expect(enabled.every((t) => t.enabled)).toBe(true);
  });

  it("updates tool fields", () => {
    createCallTool({ id: "test.update", name: "Original" });
    const updated = updateCallTool("test.update", {
      name: "Updated",
      timeout_ms: 10000,
      side_effect_class: "external_message",
    });
    expect(updated).not.toBeNull();
    expect(updated!.name).toBe("Updated");
    expect(updated!.timeout_ms).toBe(10000);
    expect(updated!.side_effect_class).toBe("external_message");
  });

  it("persists input/output schemas", () => {
    createCallTool({
      id: "test.schema",
      name: "Schema Tool",
      input_schema_json: { type: "object", properties: { reason: { type: "string" } } },
      output_schema_json: { type: "object", properties: { ok: { type: "boolean" } } },
    });

    const fetched = getCallTool("test.schema")!;
    expect(fetched.input_schema_json).toEqual({
      type: "object",
      properties: { reason: { type: "string" } },
    });
    expect(fetched.output_schema_json).toEqual({
      type: "object",
      properties: { ok: { type: "boolean" } },
    });
  });
});

// ---------------------------------------------------------------------------
// call_tool_binding CRUD
// ---------------------------------------------------------------------------

describe("call_tool_bindings", () => {
  it("creates and retrieves a binding", () => {
    createCallTool({ id: "bind.tool1", name: "Tool 1" });
    const binding = createCallToolBinding({
      tool_id: "bind.tool1",
      scope_type: "voice_agent",
      scope_id: "ravi-followup",
      provider_tool_name: "end_call",
      tool_prompt: "Use this to end the call",
      required: true,
    });

    expect(binding.id).toMatch(/^bind_/);
    expect(binding.tool_id).toBe("bind.tool1");
    expect(binding.scope_type).toBe("voice_agent");
    expect(binding.scope_id).toBe("ravi-followup");
    expect(binding.provider_tool_name).toBe("end_call");
    expect(binding.tool_prompt).toBe("Use this to end the call");
    expect(binding.required).toBe(true);
    expect(binding.enabled).toBe(true);

    const fetched = getCallToolBinding(binding.id);
    expect(fetched).not.toBeNull();
  });

  it("lists bindings by scope", () => {
    createCallTool({ id: "bind.tool2", name: "Tool 2" });
    createCallToolBinding({
      tool_id: "bind.tool2",
      scope_type: "profile",
      scope_id: "followup",
    });
    createCallToolBinding({
      tool_id: "bind.tool2",
      scope_type: "voice_agent",
      scope_id: "va-x",
    });

    const profileBindings = listCallToolBindings({ scope_type: "profile", scope_id: "followup" });
    expect(profileBindings.length).toBeGreaterThanOrEqual(1);
    expect(profileBindings.every((b) => b.scope_type === "profile")).toBe(true);

    const vaBindings = listCallToolBindings({ scope_type: "voice_agent", scope_id: "va-x" });
    expect(vaBindings.length).toBeGreaterThanOrEqual(1);
  });

  it("defaults provider_tool_name to tool_id", () => {
    createCallTool({ id: "bind.default-name", name: "Default Name" });
    const binding = createCallToolBinding({
      tool_id: "bind.default-name",
      scope_type: "profile",
      scope_id: "test",
    });
    expect(binding.provider_tool_name).toBe("bind.default-name");
  });

  it("updates binding fields", () => {
    createCallTool({ id: "bind.upd", name: "Upd" });
    const binding = createCallToolBinding({
      tool_id: "bind.upd",
      scope_type: "profile",
      scope_id: "test-upd",
    });

    const updated = updateCallToolBinding(binding.id, {
      enabled: false,
      tool_prompt: "new prompt",
    });
    expect(updated).not.toBeNull();
    expect(updated!.enabled).toBe(false);
    expect(updated!.tool_prompt).toBe("new prompt");
  });
});

// ---------------------------------------------------------------------------
// call_tool_policy CRUD
// ---------------------------------------------------------------------------

describe("call_tool_policies", () => {
  it("creates and retrieves a policy", () => {
    const policy = createCallToolPolicy({
      tool_id: "call.end",
      voice_agent_id: "ravi-followup",
      allow: true,
      max_calls_per_run: 5,
    });

    expect(policy.id).toMatch(/^pol_/);
    expect(policy.tool_id).toBe("call.end");
    expect(policy.voice_agent_id).toBe("ravi-followup");
    expect(policy.allow).toBe(true);
    expect(policy.max_calls_per_run).toBe(5);
    expect(policy.enabled).toBe(true);

    const fetched = getCallToolPolicy(policy.id);
    expect(fetched).not.toBeNull();
  });

  it("creates a blocking policy by side_effect_class", () => {
    const policy = createCallToolPolicy({
      side_effect_class: "external_irreversible",
      allow: false,
    });
    expect(policy.allow).toBe(false);
    expect(policy.side_effect_class).toBe("external_irreversible");
  });

  it("lists policies by tool_id", () => {
    createCallToolPolicy({ tool_id: "test.pol.a" });
    createCallToolPolicy({ tool_id: "test.pol.b" });

    const results = listCallToolPolicies({ tool_id: "test.pol.a" });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.every((p) => p.tool_id === "test.pol.a")).toBe(true);
  });

  it("updates policy fields", () => {
    const policy = createCallToolPolicy({ tool_id: "test.pol.upd", allow: true });
    const updated = updateCallToolPolicy(policy.id, { allow: false, max_calls_per_run: 2 });
    expect(updated).not.toBeNull();
    expect(updated!.allow).toBe(false);
    expect(updated!.max_calls_per_run).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Effective tool resolution
// ---------------------------------------------------------------------------

describe("effective tool resolution", () => {
  it("resolves tools across voice-agent + profile bindings", () => {
    const _tool = createCallTool({ id: "eff.tool1", name: "Effective Tool 1" });
    createCallToolBinding({
      tool_id: "eff.tool1",
      scope_type: "voice_agent",
      scope_id: "eff-va",
    });
    createCallToolBinding({
      tool_id: "eff.tool1",
      scope_type: "profile",
      scope_id: "eff-profile",
    });

    const results = resolveEffectiveTools({
      voice_agent_id: "eff-va",
      profile_id: "eff-profile",
    });

    const match = results.find((r) => r.tool.id === "eff.tool1");
    expect(match).toBeDefined();
    expect(match!.blocked).toBe(false);
  });

  it("blocks tools with disabled binding", () => {
    createCallTool({ id: "eff.disabled-bind", name: "Disabled Bind Tool" });
    createCallToolBinding({
      tool_id: "eff.disabled-bind",
      scope_type: "voice_agent",
      scope_id: "eff-va2",
      enabled: false,
    });
    createCallToolBinding({
      tool_id: "eff.disabled-bind",
      scope_type: "profile",
      scope_id: "eff-profile2",
    });

    const results = resolveEffectiveTools({
      voice_agent_id: "eff-va2",
      profile_id: "eff-profile2",
    });

    const match = results.find((r) => r.tool.id === "eff.disabled-bind");
    expect(match).toBeDefined();
    expect(match!.blocked).toBe(true);
    expect(match!.block_reason).toContain("disabled");
  });

  it("blocks tools with disabled tool", () => {
    createCallTool({ id: "eff.disabled-tool", name: "Disabled Tool", enabled: false });
    createCallToolBinding({
      tool_id: "eff.disabled-tool",
      scope_type: "voice_agent",
      scope_id: "eff-va3",
    });
    createCallToolBinding({
      tool_id: "eff.disabled-tool",
      scope_type: "profile",
      scope_id: "eff-profile3",
    });

    const results = resolveEffectiveTools({
      voice_agent_id: "eff-va3",
      profile_id: "eff-profile3",
    });

    const match = results.find((r) => r.tool.id === "eff.disabled-tool");
    expect(match).toBeDefined();
    expect(match!.blocked).toBe(true);
    expect(match!.block_reason).toBe("tool disabled");
  });

  it("blocks tools by deny policy", () => {
    createCallTool({
      id: "eff.policy-block",
      name: "Policy Block",
      side_effect_class: "external_irreversible",
    });
    createCallToolBinding({
      tool_id: "eff.policy-block",
      scope_type: "voice_agent",
      scope_id: "eff-va4",
    });
    createCallToolBinding({
      tool_id: "eff.policy-block",
      scope_type: "profile",
      scope_id: "eff-profile4",
    });
    createCallToolPolicy({
      tool_id: "eff.policy-block",
      allow: false,
    });

    const results = resolveEffectiveTools({
      voice_agent_id: "eff-va4",
      profile_id: "eff-profile4",
    });

    const match = results.find((r) => r.tool.id === "eff.policy-block");
    expect(match).toBeDefined();
    expect(match!.blocked).toBe(true);
    expect(match!.block_reason).toContain("blocked by policy");
  });

  it("includes profile-only tools when no voice-agent binding exists", () => {
    createCallTool({ id: "eff.profile-only", name: "Profile Only" });
    createCallToolBinding({
      tool_id: "eff.profile-only",
      scope_type: "profile",
      scope_id: "eff-profile5",
    });

    const results = resolveEffectiveTools({
      voice_agent_id: "eff-va5",
      profile_id: "eff-profile5",
    });

    const match = results.find((r) => r.tool.id === "eff.profile-only");
    expect(match).toBeDefined();
    expect(match!.blocked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// call_tool_run audit
// ---------------------------------------------------------------------------

describe("call_tool_runs", () => {
  it("creates and retrieves a tool run", () => {
    seedDefaultProfiles();
    const request = createCallRequest({
      profile_id: "checkin",
      target_person_id: "ptr1",
      reason: "tool run test",
    });
    createCallTool({ id: "tr.tool1", name: "TR Tool 1" });

    const toolRun = createCallToolRun({
      request_id: request.id,
      tool_id: "tr.tool1",
      provider_tool_name: "end_call",
      input_json: { reason: "done" },
      source: "agora",
    });

    expect(toolRun.id).toMatch(/^tr_/);
    expect(toolRun.request_id).toBe(request.id);
    expect(toolRun.tool_id).toBe("tr.tool1");
    expect(toolRun.status).toBe("started");
    expect(toolRun.input_json).toEqual({ reason: "done" });
    expect(toolRun.source).toBe("agora");
    expect(toolRun.started_at).toBeGreaterThan(0);

    const fetched = getCallToolRun(toolRun.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(toolRun.id);
  });

  it("completes a tool run with result", () => {
    seedDefaultProfiles();
    const request = createCallRequest({
      profile_id: "checkin",
      target_person_id: "ptr2",
      reason: "complete test",
    });
    createCallTool({ id: "tr.tool2", name: "TR Tool 2" });

    const toolRun = createCallToolRun({
      request_id: request.id,
      tool_id: "tr.tool2",
      provider_tool_name: "person_lookup",
    });

    updateCallToolRunStatus(toolRun.id, "completed", {
      result_json: { ok: true, message: "Found" },
    });

    const updated = getCallToolRun(toolRun.id)!;
    expect(updated.status).toBe("completed");
    expect(updated.completed_at).not.toBeNull();
    expect(updated.result_json).toEqual({ ok: true, message: "Found" });
  });

  it("records failed tool run with error", () => {
    seedDefaultProfiles();
    const request = createCallRequest({
      profile_id: "checkin",
      target_person_id: "ptr3",
      reason: "fail test",
    });
    createCallTool({ id: "tr.tool3", name: "TR Tool 3" });

    const toolRun = createCallToolRun({
      request_id: request.id,
      tool_id: "tr.tool3",
      provider_tool_name: "bad_tool",
    });

    updateCallToolRunStatus(toolRun.id, "failed", {
      error_json: { code: "TIMEOUT", message: "Tool timed out" },
    });

    const updated = getCallToolRun(toolRun.id)!;
    expect(updated.status).toBe("failed");
    expect(updated.completed_at).not.toBeNull();
    expect(updated.error_json).toEqual({ code: "TIMEOUT", message: "Tool timed out" });
  });

  it("records blocked tool run", () => {
    seedDefaultProfiles();
    const request = createCallRequest({
      profile_id: "checkin",
      target_person_id: "ptr4",
      reason: "blocked test",
    });
    createCallTool({ id: "tr.tool4", name: "TR Tool 4" });

    const toolRun = createCallToolRun({
      request_id: request.id,
      tool_id: "tr.tool4",
      provider_tool_name: "blocked_tool",
    });

    updateCallToolRunStatus(toolRun.id, "blocked", {
      error_json: { reason: "policy denied" },
    });

    const updated = getCallToolRun(toolRun.id)!;
    expect(updated.status).toBe("blocked");
    expect(updated.completed_at).not.toBeNull();
  });

  it("lists tool runs by request and run lineage", () => {
    seedDefaultProfiles();
    const request = createCallRequest({
      profile_id: "checkin",
      target_person_id: "ptr5",
      reason: "lineage test",
    });
    const run = createCallRun({
      request_id: request.id,
      attempt_number: 1,
      provider: "stub",
    });
    createCallTool({ id: "tr.tool5", name: "TR Tool 5" });

    createCallToolRun({
      request_id: request.id,
      run_id: run.id,
      tool_id: "tr.tool5",
      provider_tool_name: "end_call",
    });
    createCallToolRun({
      request_id: request.id,
      run_id: run.id,
      tool_id: "tr.tool5",
      provider_tool_name: "person_lookup",
    });

    const byRequest = listCallToolRuns({ request_id: request.id });
    expect(byRequest.length).toBe(2);

    const byRun = listCallToolRuns({ run_id: run.id });
    expect(byRun.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Backward-compatible call request/run with voice-agent snapshot
// ---------------------------------------------------------------------------

describe("voice-agent snapshot on request/run", () => {
  it("creates call request without voice agent fields (backward compat)", () => {
    seedDefaultProfiles();
    const request = createCallRequest({
      profile_id: "checkin",
      target_person_id: "snap-p1",
      reason: "no snapshot",
    });

    expect(request.voice_agent_id).toBeNull();
    expect(request.voice_agent_version).toBeNull();
    expect(request.voice_agent_snapshot_json).toBeNull();
  });

  it("creates call request with voice-agent snapshot", () => {
    seedDefaultProfiles();
    const request = createCallRequest({
      profile_id: "checkin",
      target_person_id: "snap-p2",
      reason: "with snapshot",
      voice_agent_id: "ravi-followup",
      voice_agent_version: 3,
      voice_agent_snapshot_json: { name: "Ravi Follow-up", prompt: "test" },
    });

    expect(request.voice_agent_id).toBe("ravi-followup");
    expect(request.voice_agent_version).toBe(3);
    expect(request.voice_agent_snapshot_json).toEqual({ name: "Ravi Follow-up", prompt: "test" });

    const fetched = getCallRequest(request.id)!;
    expect(fetched.voice_agent_id).toBe("ravi-followup");
    expect(fetched.voice_agent_version).toBe(3);
    expect(fetched.voice_agent_snapshot_json).toEqual({ name: "Ravi Follow-up", prompt: "test" });
  });

  it("creates call run without voice agent fields (backward compat)", () => {
    seedDefaultProfiles();
    const request = createCallRequest({
      profile_id: "checkin",
      target_person_id: "snap-p3",
      reason: "run no snapshot",
    });
    const run = createCallRun({
      request_id: request.id,
      attempt_number: 1,
      provider: "stub",
    });

    expect(run.voice_agent_id).toBeNull();
    expect(run.voice_agent_version).toBeNull();
    expect(run.voice_agent_snapshot_json).toBeNull();
  });

  it("creates call run with voice-agent snapshot", () => {
    seedDefaultProfiles();
    const request = createCallRequest({
      profile_id: "checkin",
      target_person_id: "snap-p4",
      reason: "run with snapshot",
    });
    const run = createCallRun({
      request_id: request.id,
      attempt_number: 1,
      provider: "elevenlabs",
      voice_agent_id: "ravi-followup",
      voice_agent_version: 2,
      voice_agent_snapshot_json: { id: "ravi-followup", version: 2 },
    });

    expect(run.voice_agent_id).toBe("ravi-followup");
    expect(run.voice_agent_version).toBe(2);
    expect(run.voice_agent_snapshot_json).toEqual({ id: "ravi-followup", version: 2 });

    const fetched = getCallRun(run.id)!;
    expect(fetched.voice_agent_id).toBe("ravi-followup");
    expect(fetched.voice_agent_snapshot_json).toEqual({ id: "ravi-followup", version: 2 });
  });
});
