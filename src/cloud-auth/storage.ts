import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { getRaviStateDir } from "../utils/paths.js";
import { CloudAuthError } from "./errors.js";
import {
  CLOUD_AUTH_BACKEND_ENV,
  getCloudUserCredentialsPath,
  selectCloudAuthBackend,
  writeUserOnlyFile,
  type CloudAuthBackendDeps,
  type CloudAuthSecretBackend,
} from "./secret-backends.js";
import type { CloudAuthBackendName, CloudAuthStorePointer, CloudCredentials, SafeCloudAuthSession } from "./types.js";
import { LEGACY_CLOUD_AUTH_USER_ID } from "./types.js";

const STORE_DIR_MODE = 0o700;
const LEGACY_CREDENTIALS_FILE = "credentials.json";
const ACTIVE_POINTER_FILE = "active.json";
const USERS_DIR = "users";

export function getCloudAuthDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(getRaviStateDir(env), "cloud-auth");
}

export function getCloudAuthUsersDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(getCloudAuthDir(env), USERS_DIR);
}

/** Legacy single-slot path. Kept for migration only. */
export function getCloudCredentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getCloudAuthDir(env), LEGACY_CREDENTIALS_FILE);
}

export function getActiveCloudAuthPointerPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getCloudAuthDir(env), ACTIVE_POINTER_FILE);
}

export function getActiveCloudCredentialsPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const userId = readActiveCloudAuthUserId(env);
  if (!userId) return null;
  return getCloudUserCredentialsPath(getCloudAuthUsersDir(env), userId);
}

export function readActiveCloudAuthUserId(env: NodeJS.ProcessEnv = process.env): string | null {
  migrateLegacyCloudAuthStore(env);
  return readPointer(env)?.activeUserId ?? null;
}

