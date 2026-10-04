import { randomBytes } from "node:crypto";
import {
  dbCreateContext,
  dbGetContext,
  dbGetContextByKey,
  dbGetContextByKeyReadOnly,
  dbListContexts,
  dbTouchContext,
  dbRevokeContextCascade,
  type ContextCapability,
  type ContextRecord,
  type ContextSource,
  type RevokeContextResult,
} from "../router/router-db.js";
import { canWithCapabilityContext, materializeSubjectCapabilities } from "../permissions/provider-runtime.js";
import { TURN_SCOPED_AUTHORITY_KIND } from "../permissions/delegation.js";
import {
  capabilityNotGrantedByParentError,
  delegatedAgentIdRequiredError,
  delegatedSessionActorRequiresSessionError,
  delegatedSessionActorUnavailableError,
  delegatedSessionBindingsMustBePairedError,
  identityDelegationRequiresAdminError,
} from "./context-errors.js";

export const RAVI_CONTEXT_KEY_ENV = "RAVI_CONTEXT_KEY";
/**
 * Legacy kind for the per-session authority slot that `turn-runtime` now owns.
 * Kept so rows written before the agent-identity cutover are still reclaimed;
 * see the live authority-root inventory in `ravi doctor`.
 */
export const LEGACY_AGENT_RUNTIME_CONTEXT_KIND = "agent-runtime";
export const DEFAULT_CONTEXT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_DERIVED_CONTEXT_TTL_MS = 60 * 60 * 1000;
export const DEFAULT_BOOTSTRAP_CONTEXT_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const ADMIN_BOOTSTRAP_KIND = "admin-bootstrap";
export const ADMIN_BOOTSTRAP_AGENT_ID = "bootstrap";

export interface CreateRuntimeContextInput {
  kind?: string;
  agentId?: string;
  sessionKey?: string;
  sessionName?: string;
  source?: ContextSource;
  capabilities?: ContextCapability[];
  metadata?: Record<string, unknown>;
  ttlMs?: number;
  expiresAt?: number;
  /** Override generated contextId. Used by the bootstrap CLI for --from-env imports. */
  contextId?: string;
  /** Override generated contextKey (rctx_*). Used by the bootstrap CLI for --from-env imports. */
  contextKey?: string;
}

export interface IssueRuntimeContextInput {
  parent: ContextRecord;
  cliName: string;
  kind?: string;
  capabilities?: ContextCapability[];
  metadata?: Record<string, unknown>;
  ttlMs?: number;
  inheritCapabilities?: boolean;
  /**
   * Explicit identity delegation for a service issuer. This is intentionally
   * admin-only: ordinary child contexts always inherit the parent identity.
   */
  identity?: {
    agentId: string;
    sessionKey?: string;
    sessionName?: string;
    /**
     * Project the verified human actor of the target session's live turn onto
     * the child. Only a runtime-issued `turn-runtime` context whose actor is a
     * resolved contact qualifies; otherwise issuance fails closed. The child
     * never outlives that turn.
     */
    projectSessionActor?: boolean;
  };
}

export function createRuntimeContext(input: CreateRuntimeContextInput): ContextRecord {
  const now = Date.now();
  return dbCreateContext({
    contextId: input.contextId ?? generateOpaqueToken("ctx"),
    contextKey: input.contextKey ?? generateOpaqueToken("rctx"),
    kind: input.kind ?? "runtime",
    agentId: input.agentId,
    sessionKey: input.sessionKey,
    sessionName: input.sessionName,
    source: input.source,
    capabilities: dedupeCapabilities(input.capabilities ?? []),
    metadata: input.metadata,
    createdAt: now,
    expiresAt: input.expiresAt ?? (input.ttlMs === 0 ? undefined : now + (input.ttlMs ?? DEFAULT_CONTEXT_TTL_MS)),
  });
}

/**
 * Authority kinds that occupy a single runtime session slot.
 *
 * Only one of these may be live per session: turn-scoped authority is issued per
 * turn and each turn supersedes the previous one. Anything still live for the
 * session is therefore stale by definition.
 */
function sessionSlotAuthorityKinds(): string[] {
  // Resolved per call instead of at module scope: this module already sits in an
  // import cycle with the permission runtime, so the constant is read lazily.
  return [TURN_SCOPED_AUTHORITY_KIND, LEGACY_AGENT_RUNTIME_CONTEXT_KIND];
}

