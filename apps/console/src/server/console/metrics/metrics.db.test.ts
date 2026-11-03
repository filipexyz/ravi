import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { basesPolicyFixture } from "../../../../tests/review/bases-policy-fixture";

import { eq, inArray } from "drizzle-orm";

import { basesCallerForPagesViewer } from "@/server/console/bases/context";
import { queryViewForCaller } from "@/server/console/bases/for-caller";
import { db, schema } from "@/server/db";

import { computeDailyMetrics, computePeopleUsage } from "./compute";
import { DAYS_BASE, PEOPLE_BASE, resolveMetricsProject, syncUsageMetrics } from "./sync";

// Usage metrics against Postgres. Runs only with METRICS_TEST_DATABASE_URL
// (and DATABASE_URL) pointing at a database with the current schema. Every
// fixture lives in January 2001 so the counts ignore whatever else the
// database holds; the fixtures are deleted afterwards.
const url = process.env.METRICS_TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

const suffix = randomUUID().slice(0, 8);
const orgA = { id: randomUUID(), slug: `metrics-a-${suffix}` };
const orgB = { id: randomUUID(), slug: `metrics-b-${suffix}` };
const project = { id: randomUUID(), slug: `metricas-${suffix}` };
const siteId = randomUUID();
const user = (label: string, createdAt: string) => ({
  id: randomUUID(),
  primaryEmail: `metrics-${label}-${suffix}@example.test`,
  displayName: label,
  createdAt: new Date(createdAt),
});
const alice = user("Alice", "2001-01-02T15:00:00Z");
const bob = user("Bob", "2000-12-01T12:00:00Z");
const carol = user("Carol", "2000-12-01T12:00:00Z"); // platform operator
const dave = user("Dave", "2000-12-01T12:00:00Z"); // acts only in the excluded org
const erin = user("Erin", "2000-12-01T12:00:00Z");
const USERS = [alice, bob, carol, dave, erin];
const NOW = new Date("2001-01-10T15:00:00Z");

