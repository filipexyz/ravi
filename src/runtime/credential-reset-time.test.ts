import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { readClaudeRateLimitRejection } from "./claude-provider.js";
import { classifyRuntimeCredentialFailure } from "./credential-classifier.js";
import { selectRuntimeCredential } from "./credential-pool.js";
import { refreshRuntimeCredentialPool } from "./credential-refresh.js";
import { normalizeProviderResetEpochMs, parseProviderResetTextEpochMs } from "./credential-reset-time.js";
import {
  createRuntimeCredential,
  getRuntimeCredential,
  getRuntimeCredentialHealth,
  recordRuntimeCredentialFailure,
} from "./credential-store.js";
import type { RuntimeCredentialInput } from "./credential-types.js";

// 27/11/2026 11:25:46 in America/Sao_Paulo (UTC-03, no DST) = 14:25:46Z.
const INCIDENT_AT = Date.parse("2026-11-27T14:25:46.904Z");
const SAO_PAULO_14H = Date.parse("2026-11-27T17:00:00.000Z");
const SAO_PAULO_NOV30_6H = Date.parse("2026-11-30T09:00:00.000Z");
const WEEKLY_NOTICE =
  "Claude provider error (rate_limit): You've hit your weekly limit · resets 2pm (America/Sao_Paulo)";
const HOUR = 60 * 60_000;

describe("provider reset time parsing", () => {
  it("reads 'resets 2pm (America/Sao_Paulo)' at 11:25 as 14:00 the same day, not +24 h", () => {
    expect(parseProviderResetTextEpochMs(WEEKLY_NOTICE, INCIDENT_AT, "UTC")).toBe(SAO_PAULO_14H);
  });

  it("reads 'resets Nov 30 at 6am (America/Sao_Paulo)' as 30/11 06:00 -03", () => {
    const message = "You've hit your weekly limit · resets Nov 30 at 6am (America/Sao_Paulo)";
    expect(parseProviderResetTextEpochMs(message, INCIDENT_AT, "UTC")).toBe(SAO_PAULO_NOV30_6H);
  });

  it("rolls a reset hour that already passed to the next day", () => {
    const message = "You've hit your session limit · resets 10am (America/Sao_Paulo)";
    expect(parseProviderResetTextEpochMs(message, INCIDENT_AT, "UTC")).toBe(Date.parse("2026-11-28T13:00:00.000Z"));
  });

  it("keeps a reset hour that passed a moment ago instead of jumping a day", () => {
    const justAfter = SAO_PAULO_14H + 2 * 60_000;
    expect(parseProviderResetTextEpochMs(WEEKLY_NOTICE, justAfter, "UTC")).toBe(SAO_PAULO_14H);
  });

  it("uses the host zone when the notice names none, and minutes when given", () => {
    const message = "Usage limit reached · resets 2:30pm";
    expect(parseProviderResetTextEpochMs(message, INCIDENT_AT, "America/Sao_Paulo")).toBe(SAO_PAULO_14H + 30 * 60_000);
    expect(parseProviderResetTextEpochMs(message, INCIDENT_AT, "UTC")).toBe(Date.parse("2026-11-27T14:30:00.000Z"));
  });

  it("refuses text without a clock time, an unknown zone or an absurd horizon", () => {
    expect(parseProviderResetTextEpochMs("limit resets 3 days from now", INCIDENT_AT, "UTC")).toBeUndefined();
    expect(parseProviderResetTextEpochMs("resets 2pm (Mars/Olympus_Mons)", INCIDENT_AT, "UTC")).toBeUndefined();
    expect(parseProviderResetTextEpochMs("resets 13pm (UTC)", INCIDENT_AT, "UTC")).toBeUndefined();
    expect(parseProviderResetTextEpochMs("You've hit your weekly limit", INCIDENT_AT, "UTC")).toBeUndefined();
    expect(parseProviderResetTextEpochMs(undefined, INCIDENT_AT, "UTC")).toBeUndefined();
  });

  it("normalizes resetsAt given in epoch seconds and in epoch milliseconds", () => {
    expect(normalizeProviderResetEpochMs(SAO_PAULO_14H / 1000)).toBe(SAO_PAULO_14H);
    expect(normalizeProviderResetEpochMs(SAO_PAULO_14H)).toBe(SAO_PAULO_14H);
    expect(normalizeProviderResetEpochMs(String(SAO_PAULO_14H / 1000))).toBe(SAO_PAULO_14H);
    expect(normalizeProviderResetEpochMs(3600)).toBeUndefined();
    expect(normalizeProviderResetEpochMs(Number.NaN)).toBeUndefined();
    expect(normalizeProviderResetEpochMs(undefined)).toBeUndefined();
  });
});

describe("Claude rate_limit_event", () => {
  it("carries a rejected limit with its reset in ms, from seconds or ms", () => {
    expect(
      readClaudeRateLimitRejection({ status: "rejected", resetsAt: SAO_PAULO_14H / 1000, rateLimitType: "seven_day" }),
    ).toEqual({ resetAt: SAO_PAULO_14H, limitType: "seven_day" });
    expect(readClaudeRateLimitRejection({ status: "rejected", resetsAt: SAO_PAULO_14H })).toEqual({
      resetAt: SAO_PAULO_14H,
    });
  });

  it("ignores allowed and warning events", () => {
    expect(readClaudeRateLimitRejection({ status: "allowed", resetsAt: SAO_PAULO_14H / 1000 })).toBeNull();
    expect(readClaudeRateLimitRejection({ status: "allowed_warning", resetsAt: SAO_PAULO_14H / 1000 })).toBeNull();
    expect(readClaudeRateLimitRejection(undefined)).toBeNull();
  });
});

