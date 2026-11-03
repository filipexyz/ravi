import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

import { ConsoleApiError } from "@/server/console/api-error";
import { AGENT_INBOX_TARGET_LOCAL_INSTALLATION } from "@/server/console/agent-inbox";

import {
  BUG_STATUS_FOLLOW_CATEGORY,
  BUG_STATUS_FOLLOW_EVENT_TYPE,
  buildBugStatusFollowInboxItem,
  buildBugStatusFollowPayload,
  createMemoryBugReportFollowStore,
  fanoutBugStatusFollow,
  shouldEmitBugStatusFollow,
  subscribeBugReportFollow,
  unsubscribeBugReportFollow,
  type BugStatusFollowBug,
} from "./bug-report-follow";

const BUG_A = "11111111-1111-4111-8111-111111111111";
const BUG_B = "22222222-2222-4222-8222-222222222222";
const INSTALL_A = "33333333-3333-4333-8333-333333333333";
const INSTALL_B = "44444444-4444-4444-8444-444444444444";
const USER = "55555555-5555-4555-8555-555555555555";
const OTHER_USER = "66666666-6666-4666-8666-666666666666";
const ORG = "77777777-7777-4777-8777-777777777777";

function sampleBug(overrides: Partial<BugStatusFollowBug> = {}): BugStatusFollowBug {
  return {
    id: BUG_A,
    title: "CLI watch never arms",
    status: "in_progress",
    priority: "p1",
    reporterUserId: USER,
    organizationId: ORG,
    projectId: null,
    statusUpdatedAt: new Date("2026-09-13T12:00:00.000Z"),
    ...overrides,
  };
}

describe("bug status follow emit rules", () => {
  test("emits only when status actually changes", () => {
    expect(shouldEmitBugStatusFollow("submitted", "triaging")).toBe(true);
    expect(shouldEmitBugStatusFollow("in_progress", "in_progress")).toBe(false);
  });

  test("builds the minimal watch.console.bug.status payload", () => {
    const payload = buildBugStatusFollowPayload({
      bug: sampleBug(),
      previousStatus: "submitted",
    });
    expect(payload).toEqual({
      bugId: BUG_A,
      status: "in_progress",
      previousStatus: "submitted",
      title: "CLI watch never arms",
      consoleUrl: "https://console.ravi.bot/bugs/11111111-1111-4111-8111-111111111111",
      reporterUserId: USER,
      priority: "p1",
    });
    expect(payload).not.toHaveProperty("triage_json");
    expect(payload).not.toHaveProperty("payload");
    expect(JSON.stringify(payload)).not.toMatch(/triage/i);
  });

  test("omits null priority from the payload", () => {
    const payload = buildBugStatusFollowPayload({
      bug: sampleBug({ priority: null }),
      previousStatus: "submitted",
    });
    expect(payload).not.toHaveProperty("priority");
  });

  test("targets the subscriber installation and uses the watch event name", () => {
    const item = buildBugStatusFollowInboxItem({
      bug: sampleBug(),
      previousStatus: "submitted",
      subscription: {
        localInstallationId: INSTALL_A,
        organizationId: ORG,
        projectId: null,
      },
    });
    expect(item).toMatchObject({
      eventType: BUG_STATUS_FOLLOW_EVENT_TYPE,
      category: BUG_STATUS_FOLLOW_CATEGORY,
      sourceType: "bug_report",
      sourceId: BUG_A,
      targetType: AGENT_INBOX_TARGET_LOCAL_INSTALLATION,
      targetId: INSTALL_A,
      organizationId: ORG,
      sensitivity: "metadata",
    });
    expect(item?.payloadJson).toMatchObject({
      bugId: BUG_A,
      status: "in_progress",
      previousStatus: "submitted",
      reporterUserId: USER,
    });
    expect(item?.payloadJson).not.toHaveProperty("triage_json");
    expect(item?.linksJson).toEqual([
      { label: "Console", url: "https://console.ravi.bot/bugs/11111111-1111-4111-8111-111111111111" },
    ] as unknown as Record<string, unknown>);
  });
});

