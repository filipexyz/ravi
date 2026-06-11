import { resolveToolGroup } from "../cli/tool-registry.js";
import type { ContextCapability } from "../router/router-db.js";
import { canWithCapabilities, matchPattern } from "./capability-context.js";
import {
  DELEGATION_OVERRIDE_RELATION_PREFIX,
  formatAuthorityPrincipal,
  materializeDelegatedAuthority,
  parseAuthorityPrincipal,
  snapshotSubjectCapabilities,
  type AuthorityPrincipal,
} from "./delegation.js";
import { getPermissionDenial } from "./denials.js";
import { can } from "./engine.js";
import { listRelations, type Relation } from "./relations.js";

export type ExplainGrantState =
  | "allowed"
  | "never_granted"
  | "revoked"
  | "expired"
  | "constrained"
  | "ceiling"
  | "not_evaluated";

export interface ExplainPermissionInput {
  relation: string;
  objectType: string;
  objectId: string;
  agentId: string;
  actor?: string | null;
  chat?: string | null;
  sessionKey?: string | null;
  turnCapabilities?: ContextCapability[] | null;
  broadRecommendations?: boolean;
}

export interface ExplainPermissionDecision {
  request: {
    relation: string;
    objectType: string;
    objectId: string;
    object: string;
    agent: string;
    actor: string | null;
    chat: string | null;
    sessionKey: string | null;
  };
  final: {
    allowed: boolean;
    path: "agent" | "delegated";
    reason: string;
  };
  branches: ExplainBranch[];
  matchedRelations: ExplainedRelation[];
  nearMissRelations: ExplainedRelation[];
  revocationEvents: RevocationEvent[];
  recommendations: PermissionRecommendation[];
}

export interface ExplainDenialDecision {
  denial: {
    id: number;
    createdAt: number;
    resolvedAt: number | null;
    contextId: string | null;
    reason: string | null;
    command: string | null;
    snapshot?: Record<string, unknown> | null;
  };
  current: ExplainPermissionDecision;
  currentlyDenied: boolean;
}

export interface ExplainBranch {
  branch: "agent" | "actor" | "surface" | "turn" | "effective";
  principal: string | null;
  verdict: "allow" | "deny" | "not_evaluated";
  grantState: ExplainGrantState;
  detail: string;
  matchedRelations: ExplainedRelation[];
  nearMissRelations: ExplainedRelation[];
  capabilitiesCount?: number;
}

export interface ExplainedRelation {
  id: number;
  subject: string;
  relation: string;
  object: string;
  source: string;
  grantMode: string;
  expiresAt: number | null;
  revokedAt: number | null;
  revocationBatchId: string | null;
  reason: string | null;
  issuedBy: string | null;
  createdAt: number;
  active: boolean;
  provenance: string[];
}

export interface RevocationEvent {
  id: string;
  batchId: string | null;
  revokedAt: number;
  relationCount: number;
  subjectCount: number;
  sample: ExplainedRelation[];
}

export interface PermissionRecommendation {
  rank: number;
  kind: "role_membership" | "direct_grant" | "delegation_override" | "wildcard";
  subject: string;
  relation: string;
  object: string;
  command: string;
  reason: string;
}

interface SubjectExplainResult {
  principal: string;
  allowed: boolean;
  grantState: ExplainGrantState;
  matchedRelations: ExplainedRelation[];
  nearMissRelations: ExplainedRelation[];
}

const REVOCATION_EVENT_THRESHOLD = 10;

