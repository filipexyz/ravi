import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testDir = join(tmpdir(), `ravi-calls-test-${Date.now()}`);
mkdirSync(testDir, { recursive: true });
process.env.RAVI_STATE_DIR = testDir;

import {
  listCallProfiles,
  getCallProfile,
  seedDefaultProfiles,
  seedDefaultRules,
  getCallRules,
  getCallRulesById,
  createCallRequest,
  getCallRequest,
  listCallRequests,
  updateCallRequestStatus,
  updateCallRequestRulesId,
  createCallRun,
  getCallRun,
  listCallRuns,
  updateCallRunStatus,
  countCallRunsForRequest,
  createCallEvent,
  getCallEvent,
  listCallEvents,
  createCallResult,
  getCallResult,
  getCallResultForRequest,
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

describe("call_profiles", () => {
  it("seeds default profiles when table is empty", () => {
    seedDefaultProfiles();
    const profiles = listCallProfiles();
    expect(profiles.length).toBe(3);
    const ids = profiles.map((p) => p.id);
    expect(ids).toContain("checkin");
    expect(ids).toContain("followup");
    expect(ids).toContain("urgent-approval");
  });

  it("does not duplicate profiles on repeated seed", () => {
    seedDefaultProfiles();
    seedDefaultProfiles();
    const profiles = listCallProfiles();
    expect(profiles.length).toBe(3);
  });

  it("getCallProfile returns a profile by ID", () => {
    seedDefaultProfiles();
    const profile = getCallProfile("checkin");
    expect(profile).not.toBeNull();
    expect(profile!.name).toBe("Check-in");
    expect(profile!.provider).toBe("elevenlabs");
    expect(profile!.enabled).toBe(true);
  });

  it("getCallProfile returns null for missing ID", () => {
    const profile = getCallProfile("nonexistent");
    expect(profile).toBeNull();
  });
});

describe("call_rules", () => {
  it("seeds default global rules", () => {
    seedDefaultRules();
    const rules = getCallRules();
    expect(rules).not.toBeNull();
    expect(rules!.scope_type).toBe("global");
    expect(rules!.max_attempts).toBe(3);
    expect(rules!.cooldown_seconds).toBe(3600);
    expect(rules!.cancel_on_inbound_reply).toBe(true);
    expect(rules!.quiet_hours_json).not.toBeNull();
    expect(rules!.quiet_hours_json!.start).toBe("22:00");
    expect(rules!.quiet_hours_json!.end).toBe("08:00");
  });

  it("getCallRulesById retrieves by ID", () => {
    seedDefaultRules();
    const rules = getCallRulesById("rules-global-default");
    expect(rules).not.toBeNull();
    expect(rules!.id).toBe("rules-global-default");
  });

  it("getCallRules falls back to global when scoped rule not found", () => {
    seedDefaultRules();
    const rules = getCallRules("project", "some-project");
    expect(rules).not.toBeNull();
    expect(rules!.scope_type).toBe("global");
  });
});

describe("call_requests", () => {
  it("creates and retrieves a call request", () => {
    seedDefaultProfiles();
    const request = createCallRequest({
      profile_id: "checkin",
      target_person_id: "person_abc",
      reason: "No response in 2 days",
    });

    expect(request.id).toMatch(/^cr_/);
    expect(request.status).toBe("pending");
    expect(request.profile_id).toBe("checkin");
    expect(request.target_person_id).toBe("person_abc");
    expect(request.reason).toBe("No response in 2 days");
    expect(request.priority).toBe("normal");

    const fetched = getCallRequest(request.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(request.id);
  });

  it("lists requests ordered by updated_at", () => {
    seedDefaultProfiles();
    createCallRequest({ profile_id: "checkin", target_person_id: "p1", reason: "r1" });
    createCallRequest({ profile_id: "followup", target_person_id: "p2", reason: "r2" });
    const all = listCallRequests();
    expect(all.length).toBeGreaterThanOrEqual(2);
  });

  it("updates request status", () => {
    seedDefaultProfiles();
    const request = createCallRequest({ profile_id: "checkin", target_person_id: "p3", reason: "r3" });
    updateCallRequestStatus(request.id, "running");
    const updated = getCallRequest(request.id);
    expect(updated!.status).toBe("running");
  });

  it("updates request rules_id", () => {
    seedDefaultProfiles();
    seedDefaultRules();
    const request = createCallRequest({ profile_id: "checkin", target_person_id: "p4", reason: "r4" });
    updateCallRequestRulesId(request.id, "rules-global-default");
    const updated = getCallRequest(request.id);
    expect(updated!.rules_id).toBe("rules-global-default");
  });

  it("preserves origin lineage fields", () => {
    seedDefaultProfiles();
    const request = createCallRequest({
      profile_id: "checkin",
      target_person_id: "p5",
      reason: "test lineage",
      origin_session_name: "agent:main:dm:5511999999",
      origin_agent_name: "main",
      origin_channel: "whatsapp",
    });
    expect(request.origin_session_name).toBe("agent:main:dm:5511999999");
    expect(request.origin_agent_name).toBe("main");
    expect(request.origin_channel).toBe("whatsapp");
  });
});

describe("call_runs", () => {
  it("creates and retrieves a run", () => {
    seedDefaultProfiles();
    const request = createCallRequest({ profile_id: "checkin", target_person_id: "p6", reason: "r6" });
    const run = createCallRun({ request_id: request.id, attempt_number: 1, provider: "stub" });

    expect(run.id).toMatch(/^run_/);
    expect(run.request_id).toBe(request.id);
    expect(run.status).toBe("queued");
    expect(run.attempt_number).toBe(1);

    const fetched = getCallRun(run.id);
    expect(fetched).not.toBeNull();
  });

  it("lists runs for a request", () => {
    seedDefaultProfiles();
    const request = createCallRequest({ profile_id: "checkin", target_person_id: "p7", reason: "r7" });
    createCallRun({ request_id: request.id, attempt_number: 1, provider: "stub" });
    createCallRun({ request_id: request.id, attempt_number: 2, provider: "stub" });
    const runs = listCallRuns(request.id);
    expect(runs.length).toBe(2);
    expect(runs[0].attempt_number).toBe(1);
    expect(runs[1].attempt_number).toBe(2);
  });

  it("updateCallRunStatus sets terminal fields", () => {
    seedDefaultProfiles();
    const request = createCallRequest({ profile_id: "checkin", target_person_id: "p8", reason: "r8" });
    const run = createCallRun({ request_id: request.id, attempt_number: 1, provider: "stub" });

    updateCallRunStatus(run.id, "completed");
    const updated = getCallRun(run.id)!;
    expect(updated.status).toBe("completed");
    expect(updated.ended_at).not.toBeNull();
  });

  it("countCallRunsForRequest counts correctly", () => {
    seedDefaultProfiles();
    const request = createCallRequest({ profile_id: "checkin", target_person_id: "p9", reason: "r9" });
    expect(countCallRunsForRequest(request.id)).toBe(0);
    createCallRun({ request_id: request.id, attempt_number: 1, provider: "stub" });
    expect(countCallRunsForRequest(request.id)).toBe(1);
  });
});

describe("call_events", () => {
  it("creates and lists events", () => {
    seedDefaultProfiles();
    const request = createCallRequest({ profile_id: "checkin", target_person_id: "p10", reason: "r10" });

    const event = createCallEvent({
      request_id: request.id,
      event_type: "request.created",
      status: "pending",
      message: "Request created",
      source: "test",
    });

    expect(event.id).toBeGreaterThan(0);
    expect(event.request_id).toBe(request.id);
    expect(event.event_type).toBe("request.created");

    const events = listCallEvents(request.id);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.some((e) => e.id === event.id)).toBe(true);
  });

  it("preserves payload_json", () => {
    seedDefaultProfiles();
    const request = createCallRequest({ profile_id: "checkin", target_person_id: "p11", reason: "r11" });

    const event = createCallEvent({
      request_id: request.id,
      event_type: "rules.evaluated",
      status: "allow",
      payload_json: { verdict: "allow", rule_id: "test" },
      source: "test",
    });

    const fetched = getCallEvent(event.id)!;
    expect(fetched.payload_json).toEqual({ verdict: "allow", rule_id: "test" });
  });
});

describe("call_results", () => {
  it("creates and retrieves a result", () => {
    seedDefaultProfiles();
    const request = createCallRequest({ profile_id: "checkin", target_person_id: "p12", reason: "r12" });

    const result = createCallResult({
      request_id: request.id,
      outcome: "answered",
      summary: "Person confirmed availability",
      next_action: "none",
    });

    expect(result.id).toMatch(/^res_/);
    expect(result.outcome).toBe("answered");
    expect(result.summary).toBe("Person confirmed availability");

    const fetched = getCallResult(result.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(result.id);
  });

  it("getCallResultForRequest returns the latest result", () => {
    seedDefaultProfiles();
    const request = createCallRequest({ profile_id: "checkin", target_person_id: "p13", reason: "r13" });

    createCallResult({ request_id: request.id, outcome: "no_answer", summary: "first" });
    createCallResult({ request_id: request.id, outcome: "answered", summary: "second" });

    const latest = getCallResultForRequest(request.id);
    expect(latest).not.toBeNull();
    expect(latest!.summary).toBe("second");
  });

  it("persists terminal failures as durable results", () => {
    seedDefaultProfiles();
    const request = createCallRequest({ profile_id: "checkin", target_person_id: "p14", reason: "r14" });

    const result = createCallResult({
      request_id: request.id,
      outcome: "failed_provider",
      summary: "Twilio returned 503",
      next_action: "retry",
    });

    const fetched = getCallResult(result.id)!;
    expect(fetched.outcome).toBe("failed_provider");
    expect(fetched.summary).toBe("Twilio returned 503");
    expect(fetched.next_action).toBe("retry");
  });
});