describeDb("usage metrics", () => {
  beforeAll(async () => {
    await db.insert(schema.users).values(USERS);
    await db.insert(schema.organizations).values([
      { id: orgA.id, slug: orgA.slug, name: "Org A" },
      { id: orgB.id, slug: orgB.slug, name: "Org B" },
    ]);
    await db.insert(schema.organizationMemberships).values([
      { organizationId: orgA.id, userId: alice.id, role: "owner" },
      { organizationId: orgA.id, userId: bob.id, role: "developer" },
      { organizationId: orgA.id, userId: carol.id, role: "admin" },
      { organizationId: orgA.id, userId: erin.id, role: "developer" },
      { organizationId: orgB.id, userId: dave.id, role: "owner" },
    ]);
    await db.insert(schema.platformOperators).values({ userId: carol.id, source: "test" });
    await db.insert(schema.projects).values({ id: project.id, organizationId: orgA.id, slug: project.slug, name: "Métricas" });
    await basesPolicyFixture(orgA.id, alice.id, [{ projectId: project.id, managers: [], readers: [alice.id] }]);
    await db.insert(schema.pageSites).values({
      id: siteId,
      organizationId: orgA.id,
      projectId: project.id,
      slug: `metricas-${suffix}`,
      defaultHostname: `metricas-${suffix}.ravi.page`,
      isDefault: true,
    });
    await db.insert(schema.pagePublishes).values({
      organizationId: orgA.id,
      projectId: project.id,
      siteId,
      sourceType: "cli",
      status: "completed",
      createdByActorType: "cli",
      createdByActorId: alice.id,
      createdAt: new Date("2001-01-03T13:00:00Z"),
      completedAt: new Date("2001-01-03T13:00:05Z"),
    });
    await db.insert(schema.auditEvents).values([
      { organizationId: orgA.id, targetType: "test", actorType: "user", actorId: bob.id, action: "pages.private_route.allowed", createdAt: new Date("2001-01-05T14:00:00Z") },
      { organizationId: orgA.id, targetType: "test", actorType: "user", actorId: carol.id, action: "bases.view.created", createdAt: new Date("2001-01-05T14:00:00Z") },
      { organizationId: orgB.id, targetType: "test", actorType: "user", actorId: dave.id, action: "bases.view.created", createdAt: new Date("2001-01-05T14:00:00Z") },
      // 23:30 on Jan 5 in São Paulo (UTC-2: summer time in 2001).
      { organizationId: orgA.id, targetType: "test", actorType: "user", actorId: erin.id, action: "knowledge_source.created", createdAt: new Date("2001-01-06T01:30:00Z") },
      { organizationId: orgA.id, targetType: "test", actorType: "system", actorId: null, action: "bases.view.created", createdAt: new Date("2001-01-05T14:00:00Z") },
    ]);
    const traffic = (metricKey: string, at: string) => ({
      organizationId: orgA.id,
      projectId: project.id,
      siteId,
      source: "pages_worker",
      eventType: "pages.request_served",
      metricKey,
      quantity: "1",
      unit: "count",
      idempotencyKey: `metrics-test-${randomUUID()}`,
      occurredAt: new Date(at),
    });
    await db.insert(schema.usageEvents).values([
      traffic("pages.requests.public", "2001-01-05T12:00:00Z"),
      traffic("pages.requests.public", "2001-01-05T12:01:00Z"),
      traffic("pages.requests.public", "2001-01-05T12:02:00Z"),
      traffic("pages.requests.private", "2001-01-05T12:03:00Z"),
    ]);
    await db.insert(schema.localInstallations).values({
      organizationId: orgA.id,
      userId: alice.id,
      name: "laptop",
      firstSeenAt: new Date("2000-12-01T12:00:00Z"),
      lastSeenAt: new Date("2001-01-04T12:00:00Z"),
    });
  });

  afterAll(async () => {
    await db.delete(schema.organizations).where(inArray(schema.organizations.id, [orgA.id, orgB.id]));
    await db.delete(schema.users).where(inArray(schema.users.id, USERS.map((u) => u.id)));
  });

  test("daily counts use São Paulo days, rolling windows, and leave out the team and excluded orgs", async () => {
    const days = await computeDailyMetrics({ fromDay: "2001-01-01", toDay: "2001-01-12", excludeOrgIds: [orgB.id] });
    expect(days.map((day) => day.day)).toHaveLength(12);
    const day = (d: string) => days.find((row) => row.day === d)!;
    expect(day("2001-01-02").newPeople).toBe(1);
    expect(day("2001-01-03")).toMatchObject({ activePeople: 1, publishes: 1, publishers7d: 1 });
    expect(day("2001-01-05")).toMatchObject({
      activePeople: 2, // Bob and Erin; Carol is staff, Dave is excluded
      activePeople7d: 3,
      activeOrgs7d: 1,
      readers7d: 1,
      publicRequests: 3,
      privateRequests: 1,
      visitedSites: 1,
      activeInstallations7d: 1,
    });
    expect(day("2001-01-06").activePeople).toBe(0);
    expect(day("2001-01-12")).toMatchObject({ activePeople7d: 0, activePeople30d: 3, activeInstallations7d: 0 });

    const withB = await computeDailyMetrics({ fromDay: "2001-01-05", toDay: "2001-01-05", excludeOrgIds: [] });
    expect(withB[0]!.activePeople).toBe(3);
  });

  test("people usage lists everyone active in 90 days, with areas, CLI use and the staff flag", async () => {
    const people = await computePeopleUsage({ now: NOW, excludeOrgIds: [orgB.id] });
    const mine = people.filter((person) => USERS.some((u) => u.id === person.userId));
    expect(mine.map((person) => person.name).sort()).toEqual(["Alice", "Bob", "Carol", "Erin"]);
    const by = (name: string) => mine.find((person) => person.name === name)!;
    expect(by("Alice")).toMatchObject({ publishes30d: 1, usesCli30d: true, areas30d: ["Pages"], organizations: ["Org A"], staff: false });
    expect(by("Bob")).toMatchObject({ actions30d: 0, pageOpens30d: 1, areas30d: ["Pages"], active7d: true });
    expect(by("Carol")).toMatchObject({ staff: true, areas30d: ["Bases"] });
    expect(by("Erin").areas30d).toEqual(["Knowledge"]);
  });

  test("sync creates both bases with Painel views for the site, writes once, and page viewers can read", async () => {
    const resolved = await resolveMetricsProject(`${orgA.slug}/${project.slug}`);
    expect(resolved.id).toBe(project.id);
    expect((await resolveMetricsProject(project.id)).id).toBe(project.id);

    const first = await syncUsageMetrics({ project: resolved, now: NOW, requestId: randomUUID(), excludeOrgIds: [orgB.id] });
    expect(first.siteId).toBe(siteId);
    expect(first.days).toMatchObject({ created: 120, updated: 0, from: "2000-09-13", to: "2001-01-10" });
    expect(first.people.created).toBeGreaterThanOrEqual(4);

    const second = await syncUsageMetrics({ project: resolved, now: NOW, requestId: randomUUID(), excludeOrgIds: [orgB.id] });
    expect(second.days).toMatchObject({ created: 0, updated: 0, viewId: first.days.viewId });
    expect(second.people).toMatchObject({ created: 0, updated: 0, viewId: first.people.viewId });

    const bases = await db.select().from(schema.bases).where(eq(schema.bases.projectId, project.id));
    expect(bases.map((base) => base.slug).sort()).toEqual([DAYS_BASE.slug, PEOPLE_BASE.slug].sort());

    const viewer = basesCallerForPagesViewer({
      organizationId: orgA.id,
      userId: alice.id,
      email: alice.primaryEmail,
      pagesSessionId: randomUUID(),
      siteId,
      orgRole: "owner",
      requestId: randomUUID(),
    });
    const days = await queryViewForCaller(viewer, { projectId: project.id, viewId: first.days.viewId, limit: 3 });
    expect(days.rows[0]!.values.dia).toMatchObject({ start: "2001-01-10" });
    expect(days.columns).not.toContain("assinatura");
    const people = await queryViewForCaller(viewer, { projectId: project.id, viewId: first.people.viewId, limit: 50 });
    expect(people.columns).not.toContain("user_id");
    expect(people.rows.map((row) => row.values.nome)).toContain("Alice");
  });
});