describe("classifier reset evidence", () => {
  const classify = (input: Partial<Parameters<typeof classifyRuntimeCredentialFailure>[0]>) =>
    classifyRuntimeCredentialFailure({
      runtimeProvider: "claude",
      upstreamProvider: "anthropic",
      providerCode: "rate_limit",
      message: WEEKLY_NOTICE,
      now: INCIDENT_AT,
      source: "sdk-error",
      ...input,
    });

  it("takes the reset from the notice text when no event arrived", () => {
    const signal = classify({});
    expect(signal.kind).toBe("quota_exhausted");
    // Host zone does not matter: the notice names its zone.
    expect(signal.resetAt).toBe(SAO_PAULO_14H);
  });

  it("prefers the structured event reset over the notice text, in seconds or ms", () => {
    const eventReset = SAO_PAULO_NOV30_6H;
    expect(classify({ resetAt: eventReset / 1000, limitType: "seven_day_opus" })).toMatchObject({
      resetAt: eventReset,
      limitDimensions: [{ name: "seven_day_opus", remaining: 0, resetAt: eventReset }],
    });
    expect(classify({ resetAt: eventReset }).resetAt).toBe(eventReset);
  });

  it("does not read a reset from the text of a failure that is not a limit", () => {
    const signal = classifyRuntimeCredentialFailure({
      runtimeProvider: "claude",
      httpStatus: 400,
      message: "invalid request: the job resets 2pm (America/Sao_Paulo)",
      now: INCIDENT_AT,
      resetAt: SAO_PAULO_14H,
    });
    expect(signal.kind).toBe("invalid_request");
    expect(signal.resetAt).toBeUndefined();
  });
});

function claudeCredential(id: string): RuntimeCredentialInput {
  return {
    id,
    label: id,
    runtimeProvider: "claude",
    upstreamProvider: "anthropic",
    authMethod: "oauth",
    priority: 10,
    bindings: [
      {
        sourceKind: "env",
        targetKind: "env",
        targetName: "CLAUDE_CODE_OAUTH_TOKEN",
        secretRef: "env:RAVI_TEST_CLAUDE_TOKEN",
        sourceHint: "RAVI_TEST_CLAUDE_TOKEN",
        sensitive: true,
        remoteForward: false,
      },
    ],
  };
}

describe("exhausted Claude credential recovers at the real reset", () => {
  let stateDir: string | null = null;

  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-claude-credential-reset-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("stays out of the pool until 14:00 and comes back by itself at 14:00", async () => {
    createRuntimeCredential(claudeCredential("rcred_claude"));
    const signal = classifyRuntimeCredentialFailure({
      runtimeProvider: "claude",
      upstreamProvider: "anthropic",
      credentialId: "rcred_claude",
      providerCode: "rate_limit",
      message: WEEKLY_NOTICE,
      now: INCIDENT_AT,
      source: "sdk-error",
    });
    recordRuntimeCredentialFailure("rcred_claude", signal, INCIDENT_AT);

    expect(getRuntimeCredential("rcred_claude")?.status).toBe("exhausted");
    expect(getRuntimeCredentialHealth("rcred_claude")?.cooldownUntil).toBe(SAO_PAULO_14H);

    const request = { runtimeProvider: "claude" as const, upstreamProvider: "anthropic" };
    await refreshRuntimeCredentialPool({ ...request, now: SAO_PAULO_14H - 1 });
    expect(getRuntimeCredential("rcred_claude")?.status).toBe("exhausted");
    expect(selectRuntimeCredential({ ...request, now: SAO_PAULO_14H - 1 }).credential).toBeNull();

    await refreshRuntimeCredentialPool({ ...request, now: SAO_PAULO_14H });
    expect(getRuntimeCredential("rcred_claude")?.status).toBe("healthy");
    expect(selectRuntimeCredential({ ...request, now: SAO_PAULO_14H }).credential?.id).toBe("rcred_claude");
  });

  it("re-checks an exhausted quota with no reset evidence after 1 h, not 24 h", () => {
    createRuntimeCredential(claudeCredential("rcred_claude"));
    const signal = classifyRuntimeCredentialFailure({
      runtimeProvider: "claude",
      upstreamProvider: "anthropic",
      credentialId: "rcred_claude",
      providerCode: "rate_limit",
      message: "You've hit your weekly limit",
      now: INCIDENT_AT,
    });
    expect(signal.resetAt).toBeUndefined();
    recordRuntimeCredentialFailure("rcred_claude", signal, INCIDENT_AT);
    expect(getRuntimeCredentialHealth("rcred_claude")?.cooldownUntil).toBe(INCIDENT_AT + HOUR);
  });

  it("keeps billing blocks for a day", () => {
    createRuntimeCredential(claudeCredential("rcred_claude"));
    const signal = classifyRuntimeCredentialFailure({
      runtimeProvider: "claude",
      credentialId: "rcred_claude",
      providerCode: "billing_error",
      now: INCIDENT_AT,
    });
    recordRuntimeCredentialFailure("rcred_claude", signal, INCIDENT_AT);
    expect(getRuntimeCredentialHealth("rcred_claude")?.cooldownUntil).toBe(INCIDENT_AT + 24 * HOUR);
  });
});