export function explainPermissionDecision(input: ExplainPermissionInput): ExplainPermissionDecision {
  const actorPrincipal = parseAuthorityPrincipal(input.actor);
  const surfacePrincipal = parseSurfacePrincipal(input.chat);
  const agentPrincipal = { subjectType: "agent", subjectId: input.agentId };
  const requestObject = `${input.objectType}:${input.objectId}`;

  const agent = explainSubject(agentPrincipal, input.relation, input.objectType, input.objectId);
  const branches: ExplainBranch[] = [subjectBranch("agent", agent, input.relation, input.objectType, input.objectId)];

  let finalAllowed = agent.allowed;
  let finalPath: "agent" | "delegated" = "agent";
  let finalReason = agent.allowed ? "agent grant allows request" : "agent branch lacks grant";

  if (actorPrincipal || surfacePrincipal) {
    finalPath = "delegated";
    const actor = actorPrincipal
      ? explainSubject(actorPrincipal, input.relation, input.objectType, input.objectId)
      : null;
    const agentDelegationOverride =
      actorPrincipal?.subjectType === "contact"
        ? explainDelegationOverride(agentPrincipal, input.relation, input.objectType, input.objectId)
        : null;
    const surfaceDelegationOverride =
      actorPrincipal?.subjectType === "contact" && surfacePrincipal
        ? explainDelegationOverride(surfacePrincipal, input.relation, input.objectType, input.objectId)
        : null;
    const actorBranch = actor
      ? explainActorBranch(
          actor,
          [agentDelegationOverride, surfaceDelegationOverride].filter((result): result is SubjectExplainResult =>
            Boolean(result),
          ),
          input.relation,
          input.objectType,
          input.objectId,
        )
      : notEvaluatedBranch("actor", "actor principal was not provided or not resolved");
    const surface = surfacePrincipal
      ? explainSurface(
          surfacePrincipal,
          actor,
          surfaceDelegationOverride,
          input.relation,
          input.objectType,
          input.objectId,
        )
      : null;
    branches.push(actorBranch);
    if (surface) {
      branches.push(surface);
    }

    const turnCapabilities = hasAnyCapability(input.turnCapabilities) ? input.turnCapabilities : undefined;
    if (turnCapabilities) {
      branches.push(turnBranch(turnCapabilities, input.relation, input.objectType, input.objectId));
    }

    const materialized =
      actorPrincipal &&
      materializeDelegatedAuthority({
        agentPrincipal,
        actorPrincipal,
        surfacePrincipal,
        agentCapabilityAdditions: turnCapabilities,
        turnCapabilities,
      });
    finalAllowed = Boolean(
      materialized &&
        canWithCapabilities(materialized.effectiveCapabilities, input.relation, input.objectType, input.objectId),
    );
    branches.push({
      branch: "effective",
      principal: "effective",
      verdict: finalAllowed ? "allow" : "deny",
      grantState: finalAllowed ? "allowed" : firstDenyState(branches, agent.allowed),
      detail: finalAllowed
        ? "effective delegated capabilities allow the request"
        : "effective delegated capabilities deny the request",
      matchedRelations: [],
      nearMissRelations: [],
      capabilitiesCount: materialized ? materialized.effectiveCapabilities.length : 0,
    });

    finalReason = delegatedFinalReason({
      agent,
      actor: actorBranch,
      surface,
      turnCapabilities,
      relation: input.relation,
      objectType: input.objectType,
      objectId: input.objectId,
      allowed: finalAllowed,
    });
  }

  const matchedRelations = uniqueExplainedRelations(branches.flatMap((branch) => branch.matchedRelations));
  const nearMissRelations = uniqueExplainedRelations(branches.flatMap((branch) => branch.nearMissRelations));
  const revocationEvents = buildRevocationEvents(nearMissRelations);

  return {
    request: {
      relation: input.relation,
      objectType: input.objectType,
      objectId: input.objectId,
      object: requestObject,
      agent: `agent:${input.agentId}`,
      actor: input.actor ?? null,
      chat: input.chat ?? null,
      sessionKey: input.sessionKey ?? null,
    },
    final: {
      allowed: finalAllowed,
      path: finalPath,
      reason: finalAllowed ? finalReason : finalReason,
    },
    branches,
    matchedRelations,
    nearMissRelations,
    revocationEvents,
    recommendations: finalAllowed
      ? []
      : buildRecommendations({
          relation: input.relation,
          object: requestObject,
          agent: `agent:${input.agentId}`,
          actor: input.actor ?? null,
          chat: input.chat ?? null,
          broad: input.broadRecommendations === true,
        }),
  };
}

