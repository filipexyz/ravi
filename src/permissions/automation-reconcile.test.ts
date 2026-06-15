import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { dbCreateCronJob, dbDeleteCronJob } from "../cron/cron-db.js";
import { dbCreateTrigger } from "../triggers/triggers-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { reconcileAutomationPrincipals } from "./automation-reconcile.js";
import { materializeDelegatedAuthority } from "./delegation.js";
import { snapshotSubjectCapabilities } from "./local-grants-capabilities.js";
import { canWithCapabilities } from "./capability-context.js";
import { grantRelation, listRelations } from "./relations.js";

let stateDir: string | null = null;

function delegatedAllows(
  automationId: string,
  agentId: string,
  relation: string,
  objectType: string,
  objectId: string,
) {
  const result = materializeDelegatedAuthority({
    agentPrincipal: { subjectType: "agent", subjectId: agentId },
    actorPrincipal: { subjectType: "automation", subjectId: automationId },
    surfacePrincipal: null,
    agentCapabilities: snapshotSubjectCapabilities("agent", agentId),
    actorCapabilities: snapshotSubjectCapabilities("automation", automationId),
  });
  return canWithCapabilities(result.effectiveCapabilities, relation, objectType, objectId);
}

describe("automation principal reconcile", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-automation-reconcile-test-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("mirrors the executor agent's role memberships onto a cron principal", () => {
    grantRelation("agent", "pattern-reviewer", "member", "role", "pattern-reviewer", "manual", { permanent: true });
    grantRelation("role", "pattern-reviewer", "execute", "group", "chats_lists_members", "manual", { permanent: true });
    const job = dbCreateCronJob({
      name: "review",
      agentId: "pattern-reviewer",
      schedule: { type: "every", every: 3_600_000 },
      message: "go",
    });

    // Before reconcile: the automation principal has no role and is denied.
    expect(delegatedAllows(`cron:${job.id}`, "pattern-reviewer", "execute", "group", "chats_lists_members")).toBe(
      false,
    );

    const granted = reconcileAutomationPrincipals();
    expect(granted).toBeGreaterThanOrEqual(1);

    expect(
      listRelations({ subjectType: "automation", subjectId: `cron:${job.id}`, relation: "member", objectType: "role" }),
    ).toContainEqual(expect.objectContaining({ objectId: "pattern-reviewer", source: "config" }));

    // After reconcile: the cron principal inherits the executor agent's role.
    expect(delegatedAllows(`cron:${job.id}`, "pattern-reviewer", "execute", "group", "chats_lists_members")).toBe(true);
    // ...but only what the role grants.
    expect(delegatedAllows(`cron:${job.id}`, "pattern-reviewer", "execute", "group", "whatsapp_group_create")).toBe(
      false,
    );
  });

  it("mirrors roles onto a trigger principal", () => {
    grantRelation("agent", "audit", "member", "role", "audit-agent", "manual", { permanent: true });
    grantRelation("role", "audit-agent", "execute", "group", "sessions_info", "manual", { permanent: true });
    const trigger = dbCreateTrigger({
      name: "alert",
      agentId: "audit",
      topic: "ravi.audit.denied",
      message: "check",
    });

    reconcileAutomationPrincipals();

    expect(delegatedAllows(`trigger:${trigger.id}`, "audit", "execute", "group", "sessions_info")).toBe(true);
  });

  it("is idempotent and drops memberships for removed automations", () => {
    grantRelation("agent", "audit", "member", "role", "audit-agent", "manual", { permanent: true });
    const job = dbCreateCronJob({
      name: "tmp",
      agentId: "audit",
      schedule: { type: "every", every: 3_600_000 },
      message: "go",
    });

    reconcileAutomationPrincipals();
    expect(
      listRelations({ subjectType: "automation", subjectId: `cron:${job.id}`, relation: "member", objectType: "role" }),
    ).toHaveLength(1);

    // Re-running without the cron job present should clear its config membership.
    dbDeleteCronJob(job.id);
    reconcileAutomationPrincipals();

    expect(
      listRelations({
        subjectType: "automation",
        subjectId: `cron:${job.id}`,
        relation: "member",
        objectType: "role",
        includeInactive: true,
      }),
    ).toHaveLength(0);
  });

  it("does not touch manual automation memberships", () => {
    grantRelation("automation", "cron:manual-one", "member", "role", "special", "manual", { permanent: true });
    reconcileAutomationPrincipals();
    expect(
      listRelations({
        subjectType: "automation",
        subjectId: "cron:manual-one",
        relation: "member",
        objectType: "role",
      }),
    ).toHaveLength(1);
  });
});
