import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { TransactionSql } from "postgres";
import { compilePolicy, policyCompilationMetrics } from "../../src/server/console/authorization/engine";
import { organizationDecisionSnapshot } from "../../src/server/console/authorization/postgres";
import { auditAuthorizationDecision } from "../../src/server/console/authorization/audit-policy";
import { policyDigest, ORGANIZATION_ACTIONS } from "../../src/server/console/authorization/policy";
import { fixturePolicy } from "../fleet/authorization-fixture";

test("bounded immutable content cache shares compilation, never identity/decisions", async () => {
  const org = randomUUID(), user = randomUUID(), policy = fixturePolicy(org, user);
  const before = policyCompilationMetrics().compilations;
  const engines = await Promise.all(Array.from({ length: 15 }, () => compilePolicy(policy)));
  expect(policyCompilationMetrics().compilations - before).toBe(1);
  expect(engines.every(engine => engine === engines[0])).toBe(true);
  const engine = engines[0]!, facts = { organizationId: org, userId: user, organizationRole: "no-power", active: true };
  expect((await engine.decideOrganization(facts, "organization.settings.read")).allowed).toBe(true);
  expect((await engine.decideOrganization({ ...facts, active: false }, "organization.settings.read")).allowed).toBe(false);
  expect((await engine.decideOrganization({ ...facts, organizationId: randomUUID() }, "organization.settings.read")).allowed).toBe(false);
  expect(() => { engine.policy.organizationRules.length = 0; }).toThrow();
  policy.organizationRules = [];
  const revoked = await compilePolicy(policy);
  expect(revoked.digest).not.toBe(engine.digest);
  expect((await revoked.decideOrganization(facts, "organization.settings.read")).allowed).toBe(false);
  expect((await engine.decideOrganization(facts, "organization.settings.read")).allowed).toBe(true);
  for (let n = 0; n < 25; n++) await compilePolicy(fixturePolicy(randomUUID(), randomUUID()));
  expect(policyCompilationMetrics().entries).toBeLessThanOrEqual(16);
  expect(policyCompilationMetrics().bytes).toBeLessThanOrEqual(2 * 1024 * 1024);
});

test("native navigation snapshot: 3 queries, one compilation, 0 allowed-read writes; denials persist", async () => {
  const organizationId = randomUUID(), userId = randomUUID(), document = fixturePolicy(organizationId, userId);
  let queries = 0, writes = 0;
  const tx = (async (strings: TemplateStringsArray) => {
    const query = strings.join("?"); queries++;
    if (query.includes("insert into authorization_audit")) { writes++; return []; }
    if (query.includes("organization_memberships")) return [{ role: "custom" }];
    if (query.includes("authorization_policy_heads")) return [{ active_revision_id: "synthetic", generation: 1 }];
    if (query.includes("authorization_policy_revisions")) return [{ document, digest: policyDigest(document) }];
    throw new Error("unexpected fixture query");
  }) as unknown as TransactionSql;
  const before = policyCompilationMetrics().compilations;
  const decide = await organizationDecisionSnapshot(tx, { organizationId, userId });
  for (const action of ORGANIZATION_ACTIONS) expect((await decide(action, "fixture", true)).allowed).toBe(true);
  expect(queries).toBe(3); expect(writes).toBe(0);
  expect(policyCompilationMetrics().compilations - before).toBe(1);
  await decide("organization.settings.manage", "effect"); expect(writes).toBe(1);
  // Next request reads a changed revision. No process-cached grant survives.
  document.organizationRules = [];
  const current = await organizationDecisionSnapshot(tx, { organizationId, userId });
  expect((await current("organization.settings.read", "denied", true)).allowed).toBe(false);
  expect(writes).toBe(2);
});

test("audit budget excludes allowed SSE reads but preserves denials and effects", () => {
  expect(Array.from({ length: 5760 }, () => auditAuthorizationDecision("project.read", true)).filter(Boolean)).toHaveLength(0);
  for (const action of ["project.read", "project.write", "organization.settings.read", "organization.credentials.manage"]) {
    expect(auditAuthorizationDecision(action, false)).toBe(true);
  }
  for (const action of ["project.write", "bases.view.write", "organization.members.manage"]) expect(auditAuthorizationDecision(action, true)).toBe(true);
  // Navigation observations keep denials; per-request capability probes write nothing.
  expect(auditAuthorizationDecision("project.write", true, "observation")).toBe(false);
  expect(auditAuthorizationDecision("project.read", false, "observation")).toBe(true);
  for (const allowed of [true, false]) for (const action of ["project.write", "bases.view.write"]) {
    expect(auditAuthorizationDecision(action, allowed, "probe")).toBe(false);
  }
});