export function explainPermissionDenial(
  denialId: number,
  options: { broadRecommendations?: boolean } = {},
): ExplainDenialDecision {
  const denial = getPermissionDenial(denialId);
  if (!denial) {
    throw new Error(`Permission denial not found: ${denialId}`);
  }

  const context = objectValue(denial.detail?.context);
  const actor = stringValue(context?.actorPrincipal) ?? stringValue(denial.detail?.actorPrincipal);
  const chat = stringValue(context?.surfacePrincipal) ?? stringValue(denial.detail?.surfacePrincipal);
  const turnCapabilities = capabilityArrayValue(context?.turnCapabilities);
  const agentId = denial.agentId ?? denial.subjectId;
  const current = explainPermissionDecision({
    relation: denial.relation,
    objectType: denial.objectType,
    objectId: denial.objectId,
    agentId,
    actor,
    chat,
    sessionKey: denial.sessionKey,
    turnCapabilities,
    broadRecommendations: options.broadRecommendations,
  });

  return {
    denial: {
      id: denial.id,
      createdAt: denial.createdAt,
      resolvedAt: denial.resolvedAt,
      contextId: denial.contextId,
      reason: denial.reason,
      command: denial.command,
      snapshot: context ?? null,
    },
    current,
    currentlyDenied: !current.final.allowed,
  };
}

export function summarizePermissionGrantState(decision: ExplainPermissionDecision): {
  state: ExplainGrantState;
  revocationEvents: RevocationEvent[];
  nearMissRelations: ExplainedRelation[];
  branchStates: Array<{ branch: string; principal: string | null; state: ExplainGrantState; verdict: string }>;
} {
  const denying = decision.branches.find((branch) => branch.verdict === "deny");
  return {
    state: denying?.grantState ?? (decision.final.allowed ? "allowed" : "never_granted"),
    revocationEvents: decision.revocationEvents,
    nearMissRelations: decision.nearMissRelations,
    branchStates: decision.branches.map((branch) => ({
      branch: branch.branch,
      principal: branch.principal,
      state: branch.grantState,
      verdict: branch.verdict,
    })),
  };
}

function explainSubject(
  principal: AuthorityPrincipal,
  relation: string,
  objectType: string,
  objectId: string,
  options: { includeRoles?: boolean } = {},
): SubjectExplainResult {
  const matches = findMatchingRelations(principal, relation, objectType, objectId, new Set(), ["direct"], options);
  const matchedRelations = matches.filter((match) => match.active);
  const nearMissRelations = matches.filter((match) => !match.active);
  const allowed = isSpecialRequestedRelation(relation)
    ? matchedRelations.length > 0
    : options.includeRoles === false
      ? canWithCapabilities(
          snapshotSubjectCapabilities(principal.subjectType, principal.subjectId, {
            includeRoles: false,
            includeConstraints: false,
          }),
          relation,
          objectType,
          objectId,
        )
      : can(principal.subjectType, principal.subjectId, relation, objectType, objectId);
  return {
    principal: formatAuthorityPrincipal(principal),
    allowed,
    grantState: allowed ? "allowed" : inactiveGrantState(nearMissRelations),
    matchedRelations,
    nearMissRelations,
  };
}

function explainDelegationOverride(
  principal: AuthorityPrincipal,
  relation: string,
  objectType: string,
  objectId: string,
): SubjectExplainResult {
  if (relation === "admin") {
    return {
      principal: formatAuthorityPrincipal(principal),
      allowed: false,
      grantState: "never_granted",
      matchedRelations: [],
      nearMissRelations: [],
    };
  }

  const matches = findMatchingRelations(
    principal,
    `${DELEGATION_OVERRIDE_RELATION_PREFIX}${relation}`,
    objectType,
    objectId,
    new Set(),
    ["delegation_override"],
    { includeRoles: false },
  );
  const matchedRelations = matches.filter((match) => match.active);
  const nearMissRelations = matches.filter((match) => !match.active);
  return {
    principal: formatAuthorityPrincipal(principal),
    allowed: matchedRelations.length > 0,
    grantState: matchedRelations.length > 0 ? "allowed" : inactiveGrantState(nearMissRelations),
    matchedRelations,
    nearMissRelations,
  };
}

