import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/server/db";
import { ConsoleApiError } from "../api-error";
import { auditAuthorizationDecision, type AuthorizationAuditMode } from "./audit-policy";
import { canManagePolicy, compilePolicy, type AuthorizationDecision, type AuthorizationFacts } from "./engine";
import { loadActiveActor, loadProjectFacts, loadOrganizationFacts, type ActiveActor, type AuthorizationActor, type AuthorizationExecutor } from "./identity";
import { canonicalJson, initialPolicy, policyDigest, policySchema, PROJECT_ACTIONS, ORGANIZATION_ACTIONS, type OrganizationAction, type ProjectAction, type ProjectPolicy } from "./policy";
import { authorizationAudit as audit, authorizationMutationReceipts as receipts, authorizationPolicyHeads as heads,
  authorizationPolicyPreviews as previews, authorizationPolicyRevisions as revisions } from "./schema";

type Head = typeof heads.$inferSelect;
type State = Pick<Head, "generation" | "activeRevisionId" | "draftRevisionId">;
type Revision = typeof revisions.$inferSelect;
const state = (head: Head): State => ({ generation: head.generation, activeRevisionId: head.activeRevisionId, draftRevisionId: head.draftRevisionId });
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
function fail(status: number, error: string): never { throw new ConsoleApiError(status, { error }); }
const generation = z.number().int().min(0).max(2147483646);
const mutationSchema = z.object({ expectedGeneration: generation, operationKey: z.uuid(), reason: z.string().trim().min(3).max(300) });
export const saveDraftSchema = mutationSchema.extend({ document: policySchema }).strict();
export const publishSchema = mutationSchema.extend({ previewId: z.uuid() }).strict();
export const previewSchema = z.object({ expectedGeneration: generation }).strict();
export const rollbackSchema = mutationSchema.extend({ revisionId: z.uuid() }).strict();
const simulationBase = { expectedGeneration: generation, userId: z.uuid(), source: z.enum(["active", "draft"]) };
export const simulationSchema = z.union([
  z.object({ ...simulationBase, projectId: z.uuid(), action: z.enum(PROJECT_ACTIONS) }).strict(),
  z.object({ ...simulationBase, resourceKind: z.literal("organization"), action: z.enum(ORGANIZATION_ACTIONS) }).strict(),
]);

async function readRevision(executor: AuthorizationExecutor, org: string, id: string | null): Promise<Revision | null> {
  if (!id) return null;
  const [row] = await executor.select().from(revisions).where(and(eq(revisions.id, id), eq(revisions.organizationId, org))).limit(1);
  if (!row || policyDigest(policySchema.parse(row.document)) !== row.digest) fail(503, "authorization_revision_invalid");
  return row;
}

async function headFor(executor: AuthorizationExecutor, org: string, create = false): Promise<Head | null> {
  if (create) await executor.insert(heads).values({ organizationId: org }).onConflictDoNothing();
  const [row] = await executor.select().from(heads).where(eq(heads.organizationId, org)).limit(1).for("share");
  return row ?? null;
}

async function administrativeContext(executor: AuthorizationExecutor, input: AuthorizationActor, action: OrganizationAction = "organization.authorization.manage") {
  // CLI delegation cannot administer policy. The administrative browser adapter
  // is separate; the same project decision engine still handles native CLI data.
  if (input.delegation) fail(403, "authorization_admin_required");
  const actor = await loadActiveActor(executor, input, true);
  const head = await headFor(executor, actor.organizationId);
  const active = await readRevision(executor, actor.organizationId, head?.activeRevisionId ?? null);
  if (!active) fail(403, "authorization_admin_required");
  const engine = await compilePolicy(active.document), facts = await loadOrganizationFacts(executor, actor);
  if (!(await engine.decideOrganization(facts, action)).allowed ||
    (action === "organization.authorization.manage" && !(await engine.decideOrganization(facts, "organization.authorization.read")).allowed))
      fail(403, "authorization_admin_required");
  return { actor, head, active };
}

