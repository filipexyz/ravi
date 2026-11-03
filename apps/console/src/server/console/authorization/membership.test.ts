import { expect, test } from "bun:test";
import { BOOTSTRAP_CONFIGURATION_ACTIONS } from "./bootstrap";
import { compilePolicy } from "./engine";
import { ORGANIZATION_ACTIONS, policySchema } from "./policy";

test("bootstrap grants are a fixed contract, not the complement of known forbidden actions", () => {
  expect([...BOOTSTRAP_CONFIGURATION_ACTIONS]).toEqual([
    "organization.settings.read", "organization.settings.manage",
    "organization.onboarding.read", "organization.onboarding.manage",
    "organization.sso.read", "organization.sso.manage",
    "organization.credentials.read", "organization.credentials.manage",
    "organization.installations.read", "organization.installations.manage",
    "organization.authorization.read", "organization.authorization.manage",
  ]);
  expect(ORGANIZATION_ACTIONS.filter(action => !(BOOTSTRAP_CONFIGURATION_ACTIONS as readonly string[]).includes(action)))
    .toEqual(["organization.projects.create", "organization.members.read", "organization.members.manage",
      "organization.api_keys.read", "organization.api_keys.manage"]);
});

test("member roles are explicit, rename-stable and do not imply policy management", async () => {
  const org = crypto.randomUUID(), user = crypto.randomUUID(), manager = crypto.randomUUID(), role = crypto.randomUUID();
  const policy = policySchema.parse({ format: 1, organizationId: org, administrators: [{ kind: "user", id: manager }],
    groups: [{ id: "directory", members: [user] }], rules: [],
    roles: [{ id: role, name: "Directory readers", members: [], groups: ["directory"], scope: { kind: "organization" } }],
    organizationRules: [{ id: "directory", effect: "allow", principals: [{ kind: "role", id: role }], actions: ["organization.members.read"] }] });
  const facts = { organizationId: org, userId: user, organizationRole: "owner", active: true };
  for (const name of ["Directory readers", "admin", "owner"]) {
    policy.roles[0]!.name = name;
    const engine = await compilePolicy(policy);
    expect((await engine.decideOrganization(facts, "organization.members.read")).allowed).toBe(true);
    for (const action of ["organization.members.manage", "organization.authorization.read", "organization.authorization.manage", "organization.settings.read"] as const)
      expect((await engine.decideOrganization(facts, action)).allowed).toBe(false);
  }
  policy.groups[0]!.members = [];
  expect((await (await compilePolicy(policy)).decideOrganization(facts, "organization.members.read")).allowed).toBe(false);
  policy.roles[0]!.members = [user];
  policy.organizationRules[0]!.actions = ["organization.members.manage"];
  const manageOnly = await compilePolicy(policy);
  expect((await manageOnly.decideOrganization(facts, "organization.members.manage")).allowed).toBe(true);
  expect((await manageOnly.decideOrganization(facts, "organization.members.read")).allowed).toBe(false);
});