function explainActorBranch(
  actor: SubjectExplainResult,
  overrides: SubjectExplainResult[],
  relation: string,
  objectType: string,
  objectId: string,
): ExplainBranch {
  if (actor.allowed) {
    return subjectBranch("actor", actor, relation, objectType, objectId);
  }

  const activeOverrideRelations = uniqueExplainedRelations(overrides.flatMap((override) => override.matchedRelations));
  if (activeOverrideRelations.length > 0) {
    return {
      branch: "actor",
      principal: actor.principal,
      verdict: "allow",
      grantState: "allowed",
      detail: "actor branch satisfied by delegation override",
      matchedRelations: activeOverrideRelations,
      nearMissRelations: uniqueExplainedRelations([
        ...actor.nearMissRelations,
        ...overrides.flatMap((override) => override.nearMissRelations),
      ]),
    };
  }

  return subjectBranch("actor", actor, relation, objectType, objectId);
}

function explainSurface(
  surfacePrincipal: AuthorityPrincipal,
  actor: SubjectExplainResult | null,
  surfaceDelegationOverride: SubjectExplainResult | null,
  relation: string,
  objectType: string,
  objectId: string,
): ExplainBranch {
  const allow = explainSubject(surfacePrincipal, relation, objectType, objectId, { includeRoles: false });
  const deny = explainSubject(surfacePrincipal, `deny_${relation}`, objectType, objectId, { includeRoles: false });
  const constraints = explainSurfaceConstraints(surfacePrincipal, relation, objectType, objectId);

  if (deny.allowed) {
    return {
      branch: "surface",
      principal: allow.principal,
      verdict: "deny",
      grantState: "constrained",
      detail: "surface has an explicit deny override",
      matchedRelations: deny.matchedRelations,
      nearMissRelations: allow.nearMissRelations,
    };
  }

  if (surfaceDelegationOverride?.allowed) {
    return {
      branch: "surface",
      principal: allow.principal,
      verdict: "allow",
      grantState: "allowed",
      detail: "surface branch satisfied by delegation override",
      matchedRelations: surfaceDelegationOverride.matchedRelations,
      nearMissRelations: uniqueExplainedRelations([
        ...allow.nearMissRelations,
        ...surfaceDelegationOverride.nearMissRelations,
      ]),
    };
  }

  if (constraints.hasActiveConstraints) {
    if (constraints.allowed) {
      return {
        branch: "surface",
        principal: allow.principal,
        verdict: "allow",
        grantState: "allowed",
        detail: "surface constraints include the request",
        matchedRelations: constraints.matchedRelations,
        nearMissRelations: uniqueExplainedRelations([...allow.nearMissRelations, ...constraints.nearMissRelations]),
      };
    }
    return {
      branch: "surface",
      principal: allow.principal,
      verdict: "deny",
      grantState: "constrained",
      detail: "surface has explicit role constraints that do not include the request",
      matchedRelations: constraints.constraintRelations,
      nearMissRelations: uniqueExplainedRelations([...allow.nearMissRelations, ...constraints.nearMissRelations]),
    };
  }

  if (allow.allowed) {
    return subjectBranch("surface", allow, relation, objectType, objectId);
  }

  if (actor?.allowed) {
    return {
      branch: "surface",
      principal: allow.principal,
      verdict: "allow",
      grantState: "allowed",
      detail: "surface has no explicit allow/deny for this object; inherited actor branch",
      matchedRelations: [],
      nearMissRelations: allow.nearMissRelations,
    };
  }

  return {
    branch: "surface",
    principal: allow.principal,
    verdict: "deny",
    grantState: inactiveGrantState(allow.nearMissRelations),
    detail: "surface has no explicit allow or override, and actor direct grants cannot be inherited",
    matchedRelations: [],
    nearMissRelations: allow.nearMissRelations,
  };
}