/**
 * Revoke every live authority context bound to a runtime session.
 *
 * Used by every path that hands the session's authority slot back: turn abort,
 * provider-policy recovery, prompt-too-long reset, context-window recovery and
 * explicit session resets. The lookup covers both the current `turn-runtime`
 * kind and the legacy `agent-runtime` kind, and is done per kind so the
 * `(session_key, kind)` index stays usable.
 */
export function revokeAgentRuntimeContextsForSession(
  sessionKey: string,
  options: RevokeRuntimeContextOptions = {},
): RevokeContextResult[] {
  const now = Date.now();
  const contexts = sessionSlotAuthorityKinds()
    .flatMap((kind) => dbListContexts({ sessionKey, kind, includeInactive: false }))
    .filter((ctx) => isContextLive(ctx, now));

  return contexts.map((ctx) =>
    revokeRuntimeContext(ctx.contextId, {
      cascade: options.cascade,
      reason: options.reason ?? "session_context_reset",
      revokedAt: options.revokedAt,
    }),
  );
}

/**
 * Revoke every live authority snapshot issued for an agent.
 *
 * Runtime capabilities are immutable snapshots. Changing an agent's stored
 * permission profile without revoking those snapshots leaves the old
 * authority usable until expiry or the next turn rotation. Permission
 * mutations call this helper so reductions take effect immediately and
 * expansions only appear in a newly issued context.
 */
export function revokeLiveRuntimeContextsForAgent(
  agentId: string,
  options: RevokeRuntimeContextOptions = {},
): RevokeContextResult[] {
  const contexts = dbListContexts({ agentId, includeInactive: false });
  const liveContextIds = new Set(contexts.map((context) => context.contextId));
  const roots = contexts.filter((context) => {
    const parentContextId = context.metadata?.parentContextId;
    return typeof parentContextId !== "string" || !liveContextIds.has(parentContextId);
  });

  return roots.map((context) =>
    revokeRuntimeContext(context.contextId, {
      cascade: options.cascade,
      reason: options.reason ?? "agent_permissions_changed",
      revokedAt: options.revokedAt,
    }),
  );
}

/**
 * Revoke live authority snapshots whose user overlay used one contact grant.
 *
 * `grantRef` is the `<profile>@<scope>` entry recorded in `userOverlayGrants`.
 * Like agent permission reductions, a revoked grant must stop authorizing
 * immediately instead of lasting until the turn ends.
 */
export function revokeLiveRuntimeContextsForContactGrant(
  contactId: string,
  grantRef: string,
  options: RevokeRuntimeContextOptions = {},
): RevokeContextResult[] {
  const actorPrincipal = `contact:${contactId}`;
  const contexts = dbListContexts({ includeInactive: false }).filter((context) => {
    const grants = context.metadata?.userOverlayGrants;
    return context.metadata?.actorPrincipal === actorPrincipal && Array.isArray(grants) && grants.includes(grantRef);
  });
  const matchingIds = new Set(contexts.map((context) => context.contextId));
  const roots = contexts.filter((context) => {
    const parentContextId = context.metadata?.parentContextId;
    return typeof parentContextId !== "string" || !matchingIds.has(parentContextId);
  });

  return roots.map((context) =>
    revokeRuntimeContext(context.contextId, {
      cascade: options.cascade,
      reason: options.reason ?? "contact_grant_revoked",
      revokedAt: options.revokedAt,
    }),
  );
}

export function snapshotAgentCapabilities(agentId: string): ContextCapability[] {
  return dedupeCapabilities(materializeSubjectCapabilities("agent", agentId));
}

export function resolveRuntimeContext(
  contextKey: string,
  options?: { touch?: boolean; readOnly?: boolean },
): ContextRecord | null {
  const record = options?.readOnly ? dbGetContextByKeyReadOnly(contextKey) : dbGetContextByKey(contextKey);
  if (!record) return null;
  if (record.revokedAt && record.revokedAt <= Date.now()) return null;
  if (record.expiresAt && record.expiresAt <= Date.now()) return null;

  if (!options?.readOnly && options?.touch !== false) {
    const lastUsedAt = Date.now();
    dbTouchContext(record.contextId, lastUsedAt);
    record.lastUsedAt = lastUsedAt;
  }

  return record;
}