describe("bug status follow fanout isolation", () => {
  test("status change for bug A delivers one item to that subscriber only", async () => {
    const store = createMemoryBugReportFollowStore({
      bugs: [sampleBug({ id: BUG_A, status: "in_progress" }), sampleBug({ id: BUG_B, title: "Other" })],
      subscriptions: [
        {
          id: "sub-a",
          bugReportId: BUG_A,
          localInstallationId: INSTALL_A,
          userId: USER,
          organizationId: ORG,
          projectId: null,
          createdAt: new Date(),
        },
        {
          id: "sub-b",
          bugReportId: BUG_B,
          localInstallationId: INSTALL_B,
          userId: USER,
          organizationId: ORG,
          projectId: null,
          createdAt: new Date(),
        },
      ],
    });

    const result = await fanoutBugStatusFollow({
      bug: sampleBug({ status: "in_progress" }),
      previousStatus: "submitted",
      requestId: "req_a",
      store,
    });

    expect(result).toEqual({ emitted: 1, skipped: 0 });
    expect(store.inboxItems).toHaveLength(1);
    const delivered = store.inboxItems[0];
    expect(delivered).toBeDefined();
    expect(delivered?.targetId).toBe(INSTALL_A);
    expect(delivered?.payloadJson?.bugId).toBe(BUG_A);
    expect(delivered?.targetId).not.toBe(INSTALL_B);
  });

  test("does not emit when status is unchanged", async () => {
    const store = createMemoryBugReportFollowStore({
      bugs: [sampleBug()],
      subscriptions: [
        {
          id: "sub-a",
          bugReportId: BUG_A,
          localInstallationId: INSTALL_A,
          userId: USER,
          organizationId: ORG,
          projectId: null,
          createdAt: new Date(),
        },
      ],
    });

    const result = await fanoutBugStatusFollow({
      bug: sampleBug({ status: "in_progress" }),
      previousStatus: "in_progress",
      requestId: "req_same",
      store,
    });

    expect(result).toEqual({ emitted: 0, skipped: 0 });
    expect(store.inboxItems).toHaveLength(0);
  });

  test("cascade delete of a bug removes only that bug's subscriptions", async () => {
    const store = createMemoryBugReportFollowStore({
      bugs: [sampleBug({ id: BUG_A }), sampleBug({ id: BUG_B, title: "Other" })],
      subscriptions: [
        {
          id: "sub-a",
          bugReportId: BUG_A,
          localInstallationId: INSTALL_A,
          userId: USER,
          organizationId: ORG,
          projectId: null,
          createdAt: new Date(),
        },
        {
          id: "sub-b",
          bugReportId: BUG_B,
          localInstallationId: INSTALL_B,
          userId: USER,
          organizationId: ORG,
          projectId: null,
          createdAt: new Date(),
        },
      ],
    });

    await store.deleteBug(BUG_A);
    expect(await store.listSubscriptions(BUG_A)).toEqual([]);
    expect(await store.listSubscriptions(BUG_B)).toHaveLength(1);
    expect(store.subscriptions.has(`${BUG_B}:${INSTALL_B}`)).toBe(true);
  });

  test("migration cascades subscriptions when the bug row is deleted", () => {
    const sql = readFileSync("drizzle/0042_bug_report_subscriptions.sql", "utf8");
    expect(sql).toContain("CREATE TABLE \"bug_report_subscriptions\"");
    expect(sql).toContain("bug_report_subscriptions_bug_installation_unique");
    expect(sql).toMatch(
      /bug_report_subscriptions_bug_report_id_bug_reports_id_fk[\s\S]*ON DELETE cascade/,
    );
  });
});

describe("bug status follow subscribe", () => {
  test("is idempotent for the same installation and 404s for another user", async () => {
    const store = createMemoryBugReportFollowStore({
      bugs: [sampleBug({ status: "submitted" })],
    });

    const first = await subscribeBugReportFollow(
      {
        id: BUG_A,
        reporterUserId: USER,
        localInstallationId: INSTALL_A,
        organizationId: ORG,
      },
      store,
    );
    const second = await subscribeBugReportFollow(
      {
        id: BUG_A,
        reporterUserId: USER,
        localInstallationId: INSTALL_A,
        organizationId: ORG,
      },
      store,
    );

    expect(first.subscribed).toBe(true);
    expect(second.id).toBe(first.id);
    expect(store.subscriptions.size).toBe(1);

    try {
      await subscribeBugReportFollow(
        {
          id: BUG_A,
          reporterUserId: OTHER_USER,
          localInstallationId: INSTALL_B,
          organizationId: ORG,
        },
        store,
      );
      throw new Error("expected not found for non-reporter");
    } catch (error) {
      expect(error).toBeInstanceOf(ConsoleApiError);
      expect((error as ConsoleApiError).status).toBe(404);
    }

    const removed = await unsubscribeBugReportFollow(
      { id: BUG_A, reporterUserId: USER, localInstallationId: INSTALL_A },
      store,
    );
    expect(removed).toEqual({
      bugId: BUG_A,
      localInstallationId: INSTALL_A,
      unsubscribed: true,
    });
    expect(store.subscriptions.size).toBe(0);

    const again = await unsubscribeBugReportFollow(
      { id: BUG_A, reporterUserId: USER, localInstallationId: INSTALL_A },
      store,
    );
    expect(again.unsubscribed).toBe(true);
  });
});