function explainSurfaceConstraints(
  surfacePrincipal: AuthorityPrincipal,
  relation: string,
  objectType: string,
  objectId: string,
): {
  hasActiveConstraints: boolean;
  allowed: boolean;
  constraintRelations: ExplainedRelation[];
  matchedRelations: ExplainedRelation[];
  nearMissRelations: ExplainedRelation[];
} {
  const constraints = listRelations({
    subjectType: surfacePrincipal.subjectType,
    subjectId: surfacePrincipal.subjectId,
    relation: "constrain",
    objectType: "role",
  }).filter(isActiveRelationNow);
  const constraintRelations = constraints.map((rel) => explainRelation(rel, ["surface_constraint"]));
  const roleMatches = constraints.flatMap((constraint) =>
    findMatchingRelations(
      { subjectType: "role", subjectId: constraint.objectId },
      relation,
      objectType,
      objectId,
      new Set(),
      ["surface_constraint", `role:${constraint.objectId}`],
    ),
  );
  const activeRoleMatches = roleMatches.filter((match) => match.active);
  const nearMissRelations = roleMatches.filter((match) => !match.active);
  return {
    hasActiveConstraints: constraints.length > 0,
    allowed: activeRoleMatches.length > 0,
    constraintRelations,
    matchedRelations: uniqueExplainedRelations([...constraintRelations, ...activeRoleMatches]),
    nearMissRelations: uniqueExplainedRelations(nearMissRelations),
  };
}

function subjectBranch(
  branch: "agent" | "actor" | "surface",
  result: SubjectExplainResult,
  relation: string,
  objectType: string,
  objectId: string,
): ExplainBranch {
  const object = `${objectType}:${objectId}`;
  return {
    branch,
    principal: result.principal,
    verdict: result.allowed ? "allow" : "deny",
    grantState: result.grantState,
    detail: result.allowed
      ? `${result.principal} has ${relation} ${object}`
      : `${result.principal} lacks active ${relation} ${object}`,
    matchedRelations: result.matchedRelations,
    nearMissRelations: result.nearMissRelations,
  };
}

function notEvaluatedBranch(branch: "actor" | "surface", detail: string): ExplainBranch {
  return {
    branch,
    principal: null,
    verdict: "not_evaluated",
    grantState: "not_evaluated",
    detail,
    matchedRelations: [],
    nearMissRelations: [],
  };
}

function turnBranch(
  capabilities: ContextCapability[],
  relation: string,
  objectType: string,
  objectId: string,
): ExplainBranch {
  const allowed = canWithCapabilities(capabilities, relation, objectType, objectId);
  return {
    branch: "turn",
    principal: "turn",
    verdict: allowed ? "allow" : "deny",
    grantState: allowed ? "allowed" : "constrained",
    detail: allowed
      ? "turn capability upper bound includes the request"
      : "turn capability upper bound does not include the request",
    matchedRelations: [],
    nearMissRelations: [],
    capabilitiesCount: capabilities.length,
  };
}

function findMatchingRelations(
  principal: AuthorityPrincipal,
  relation: string,
  objectType: string,
  objectId: string,
  visitedRoles: Set<string>,
  provenance: string[] = ["direct"],
  options: { includeRoles?: boolean } = {},
): ExplainedRelation[] {
  const relations = listRelations({
    subjectType: principal.subjectType,
    subjectId: principal.subjectId,
    includeInactive: true,
  });
  const direct = relations
    .filter((candidate) => relationCoversRequest(candidate, relation, objectType, objectId))
    .map((candidate) => explainRelation(candidate, provenance));
  const activeRoleMatches =
    options.includeRoles === false
      ? []
      : relations
          .filter(
            (candidate) =>
              candidate.relation === "member" && candidate.objectType === "role" && isActiveRelationNow(candidate),
          )
          .flatMap((membership) => {
            if (visitedRoles.has(membership.objectId)) return [];
            visitedRoles.add(membership.objectId);
            return findMatchingRelations(
              { subjectType: "role", subjectId: membership.objectId },
              relation,
              objectType,
              objectId,
              visitedRoles,
              [...provenance, `role:${membership.objectId}`],
              options,
            );
          });
  return uniqueExplainedRelations([...direct, ...activeRoleMatches]);
}

