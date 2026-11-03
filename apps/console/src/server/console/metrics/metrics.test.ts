import { describe, expect, test } from "bun:test";

import { localDay, parseExcludedOrgIds, shiftDay } from "./compute";
import { METRICS_DASHBOARD_USES, renderMetricsDashboard } from "./dashboard";
import { handleMetricsTickHttp } from "./http";
import { dayValues, fingerprint, personValues } from "./sync";

const DAYS_VIEW = "0b0b0b0b-0000-4000-8000-000000000001";
const PEOPLE_VIEW = "0b0b0b0b-0000-4000-8000-000000000002";

describe("metrics helpers", () => {
  test("local days follow São Paulo, and shifting crosses months", () => {
    expect(localDay(new Date("2026-10-18T02:00:00Z"))).toBe("2026-10-17");
    expect(localDay(new Date("2026-10-18T03:00:00Z"))).toBe("2026-10-18");
    expect(shiftDay("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftDay("2026-12-31", 1)).toBe("2027-01-01");
  });

  test("excluded org ids keep only uuids", () => {
    expect(parseExcludedOrgIds(` ${DAYS_VIEW.toUpperCase()}, nope,,${PEOPLE_VIEW}`)).toEqual([DAYS_VIEW, PEOPLE_VIEW]);
    expect(parseExcludedOrgIds(undefined)).toEqual([]);
  });

  test("the fingerprint ignores key order and changes with any value", () => {
    expect(fingerprint({ a: 1, b: [2] })).toBe(fingerprint({ b: [2], a: 1 }));
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
  });

  test("row values use the base keys", () => {
    expect(
      Object.keys(
        dayValues({
          day: "2026-10-18",
          activePeople: 1,
          activePeople7d: 2,
          activePeople30d: 3,
          activeOrgs7d: 1,
          newPeople: 0,
          publishers7d: 1,
          publishes: 1,
          readers7d: 0,
          publicRequests: 10,
          privateRequests: 2,
          visitedSites: 1,
          activeInstallations7d: 1,
        }),
      ),
    ).toContain("pessoas_7d");
    const person = personValues({
      userId: DAYS_VIEW,
      name: "Ana",
      email: "ana@example.test",
      organizations: ["A", "B"],
      joinedAt: "2026-10-18T02:00:00.000Z",
      lastActiveAt: "2026-10-18T12:00:00.000Z",
      actions30d: 3,
      publishes30d: 1,
      pageOpens30d: 0,
      usesCli30d: true,
      active7d: true,
      areas30d: ["Pages", "CLI"],
      staff: false,
    });
    expect(person).toMatchObject({ orgs: "A, B", entrou_em: "2026-10-17", user_id: DAYS_VIEW, areas: ["Pages", "CLI"] });
  });
});

describe("metrics dashboard", () => {
  test("carries only the view ids and calls only the declared connectors", () => {
    const html = renderMetricsDashboard({ daysViewId: DAYS_VIEW, peopleViewId: PEOPLE_VIEW.toUpperCase() });
    expect(html).toContain(`"daysView":"${DAYS_VIEW}"`);
    expect(html).toContain(`"peopleView":"${PEOPLE_VIEW}"`);
    expect(html).not.toContain("__RAVI_METRICS_CONFIG__");
    const called = new Set(html.match(/ravi\.bases\.[a-z.]+/g));
    expect([...called].sort()).toEqual([...METRICS_DASHBOARD_USES].sort());
  });

  test("refuses anything but uuids", () => {
    expect(() => renderMetricsDashboard({ daysViewId: '"></script>', peopleViewId: PEOPLE_VIEW })).toThrow();
  });
});

describe("metrics tick auth", () => {
  test("the cron needs CRON_SECRET and skips an unconfigured project", async () => {
    const request = (auth?: string) =>
      new Request("https://console.ravi.bot/api/internal/admin/metrics/tick", { headers: auth ? { authorization: auth } : {} });
    expect((await handleMetricsTickHttp(request(), { cronSecret: "" })).status).toBe(503);
    expect((await handleMetricsTickHttp(request("Bearer wrong"), { cronSecret: "s3cret" })).status).toBe(401);
    const skipped = await handleMetricsTickHttp(request("Bearer s3cret"), { cronSecret: "s3cret" });
    expect(skipped.status).toBe(200);
    expect(await skipped.json()).toMatchObject({ status: "skipped", code: "metrics_project_not_configured" });
  });
});
