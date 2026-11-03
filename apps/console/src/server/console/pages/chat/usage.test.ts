import { describe, expect, test } from "bun:test";

import { normalizeUsageEvents } from "@/server/console/billing/usage-ingest";
import type { getConsoleFeatureAccessForOrganizationRole } from "@/server/console/feature-access";

import { PAGE_CHAT_GUEST_DAILY_SECONDS_CAP } from "./limits";
import { buildPageChatSessionUsageEvents, resolvePageChatAllowance, type PageChatAllowanceFacts } from "./usage";

const report = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  projectId: "00000000-0000-4000-8000-000000000002",
  siteId: "00000000-0000-4000-8000-000000000003",
  chatSessionId: "pchat_1",
  viewerUserId: "00000000-0000-4000-8000-000000000004",
  requestId: "req_chat_1",
  endedAt: new Date("2026-10-10T15:00:00.000Z"),
  endReason: "viewer_closed" as const,
  voiceSeconds: 90.5,
  usageComplete: true,
  model: "background-model",
  inputTokens: 1200,
  outputTokens: 300,
  toolCalls: { "page.read": 2, "page.navigate": 1, "bases.query": 0 },
};

describe("Page Chat usage events", () => {
  test("records one event per metric with stable idempotency keys", () => {
    const events = buildPageChatSessionUsageEvents(report);
    expect(events.map((event) => [event.metricKey, event.quantity, event.unit])).toEqual([
      ["pages.chat.sessions", "1", "count"],
      ["pages.chat.voice_seconds", "90.5", "seconds"],
      ["pages.chat.model_input_tokens", "1200", "tokens"],
      ["pages.chat.model_output_tokens", "300", "tokens"],
      ["pages.chat.tool_calls", "3", "count"],
    ]);
    expect(events.every((event) => event.idempotencyKey?.startsWith("pages.chat.session_closed:pchat_1:"))).toBe(true);
    expect(new Set(events.map((event) => event.idempotencyKey)).size).toBe(events.length);
    expect(buildPageChatSessionUsageEvents(report).map((event) => event.idempotencyKey)).toEqual(
      events.map((event) => event.idempotencyKey),
    );
  });

  test("puts the cost estimate on the session event and keeps the model internal", () => {
    const [session, voice] = buildPageChatSessionUsageEvents(report);
    if (!session || !voice) throw new Error("missing events");
    expect(session.measurementsJson).toMatchObject({
      estimatedVoiceCostUsd: 0.07541667,
      estimatedCostComplete: false,
      priceVersion: "2026-10-10",
    });
    expect(voice.dimensionsJson).toMatchObject({ service: "pages", object: "chat_session", endReason: "viewer_closed" });
    expect(JSON.stringify(voice.dimensionsJson)).not.toContain("background-model");
    expect(voice.metadataJson).toEqual({ model: "background-model" });
  });

  test("stays out of the serving-plane ingest allowlist", () => {
    const [session] = buildPageChatSessionUsageEvents(report);
    if (!session) throw new Error("missing event");
    expect(() => normalizeUsageEvents({ events: [{ ...session, quantity: 1 }] }, "req")).toThrow();
  });
});

describe("Page Chat allowance for guests", () => {
  const organizationId = "00000000-0000-4000-8000-000000000001";
  const noOpen = { count: 0, orgReservedSeconds: 0, viewerReservedSeconds: 0 };
  const facts = (overrides: Partial<PageChatAllowanceFacts> = {}) => async () => ({
    entitlementValueJson: { enabled: true },
    orgMonthSpentUsd: 0,
    viewerDaySeconds: 0,
    ...overrides,
  });
  // Only the organization-level check (role "owner") knows the feature is on.
  function featureAccess(available: boolean) {
    const roles: string[] = [];
    const access = (async ({ role }: { organizationId: string; role: string }) => {
      roles.push(role);
      return {
        byKey: { "console.pages.chat": { available, authorized: role === "owner", enabled: available && role === "owner" } },
      };
    }) as unknown as typeof getConsoleFeatureAccessForOrganizationRole;
    return { access, roles };
  }

  test("a guest is not feature_unavailable when the org has console.pages.chat", async () => {
    const { access, roles } = featureAccess(true);
    const allowance = await resolvePageChatAllowance(
      { organizationId, viewerUserId: "guest_1", viewer: { kind: "guest", userId: "guest_1" }, openSessions: noOpen },
      { featureAccess: access, readFacts: facts() },
    );
    expect(allowance).toMatchObject({ allowed: true });
    expect(roles).toEqual(["owner"]);
    expect(allowance.limits.viewerDailySeconds).toBeLessThanOrEqual(900);
    expect(allowance.limits.viewerDailySeconds).toBe(PAGE_CHAT_GUEST_DAILY_SECONDS_CAP);
  });

  test("a guest is feature_unavailable when the org lacks console.pages.chat", async () => {
    const { access } = featureAccess(false);
    expect(
      await resolvePageChatAllowance(
        { organizationId, viewerUserId: "guest_1", viewer: { kind: "guest", userId: "guest_1" }, openSessions: noOpen },
        { featureAccess: access, readFacts: facts() },
      ),
    ).toMatchObject({ allowed: false, reason: "feature_unavailable" });
  });

  test("the guest daily cap is at most 900 seconds even when the org allows more", async () => {
    const { access } = featureAccess(true);
    const guest = { kind: "guest" as const, userId: "guest_1" };
    const generous = facts({ entitlementValueJson: { limits: { viewerDailySeconds: 7200 } }, viewerDaySeconds: 890 });
    expect(
      await resolvePageChatAllowance(
        { organizationId, viewerUserId: "guest_1", viewer: guest, openSessions: noOpen },
        { featureAccess: access, readFacts: generous },
      ),
    ).toMatchObject({ allowed: false, reason: "viewer_daily_limit" });

    const allowed = await resolvePageChatAllowance(
      { organizationId, viewerUserId: "guest_1", viewer: guest, openSessions: noOpen },
      { featureAccess: access, readFacts: facts({ viewerDaySeconds: 600 }) },
    );
    expect(allowed).toMatchObject({ allowed: true, sessionMaxSeconds: 300 });
  });

  test("the member path is unchanged: checked by role", async () => {
    const { access, roles } = featureAccess(true);
    expect(
      await resolvePageChatAllowance(
        { organizationId, viewerUserId: "user_1", viewerRole: "viewer", openSessions: noOpen },
        { featureAccess: access, readFacts: facts() },
      ),
    ).toMatchObject({ allowed: false, reason: "feature_unavailable" });
    const owner = await resolvePageChatAllowance(
      { organizationId, viewerUserId: "user_1", viewerRole: "owner", openSessions: noOpen },
      { featureAccess: access, readFacts: facts() },
    );
    expect(owner).toMatchObject({ allowed: true, sessionMaxSeconds: 600 });
    expect(owner.limits.viewerDailySeconds).toBe(3600);
    expect(roles).toEqual(["viewer", "owner"]);
    expect(
      await resolvePageChatAllowance(
        { organizationId, viewerUserId: "user_1", openSessions: noOpen },
        { featureAccess: access, readFacts: facts() },
      ),
    ).toMatchObject({ allowed: false, reason: "feature_unavailable" });
  });
});
