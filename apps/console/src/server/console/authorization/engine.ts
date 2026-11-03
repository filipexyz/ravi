import { newEnforcer, newModelFromString } from "casbin";
import type { AuthorizationResource } from "@/shared/project-authorization";
import { policyDigest, policySchema, principalKey, type ProjectAction, type OrganizationAction, type ParsedPolicy, type ProjectPolicy } from "./policy";

// Product-owned model. Editors supply bounded literals, never expressions.
const MODEL = [
  "[request_definition]", "r = subjects, resource, action",
  "[policy_definition]", "p = subject, resource, action, eft, rule",
  "[policy_effect]", "e = some(where (p.eft == allow)) && !some(where (p.eft == deny))",
  "[matchers]", 'm = hasSubject(r.subjects, p.subject) && (p.resource == r.resource || (p.resource == "project:*" && isProject(r.resource))) && r.action == p.action',
].join("\n");

/** Trusted server facts; NOT a browser/CLI body schema. Role names are ignored. */
export type AuthorizationFacts = {
  organizationId: string; projectId: string; projectOrganizationId: string;
  userId: string; active: boolean; organizationRole: string; projectRole: string | null;
  delegation?: { installationId: string; organizationId: string; userId: string; active: boolean;
    bindingId: string | null; agent?: { id: string; active: boolean } };
};
export type OrganizationFacts = Omit<AuthorizationFacts, "projectId" | "projectOrganizationId" | "projectRole">;
export type DecisionLane = "human" | "installation" | "agent" | "service";
export type AuthorizationDecision = {
  allowed: boolean;
  reason: "allowed" | "no_grant" | "explicit_deny" | "invalid_identity" | "invalid_policy" | "not_configured";
  policyDigest: string | null;
  lanes: { lane: DecisionLane; allowed: boolean; ruleIds: string[] }[];
};
function humanSubjects(policy: ParsedPolicy, userId: string, resource: AuthorizationResource) {
  const groupIds = policy.groups.filter(g => g.members.includes(userId)).map(g => g.id);
  const subjects = ["user:" + userId, ...groupIds.map(id => "group:" + id)];
  for (const role of policy.roles) {
    const assigned = role.members.includes(userId) || role.groups.some(id => groupIds.includes(id));
    const scoped = role.scope.kind === resource.kind &&
      (role.scope.kind === "organization" || role.scope.projects.includes("*") || role.scope.projects.includes(resource.id));
    if (assigned && scoped) subjects.push("role:" + role.id);
  }
  return subjects;
}
export async function canManagePolicy(policy: ProjectPolicy, facts: Pick<OrganizationFacts, "organizationId" | "userId" | "organizationRole" | "active">) {
  const engine = await compilePolicy(policy);
  const human = { organizationId: facts.organizationId, userId: facts.userId, organizationRole: facts.organizationRole, active: facts.active };
  return (await engine.decideOrganization(human, "organization.authorization.manage")).allowed &&
    (await engine.decideOrganization(human, "organization.authorization.read")).allowed;
}
// Content only: no membership, session, delegation or decision enters this cache.
// Both entry count and serialized bytes are bounded; failed builds are evicted.
const MAX_COMPILED = 16, MAX_COMPILED_BYTES = 2 * 1024 * 1024;
type Compiled = Awaited<ReturnType<typeof buildPolicy>>;
const compiled = new Map<string, { bytes: number; promise: Promise<Compiled> }>();
let compiledBytes = 0, compilationCount = 0;
export function policyCompilationMetrics() { return { entries: compiled.size, bytes: compiledBytes, compilations: compilationCount }; }
function freezeDocument<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freezeDocument(item);
    Object.freeze(value);
  }
  return value;
}
export async function compilePolicy(input: unknown): Promise<Compiled> {
  // Parse/copy even on a hit; callers cannot modify the cached policy by alias.
  const policy = policySchema.parse(input), digest = policyDigest(policy);
  const key = `${policy.organizationId}:${digest}`, hit = compiled.get(key);
  if (hit) { compiled.delete(key); compiled.set(key, hit); return hit.promise; }
  const bytes = Buffer.byteLength(JSON.stringify(policy));
  const promise = buildPolicy(freezeDocument(policy), digest);
  if (bytes > MAX_COMPILED_BYTES) return promise;
  while (compiled.size >= MAX_COMPILED || compiledBytes + bytes > MAX_COMPILED_BYTES) {
    const oldest = compiled.keys().next().value!;
    compiledBytes -= compiled.get(oldest)!.bytes; compiled.delete(oldest);
  }
  compiled.set(key, { bytes, promise }); compiledBytes += bytes;
  try { return await promise; } catch (error) {
    if (compiled.get(key)?.promise === promise) { compiled.delete(key); compiledBytes -= bytes; }
    throw error;
  }
}
function bridgeResource(projectId:string, installationId:string, agentId:string) {return `bridge:${projectId}:${installationId}:${agentId}`;}
const capKey = (c: {permission:string;objectType:string;objectId:string}) => JSON.stringify([c.permission,c.objectType,c.objectId]);
async function buildPolicy(policy: ParsedPolicy, digest: string) {
  compilationCount++;
  const enforcer = await newEnforcer(newModelFromString(MODEL));
  enforcer.enableAutoSave(false); enforcer.enableLog(false);
  enforcer.addFunction("hasSubject", (values: unknown, subject: unknown) =>
    Array.isArray(values) && typeof subject === "string" && values.includes(subject));
  enforcer.addFunction("isProject", (value: unknown) => typeof value === "string" && value.startsWith("project:"));
  const rows: string[][] = [];
  for (const rule of policy.rules) for (const principal of rule.principals) {
    for (const project of rule.projects) for (const action of rule.actions)
      rows.push([principalKey(principal), "project:" + project, action, rule.effect, rule.id]);
  }
  for (const rule of policy.organizationRules) for (const principal of rule.principals) for (const action of rule.actions)
    rows.push([principalKey(principal), "organization:" + policy.organizationId, action, rule.effect, rule.id]);
  for (const principal of policy.administrators) for (const action of ["organization.authorization.read", "organization.authorization.manage"])
    rows.push([principalKey(principal), "organization:" + policy.organizationId, action, "allow", "$policy-administrators"]);
  for (const rule of policy.bridgeRules ?? []) for (const principal of rule.principals) for (const capability of rule.capabilities) {
    // Explicit deny overrides both direct and conditional authorization. Casbin remains the decision authority.
    for (const mode of rule.effect === "deny" ? ["allow","approval"] : [rule.effect])
      rows.push([principalKey(principal),bridgeResource(rule.projectId,rule.installationId,rule.agentId),`${mode}:${capKey(capability)}`,
        rule.effect === "deny" ? "deny" : "allow",rule.id]);
  }
  if (rows.length) await enforcer.addPolicies(rows);
  async function decideResource(facts: OrganizationFacts, resource: AuthorizationResource, action: ProjectAction | OrganizationAction,
    servicePrincipalId?: string): Promise<AuthorizationDecision> {
    const reject = (reason: AuthorizationDecision["reason"]): AuthorizationDecision =>
      ({ allowed: false, reason, policyDigest: digest, lanes: [] });
    if (!facts.active || facts.organizationId !== policy.organizationId ||
      (resource.kind === "organization" && resource.id !== policy.organizationId)) return reject("invalid_identity");
    const delegate = facts.delegation;
    if (delegate && (!delegate.active || delegate.organizationId !== facts.organizationId ||
      delegate.userId !== facts.userId || (delegate.agent && !delegate.agent.active))) return reject("invalid_identity");
    const requests: { lane: DecisionLane; subjects: string[] }[] = [
      servicePrincipalId ? { lane: "service", subjects: ["service:" + servicePrincipalId] }
        : { lane: "human", subjects: humanSubjects(policy, facts.userId, resource) },
    ];
    if (delegate) {
      requests.push({ lane: "installation", subjects: ["installation:" + delegate.installationId] });
      if (delegate.agent) requests.push({ lane: "agent", subjects: ["agent:" + delegate.installationId + ":" + delegate.agent.id] });
    }
    const lanes: AuthorizationDecision["lanes"] = [];
    let explicitDeny = false;
    const key = resource.kind + ":" + resource.id;
    for (const request of requests) {
      const allowed = await enforcer.enforce(request.subjects, key, action);
      // Explanation only: Casbin is the sole decision authority.
      const matching = rows.filter(row => row[2] === action && request.subjects.includes(row[0]!) &&
        (row[1] === key || (resource.kind === "project" && row[1] === "project:*")));
      explicitDeny ||= matching.some(row => row[3] === "deny");
      lanes.push({ lane: request.lane, allowed, ruleIds: [...new Set(matching.map(row => row[4]!))] });
    }
    const allowed = lanes.every(lane => lane.allowed);
    return { allowed, reason: allowed ? "allowed" : explicitDeny ? "explicit_deny" : "no_grant", policyDigest: digest, lanes };
  }
  // The enforcer is private and configured once. No mutation API is exposed.
  return Object.freeze({
    policy, digest,
    async bridgeDelegation(facts: AuthorizationFacts, installationId:string) {
      if (!facts.active || facts.organizationId !== policy.organizationId || facts.projectOrganizationId !== policy.organizationId) return [];
      const assignment = policy.bridgeAgents?.find(b => b.installationId === installationId && b.projectId === facts.projectId);
      if (!assignment) return [];
      const subjects = humanSubjects(policy,facts.userId,{kind:"project",id:facts.projectId});
      return Promise.all(assignment.agentIds.map(async id => {
        const resource = bridgeResource(facts.projectId,installationId,id);
        const candidates = new Map((policy.bridgeRules ?? []).filter(r => r.installationId === installationId && r.projectId === facts.projectId && r.agentId === id)
          .flatMap(r=>r.capabilities).map(c=>[capKey(c),c]));
        const capabilities = [], approvalCapabilities = [];
        for (const [key,capability] of candidates) {
          const direct = await enforcer.enforce(subjects,resource,`allow:${key}`);
          const conditional = await enforcer.enforce(subjects,resource,`approval:${key}`);
          // A conditional rule is intentionally stricter than a direct allow for the same action.
          if (conditional) approvalCapabilities.push(capability); else if (direct) capabilities.push(capability);
        }
        return {id,capabilities,approvalCapabilities};
      }));
    },
    decideService(facts: { organizationId: string; servicePrincipalId: string; active: boolean }, resource: AuthorizationResource,
      action: ProjectAction | OrganizationAction) {
      // Dedicated lane: no creator, user, group, role or installation inheritance.
      return decideResource({ organizationId: facts.organizationId, active: facts.active, userId: "", organizationRole: "" },
        resource, action, facts.servicePrincipalId);
    },
    async decide(facts: AuthorizationFacts, action: ProjectAction): Promise<AuthorizationDecision> {
      if (facts.projectOrganizationId !== policy.organizationId) return { allowed: false, reason: "invalid_identity", policyDigest: digest, lanes: [] };
      return decideResource(facts, { kind: "project", id: facts.projectId }, action);
    },
    decideOrganization(facts: OrganizationFacts, action: OrganizationAction) {
      return decideResource(facts, { kind: "organization", id: facts.organizationId }, action);
    },
  });
}
export async function evaluatePolicy(input: unknown, facts: AuthorizationFacts, action: ProjectAction): Promise<AuthorizationDecision> {
  if (input === null || input === undefined) return { allowed: false, reason: "not_configured", policyDigest: null, lanes: [] };
  const parsed = policySchema.safeParse(input);
  if (!parsed.success) return { allowed: false, reason: "invalid_policy", policyDigest: null, lanes: [] };
  return (await compilePolicy(parsed.data)).decide(facts, action);
}