export function listCloudAuthUserIds(env: NodeJS.ProcessEnv = process.env): string[] {
  migrateLegacyCloudAuthStore(env);
  const usersDir = getCloudAuthUsersDir(env);
  if (!existsSync(usersDir)) return [];
  return readdirSync(usersDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
}

export function readCloudCredentials(env: NodeJS.ProcessEnv = process.env): CloudCredentials | null {
  migrateLegacyCloudAuthStore(env);
  const userId = readPointer(env)?.activeUserId;
  if (!userId) return null;
  return readCloudCredentialsForUser(userId, env);
}

export function readCloudCredentialsForUser(
  userId: string,
  env: NodeJS.ProcessEnv = process.env,
): CloudCredentials | null {
  migrateLegacyCloudAuthStore(env);
  const backend = resolveBackend(env);
  const raw = backend.read(sanitizeUserId(userId));
  if (raw == null) return null;
  return parseStoredCredentials(raw, getCloudUserCredentialsPath(getCloudAuthUsersDir(env), sanitizeUserId(userId)));
}

export function writeCloudCredentials(credentials: CloudCredentials, env: NodeJS.ProcessEnv = process.env): void {
  migrateLegacyCloudAuthStore(env);
  const userId = resolveWriteUserId(credentials);
  const backend = resolveBackend(env);
  const previousActive = readPointer(env)?.activeUserId ?? null;

  ensureStoreDirs(env);
  try {
    backend.write(userId, `${JSON.stringify(credentials, null, 2)}\n`);
  } catch (error) {
    if (backend.name !== "file") {
      const fileBackend = resolveBackend({ ...env, [CLOUD_AUTH_BACKEND_ENV]: "file" }, "file");
      fileBackend.write(userId, `${JSON.stringify(credentials, null, 2)}\n`);
      writePointer({ version: 1, activeUserId: userId, backend: "file" }, env);
      maybeDeletePromotedLegacy(userId, previousActive, env);
      removeLegacyCredentialsFile(env);
      return;
    }
    throw error;
  }

  writePointer({ version: 1, activeUserId: userId, backend: backend.name }, env);
  maybeDeletePromotedLegacy(userId, previousActive, env);
  removeLegacyCredentialsFile(env);
}

export function deleteCloudCredentials(env: NodeJS.ProcessEnv = process.env): void {
  migrateLegacyCloudAuthStore(env);
  const pointer = readPointer(env);
  const activeUserId = pointer?.activeUserId;
  if (activeUserId) {
    resolveBackend(env).delete(sanitizeUserId(activeUserId));
  }
  rmSync(getCloudCredentialsPath(env), { force: true });

  const remaining = listCloudAuthUserIds(env).filter((userId) => userId !== activeUserId);
  if (remaining[0]) {
    writePointer(
      {
        version: 1,
        activeUserId: remaining[0],
        backend: pointer?.backend ?? "file",
      },
      env,
    );
    return;
  }
  rmSync(getActiveCloudAuthPointerPath(env), { force: true });
}

export function deleteCloudCredentialsForUser(userId: string, env: NodeJS.ProcessEnv = process.env): void {
  migrateLegacyCloudAuthStore(env);
  const sanitized = sanitizeUserId(userId);
  resolveBackend(env).delete(sanitized);
  const pointer = readPointer(env);
  if (pointer?.activeUserId === sanitized) {
    const remaining = listCloudAuthUserIds(env);
    if (remaining[0]) {
      writePointer({ version: 1, activeUserId: remaining[0], backend: pointer.backend }, env);
    } else {
      rmSync(getActiveCloudAuthPointerPath(env), { force: true });
    }
  }
}

export function toSafeCloudAuthSession(credentials: CloudCredentials): SafeCloudAuthSession {
  return {
    consoleUrl: credentials.consoleUrl,
    user: credentials.user ?? null,
    organization: credentials.organization ?? null,
    installation: {
      id: credentials.installationId,
    },
    scopes: credentials.scopes,
    accessTokenExpiresAt: credentials.accessTokenExpiresAt,
    refreshTokenExpiresAt: credentials.refreshTokenExpiresAt ?? null,
  };
}

export function persistMeIntoCredentials(
  credentials: CloudCredentials,
  me: {
    user?: CloudCredentials["user"];
    organization?: CloudCredentials["organization"];
    org?: CloudCredentials["organization"];
  },
): CloudCredentials {
  return {
    ...credentials,
    user: me.user ?? credentials.user ?? null,
    organization: me.organization ?? me.org ?? credentials.organization ?? null,
    updatedAt: new Date().toISOString(),
  };
}

export function shouldPersistHydratedIdentity(previous: CloudCredentials, next: CloudCredentials): boolean {
  const previousUserId = previous.user?.id?.trim() || "";
  const nextUserId = next.user?.id?.trim() || "";
  const previousOrgId = previous.organization?.id?.trim() || "";
  const nextOrgId = next.organization?.id?.trim() || "";
  return Boolean((nextUserId && nextUserId !== previousUserId) || (nextOrgId && nextOrgId !== previousOrgId));
}

export function migrateLegacyCloudAuthStore(env: NodeJS.ProcessEnv = process.env): void {
  const legacyPath = getCloudCredentialsPath(env);
  if (!existsSync(legacyPath)) return;

  let credentials: CloudCredentials;
  try {
    assertUserOnlyFileMode(legacyPath);
    credentials = normalizeStoredCredentials(JSON.parse(readFileSync(legacyPath, "utf8")));
  } catch (error) {
    throw error instanceof CloudAuthError
      ? error
      : new CloudAuthError(
          "CREDENTIALS_INVALID",
          "Stored Ravi Cloud credentials are invalid. Run `ravi logout` and login again.",
          { cause: error },
        );
  }

  const userId = resolveWriteUserId(credentials);
  const usersDir = getCloudAuthUsersDir(env);
  ensureStoreDirs(env);
  const fileBackend = resolveBackend({ ...env, [CLOUD_AUTH_BACKEND_ENV]: "file" }, "file");
  fileBackend.write(userId, `${JSON.stringify(credentials, null, 2)}\n`);
  if (!readPointer(env)?.activeUserId) {
    writePointer({ version: 1, activeUserId: userId, backend: "file" }, env);
  }
  rmSync(legacyPath, { force: true });
  chmodSync(usersDir, STORE_DIR_MODE);
}

function resolveWriteUserId(credentials: CloudCredentials): string {
  const userId = credentials.user?.id?.trim();
  return userId ? sanitizeUserId(userId) : LEGACY_CLOUD_AUTH_USER_ID;
}

function maybeDeletePromotedLegacy(userId: string, previousActive: string | null, env: NodeJS.ProcessEnv): void {
  if (userId === LEGACY_CLOUD_AUTH_USER_ID) return;
  if (previousActive === LEGACY_CLOUD_AUTH_USER_ID) {
    resolveBackend(env).delete(LEGACY_CLOUD_AUTH_USER_ID);
  }
}

function removeLegacyCredentialsFile(env: NodeJS.ProcessEnv): void {
  rmSync(getCloudCredentialsPath(env), { force: true });
}

function resolveBackend(env: NodeJS.ProcessEnv, forceName?: CloudAuthBackendName): CloudAuthSecretBackend {
  const deps: CloudAuthBackendDeps = {
    env: forceName ? { ...env, [CLOUD_AUTH_BACKEND_ENV]: forceName } : env,
    usersDir: getCloudAuthUsersDir(env),
    platform: process.platform,
  };
  return selectCloudAuthBackend(deps);
}

function ensureStoreDirs(env: NodeJS.ProcessEnv): void {
  const dir = getCloudAuthDir(env);
  const usersDir = getCloudAuthUsersDir(env);
  mkdirSync(dir, { recursive: true, mode: STORE_DIR_MODE });
  chmodSync(dir, STORE_DIR_MODE);
  mkdirSync(usersDir, { recursive: true, mode: STORE_DIR_MODE });
  chmodSync(usersDir, STORE_DIR_MODE);
}

function readPointer(env: NodeJS.ProcessEnv): CloudAuthStorePointer | null {
  const path = getActiveCloudAuthPointerPath(env);
  if (!existsSync(path)) return null;
  assertUserOnlyFileMode(path);
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const input = parsed as Record<string, unknown>;
    const activeUserId = typeof input.activeUserId === "string" ? input.activeUserId.trim() : "";
    if (!activeUserId) return null;
    const backend = input.backend === "libsecret" || input.backend === "keychain" ? input.backend : "file";
    return { version: 1, activeUserId, backend };
  } catch {
    return null;
  }
}

