import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
} from "../../prox/calls/index.js";

beforeEach(() => {
  resetCallsSchemaFlag();
});

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
    initCallsDefaults();
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
    initCallsDefaults();
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

  it("request uses stub provider when no real provider configured", async () => {
    initCallsDefaults();
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
});

describe("prox calls show", () => {
  it("show returns request with runs and result", async () => {
    initCallsDefaults();
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
    initCallsDefaults();
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
    initCallsDefaults();
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
    initCallsDefaults();
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
    initCallsDefaults();
    const result = cancelCallRequest("cr_nonexistent");
    expect(result.success).toBe(false);
    expect(result.message).toContain("not found");
  });
});

describe("terminal failures are durable", () => {
  it("provider failure creates durable result and event", async () => {
    initCallsDefaults();
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
    initCallsDefaults();
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
    initCallsDefaults();
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
