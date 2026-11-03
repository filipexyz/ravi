import { describe, expect, test } from "bun:test";
import { canManagePolicy, compilePolicy, evaluatePolicy, type AuthorizationFacts } from "./engine";
import { initialPolicy, policyDigest, policySchema, type ProjectPolicy } from "./policy";

const org = "00000000-0000-4000-8000-000000000001";
const user = "00000000-0000-4000-8000-000000000002";
const a = "00000000-0000-4000-8000-000000000003";
const b = "00000000-0000-4000-8000-000000000004";
const install = "00000000-0000-4000-8000-000000000005";
const other = "00000000-0000-4000-8000-000000000006";
const facts: AuthorizationFacts = { organizationId: org, projectOrganizationId: org, projectId: a,
  userId: user, active: true, organizationRole: "owner", projectRole: null };
const base = (): ProjectPolicy => ({ format: 1, organizationId: org, administrators: [{ kind: "user", id: user }], groups: [], rules: [] });
const permit = (): ProjectPolicy => ({ ...base(), rules: [{ id: "alice-a", effect: "allow", principals: [{ kind: "user", id: user }],
  projects: [a], actions: ["project.read"] }] });

describe("project policy: one authority, no organization-role bypass", () => {
  test("service is a distinct explicit lane, denies win and human/admin grants never leak", async () => {
    const policy = permit();
    const service = { organizationId: org, servicePrincipalId: user, active: true };
    const resource = { kind: "project" as const, id: a };
    expect((await (await compilePolicy(policy)).decideService(service, resource, "project.read")).allowed).toBe(false);
    expect((await (await compilePolicy(policy)).decideService(service, { kind: "organization", id: org }, "organization.authorization.manage")).allowed).toBe(false);
    policy.rules.push({ id: "service-read", effect: "allow", principals: [{ kind: "service", id: user }], projects: [a], actions: ["project.read"] });
    const engine = await compilePolicy(policy);
    expect(await engine.decideService(service, resource, "project.read")).toMatchObject({ allowed: true, lanes: [{ lane: "service", allowed: true }] });
    for (const patch of [{ active: false }, { organizationId: other }, { servicePrincipalId: other }])
      expect((await engine.decideService({ ...service, ...patch }, resource, "project.read")).allowed).toBe(false);
    expect((await engine.decideService(service, { kind: "project", id: b }, "project.read")).allowed).toBe(false);
    expect((await engine.decideService(service, resource, "project.write")).allowed).toBe(false);
    policy.rules.push({ id: "service-denied", effect: "deny", principals: [{ kind: "service", id: user }], projects: ["*"], actions: ["project.read"] });
    expect(await (await compilePolicy(policy)).decideService(service, resource, "project.read")).toMatchObject({ allowed: false, reason: "explicit_deny" });
    expect((await (await compilePolicy(policy)).decide(facts, "project.read")).allowed).toBe(true);
  });
  test("absent, malformed, future-format and no-match deny", async () => {
    for (const input of [null, {}, { ...base(), format: 2 }, { ...base(), model: "allow-all" }]) {
      expect((await evaluatePolicy(input, facts, "project.read")).allowed).toBe(false);
    }
    expect(await evaluatePolicy(base(), facts, "project.read")).toMatchObject({ allowed: false, reason: "no_grant" });
  });
  test("same org A/B and read/write are distinct even for owner", async () => {
    const engine = await compilePolicy(permit());
    expect((await engine.decide(facts, "project.read")).allowed).toBe(true);
    expect((await engine.decide({ ...facts, projectId: b }, "project.read")).allowed).toBe(false);
    expect((await engine.decide(facts, "project.write")).allowed).toBe(false);
    expect((await engine.decide({ ...facts, userId: other }, "project.read")).allowed).toBe(false);
    expect(await canManagePolicy(permit(), facts)).toBe(true);
    expect((await evaluatePolicy(base(), facts, "project.read")).allowed).toBe(false);
  });
  test("explicit deny wins independent of rule ordering", async () => {
    const policy = permit();
    policy.rules.push({ id: "deny", effect: "deny", principals: [{ kind: "user", id: user }], projects: ["*"], actions: ["project.read"] });
    for (const rules of [policy.rules, policy.rules.toReversed()]) {
      expect(await evaluatePolicy({ ...policy, rules }, facts, "project.read")).toMatchObject({ allowed: false, reason: "explicit_deny" });
    }
  });
  test("inactive identity or cross-org resource never gets a grant", async () => {
    for (const patch of [{ active: false }, { organizationId: other }, { projectOrganizationId: other }]) {
      expect(await evaluatePolicy(permit(), { ...facts, ...patch }, "project.read")).toMatchObject({ allowed: false, reason: "invalid_identity" });
    }
  });
  test("role names and legacy membership never imply a grant", async () => {
    const draft = initialPolicy(org, user);
    expect((await evaluatePolicy(draft, facts, "project.read")).allowed).toBe(false);
    const reader = { ...facts, projectRole: "viewer" };
    expect((await evaluatePolicy(draft, reader, "project.read")).allowed).toBe(false);
    expect((await evaluatePolicy(draft, reader, "project.write")).allowed).toBe(false);
    draft.rules = [];
    expect((await evaluatePolicy(draft, reader, "project.read")).allowed).toBe(false);
  });
  test("stable custom role IDs, scoped assignments, rename and organization actions", async () => {
    const p = permit();
    p.roles = [{ id: other, name: "owner", members: [], groups: [], scope: { kind: "project", projects: [a] } }];
    p.rules = [{ id: "custom-a", effect: "allow", projects: ["*"], actions: ["project.read"], principals: [{ kind: "role", id: other }] }];
    expect((await evaluatePolicy(p, facts, "project.read")).allowed).toBe(false);
    p.roles[0]!.members = [user];
    expect((await evaluatePolicy(p, facts, "project.read")).allowed).toBe(true);
    p.roles[0]!.name = "Reviewers";
    expect((await evaluatePolicy(p, facts, "project.read")).allowed).toBe(true);
    expect((await evaluatePolicy(p, { ...facts, projectId: b }, "project.read")).allowed).toBe(false);
    p.organizationRules = [{ id: "settings", effect: "allow", actions: ["organization.settings.read"], principals: [{ kind: "role", id: other }] }];
    expect((await (await compilePolicy(p)).decideOrganization(facts, "organization.settings.read")).allowed).toBe(false);
    p.roles[0]!.scope = { kind: "organization" };
    expect((await (await compilePolicy(p)).decideOrganization(facts, "organization.settings.read")).allowed).toBe(true);
    expect((await (await compilePolicy(p)).decideOrganization(facts, "organization.settings.manage")).allowed).toBe(false);
    expect((await evaluatePolicy(p, facts, "project.read")).allowed).toBe(false);
    p.organizationRules.push({ id: "deny-policy", effect: "deny", actions: ["organization.authorization.manage"], principals: [{ kind: "user", id: user }] });
    expect(await canManagePolicy(p, facts)).toBe(false);
  });
  test("published group membership removal changes outcome without code", async () => {
    const policy = base();
    policy.groups = [{ id: "design", members: [user] }];
    policy.rules = [{ id: "design-a", effect: "allow", principals: [{ kind: "group", id: "design" }], projects: [a], actions: ["project.read"] }];
    expect((await evaluatePolicy(policy, facts, "project.read")).allowed).toBe(true);
    policy.groups[0]!.members = [];
    expect((await evaluatePolicy(policy, facts, "project.read")).allowed).toBe(false);
  });
  test("delegation requires a separate installation ceiling", async () => {
    const policy = permit();
    const delegated = { ...facts, delegation: { installationId: install, organizationId: org, userId: user, active: true, bindingId: "verified-link" } };
    expect((await evaluatePolicy(policy, delegated, "project.read")).allowed).toBe(false);
    policy.rules.push({ id: "install-read", effect: "allow", principals: [{ kind: "installation", id: install }], projects: [a], actions: ["project.read", "project.write"] });
    expect(await evaluatePolicy(policy, delegated, "project.read")).toMatchObject({ allowed: true, lanes: [{ lane: "human", allowed: true }, { lane: "installation", allowed: true }] });
    expect((await evaluatePolicy(policy, delegated, "project.write")).allowed).toBe(false);
    for (const patch of [{ active: false }, { organizationId: other }, { userId: other }, { installationId: other }]) {
      expect((await evaluatePolicy(policy, { ...delegated, delegation: { ...delegated.delegation, ...patch } }, "project.read")).allowed).toBe(false);
    }
  });
  test("attested agent is a third lane, scoped to its installation", async () => {
    const policy = permit();
    policy.rules.push({ id: "installation", effect: "allow", principals: [{ kind: "installation", id: install }], projects: [a], actions: ["project.read"] });
    const delegated = { ...facts, delegation: { installationId: install, organizationId: org, userId: user, active: true, bindingId: "binding", agent: { id: "helper", active: true } } };
    expect((await evaluatePolicy(policy, delegated, "project.read")).allowed).toBe(false);
    policy.rules.push({ id: "helper", effect: "allow", principals: [{ kind: "agent", installationId: install, id: "helper" }], projects: [a], actions: ["project.read"] });
    expect((await evaluatePolicy(policy, delegated, "project.read")).allowed).toBe(true);
    delegated.delegation.agent.id = "another";
    expect((await evaluatePolicy(policy, delegated, "project.read")).allowed).toBe(false);
    delegated.delegation.agent = { id: "helper", active: false };
    expect((await evaluatePolicy(policy, delegated, "project.read")).allowed).toBe(false);
  });
  test("rules cannot evaluate code, unknown actions or malformed principals", () => {
    const good = permit();
    for (const rule of [
      { ...good.rules[0], matcher: "true" }, { ...good.rules[0], actions: ["*"] },
      { ...good.rules[0], principals: [{ kind: "user", id: "*" }] },
      { ...good.rules[0], projects: ["*", a] }, { ...good.rules[0], actions: ["project.read", "project.read"] },
      { ...good.rules[0], principals: [{ kind: "group", id: "missing" }] },
    ]) expect(policySchema.safeParse({ ...good, rules: [rule] }).success).toBe(false);
    expect(policySchema.safeParse({ ...good, administrators: [] }).success).toBe(false);
    expect(policySchema.safeParse({ ...good, rules: [good.rules[0], good.rules[0]] }).success).toBe(false);
  });
  test("revision digest ignores object-key order, not policy changes", () => {
    const policy = permit();
    expect(policyDigest(policy)).toBe(policyDigest({ ...policy, rules: policy.rules.map((r) => ({ actions: r.actions, projects: r.projects, effect: r.effect, principals: r.principals, id: r.id })) }));
    expect(policyDigest(policy)).not.toBe(policyDigest(base()));
  });
});