function writePointer(pointer: CloudAuthStorePointer, env: NodeJS.ProcessEnv): void {
  ensureStoreDirs(env);
  writeUserOnlyFile(getActiveCloudAuthPointerPath(env), `${JSON.stringify(pointer, null, 2)}\n`);
}

function parseStoredCredentials(raw: string, pathForMode: string): CloudCredentials {
  if (existsSync(pathForMode)) {
    assertUserOnlyFileMode(pathForMode);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new CloudAuthError(
      "CREDENTIALS_INVALID",
      "Stored Ravi Cloud credentials are invalid. Run `ravi logout` and login again.",
      { cause: error },
    );
  }
  return normalizeStoredCredentials(parsed);
}

function normalizeStoredCredentials(value: unknown): CloudCredentials {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CloudAuthError(
      "CREDENTIALS_INVALID",
      "Stored Ravi Cloud credentials are invalid. Run `ravi logout` and login again.",
    );
  }

  const input = value as Record<string, unknown>;
  const accessToken = asString(input.accessToken);
  const refreshToken = asString(input.refreshToken);
  const consoleUrl = asString(input.consoleUrl);
  const installationId = asString(input.installationId);

  if (!accessToken || !refreshToken || !consoleUrl || !installationId) {
    throw new CloudAuthError(
      "CREDENTIALS_INVALID",
      "Stored Ravi Cloud credentials are incomplete. Run `ravi logout` and login again.",
    );
  }

  return {
    version: 1,
    consoleUrl,
    installationId,
    accessToken,
    refreshToken,
    accessTokenExpiresAt: asString(input.accessTokenExpiresAt),
    refreshTokenExpiresAt: asString(input.refreshTokenExpiresAt),
    scopes: Array.isArray(input.scopes)
      ? input.scopes.filter((scope): scope is string => typeof scope === "string")
      : [],
    user: objectOrNull(input.user),
    organization: objectOrNull(input.organization),
    createdAt: asString(input.createdAt) ?? new Date().toISOString(),
    updatedAt: asString(input.updatedAt) ?? new Date().toISOString(),
  };
}

export function sanitizeUserId(userId: string): string {
  const trimmed = userId.trim();
  if (!trimmed || trimmed === "." || trimmed === ".." || trimmed.includes("/") || trimmed.includes("\\")) {
    throw new CloudAuthError("CREDENTIALS_INVALID", "Console user id is not a valid local store key.");
  }
  if (!/^[A-Za-z0-9._:@-]+$/.test(trimmed)) {
    throw new CloudAuthError("CREDENTIALS_INVALID", "Console user id is not a valid local store key.");
  }
  return trimmed;
}

function assertUserOnlyFileMode(path: string): void {
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077) {
    throw new CloudAuthError(
      "CREDENTIALS_INVALID",
      `Stored Ravi Cloud credentials file has mode 0${mode.toString(8).padStart(3, "0")}; expected 0600.`,
    );
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function objectOrNull<T extends Record<string, unknown>>(value: unknown): T | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as T;
}