export function resolveRuntimeContextOrThrow(
  contextKey: string,
  options?: { touch?: boolean; readOnly?: boolean },
): ContextRecord {
  const record = options?.readOnly ? dbGetContextByKeyReadOnly(contextKey) : dbGetContextByKey(contextKey);
  if (!record) {
    throw new Error("Context not found");
  }
  if (record.revokedAt && record.revokedAt <= Date.now()) {
    throw new Error("Context revoked");
  }
  if (record.expiresAt && record.expiresAt <= Date.now()) {
    throw new Error("Context expired");
  }

  if (!options?.readOnly && options?.touch !== false) {
    const lastUsedAt = Date.now();
    dbTouchContext(record.contextId, lastUsedAt);
    record.lastUsedAt = lastUsedAt;
  }

  return record;
}

export function getRuntimeContextFromEnv(env: NodeJS.ProcessEnv = process.env): ContextRecord | undefined {
  const key = env[RAVI_CONTEXT_KEY_ENV];
  if (!key) return undefined;
  return resolveRuntimeContext(key) ?? undefined;
}

export function issueRuntimeContext(input: IssueRuntimeContextInput): ContextRecord {
  const now = Date.now();
  const delegatedIdentity = input.identity ? resolveDelegatedIdentity(input.parent, input.identity) : undefined;
  const sessionActor =
    delegatedIdentity && input.identity?.projectSessionActor
      ? resolveDelegatedSessionActor(delegatedIdentity, now)
      : undefined;
  const identity = delegatedIdentity ?? {
    agentId: input.parent.agentId,
    sessionKey: input.parent.sessionKey,
    sessionName: input.parent.sessionName,
  };
  const requestedCapabilities = dedupeCapabilities([
    ...(input.inheritCapabilities ? input.parent.capabilities : []),
    ...(input.capabilities ?? []),
  ]);

  for (const capability of requestedCapabilities) {
    if (!canWithCapabilityContext(input.parent, capability.permission, capability.objectType, capability.objectId)) {
      throw capabilityNotGrantedByParentError(capability);
    }
  }

  return createRuntimeContext({
    kind: input.kind ?? "cli-runtime",
    agentId: identity.agentId,
    sessionKey: identity.sessionKey,
    sessionName: identity.sessionName,
    source: input.identity ? undefined : input.parent.source,
    capabilities: requestedCapabilities,
    metadata: buildDerivedContextMetadata(
      input.parent,
      input.cliName,
      input.metadata,
      input.inheritCapabilities,
      now,
      delegatedIdentity,
      sessionActor?.metadata,
    ),
    expiresAt: capExpiresAt(
      resolveChildExpiresAt(input.parent.expiresAt, input.ttlMs, now),
      sessionActor?.source.expiresAt,
    ),
  });
}

export interface RevokeRuntimeContextOptions {
  cascade?: boolean;
  reason?: string;
  revokedAt?: number;
}

export function revokeRuntimeContext(
  contextId: string,
  options: RevokeRuntimeContextOptions = {},
): RevokeContextResult {
  const result = dbRevokeContextCascade(contextId, {
    revokedAt: options.revokedAt,
    cascade: options.cascade,
    reason: options.reason,
  });
  // Independent of `cascade`: a projection borrows the source turn's actor, so
  // it can never outlive that turn, even when lineage descendants are kept.
  revokeDependentActorProjections(result, options);
  return result;
}

/**
 * A child that projects a delegated session's actor depends on that session's
 * turn context as well as on its issuing parent: revoking the turn (or any of
 * its ancestors) must revoke the projection too, not leave it live until TTL.
 */
function revokeDependentActorProjections(result: RevokeContextResult, options: RevokeRuntimeContextOptions): void {
  const revokedIds = new Set([result.context.contextId, ...result.cascaded.map((ctx) => ctx.contextId)]);
  const dependents = dbListContexts({ includeInactive: false }).filter((ctx) => {
    const sourceContextId = readActorProjectionSourceContextId(ctx.metadata);
    return sourceContextId !== null && revokedIds.has(sourceContextId) && !revokedIds.has(ctx.contextId);
  });
  for (const dependent of dependents) {
    if (dbGetContext(dependent.contextId)?.revokedAt) continue;
    const nested = revokeRuntimeContext(dependent.contextId, {
      ...options,
      reason: options.reason ?? "actor_projection_source_revoked",
    });
    result.cascaded.push(nested.context, ...nested.cascaded);
  }
}

