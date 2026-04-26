import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testDir = join(tmpdir(), `ravi-rules-test-${Date.now()}`);
mkdirSync(testDir, { recursive: true });
process.env.RAVI_STATE_DIR = testDir;

import { evaluateCallRules } from "./rules.js";
import {
  seedDefaultProfiles,
  seedDefaultRules,
  createCallRequest,
  createCallRun,
  updateCallRunStatus,
  resetCallsSchemaFlag,
} from "./calls-db.js";
import type { CallRules } from "./types.js";

afterAll(() => {
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {}
});

beforeEach(() => {
  resetCallsSchemaFlag();
});

function makeRules(overrides: Partial<CallRules> = {}): CallRules {
  return {
    id: "test-rules",
    scope_type: "global",
    scope_id: "*",
    quiet_hours_json: null,
    max_attempts: 3,
    cooldown_seconds: 3600,
    snooze_until: null,
    cancel_on_inbound_reply: true,
    require_approval: false,
    enabled: true,
    created_at: Date.now(),
    updated_at: Date.now(),
    ...overrides,
  };
}

describe("evaluateCallRules", () => {
  it("returns allow when no blocking conditions", () => {
    seedDefaultProfiles();
    const request = createCallRequest({ profile_id: "checkin", target_person_id: "test-p1", reason: "test" });
    const rules = makeRules();
    const result = evaluateCallRules(rules, request.id, "test-p1");
    expect(result.verdict).toBe("allow");
    expect(result.reason).toBe("All rules passed");
  });

  it("blocks during quiet hours (overnight wrap)", () => {
    seedDefaultProfiles();
    const request = createCallRequest({ profile_id: "checkin", target_person_id: "test-p2", reason: "test" });
    const rules = makeRules({
      quiet_hours_json: { start: "22:00", end: "08:00", timezone: "UTC" },
    });
    // 23:00 UTC should be in quiet hours
    const now = new Date("2025-06-15T23:00:00Z");
    const result = evaluateCallRules(rules, request.id, "test-p2", { now });
    expect(result.verdict).toBe("block_quiet_hours");
  });

  it("allows outside quiet hours", () => {
    seedDefaultProfiles();
    const request = createCallRequest({ profile_id: "checkin", target_person_id: "test-p3", reason: "test" });
    const rules = makeRules({
      quiet_hours_json: { start: "22:00", end: "08:00", timezone: "UTC" },
    });
    // 14:00 UTC is outside quiet hours
    const now = new Date("2025-06-15T14:00:00Z");
    const result = evaluateCallRules(rules, request.id, "test-p3", { now });
    expect(result.verdict).toBe("allow");
  });

  it("blocks when max attempts reached", () => {
    seedDefaultProfiles();
    const request = createCallRequest({ profile_id: "checkin", target_person_id: "test-p4", reason: "test" });
    const rules = makeRules({ max_attempts: 2 });

    // Create 2 runs to hit max
    createCallRun({ request_id: request.id, attempt_number: 1, provider: "stub" });
    createCallRun({ request_id: request.id, attempt_number: 2, provider: "stub" });

    const result = evaluateCallRules(rules, request.id, "test-p4");
    expect(result.verdict).toBe("block_max_attempts");
    expect(result.reason).toContain("Max attempts reached");
  });

  it("allows when under max attempts", () => {
    seedDefaultProfiles();
    const request = createCallRequest({ profile_id: "checkin", target_person_id: "test-p5", reason: "test" });
    const rules = makeRules({ max_attempts: 3 });

    createCallRun({ request_id: request.id, attempt_number: 1, provider: "stub" });

    const result = evaluateCallRules(rules, request.id, "test-p5");
    expect(result.verdict).toBe("allow");
  });

  it("blocks when cooldown active", () => {
    seedDefaultProfiles();
    const request1 = createCallRequest({ profile_id: "checkin", target_person_id: "test-p6", reason: "first call" });
    const run = createCallRun({ request_id: request1.id, attempt_number: 1, provider: "stub" });
    updateCallRunStatus(run.id, "completed");

    const request2 = createCallRequest({ profile_id: "checkin", target_person_id: "test-p6", reason: "second call" });
    const rules = makeRules({ cooldown_seconds: 3600 });

    // Immediately after — cooldown should block
    const result = evaluateCallRules(rules, request2.id, "test-p6");
    expect(result.verdict).toBe("block_cooldown");
  });

  it("allows when cooldown expired", () => {
    seedDefaultProfiles();
    const request = createCallRequest({ profile_id: "checkin", target_person_id: "test-p7-fresh", reason: "test" });
    const rules = makeRules({ cooldown_seconds: 1 }); // 1 second cooldown

    // No prior runs for this person — should pass
    const result = evaluateCallRules(rules, request.id, "test-p7-fresh");
    expect(result.verdict).toBe("allow");
  });

  it("blocks when snoozed", () => {
    seedDefaultProfiles();
    const request = createCallRequest({ profile_id: "checkin", target_person_id: "test-p8", reason: "test" });
    const futureTime = Date.now() + 3600 * 1000;
    const rules = makeRules({ snooze_until: futureTime });

    const result = evaluateCallRules(rules, request.id, "test-p8");
    expect(result.verdict).toBe("block_snoozed");
    expect(result.reason).toContain("Snoozed until");
  });

  it("allows when snooze has passed", () => {
    seedDefaultProfiles();
    const request = createCallRequest({ profile_id: "checkin", target_person_id: "test-p9", reason: "test" });
    const pastTime = Date.now() - 1000;
    const rules = makeRules({ snooze_until: pastTime });

    const result = evaluateCallRules(rules, request.id, "test-p9");
    expect(result.verdict).toBe("allow");
  });

  it("cancel_on_inbound_reply is persisted as policy field", () => {
    seedDefaultRules();
    seedDefaultProfiles();
    const rules = makeRules({ cancel_on_inbound_reply: true });
    expect(rules.cancel_on_inbound_reply).toBe(true);

    const rulesOff = makeRules({ cancel_on_inbound_reply: false });
    expect(rulesOff.cancel_on_inbound_reply).toBe(false);
  });
});
