import { randomBytes } from "node:crypto";
import {
  dbCreateContext,
  dbGetContextByKey,
  dbTouchContext,
  dbRevokeContext,
  type ContextCapability,
  type ContextRecord,
  type ContextSource,
} from "../router/router-db.js";
import { canWithCapabilityContext } from "../permissions/engine.js";
import { listRelations } from "../permissions/relations.js";

export const RAVI_CONTEXT_KEY_ENV = "RAVI_CONTEXT_KEY";
export const DEFAULT_CONTEXT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_DERIVED_CONTEXT_TTL_MS = 60 * 60 * 1000;

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
    contextId: generateOpaqueToken("ctx"),
    contextKey: generateOpaqueToken("rctx"),
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

export function resolveRuntimeContext(contextKey: string, options?: { touch?: boolean }): ContextRecord | null {
  const record = dbGetContextByKey(contextKey);
  if (!record) return null;
  if (record.revokedAt && record.revokedAt <= Date.now()) return null;
  if (record.expiresAt && record.expiresAt <= Date.now()) return null;

  if (options?.touch !== false) {
    const lastUsedAt = Date.now();
    dbTouchContext(record.contextId, lastUsedAt);
    record.lastUsedAt = lastUsedAt;
  }

  return record;
}

export function resolveRuntimeContextOrThrow(contextKey: string, options?: { touch?: boolean }): ContextRecord {
  const record = dbGetContextByKey(contextKey);
  if (!record) {
    throw new Error("Context not found");
  }
  if (record.revokedAt && record.revokedAt <= Date.now()) {
    throw new Error("Context revoked");
  }
  if (record.expiresAt && record.expiresAt <= Date.now()) {
    throw new Error("Context expired");
  }

  if (options?.touch !== false) {
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

export function revokeRuntimeContext(contextId: string): ContextRecord {
  return dbRevokeContext(contextId);
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