function readActorProjectionSourceContextId(metadata: Record<string, unknown> | undefined): string | null {
  const projection = metadata?.actorProjection;
  if (!projection || typeof projection !== "object" || Array.isArray(projection)) return null;
  const sourceContextId = (projection as Record<string, unknown>).sourceContextId;
  return typeof sourceContextId === "string" ? sourceContextId : null;
}

export interface ContextLineage {
  context: ContextRecord;
  ancestors: ContextRecord[];
  descendants: ContextRecord[];
}

/**
 * Resolve full ancestor chain (up to root) and descendant tree rooted at the
 * given context. Used by `ravi context lineage`.
 */
export function getContextLineage(contextId: string): ContextLineage | null {
  const target = dbGetContext(contextId);
  if (!target) return null;

  const ancestors: ContextRecord[] = [];
  const seen = new Set<string>([target.contextId]);
  let cursor: ContextRecord | null = target;
  while (cursor) {
    const parentId = typeof cursor.metadata?.parentContextId === "string" ? cursor.metadata.parentContextId : null;
    if (!parentId || seen.has(parentId)) break;
    const parent = dbGetContext(parentId);
    if (!parent) break;
    ancestors.push(parent);
    seen.add(parent.contextId);
    cursor = parent;
  }

  const all = dbListContexts({ includeInactive: true });
  const childrenByParent = new Map<string, ContextRecord[]>();
  for (const ctx of all) {
    const parentId = typeof ctx.metadata?.parentContextId === "string" ? ctx.metadata.parentContextId : null;
    if (!parentId) continue;
    const list = childrenByParent.get(parentId) ?? [];
    list.push(ctx);
    childrenByParent.set(parentId, list);
  }

  const descendants: ContextRecord[] = [];
  const visited = new Set<string>([target.contextId]);
  const queue: string[] = [target.contextId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const child of childrenByParent.get(current) ?? []) {
      if (visited.has(child.contextId)) continue;
      visited.add(child.contextId);
      descendants.push(child);
      queue.push(child.contextId);
    }
  }

  return { context: target, ancestors, descendants };
}

/**
 * Lookup the live admin (`admin:system:*`) contexts. Used by the daemon to
 * decide whether the bootstrap CLI must be run before any non-`open` request
 * is accepted.
 */
export function listLiveAdminContexts(): ContextRecord[] {
  const now = Date.now();
  return dbListContexts({ kind: ADMIN_BOOTSTRAP_KIND, includeInactive: false }).filter((ctx) => {
    if (ctx.revokedAt && ctx.revokedAt <= now) return false;
    if (ctx.expiresAt && ctx.expiresAt <= now) return false;
    return ctx.capabilities.some(
      (cap) => cap.permission === "admin" && cap.objectType === "system" && cap.objectId === "*",
    );
  });
}

