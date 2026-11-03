import { afterAll, describe, expect, test } from "bun:test";
import { dbClient } from "@/server/db";
import { createAuthorizationStore } from "./store";
import { withAuthorizedMembershipMutationInPostgresTransaction as mutateMembership } from "./membership";
import { decideOrganizationInPostgresTransaction as decide } from "./postgres";
import { initialPolicy, policyDigest, policySchema, type ParsedPolicy } from "./policy";
import { handlePolicyRequest } from "./http";

const enabled = Boolean(process.env.RAVI_POLICY_TEST_CLUSTER && process.env.PGHOST === process.env.RAVI_POLICY_TEST_CLUSTER && process.env.DATABASE_URL === "postgres:///postgres");
const suite = enabled ? describe : describe.skip;
const id = () => crypto.randomUUID();
const store = createAuthorizationStore();
async function fixture() {
  const org = id(), manager = id(), member = id(), other = id(), revision = id();
  await dbClient`insert into organizations(id,name,slug) values(${org},'Membership contract',${org})`;
  for (const [user, role] of [[manager, "viewer"], [member, "owner"], [other, "admin"]] as const) {
    await dbClient`insert into users(id,primary_email) values(${user},${user + '@membership.invalid'})`;
    await dbClient`insert into organization_memberships(organization_id,user_id,role) values(${org},${user},${role})`;
  }
  const policy = initialPolicy(org, manager);
  policy.organizationRules.push({ id: "members", effect: "allow", principals: [{ kind: "user", id: manager }],
    actions: ["organization.members.read", "organization.members.manage"] });
  await dbClient`insert into authorization_policy_revisions(id,organization_id,document,digest,created_by,reason)
    values(${revision},${org},${JSON.stringify(policy)}::jsonb,${policyDigest(policy)},${manager},'Synthetic policy fixture, not bootstrap')`;
  await dbClient`insert into authorization_policy_heads(organization_id,generation,active_revision_id) values(${org},1,${revision})`;
  return { org, manager, member, other, policy, actor: { organizationId: org, userId: manager } };
}
async function publish(actor: { organizationId: string; userId: string }, document: ParsedPolicy) {
  const before = await store.read(actor);
  const saved = await store.saveDraft(actor, { expectedGeneration: before.generation, operationKey: id(), reason: "Membership contract change", document });
  const preview = await store.preview(actor, { expectedGeneration: saved.generation });
  return store.publish(actor, { expectedGeneration: saved.generation, operationKey: id(), reason: "Membership contract change", previewId: preview.id });
}
async function status(org: string, user: string) {
  return (await dbClient`select status from organization_memberships where organization_id=${org} and user_id=${user}`)[0]?.status;
}
async function auditCount(org: string) { return Number((await dbClient`select count(*) n from authorization_audit where organization_id=${org}`)[0]!.n); }

