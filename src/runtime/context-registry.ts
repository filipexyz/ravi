import { randomBytes } from "node:crypto";
import {
  dbCreateContext,
  dbGetContext,
  dbGetContextByKey,
  dbGetContextByKeyReadOnly,
  dbListContexts,
  dbTouchContext,
  dbUpdateContextRuntimeState,
  dbRevokeContextCascade,
  type ContextCapability,
  type ContextRecord,
  type ContextSource,
  type RevokeContextResult,
} from "../router/router-db.js";
import { canWithCapabilityContext } from "../permissions/capability-context.js";
import { listRelations } from "../permissions/relations.js";

export const RAVI_CONTEXT_KEY_ENV = "RAVI_CONTEXT_KEY";
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

export interface GetOrCreateAgentRuntimeContextInput
  extends Omit<CreateRuntimeContextInput, "kind" | "agentId" | "sessionKey"> {
  agentId: string;
  sessionKey: string;
}

export interface IssueRuntimeContextInput {
  parent: ContextRecord;
  cliName: string;
  kind?: string;
  capabilities?: ContextCapability[];
  metadata?: Record<string, unknown>;
  ttlMs?: number;
  inheritCapabilities?: boolean;
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

export function getOrCreateAgentRuntimeContext(input: GetOrCreateAgentRuntimeContextInput): ContextRecord {
  const now = Date.now();
  const reusable = findLiveAgentRuntimeContext({
    agentId: input.agentId,
    sessionKey: input.sessionKey,
    now,
  });

  if (reusable) {
    return dbUpdateContextRuntimeState(
      reusable.contextId,
      {
        sessionName: input.sessionName,
        source: input.source,
        metadata: input.metadata,
      },
      now,
    );
  }

  return createRuntimeContext({
    ...input,
    kind: "agent-runtime",
    agentId: input.agentId,
    sessionKey: input.sessionKey,
  });
}

export function findLiveAgentRuntimeContext(input: {
  agentId: string;
  sessionKey: string;
  now?: number;
}): ContextRecord | null {
  const now = input.now ?? Date.now();
  const contexts = dbListContexts({
    agentId: input.agentId,
    sessionKey: input.sessionKey,
    kind: "agent-runtime",
    includeInactive: false,
  }).filter((ctx) => isContextLive(ctx, now));

  contexts.sort((a, b) => {
    const aUsed = a.lastUsedAt ?? a.createdAt;
    const bUsed = b.lastUsedAt ?? b.createdAt;
    return bUsed - aUsed || b.createdAt - a.createdAt;
  });

  return contexts[0] ?? null;
}

export function revokeAgentRuntimeContextsForSession(
  sessionKey: string,
  options: RevokeRuntimeContextOptions = {},
): RevokeContextResult[] {
  const now = Date.now();
  const contexts = dbListContexts({
    sessionKey,
    kind: "agent-runtime",
    includeInactive: false,
  }).filter((ctx) => isContextLive(ctx, now));

  return contexts.map((ctx) =>
    revokeRuntimeContext(ctx.contextId, {
      cascade: options.cascade,
      reason: options.reason ?? "session_context_reset",
      revokedAt: options.revokedAt,
    }),
  );
}

export function snapshotAgentCapabilities(agentId: string): ContextCapability[] {
  return dedupeCapabilities(
    listRelations({ subjectType: "agent", subjectId: agentId }).map((relation) => ({
      permission: relation.relation,
      objectType: relation.objectType,
      objectId: relation.objectId,
      source: relation.source,
    })),
  );
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
  const requestedCapabilities = dedupeCapabilities([
    ...(input.inheritCapabilities ? input.parent.capabilities : []),
    ...(input.capabilities ?? []),
  ]);

  for (const capability of requestedCapabilities) {
    if (!canWithCapabilityContext(input.parent, capability.permission, capability.objectType, capability.objectId)) {
      throw new Error(
        `Capability not granted by parent context: ${capability.permission}:${capability.objectType}:${capability.objectId}`,
      );
    }
  }

  return createRuntimeContext({
    kind: input.kind ?? "cli-runtime",
    agentId: input.parent.agentId,
    sessionKey: input.parent.sessionKey,
    sessionName: input.parent.sessionName,
    source: input.parent.source,
    capabilities: requestedCapabilities,
    metadata: buildDerivedContextMetadata(input.parent, input.cliName, input.metadata, input.inheritCapabilities, now),
    expiresAt: resolveChildExpiresAt(input.parent.expiresAt, input.ttlMs, now),
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
  return dbRevokeContextCascade(contextId, {
    revokedAt: options.revokedAt,
    cascade: options.cascade,
    reason: options.reason,
  });
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
  return dbListContexts({ includeInactive: false }).filter((ctx) => {
    if (ctx.kind !== ADMIN_BOOTSTRAP_KIND) return false;
    if (ctx.revokedAt && ctx.revokedAt <= now) return false;
    if (ctx.expiresAt && ctx.expiresAt <= now) return false;
    return ctx.capabilities.some(
      (cap) => cap.permission === "admin" && cap.objectType === "system" && cap.objectId === "*",
    );
  });
}

export function hasLiveAdminContext(): boolean {
  return listLiveAdminContexts().length > 0;
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
): Record<string, unknown> {
  const derived: Record<string, unknown> = {
    parentContextId: parent.contextId,
    parentContextKind: parent.kind,
    issuedFor: cliName,
    issuedAt: now,
    issuanceMode: inheritCapabilities ? "inherit" : "explicit",
  };

  const approvalSource = parent.metadata?.approvalSource;
  if (approvalSource !== undefined) {
    derived.approvalSource = approvalSource;
  }

  if (metadata) {
    for (const [key, value] of Object.entries(metadata)) {
      derived[key] = value;
    }
  }

  return derived;
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