async function validateReferences(executor: AuthorizationExecutor, document: ProjectPolicy) {
  const [members, projects, installations, services, bridgeInstallations] = await Promise.all([
    executor.select({ id: schema.organizationMemberships.userId }).from(schema.organizationMemberships)
      .innerJoin(schema.users, eq(schema.users.id, schema.organizationMemberships.userId))
      .where(and(eq(schema.organizationMemberships.organizationId, document.organizationId),
        eq(schema.organizationMemberships.status, "active"), eq(schema.users.status, "active"))),
    executor.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.organizationId, document.organizationId)),
    executor.select({ id: schema.localInstallations.id }).from(schema.localInstallations).where(eq(schema.localInstallations.organizationId, document.organizationId)),
    executor.select({ id: schema.apiKeyServicePrincipals.id }).from(schema.apiKeyServicePrincipals)
      .where(and(eq(schema.apiKeyServicePrincipals.organizationId, document.organizationId), eq(schema.apiKeyServicePrincipals.status, "active"))),
    executor.select({id:schema.fleetInstallations.id}).from(schema.fleetInstallations).where(eq(schema.fleetInstallations.organizationId, document.organizationId)),
  ]);
  const userIds = new Set(members.map((m) => m.id));
  const projectIds = new Set(projects.map((p) => p.id));
  const installationIds = new Set(installations.map((i) => i.id));
  const serviceIds = new Set(services.map((i) => i.id));
  for (const user of [...document.groups.flatMap((g) => g.members), ...(document.roles ?? []).flatMap(r => r.members)]) if (!userIds.has(user)) fail(400, "authorization_reference_invalid");
  for (const principal of [...document.administrators, ...document.rules.flatMap((r) => r.principals), ...(document.organizationRules ?? []).flatMap(r => r.principals), ...(document.bridgeRules ?? []).flatMap(r => r.principals)]) {
    if (principal.kind === "user" && !userIds.has(principal.id)) fail(400, "authorization_reference_invalid");
    if (principal.kind === "service" && !serviceIds.has(principal.id)) fail(400, "authorization_reference_invalid");
    if (principal.kind === "installation" && !installationIds.has(principal.id)) fail(400, "authorization_reference_invalid");
    if (principal.kind === "agent" && !installationIds.has(principal.installationId)) fail(400, "authorization_reference_invalid");
  }
  const bridgeInstallationIds = new Set(bridgeInstallations.map(i=>i.id));
  for (const b of document.bridgeAgents ?? []) if (!bridgeInstallationIds.has(b.installationId) || !projectIds.has(b.projectId)) fail(400,"authorization_reference_invalid");
  for (const id of [...document.rules.flatMap((r) => r.projects), ...(document.roles ?? []).flatMap(r => r.scope.kind === "project" ? r.scope.projects : [])]) if (id !== "*" && !projectIds.has(id)) fail(400, "authorization_reference_invalid");
}