function dedupeCapabilities(capabilities: ContextCapability[]): ContextCapability[] {
  const seen = new Set<string>();
  const result: ContextCapability[] = [];
  for (const capability of capabilities) {
    const key = `${capability.permission}:${capability.objectType}:${capability.objectId}:${capability.source ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(capability);
  }
  return result;
}

function isContextLive(ctx: ContextRecord, now = Date.now()): boolean {
  if (ctx.revokedAt && ctx.revokedAt <= now) return false;
  if (ctx.expiresAt && ctx.expiresAt <= now) return false;
  return true;
}

function buildDerivedContextMetadata(
  parent: ContextRecord,
  cliName: string,
  metadata: Record<string, unknown> | undefined,
  inheritCapabilities: boolean | undefined,
  now: number,
  delegatedIdentity?: {
    agentId: string;
    sessionKey?: string;
    sessionName?: string;
  },
  sessionActorMetadata?: Record<string, unknown>,
): Record<string, unknown> {
  const derived: Record<string, unknown> = {
    parentContextId: parent.contextId,
    parentContextKind: parent.kind,
    issuedFor: cliName,
    issuedAt: now,
    issuanceMode: inheritCapabilities ? "inherit" : "explicit",
  };

  if (delegatedIdentity) {
    derived.identityDelegation = {
      agentId: delegatedIdentity.agentId,
      sessionKey: delegatedIdentity.sessionKey ?? null,
      sessionName: delegatedIdentity.sessionName ?? null,
    };
  }

  const approvalSource = parent.metadata?.approvalSource;
  if (approvalSource !== undefined) {
    derived.approvalSource = approvalSource;
  }

  if (metadata) {
    for (const [key, value] of Object.entries(metadata)) {
      derived[key] = value;
    }
  }

  // Applied last so caller-supplied metadata can never forge the projected actor.
  if (sessionActorMetadata) {
    for (const key of PROJECTED_SESSION_ACTOR_KEYS) {
      delete derived[key];
    }
    delete derived.actorProjection;
    Object.assign(derived, sessionActorMetadata);
  }

  return derived;
}

const PROJECTED_SESSION_ACTOR_KEYS = [
  "actorPrincipal",
  "actorResolution",
  "actorDisplayName",
  "consoleUserId",
  "consoleOrgId",
] as const;

/**
 * Resolve the verified human actor of a delegated session from its live
 * runtime-issued turn context. Fails closed unless the actor is a resolved
 * contact; the projection is never reconstructed from traces or env.
 */
function resolveDelegatedSessionActor(
  identity: { agentId: string; sessionKey?: string; sessionName?: string },
  now: number,
): { source: ContextRecord; metadata: Record<string, unknown> } {
  if (!identity.sessionKey) throw delegatedSessionActorRequiresSessionError();

  const turns = dbListContexts({
    agentId: identity.agentId,
    sessionKey: identity.sessionKey,
    kind: TURN_SCOPED_AUTHORITY_KIND,
    includeInactive: false,
  })
    .filter((ctx) => isContextLive(ctx, now))
    .sort((a, b) => b.createdAt - a.createdAt);
  const source = turns[0];
  if (!source) throw delegatedSessionActorUnavailableError("no_live_turn");

  const sourceMetadata = source.metadata ?? {};
  const actorPrincipal = sourceMetadata.actorPrincipal;
  if (sourceMetadata.actorResolution !== "resolved") {
    throw delegatedSessionActorUnavailableError("actor_not_resolved");
  }
  if (typeof actorPrincipal !== "string" || !actorPrincipal.startsWith("contact:")) {
    throw delegatedSessionActorUnavailableError("actor_not_human");
  }

  const metadata: Record<string, unknown> = {};
  for (const key of PROJECTED_SESSION_ACTOR_KEYS) {
    const value = sourceMetadata[key];
    if (typeof value === "string" && value) metadata[key] = value;
  }
  metadata.actorProjection = {
    source: "delegated-session-turn",
    sourceContextId: source.contextId,
    agentId: identity.agentId,
    sessionKey: identity.sessionKey,
    projectedAt: now,
  };
  return { source, metadata };
}

function capExpiresAt(expiresAt: number | undefined, cap: number | undefined): number | undefined {
  if (cap === undefined) return expiresAt;
  if (expiresAt === undefined) return cap;
  return Math.min(expiresAt, cap);
}

function resolveDelegatedIdentity(
  parent: ContextRecord,
  requested: {
    agentId: string;
    sessionKey?: string;
    sessionName?: string;
    projectSessionActor?: boolean;
  },
): { agentId: string; sessionKey?: string; sessionName?: string } {
  if (!canWithCapabilityContext(parent, "admin", "system", "*")) {
    throw identityDelegationRequiresAdminError();
  }

  const agentId = requested.agentId.trim();
  const sessionKey = requested.sessionKey?.trim();
  const sessionName = requested.sessionName?.trim();
  if (!agentId) throw delegatedAgentIdRequiredError();
  if (Boolean(sessionKey) !== Boolean(sessionName)) {
    throw delegatedSessionBindingsMustBePairedError();
  }

  return {
    agentId,
    ...(sessionKey ? { sessionKey } : {}),
    ...(sessionName ? { sessionName } : {}),
  };
}

function resolveChildExpiresAt(
  parentExpiresAt: number | undefined,
  ttlMs: number | undefined,
  now: number,
): number | undefined {
  const requestedExpiresAt = ttlMs === 0 ? undefined : now + (ttlMs ?? DEFAULT_DERIVED_CONTEXT_TTL_MS);
  if (parentExpiresAt === undefined) return requestedExpiresAt;
  if (requestedExpiresAt === undefined) return parentExpiresAt;
  return Math.min(parentExpiresAt, requestedExpiresAt);
}

function generateOpaqueToken(prefix: string): string {
  return `${prefix}_${randomBytes(18).toString("base64url")}`;
}