function relationCoversRequest(
  relation: Relation,
  requestedRelation: string,
  requestedObjectType: string,
  requestedObjectId: string,
): boolean {
  if (
    !isSpecialRequestedRelation(requestedRelation) &&
    relation.relation === "admin" &&
    relation.objectType === "system" &&
    relation.objectId === "*"
  ) {
    return true;
  }
  const requestedRelationPermission = requestedRelation.startsWith(DELEGATION_OVERRIDE_RELATION_PREFIX)
    ? requestedRelation.slice(DELEGATION_OVERRIDE_RELATION_PREFIX.length)
    : requestedRelation;
  if (
    requestedRelationPermission === "use" &&
    requestedObjectType === "tool" &&
    relation.relation === requestedRelation
  ) {
    if (relation.objectType === "toolgroup") {
      return resolveToolGroup(relation.objectId)?.includes(requestedObjectId) ?? false;
    }
  }
  if (relation.relation !== requestedRelation || relation.objectType !== requestedObjectType) {
    return false;
  }
  if (relation.objectId === requestedObjectId || relation.objectId === "*") {
    return true;
  }
  return (
    requestedObjectId !== "*" && relation.objectId.includes("*") && matchPattern(relation.objectId, requestedObjectId)
  );
}

function isSpecialRequestedRelation(relation: string): boolean {
  return relation.startsWith(DELEGATION_OVERRIDE_RELATION_PREFIX) || relation.startsWith("deny_");
}

function explainRelation(relation: Relation, provenance: string[]): ExplainedRelation {
  return {
    id: relation.id,
    subject: `${relation.subjectType}:${relation.subjectId}`,
    relation: relation.relation,
    object: `${relation.objectType}:${relation.objectId}`,
    source: relation.source,
    grantMode: relation.grantMode,
    expiresAt: relation.expiresAt,
    revokedAt: relation.revokedAt,
    revocationBatchId: relation.revocationBatchId,
    reason: relation.reason,
    issuedBy: relation.issuedBy,
    createdAt: relation.createdAt,
    active: isActiveRelationNow(relation),
    provenance,
  };
}

function inactiveGrantState(relations: ExplainedRelation[]): ExplainGrantState {
  if (relations.some((relation) => relation.revokedAt !== null)) {
    return "revoked";
  }
  if (relations.some((relation) => relation.expiresAt !== null)) {
    return "expired";
  }
  return "never_granted";
}

function firstDenyState(branches: ExplainBranch[], agentAllowed: boolean): ExplainGrantState {
  if (!agentAllowed) return "ceiling";
  return branches.find((branch) => branch.verdict === "deny")?.grantState ?? "never_granted";
}

function delegatedFinalReason(input: {
  agent: SubjectExplainResult;
  actor: ExplainBranch | null;
  surface: ExplainBranch | null;
  turnCapabilities?: ContextCapability[];
  relation: string;
  objectType: string;
  objectId: string;
  allowed: boolean;
}): string {
  if (input.allowed) return "delegated effective capabilities allow request";
  if (!input.agent.allowed) return "agent ceiling lacks the requested capability";
  if (input.actor?.verdict === "deny") return input.actor.detail;
  if (input.surface?.verdict === "deny") return input.surface.detail;
  if (
    input.turnCapabilities &&
    !canWithCapabilities(input.turnCapabilities, input.relation, input.objectType, input.objectId)
  ) {
    return "turn capability upper bound does not include the request";
  }
  return "delegated effective capabilities do not include the request";
}

function buildRevocationEvents(nearMisses: ExplainedRelation[]): RevocationEvent[] {
  const groups = uniqueRevocationGroups(nearMisses);
  const events: RevocationEvent[] = [];
  for (const group of groups) {
    const batch = listRelations({ includeInactive: true }).filter((relation) =>
      group.batchId ? relation.revocationBatchId === group.batchId : relation.revokedAt === group.revokedAt,
    );
    if (batch.length < REVOCATION_EVENT_THRESHOLD) continue;
    events.push({
      id: group.batchId ? `batch:${group.batchId}` : `revoked_at:${group.revokedAt}`,
      batchId: group.batchId,
      revokedAt: group.revokedAt,
      relationCount: batch.length,
      subjectCount: new Set(batch.map((relation) => `${relation.subjectType}:${relation.subjectId}`)).size,
      sample: batch.slice(0, 10).map((relation) => explainRelation(relation, ["revocation_event"])),
    });
  }
  return events;
}