async function calculateImpact(executor: AuthorizationExecutor, org: string, before: ProjectPolicy | null, after: ProjectPolicy) {
  const [members, projects, memberships, services] = await Promise.all([
    executor.select({ id: schema.users.id, role: schema.organizationMemberships.role }).from(schema.organizationMemberships)
      .innerJoin(schema.users, eq(schema.users.id, schema.organizationMemberships.userId))
      .where(and(eq(schema.organizationMemberships.organizationId, org), eq(schema.organizationMemberships.status, "active"), eq(schema.users.status, "active"))).orderBy(schema.users.id),
    executor.select({ id: schema.projects.id, name: schema.projects.name }).from(schema.projects)
      .where(eq(schema.projects.organizationId, org)).orderBy(schema.projects.id),
    executor.select({ userId: schema.projectMemberships.userId, projectId: schema.projectMemberships.projectId, role: schema.projectMemberships.role })
      .from(schema.projectMemberships).innerJoin(schema.projects, eq(schema.projects.id, schema.projectMemberships.projectId))
      .where(and(eq(schema.projects.organizationId, org), eq(schema.projectMemberships.status, "active")))
      .orderBy(schema.projectMemberships.projectId, schema.projectMemberships.userId),
    executor.select({ id: schema.apiKeyServicePrincipals.id, name: schema.apiKeyServicePrincipals.name,
      status: schema.apiKeyServicePrincipals.status, revision: schema.apiKeyServicePrincipals.revision }).from(schema.apiKeyServicePrincipals)
      .where(eq(schema.apiKeyServicePrincipals.organizationId, org)).orderBy(schema.apiKeyServicePrincipals.id),
  ]);
  const evaluated = (members.length + services.length) * (projects.length * PROJECT_ACTIONS.length + ORGANIZATION_ACTIONS.length);
  if (evaluated > 15000) fail(422, "authorization_preview_too_large");
  const oldEngine = before ? await compilePolicy(before) : null;
  const newEngine = await compilePolicy(after);
  const roles = new Map(memberships.map((m) => [`${m.projectId}:${m.userId}`, m.role]));
  const changes: { userId: string; projectId: string; projectName: string; action: ProjectAction; before: boolean; after: boolean }[] = [];
  let allowedBefore = 0, allowedAfter = 0, added = 0, removed = 0;
  for (const member of members) for (const project of projects) {
    const facts: AuthorizationFacts = { organizationId: org, projectOrganizationId: org, projectId: project.id,
      userId: member.id, organizationRole: member.role, projectRole: roles.get(`${project.id}:${member.id}`) ?? null, active: true };
    for (const action of PROJECT_ACTIONS) {
      const was = oldEngine ? (await oldEngine.decide(facts, action)).allowed : false;
      const will = (await newEngine.decide(facts, action)).allowed;
      allowedBefore += Number(was); allowedAfter += Number(will);
      added += Number(!was && will); removed += Number(was && !will);
      if (was !== will && changes.length < 50) changes.push({ userId: member.id, projectId: project.id, projectName: project.name, action, before: was, after: will });
    }
  }
  const organizationSample: { userId: string; action: OrganizationAction; before: boolean; after: boolean }[] = [];
  let organizationAdded = 0, organizationRemoved = 0;
  for (const member of members) for (const action of ORGANIZATION_ACTIONS) {
    const facts = { organizationId: org, userId: member.id, organizationRole: member.role, active: true };
    const was = oldEngine ? (await oldEngine.decideOrganization(facts, action)).allowed : false;
    const will = (await newEngine.decideOrganization(facts, action)).allowed;
    allowedBefore += Number(was); allowedAfter += Number(will);
    added += Number(!was && will); removed += Number(was && !will);
    organizationAdded += Number(!was && will); organizationRemoved += Number(was && !will);
    if (was !== will && organizationSample.length < 50) organizationSample.push({ userId: member.id, action, before: was, after: will });
  }
  const serviceSample: { serviceId: string; name: string; resource: string; action: string; before: boolean; after: boolean }[] = [];
  for (const service of services) {
    const facts = { organizationId: org, servicePrincipalId: service.id, active: service.status === "active" };
    const resources = [{ resource: { kind: "organization" as const, id: org }, actions: ORGANIZATION_ACTIONS },
      ...projects.map(p => ({ resource: { kind: "project" as const, id: p.id }, actions: PROJECT_ACTIONS }))];
    for (const { resource, actions } of resources) for (const action of actions) {
      const was = oldEngine ? (await oldEngine.decideService(facts, resource, action)).allowed : false;
      const will = (await newEngine.decideService(facts, resource, action)).allowed;
      allowedBefore += Number(was); allowedAfter += Number(will);
      added += Number(!was && will); removed += Number(was && !will);
      if (was !== will && serviceSample.length < 50) serviceSample.push({ serviceId: service.id, name: service.name, resource: resource.id, action, before: was, after: will });
      if (resource.kind === "organization") { organizationAdded += Number(!was && will); organizationRemoved += Number(was && !will); }
    }
  }
  const bridgeChanged = JSON.stringify(before?.bridgeAgents ?? []) !== JSON.stringify(after.bridgeAgents ?? []) ||
    JSON.stringify(before?.bridgeRules ?? []) !== JSON.stringify(after.bridgeRules ?? []);
  const summary = { bridgeChanged, bridgeAgents:after.bridgeAgents ?? [], bridgeRules:after.bridgeRules ?? [], evaluated, allowedBefore, allowedAfter, added, removed, organizationAdded, organizationRemoved, serviceSample,
    initialActivation: !before, sample: changes, organizationSample, delegationPreview: "requires_explicit_installation_grants" as const };
  // Membership edits during review invalidate publication, even if sampled changes
  // remain identical. The preview is not a reusable authorization capability.
  return { summary, digest: digest({ members, projects, memberships, services, before: before ? policyDigest(before) : null, after: policyDigest(after), summary }) };
}