suite("member authorization core — PostgreSQL, no lifecycle HTTP/SSO claim", () => {
  afterAll(async () => { if (enabled) await dbClient.end(); });

  test("settings-only and member-reader roles cannot mutate membership or assign access", async () => {
    const f = await fixture(), roleId = id();
    const reader = { organizationId: f.org, userId: f.member };
    f.policy.roles.push({ id: roleId, name: "Settings reviewers", members: [f.member], groups: [], scope: { kind: "organization" } });
    f.policy.organizationRules.push({ id: "settings", effect: "allow", principals: [{ kind: "role", id: roleId }], actions: ["organization.settings.read"] });
    await publish(f.actor, f.policy);
    expect((await dbClient.begin(tx => decide(tx, reader, "organization.settings.read", id()))).allowed).toBe(true);
    for (const action of ["organization.members.read", "organization.members.manage", "organization.authorization.read", "organization.credentials.read"] as const)
      expect((await dbClient.begin(tx => decide(tx, reader, action, id()))).allowed).toBe(false);
    f.policy.organizationRules[1]!.actions = ["organization.members.read"];
    await publish(f.actor, f.policy);
    expect((await dbClient.begin(tx => decide(tx, reader, "organization.members.read", id()))).allowed).toBe(true);
    let effects = 0;
    await expect(dbClient.begin(tx => mutateMembership(tx, reader, id(), async () => ++effects))).rejects.toMatchObject({ status: 403 });
    expect(effects).toBe(0);
    f.policy.organizationRules[1]!.actions = ["organization.members.manage"];
    await publish(f.actor, f.policy);
    await expect(dbClient.begin(tx => mutateMembership(tx, reader, id(), async () => ++effects))).rejects.toMatchObject({ status: 403 });
    expect(effects).toBe(0);
    f.policy.organizationRules[1]!.actions = ["organization.members.read", "organization.members.manage"];
    f.policy.roles[0]!.name = "admin";
    await publish(f.actor, f.policy);
    expect((await dbClient.begin(tx => decide(tx, reader, "organization.members.manage", id()))).allowed).toBe(true);
    await expect(store.read(reader)).rejects.toMatchObject({ status: 403 });
    const before = await store.read(f.actor), escalation = structuredClone(f.policy);
    escalation.administrators.push({ kind: "user", id: f.member });
    const response = await handlePolicyRequest(new Request("https://membership.invalid/api/console/authorization/draft", {
      method: "POST", headers: { origin: "https://membership.invalid", "content-type": "application/json" },
      body: JSON.stringify({ document: escalation, expectedGeneration: before.generation, operationKey: id(), reason: "Denied escalation" }),
    }), ["draft"], { authenticate: async () => reader, canonicalOrigin: () => "https://membership.invalid", store });
    expect(response.status).toBe(403);
    expect((await store.read(f.actor)).generation).toBe(before.generation);
    f.policy.roles[0]!.members = [];
    await publish(f.actor, f.policy);
    await expect(dbClient.begin(tx => mutateMembership(tx, reader, id(), async () => ++effects))).rejects.toMatchObject({ status: 403 });
    expect(effects).toBe(0);
  });

  test("membership change does not assign roles or create a policy revision", async () => {
    const f = await fixture(), before = await store.read(f.actor), request = id();
    await dbClient.begin(tx => mutateMembership(tx, f.actor, request, async tx => {
      await tx`update organization_memberships set status='suspended' where organization_id=${f.org} and user_id=${f.member}`;
    }));
    expect(await status(f.org, f.member)).toBe("suspended");
    const after = await store.read(f.actor);
    expect(after.generation).toBe(before.generation);
    expect(after.active!.digest).toBe(before.active!.digest);
    expect((await dbClient`select action from authorization_audit where organization_id=${f.org} and request_id=${request}`).map(r => r.action).sort())
      // The allowed organization.members.read check writes no decision row (audit-policy.ts).
      .toEqual(["membership.authorization", "organization.members.manage"]);
    await dbClient.begin(tx => mutateMembership(tx, f.actor, id(), async tx => {
      await tx`update organization_memberships set status='active' where organization_id=${f.org} and user_id=${f.member}`;
    }));
    for (const action of ["organization.members.read", "organization.authorization.manage", "organization.projects.create"] as const)
      expect((await store.decideOrganization({ organizationId: f.org, userId: f.member }, action)).allowed).toBe(false);
  });

  test("the last effective manager cannot be suspended, removed or globally disabled", async () => {
    const f = await fixture(), beforeAudit = await auditCount(f.org);
    // A second principal is listed but lacks read; nominal owner/admin also do not count.
    f.policy.administrators.push({ kind: "user", id: f.other });
    f.policy.organizationRules.push({ id: "deny-second-read", effect: "deny", principals: [{ kind: "user", id: f.other }], actions: ["organization.authorization.read"] });
    await publish(f.actor, f.policy);
    const policyAudit = await auditCount(f.org);
    expect(policyAudit).toBeGreaterThan(beforeAudit);
    for (const next of ["suspended", "removed"]) {
      await expect(dbClient.begin(tx => mutateMembership(tx, f.actor, id(), async tx => {
        await tx`update organization_memberships set status=${next} where organization_id=${f.org} and user_id=${f.manager}`;
      }))).rejects.toMatchObject({ payload: { error: "authorization_last_manager_required" } });
      expect(await status(f.org, f.manager)).toBe("active");
      expect(await auditCount(f.org)).toBe(policyAudit);
    }
    await expect(dbClient.begin(tx => mutateMembership(tx, f.actor, id(), async tx => {
      await tx`update users set status='disabled' where id=${f.manager}`;
    }))).rejects.toMatchObject({ payload: { error: "authorization_last_manager_required" } });
    expect((await dbClient`select status from users where id=${f.manager}`)[0]!.status).toBe("active");
  });

  test("inactive manager identities do not count; an active explicit manager permits removal", async () => {
    const f = await fixture();
    f.policy.administrators.push({ kind: "user", id: f.other });
    await publish(f.actor, f.policy);
    await dbClient`update users set status='disabled' where id=${f.other}`;
    const remove = () => dbClient.begin(tx => mutateMembership(tx, f.actor, id(), async tx => {
      await tx`delete from organization_memberships where organization_id=${f.org} and user_id=${f.manager}`;
    }));
    await expect(remove()).rejects.toMatchObject({ payload: { error: "authorization_last_manager_required" } });
    expect(await status(f.org, f.manager)).toBe("active");
    await dbClient`update users set status='active' where id=${f.other}`;
    await remove();
    expect(await status(f.org, f.manager)).toBeUndefined();
    expect((await store.read({ organizationId: f.org, userId: f.other })).canManage).toBe(true);
  });

  test("concurrent removals cannot both remove the two remaining managers", async () => {
    const f = await fixture();
    f.policy.administrators.push({ kind: "user", id: f.other });
    f.policy.organizationRules[0]!.principals.push({ kind: "user", id: f.other });
    await publish(f.actor, f.policy);
    const leave = (userId: string) => dbClient.begin(tx => mutateMembership(tx, { organizationId: f.org, userId }, id(), async tx => {
      await tx`update organization_memberships set status='removed' where organization_id=${f.org} and user_id=${userId}`;
    }));
    const results = await Promise.allSettled([leave(f.manager), leave(f.other)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(r => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ payload: { error: "authorization_last_manager_required" } });
    expect([await status(f.org, f.manager), await status(f.org, f.other)].sort()).toEqual(["active", "removed"]);
    expect(Number((await dbClient`select count(*) n from authorization_audit where organization_id=${f.org} and action='membership.authorization'`)[0]!.n)).toBe(1);
  });

  test("callback failure and attempted policy mutation roll back membership and audit", async () => {
    const f = await fixture(), before = await store.read(f.actor), count = await auditCount(f.org);
    await expect(dbClient.begin(tx => mutateMembership(tx, f.actor, id(), async tx => {
      await tx`update organization_memberships set status='removed' where organization_id=${f.org} and user_id=${f.member}`;
      throw new Error("Synthetic business failure");
    }))).rejects.toThrow("Synthetic business failure");
    await expect(dbClient.begin(tx => mutateMembership(tx, f.actor, id(), async tx => {
      await tx`update organization_memberships set status='removed' where organization_id=${f.org} and user_id=${f.member}`;
      await tx`update authorization_policy_heads set generation=generation+1 where organization_id=${f.org}`;
    }))).rejects.toMatchObject({ payload: { error: "authorization_membership_policy_changed" } });
    const escalation = policySchema.parse(before.active!.document);
    escalation.administrators.push({ kind: "user", id: f.member });
    await expect(dbClient.begin(tx => mutateMembership(tx, f.actor, id(), async tx => {
      await tx`update authorization_policy_revisions set document=${JSON.stringify(escalation)}::jsonb,digest=${policyDigest(escalation)} where id=${before.active!.id}`;
    }))).rejects.toMatchObject({ payload: { error: "authorization_membership_policy_changed" } });
    expect(await status(f.org, f.member)).toBe("active");
    expect((await store.read(f.actor)).generation).toBe(before.generation);
    expect((await store.read(f.actor)).active!.digest).toBe(before.active!.digest);
    expect(await auditCount(f.org)).toBe(count);
  });

  test("policy writers wait for the membership effect transaction, not only its initial check", async () => {
    const f = await fixture();
    let release!: () => void, enter!: () => void, publishPid!: (pid: number) => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const pidReady = new Promise<number>(resolve => { publishPid = resolve; });
    const effect = dbClient.begin(tx => mutateMembership(tx, f.actor, id(), async tx => {
      await tx`update organization_memberships set status='suspended' where organization_id=${f.org} and user_id=${f.member}`;
      enter(); await gate; return "committed";
    }));
    await entered;
    const writer = dbClient.begin(async tx => {
      publishPid(Number((await tx`select pg_backend_pid() pid`)[0]!.pid));
      // Same policy lock used by real draft/preview/publication; no policy bypass.
      await tx`select pg_advisory_xact_lock(hashtextextended(${`project-policy:${f.org}`},0))`;
    });
    try {
      const pid = await pidReady;
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        blocked = Boolean((await dbClient`select cardinality(pg_blocking_pids(${pid}))>0 blocked`)[0]!.blocked);
        if (blocked) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
    } finally { release(); }
    expect(await effect).toBe("committed");
    await writer;
    expect(await status(f.org, f.member)).toBe("suspended");
  });

  test("revoked identity, delegation and corrupt policy deny before any effect", async () => {
    const f = await fixture(); let effects = 0;
    await dbClient`update organization_memberships set status='suspended' where organization_id=${f.org} and user_id=${f.manager}`;
    await expect(dbClient.begin(tx => mutateMembership(tx, f.actor, id(), async () => ++effects))).rejects.toMatchObject({ status: 403 });
    await dbClient`update organization_memberships set status='active' where organization_id=${f.org} and user_id=${f.manager}`;
    const delegated = { ...f.actor, delegation: { installationId: id(), sessionId: id(), accessTokenJti: id(), bindingId: id() } };
    await expect(dbClient.begin(tx => mutateMembership(tx, delegated, id(), async () => ++effects))).rejects.toMatchObject({ status: 403 });
    const head = await store.read(f.actor);
    await dbClient`update authorization_policy_revisions set digest='synthetic-corruption' where id=${head.active!.id}`;
    await expect(dbClient.begin(tx => mutateMembership(tx, f.actor, id(), async () => ++effects))).rejects.toMatchObject({ status: 503 });
    expect(effects).toBe(0);
  });
});