function uniqueRevocationGroups(nearMisses: ExplainedRelation[]): Array<{ batchId: string | null; revokedAt: number }> {
  const groups = new Map<string, { batchId: string | null; revokedAt: number }>();
  for (const relation of nearMisses) {
    if (!isNumber(relation.revokedAt)) continue;
    const key = relation.revocationBatchId ? `batch:${relation.revocationBatchId}` : `revoked_at:${relation.revokedAt}`;
    if (groups.has(key)) continue;
    groups.set(key, {
      batchId: relation.revocationBatchId,
      revokedAt: relation.revokedAt,
    });
  }
  return [...groups.values()];
}

function buildRecommendations(input: {
  relation: string;
  object: string;
  agent: string;
  actor: string | null;
  chat: string | null;
  broad: boolean;
}): PermissionRecommendation[] {
  const subject = input.actor ?? input.agent;
  const recommendations: PermissionRecommendation[] = [
    {
      rank: 1,
      kind: "role_membership",
      subject,
      relation: "member",
      object: "role:<profile>",
      command: `ravi permissions grant ${subject} member role:<profile>`,
      reason: "prefer a reusable permission profile over one-off grants",
    },
    {
      rank: 2,
      kind: "direct_grant",
      subject,
      relation: input.relation,
      object: input.object,
      command: `ravi permissions grant ${subject} ${input.relation} ${input.object}`,
      reason: "narrow direct grant for this object",
    },
  ];

  if (input.chat) {
    recommendations.push({
      rank: 3,
      kind: "delegation_override",
      subject: input.chat,
      relation: `delegate_${input.relation}`,
      object: input.object,
      command: `ravi permissions grant ${input.chat} delegate_${input.relation} ${input.object}`,
      reason: "surface-specific delegated override; use only when the surface must override actor membership",
    });
  }

  if (input.broad) {
    const [objectType] = input.object.split(":", 1);
    recommendations.push({
      rank: recommendations.length + 1,
      kind: "wildcard",
      subject,
      relation: input.relation,
      object: `${objectType}:*`,
      command: `ravi permissions grant ${subject} ${input.relation} ${objectType}:*`,
      reason: "broad wildcard grant requested explicitly",
    });
  }

  return recommendations;
}

function parseSurfacePrincipal(value: string | null | undefined): AuthorityPrincipal | null {
  if (!value) return null;
  const explicit = parseAuthorityPrincipal(value);
  if (explicit) return explicit;
  return { subjectType: "chat", subjectId: value };
}

function uniqueExplainedRelations(relations: ExplainedRelation[]): ExplainedRelation[] {
  const seen = new Set<number>();
  const result: ExplainedRelation[] = [];
  for (const relation of relations) {
    if (seen.has(relation.id)) continue;
    seen.add(relation.id);
    result.push(relation);
  }
  return result;
}

function isActiveRelationNow(relation: Relation): boolean {
  if (relation.revokedAt !== null) return false;
  return relation.expiresAt === null || relation.expiresAt > Math.floor(Date.now() / 1000);
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function hasAnyCapability(value: ContextCapability[] | null | undefined): value is ContextCapability[] {
  return Boolean(value && value.length > 0);
}

function capabilityArrayValue(value: unknown): ContextCapability[] {
  if (!Array.isArray(value)) return [];
  const capabilities: ContextCapability[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const permission = stringValue(record.permission);
    const objectType = stringValue(record.objectType);
    const objectId = stringValue(record.objectId);
    if (!permission || !objectType || !objectId) continue;
    const source = stringValue(record.source);
    capabilities.push({
      permission,
      objectType,
      objectId,
      ...(source ? { source } : {}),
    });
  }
  return capabilities;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