export function createAuthorizationStore(database = db) {
  const mutate = async (actorInput: AuthorizationActor, input: z.infer<typeof mutationSchema>, kind: string, payload: unknown,
    change: (executor: AuthorizationExecutor, actor: ActiveActor, head: Head, active: Revision | null) => Promise<State>) => database.transaction(async (tx) => {
      // Serialize even first initialization. Lock namespace is independent of Fleet.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`project-policy:${actorInput.organizationId}`}, 0))`);
      const { actor, active } = await administrativeContext(tx, actorInput);
      const head = (await headFor(tx, actor.organizationId, true))!;
      await tx.execute(sql`select 1 from ${heads} where ${heads.organizationId}=${actor.organizationId} for update`);
      const inputDigest = digest({ kind, actorId: actor.userId, input: payload });
      const [receipt] = await tx.select().from(receipts).where(and(eq(receipts.organizationId, actor.organizationId), eq(receipts.operationKey, input.operationKey))).limit(1);
      if (receipt) {
        if (receipt.actorId !== actor.userId || receipt.inputDigest !== inputDigest) fail(409, "authorization_idempotency_conflict");
        return receipt.result;
      }
      if (head.generation !== input.expectedGeneration) fail(409, "authorization_revision_conflict");
      const result = await change(tx, actor, head, active);
      await tx.update(heads).set({ ...result, updatedAt: new Date() }).where(eq(heads.organizationId, actor.organizationId));
      await tx.insert(receipts).values({ organizationId: actor.organizationId, actorId: actor.userId, operationKey: input.operationKey, inputDigest, result });
      await tx.insert(audit).values({ organizationId: actor.organizationId, actorId: actor.userId, action: kind,
        revisionId: kind === "policy.publish" ? result.activeRevisionId : result.draftRevisionId, generation: result.generation,
        requestId: input.operationKey, metadata: { reason: input.reason, inputDigest, previousActiveRevisionId: head.activeRevisionId } });
      return result;
    });

  const save = async (actor: AuthorizationActor, unknownInput: unknown) => {
    const input = saveDraftSchema.parse(unknownInput);
    return mutate(actor, input, "policy.draft", input, async (tx, actor, head) => {
      if (input.document.organizationId !== actor.organizationId) fail(400, "authorization_org_mismatch");
      await validateReferences(tx, input.document);
      if (!(await canManagePolicy(input.document, actor))) fail(409, "authorization_self_lockout");
      const [revision] = await tx.insert(revisions).values({ organizationId: actor.organizationId, document: input.document,
        digest: policyDigest(input.document), createdBy: actor.userId, reason: input.reason }).returning({ id: revisions.id });
      return { ...state(head), generation: head.generation + 1, draftRevisionId: revision!.id };
    });
  };

  return {
    async read(actorInput: AuthorizationActor) {
      return database.transaction(async (tx) => {
        const { actor, head, active } = await administrativeContext(tx, actorInput, "organization.authorization.read");
        const draft = await readRevision(tx, actor.organizationId, head?.draftRevisionId ?? null);
        const history = await tx.select({ id: revisions.id, digest: revisions.digest, createdAt: revisions.createdAt, reason: revisions.reason, createdBy: revisions.createdBy })
          .from(revisions).where(eq(revisions.organizationId, actor.organizationId)).orderBy(desc(revisions.createdAt)).limit(30);
        const events = await tx.select().from(audit).where(and(eq(audit.organizationId, actor.organizationId), sql`${audit.action} like 'policy.%'`)).orderBy(desc(audit.createdAt)).limit(50);
        const members = await tx.select({ id: schema.users.id, name: schema.users.displayName, email: schema.users.primaryEmail, role: schema.organizationMemberships.role })
          .from(schema.organizationMemberships).innerJoin(schema.users, eq(schema.users.id, schema.organizationMemberships.userId))
          .where(and(eq(schema.organizationMemberships.organizationId, actor.organizationId), eq(schema.organizationMemberships.status, "active"), eq(schema.users.status, "active")));
        const projects = await tx.select({ id: schema.projects.id, name: schema.projects.name }).from(schema.projects).where(eq(schema.projects.organizationId, actor.organizationId));
        const installations = await tx.select({ id: schema.localInstallations.id, name: schema.localInstallations.name }).from(schema.localInstallations)
          .where(and(eq(schema.localInstallations.organizationId, actor.organizationId), eq(schema.localInstallations.status, "active")));
        const services = await tx.select({ id: schema.apiKeyServicePrincipals.id, name: schema.apiKeyServicePrincipals.name })
          .from(schema.apiKeyServicePrincipals).where(and(eq(schema.apiKeyServicePrincipals.organizationId, actor.organizationId), eq(schema.apiKeyServicePrincipals.status, "active")));
        return { generation: head?.generation ?? 0, currentUserId: actor.userId, organizationId: actor.organizationId,
          canManage: active ? await canManagePolicy(active.document, actor) : false, active, draft, history, events, members, projects, installations, services,
          initialProposal: active || draft ? null : initialPolicy(actor.organizationId, actor.userId) };
      });
    },
    saveDraft: save,
    async simulate(actorInput: AuthorizationActor, unknownInput: unknown) {
      const input = simulationSchema.parse(unknownInput);
      return database.transaction(async (tx) => {
        const { actor, head } = await administrativeContext(tx, actorInput);
        if (!head || head.generation !== input.expectedGeneration) fail(409, "authorization_revision_conflict");
        const revision = await readRevision(tx, actor.organizationId, input.source === "draft" ? head.draftRevisionId : head.activeRevisionId);
        if (!revision) fail(409, "authorization_revision_required");
        // Administrative simulation, not a credential or an operation as this user.
        const target = await loadActiveActor(tx, { organizationId: actor.organizationId, userId: input.userId }, true);
        if ("resourceKind" in input) return {
          ...(await (await compilePolicy(revision.document)).decideOrganization(await loadOrganizationFacts(tx, target), input.action)),
          generation: head.generation, revisionId: revision.id, simulation: true as const,
          action: input.action, userId: target.userId, resourceKind: "organization" as const, organizationId: actor.organizationId,
        };
        const facts = await loadProjectFacts(tx, target, input.projectId);
        if (!facts) fail(404, "project_not_found");
        return { ...(await (await compilePolicy(revision.document)).decide(facts, input.action)), generation: head.generation,
          revisionId: revision.id, simulation: true as const, action: input.action, userId: target.userId, projectId: input.projectId };
      });
    },
    async preview(actorInput: AuthorizationActor, unknownInput: unknown) {
      const input = previewSchema.parse(unknownInput);
      return database.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`project-policy:${actorInput.organizationId}`}, 0))`);
        const { actor, head, active } = await administrativeContext(tx, actorInput);
        if (!head || head.generation !== input.expectedGeneration) fail(409, "authorization_revision_conflict");
        const draft = await readRevision(tx, actor.organizationId, head.draftRevisionId);
        if (!draft) fail(409, "authorization_draft_required");
        await validateReferences(tx, draft.document);
        if (!(await canManagePolicy(draft.document, actor))) fail(409, "authorization_self_lockout");
        const impact = await calculateImpact(tx, actor.organizationId, active?.document ?? null, draft.document);
        const [preview] = await tx.insert(previews).values({ organizationId: actor.organizationId, revisionId: draft.id,
          generation: head.generation, actorId: actor.userId, impactDigest: impact.digest, expiresAt: new Date(Date.now() + 300_000) }).returning({ id: previews.id, expiresAt: previews.expiresAt });
        return { ...preview!, generation: head.generation, revisionId: draft.id, impact: impact.summary };
      });
    },
    async publish(actor: AuthorizationActor, unknownInput: unknown) {
      const input = publishSchema.parse(unknownInput);
      return mutate(actor, input, "policy.publish", input, async (tx, actor, head, active) => {
        const [preview] = await tx.select().from(previews).where(and(eq(previews.id, input.previewId), eq(previews.organizationId, actor.organizationId),
          eq(previews.actorId, actor.userId), eq(previews.generation, head.generation), sql`${previews.expiresAt}>now()`)).limit(1);
        if (!preview || preview.revisionId !== head.draftRevisionId) fail(409, "authorization_preview_required");
        const draft = await readRevision(tx, actor.organizationId, head.draftRevisionId);
        if (!draft || !(await canManagePolicy(draft.document, actor))) fail(409, "authorization_self_lockout");
        await validateReferences(tx, draft.document);
        const impact = await calculateImpact(tx, actor.organizationId, active?.document ?? null, draft.document);
        if (impact.digest !== preview.impactDigest) fail(409, "authorization_preview_stale");
        return { generation: head.generation + 1, activeRevisionId: draft.id, draftRevisionId: null };
      });
    },
    async prepareRollback(actor: AuthorizationActor, unknownInput: unknown) {
      const input = rollbackSchema.parse(unknownInput);
      return mutate(actor, input, "policy.rollback_draft", input, async (tx, actor, head) => {
        const previous = await readRevision(tx, actor.organizationId, input.revisionId);
        if (!previous) fail(404, "authorization_revision_not_found");
        await validateReferences(tx, previous.document);
        if (!(await canManagePolicy(previous.document, actor))) fail(409, "authorization_self_lockout");
        const [copy] = await tx.insert(revisions).values({ organizationId: actor.organizationId, document: previous.document,
          digest: previous.digest, createdBy: actor.userId, reason: input.reason }).returning({ id: revisions.id });
        return { ...state(head), generation: head.generation + 1, draftRevisionId: copy!.id };
      });
    },
    async decideOrganization(actor: AuthorizationActor, action: OrganizationAction, requestId = crypto.randomUUID()) {
      return database.transaction(tx => decideOrganizationInTransaction(tx, actor, action, requestId));
    },
    async withAuthorizedOrganization<T>(actor: AuthorizationActor, action: OrganizationAction,
      effect: (tx: AuthorizationExecutor) => Promise<T>, requestId = crypto.randomUUID()) {
      const outcome = await database.transaction(async tx => {
        const decision = await decideOrganizationInTransaction(tx, actor, action, requestId);
        return decision.allowed ? { allowed: true as const, result: await effect(tx) } : { allowed: false as const };
      });
      if (!outcome.allowed) fail(403, "organization_forbidden");
      return outcome.result;
    },
    /** Independent single-resource observation. Effects must use withAuthorizedProject. */
    async decide(actorInput: AuthorizationActor, projectId: string, action: ProjectAction, requestId = crypto.randomUUID()) {
      return database.transaction((tx) => decideInTransaction(tx, actorInput, projectId, action, requestId));
    },
    async withAuthorizedProject<T>(actorInput: AuthorizationActor, projectId: string, action: ProjectAction,
      effect: (tx: AuthorizationExecutor) => Promise<T>, requestId = crypto.randomUUID()) {
      const outcome = await database.transaction(async (tx) => {
        const result = await decideInTransaction(tx, actorInput, projectId, action, requestId);
        if (!result.allowed) return { allowed: false as const };
        return { allowed: true as const, result: await effect(tx) };
      });
      if (!outcome.allowed) fail(403, "project_forbidden");
      return outcome.result;
    },
    async accessibleProjects(actorInput: AuthorizationActor, action: ProjectAction = "project.read") {
      return database.transaction((tx) => accessibleProjectsInTransaction(tx, actorInput, action));
    },
  };
}

/** The caller keeps this transaction open through data projection/effect. */
export async function accessibleProjectsInTransaction(tx: AuthorizationExecutor, actorInput: AuthorizationActor, action: ProjectAction = "project.read") {
  const actor = await loadActiveActor(tx, actorInput, true);
  const [head] = await tx.select().from(heads).where(eq(heads.organizationId, actor.organizationId)).for("share");
  const revision = await readRevision(tx, actor.organizationId, head?.activeRevisionId ?? null);
  if (!revision) return [];
  const engine = await compilePolicy(revision.document);
  const projects = await tx.select().from(schema.projects).where(eq(schema.projects.organizationId, actor.organizationId))
    .orderBy(desc(schema.projects.updatedAt), schema.projects.id).for("share");
  const organizationFacts = await loadOrganizationFacts(tx, actor);
  const memberships = await tx.select({ projectId: schema.projectMemberships.projectId, role: schema.projectMemberships.role })
    .from(schema.projectMemberships).innerJoin(schema.projects, eq(schema.projects.id, schema.projectMemberships.projectId))
    .where(and(eq(schema.projects.organizationId, actor.organizationId), eq(schema.projectMemberships.userId, actor.userId),
      eq(schema.projectMemberships.status, "active"))).for("share");
  const roles = new Map(memberships.map(member => [member.projectId, member.role]));
  const allowed: (typeof schema.projects.$inferSelect)[] = [];
  for (const project of projects) {
    const facts = { ...organizationFacts, projectId: project.id, projectOrganizationId: project.organizationId,
      projectRole: roles.get(project.id) ?? null };
    if ((await engine.decide(facts, action)).allowed) allowed.push(project);
  }
  // A filtered read list is visibility, not a refused attempt (a member rarely sees every
  // project), so it writes no row; non-read listings keep one summary, never a row per project.
  if (auditAuthorizationDecision(action, true)) await tx.insert(audit).values({ organizationId: actor.organizationId, actorId: actor.userId, action: "project.list",
    generation: head!.generation, revisionId: revision.id, requestId: crypto.randomUUID(),
    metadata: { action, returnedProjectIds: allowed.map((p) => p.id), policyDigest: revision.digest,
      installationId: actor.delegation?.installationId ?? null, bindingId: actor.delegation?.bindingId ?? null } });
  return allowed;
}

export async function decideInTransaction(executor: AuthorizationExecutor, input: AuthorizationActor, projectId: string,
  action: ProjectAction, requestId: string, mode: AuthorizationAuditMode = "decision"): Promise<AuthorizationDecision & { revisionId: string | null; generation: number }> {
  const actor = await loadActiveActor(executor, input, true);
  const [head] = await executor.select().from(heads).where(eq(heads.organizationId, actor.organizationId)).for("share");
  const revision = await readRevision(executor, actor.organizationId, head?.activeRevisionId ?? null);
  const facts = await loadProjectFacts(executor, actor, projectId);
  let result: AuthorizationDecision = { allowed: false, reason: "not_configured", policyDigest: null, lanes: [] };
  if (revision && facts) result = await (await compilePolicy(revision.document)).decide(facts, action);
  else if (!facts) result = { ...result, reason: "invalid_identity" };
  const decision = { ...result, revisionId: revision?.id ?? null, generation: head?.generation ?? 0 };
  if (auditAuthorizationDecision(action, decision.allowed, mode)) await executor.insert(audit).values({ organizationId: actor.organizationId, actorId: actor.userId,
    projectId: facts?.projectId ?? null, action, revisionId: decision.revisionId, generation: decision.generation, requestId,
    metadata: { allowed: decision.allowed, reason: decision.reason, policyDigest: decision.policyDigest, lanes: decision.lanes,
      installationId: actor.delegation?.installationId ?? null, bindingId: actor.delegation?.bindingId ?? null } });
  return decision;
}

export const authorizationStore = createAuthorizationStore();

/** SERVER-ONLY creation preflight. candidateId is generated by the service,
 * never supplied by a body. It is the exact UUID inserted in THIS transaction.
 * No implicit creator grant: current future-project rules must allow read/write.
 */
export async function authorizeProjectCreationInTransaction(executor: AuthorizationExecutor, actor: AuthorizationActor,
  candidateId: string, requestId: string) {
  z.uuid().parse(candidateId);
  const organization = await decideOrganizationInTransaction(executor, actor, "organization.projects.create", requestId);
  if (!organization.allowed) return false;
  const [existing] = await executor.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.id, candidateId)).limit(1);
  if (existing) fail(409, "project_creation_id_conflict");
  const active = await loadActiveActor(executor, actor, true);
  const revision = await readRevision(executor, actor.organizationId, organization.revisionId);
  if (!revision) return false;
  const facts = { ...(await loadOrganizationFacts(executor, active)), projectId: candidateId,
    projectOrganizationId: actor.organizationId, projectRole: null };
  const engine = await compilePolicy(revision.document);
  const decisions = await Promise.all([engine.decide(facts, "project.read"), engine.decide(facts, "project.write")]);
  const allowed = decisions.every(decision => decision.allowed);
  await executor.insert(audit).values({ organizationId: actor.organizationId, actorId: actor.userId,
    action: "project.creation.review", revisionId: revision.id, generation: organization.generation, requestId,
    metadata: { candidateId, allowed, requiredActions: ["project.read", "project.write"], decisions,
      installationId: actor.delegation?.installationId ?? null, bindingId: actor.delegation?.bindingId ?? null } });
  return allowed;
}

/** SAME transaction as the caller's configuration mutation; never accept actor from a body. */
export async function decideOrganizationInTransaction(executor: AuthorizationExecutor, input: AuthorizationActor,
  action: OrganizationAction, requestId: string) {
  if (!(ORGANIZATION_ACTIONS as readonly string[]).includes(action)) fail(400, "authorization_action_invalid");
  const actor = await loadActiveActor(executor, input, true);
  const head = await headFor(executor, actor.organizationId);
  const revision = await readRevision(executor, actor.organizationId, head?.activeRevisionId ?? null);
  const result: AuthorizationDecision = revision
    ? await (await compilePolicy(revision.document)).decideOrganization(await loadOrganizationFacts(executor, actor), action)
    : { allowed: false, reason: "not_configured", policyDigest: null, lanes: [] };
  const decision = { ...result, revisionId: revision?.id ?? null, generation: head?.generation ?? 0 };
  if (auditAuthorizationDecision(action, decision.allowed)) await executor.insert(audit).values({ organizationId: actor.organizationId, actorId: actor.userId, action,
    revisionId: decision.revisionId, generation: decision.generation, requestId,
    metadata: { resourceKind: "organization", allowed: decision.allowed, reason: decision.reason,
      policyDigest: decision.policyDigest, lanes: decision.lanes,
      installationId: actor.delegation?.installationId ?? null, bindingId: actor.delegation?.bindingId ?? null } });
  return decision;
}
