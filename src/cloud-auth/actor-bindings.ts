import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { CloudAuthError } from "./errors.js";
import { writeUserOnlyFile } from "./secret-backends.js";
import { getCloudAuthDir, sanitizeUserId } from "./storage.js";
import type { ActorBinding, ActorBindingCacheRecord, ActorPlatformIdentity } from "./types.js";

const STORE_DIR_MODE = 0o700;
const BINDINGS_DIR = "bindings";
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export const ACTOR_BINDING_CACHE_TTL_MS = DEFAULT_TTL_MS;

export function getActorBindingsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(getCloudAuthDir(env), BINDINGS_DIR);
}

export function getActorBindingCachePath(contactId: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(getActorBindingsDir(env), `${sanitizeBindingKey(contactId)}.json`);
}

export function readCachedActorBinding(
  contactId: string,
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): ActorBinding | null {
  const path = getActorBindingCachePath(contactId, env);
  if (!existsSync(path)) return null;
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077) {
    rmSync(path, { force: true });
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as ActorBindingCacheRecord;
    if (!parsed?.binding?.contactId || !parsed.binding.consoleUserId || !parsed.expiresAt) return null;
    if (Date.parse(parsed.expiresAt) <= now) {
      rmSync(path, { force: true });
      return null;
    }
    if (parsed.binding.contactId !== contactId) return null;
    return parsed.binding;
  } catch {
    return null;
  }
}

export function writeCachedActorBinding(
  binding: ActorBinding,
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
  ttlMs = DEFAULT_TTL_MS,
): ActorBindingCacheRecord {
  const dir = getActorBindingsDir(env);
  mkdirSync(dir, { recursive: true, mode: STORE_DIR_MODE });
  chmodSync(dir, STORE_DIR_MODE);
  const record: ActorBindingCacheRecord = {
    version: 1,
    binding,
    expiresAt: new Date(now + ttlMs).toISOString(),
    updatedAt: new Date(now).toISOString(),
  };
  writeUserOnlyFile(getActorBindingCachePath(binding.contactId, env), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

export function deleteCachedActorBinding(contactId: string, env: NodeJS.ProcessEnv = process.env): void {
  rmSync(getActorBindingCachePath(contactId, env), { force: true });
}

export function listCachedActorBindings(env: NodeJS.ProcessEnv = process.env, now = Date.now()): ActorBinding[] {
  const dir = getActorBindingsDir(env);
  if (!existsSync(dir)) return [];
  const bindings: ActorBinding[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const contactId = entry.name.slice(0, -".json".length);
    const binding = readCachedActorBinding(contactId, env, now);
    if (binding) bindings.push(binding);
  }
  return bindings;
}

export function consoleIdentityFromBinding(binding: ActorBinding | null): {
  consoleUserId?: string;
  consoleOrgId?: string;
} {
  if (!binding) return {};
  return {
    consoleUserId: binding.consoleUserId,
    consoleOrgId: binding.orgId,
  };
}

export function parseActorBinding(value: unknown): ActorBinding {
  const root = asRecord(value);
  const source = asRecord(root?.binding) ?? root;
  const contactId = asString(source?.contactId);
  const consoleUserId = asString(source?.consoleUserId) ?? asString(source?.userId);
  const orgId = asString(source?.orgId) ?? asString(source?.organizationId);
  const installationId = asString(source?.installationId);
  const actorPrincipal = asString(source?.actorPrincipal) ?? (contactId ? `contact:${contactId}` : null);
  if (!contactId || !consoleUserId || !orgId || !installationId || !actorPrincipal) {
    throw new CloudAuthError("PAYLOAD_INVALID", "Console actor-binding response is incomplete.");
  }
  return {
    id: asString(source?.id) ?? undefined,
    contactId,
    actorPrincipal,
    consoleUserId,
    orgId,
    installationId,
    platformIdentity:
      parsePlatformIdentity(source?.platformIdentity) ?? parsePlatformIdentity(source?.platformIdentities),
    createdAt: asString(source?.createdAt) ?? undefined,
    updatedAt: asString(source?.updatedAt) ?? undefined,
  };
}

export function parsePlatformIdentity(value: unknown): ActorPlatformIdentity | null {
  const record = asRecord(value);
  if (!record) return null;
  const identity: ActorPlatformIdentity = {
    ...(asString(record.channel) ? { channel: asString(record.channel)! } : {}),
    ...(asString(record.accountId) ? { accountId: asString(record.accountId)! } : {}),
    ...(asString(record.platformUserId) ? { platformUserId: asString(record.platformUserId)! } : {}),
    ...(asString(record.platformIdentityId) ? { platformIdentityId: asString(record.platformIdentityId)! } : {}),
  };
  return Object.keys(identity).length > 0 ? identity : null;
}

function sanitizeBindingKey(contactId: string): string {
  return sanitizeUserId(contactId);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
