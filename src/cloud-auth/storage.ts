import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { getRaviStateDir } from "../utils/paths.js";
import { CloudAuthError } from "./errors.js";
import {
  CLOUD_AUTH_BACKEND_ENV,
  getCloudUserCredentialsPath,
  getCloudUserDir,
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
  const backend = resolveUserBackend(sanitizeUserId(userId), env);
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
      // An item from an earlier optional-backend write must not outlive this
      // one: reads follow the file store now, and stale tokens are still tokens.
      // A failed delete (locked Keychain) is reported, never thrown: the pointer
      // already sends reads to the file store, and logout clears both stores.
      const survivingItem = deleteFromBackend(backend, userId);
      warnFileStoreFallback(backend.name, userId, error, env, survivingItem);
      maybeDeletePromotedLegacy(userId, previousActive, env);
      removeLegacyCredentialsFile(env);
      return;
    }
    throw error;
  }
  if (backend.name !== "file") {
    // A file copy from an earlier fallback is stale now; reads of a user who is
    // not active prefer the file store when one exists.
    rmSync(getCloudUserCredentialsPath(getCloudAuthUsersDir(env), userId), { force: true });
  }

  writePointer({ version: 1, activeUserId: userId, backend: backend.name }, env);
  maybeDeletePromotedLegacy(userId, previousActive, env);
  removeLegacyCredentialsFile(env);
}

export function deleteCloudCredentials(env: NodeJS.ProcessEnv = process.env): void {
  migrateLegacyCloudAuthStore(env);
  const activeUserId = readPointer(env)?.activeUserId ?? null;
  if (activeUserId) {
    deleteStoredCredentials(sanitizeUserId(activeUserId), env);
  }
  rmSync(getCloudCredentialsPath(env), { force: true });
  promoteNextUser(activeUserId, env);
}

export function deleteCloudCredentialsForUser(userId: string, env: NodeJS.ProcessEnv = process.env): void {
  migrateLegacyCloudAuthStore(env);
  const sanitized = sanitizeUserId(userId);
  deleteStoredCredentials(sanitized, env);
  if (readPointer(env)?.activeUserId === sanitized) {
    promoteNextUser(sanitized, env);
  }
}

/**
 * After `departing` logs out, point at the next stored user, recording the
 * store that holds that user's credentials (a file copy left by a Keychain
 * fallback wins over the configured backend). The departing user's backend
 * says nothing about the promoted one: reusing it sent reads to a stale
 * Keychain item, or to a Keychain that never held them while a live `0600`
 * token file lingered. Without another user the pointer is removed.
 */
function promoteNextUser(departing: string | null, env: NodeJS.ProcessEnv): void {
  const next = listCloudAuthUserIds(env).find((userId) => userId !== departing);
  if (!next) {
    rmSync(getActiveCloudAuthPointerPath(env), { force: true });
    return;
  }
  writePointer({ version: 1, activeUserId: next, backend: resolveUserBackendName(next, env) }, env);
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

/**
 * Merge `/api/cli/me` into stored credentials. The Console's
 * `localInstallation.id` replaces a locally generated installation id, so
 * calls pinned to the CLI session's installation name the one Console knows.
 */
export function persistMeIntoCredentials(
  credentials: CloudCredentials,
  me: {
    user?: CloudCredentials["user"];
    organization?: CloudCredentials["organization"];
    org?: CloudCredentials["organization"];
    localInstallation?: { id?: string | null } | null;
  },
): CloudCredentials {
  const installationId = me.localInstallation?.id?.trim();
  return {
    ...credentials,
    ...(installationId ? { installationId } : {}),
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
  const installationChanged = Boolean(next.installationId && next.installationId !== previous.installationId);
  return Boolean(
    (nextUserId && nextUserId !== previousUserId) || (nextOrgId && nextOrgId !== previousOrgId) || installationChanged,
  );
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
    // Through the store that holds the slot, and the file copy either way: a
    // legacy copy left by a Keychain fallback must not outlive its promotion.
    deleteStoredCredentials(LEGACY_CLOUD_AUTH_USER_ID, env);
  }
}

function removeLegacyCredentialsFile(env: NodeJS.ProcessEnv): void {
  rmSync(getCloudCredentialsPath(env), { force: true });
}

type CloudAuthBackendTestDeps = Pick<CloudAuthBackendDeps, "platform" | "commandExists" | "runCommand"> & {
  warn?: (message: string) => void;
};

let backendTestDeps: CloudAuthBackendTestDeps | null = null;
let warnedFileStoreFallback = false;

/** Fake the platform and the `security`/`secret-tool` runner in tests; no argument restores the real ones. */
export function setCloudAuthBackendDepsForTests(deps?: CloudAuthBackendTestDeps): void {
  backendTestDeps = deps ?? null;
  warnedFileStoreFallback = false;
}

function resolveBackend(env: NodeJS.ProcessEnv, forceName?: CloudAuthBackendName): CloudAuthSecretBackend {
  const deps: CloudAuthBackendDeps = {
    env: forceName ? { ...env, [CLOUD_AUTH_BACKEND_ENV]: forceName } : env,
    usersDir: getCloudAuthUsersDir(env),
    platform: backendTestDeps?.platform ?? process.platform,
    ...(backendTestDeps?.commandExists ? { commandExists: backendTestDeps.commandExists } : {}),
    ...(backendTestDeps?.runCommand ? { runCommand: backendTestDeps.runCommand } : {}),
  };
  return selectCloudAuthBackend(deps);
}

/**
 * The store that holds `userId`'s credentials: the backend the active pointer
 * recorded at the last write (a failed Keychain write falls back to the file
 * store), the file store when it holds a copy, else the configured backend.
 * Reads and logout promotion share this rule, so the pointer written for a
 * promoted user names the store a read of that user would have used.
 */
function resolveUserBackendName(userId: string, env: NodeJS.ProcessEnv): CloudAuthBackendName {
  const pointer = readPointer(env);
  if (pointer?.activeUserId === userId) return pointer.backend;
  if (existsSync(getCloudUserCredentialsPath(getCloudAuthUsersDir(env), userId))) return "file";
  return resolveBackend(env).name;
}

function resolveUserBackend(userId: string, env: NodeJS.ProcessEnv): CloudAuthSecretBackend {
  return resolveBackend(env, resolveUserBackendName(userId, env));
}

/**
 * Remove `userId` from every store that may hold a copy: the resolved store,
 * the file copy, and the configured optional backend when it differs (a
 * Keychain item left behind by a locked-Keychain fallback is still a token,
 * and `readCloudCredentialsForUser` would hand it out after logout). A
 * backend delete that fails is warned about, never thrown past logout.
 */
function deleteStoredCredentials(userId: string, env: NodeJS.ProcessEnv): void {
  const resolved = resolveUserBackend(userId, env);
  const configured = resolveBackend(env);
  const failures: Array<{ backend: CloudAuthBackendName; error: unknown }> = [];

  if (resolved.name !== "file") {
    const error = deleteFromBackend(resolved, userId);
    if (error) failures.push({ backend: resolved.name, error });
  }
  // The file store either way: the resolved store, or a copy a fallback left.
  rmSync(getCloudUserDir(getCloudAuthUsersDir(env), userId), { recursive: true, force: true });
  if (configured.name !== "file" && configured.name !== resolved.name) {
    const error = deleteFromBackend(configured, userId);
    if (error) failures.push({ backend: configured.name, error });
  }
  for (const failure of failures) warnBackendDeleteFailed(failure.backend, userId, failure.error);
}

/** Best-effort delete in an optional backend; returns the error instead of throwing. */
function deleteFromBackend(backend: CloudAuthSecretBackend, userId: string): unknown {
  try {
    backend.delete(userId);
    return null;
  } catch (error) {
    return error ?? new Error("delete failed");
  }
}

const BACKEND_LABELS: Record<CloudAuthBackendName, string> = {
  file: "the file store",
  keychain: "macOS Keychain",
  libsecret: "the Secret Service",
};

function warnFileStoreFallback(
  backend: CloudAuthBackendName,
  userId: string,
  error: unknown,
  env: NodeJS.ProcessEnv,
  survivingItem: unknown = null,
): void {
  if (warnedFileStoreFallback) return;
  warnedFileStoreFallback = true;
  const cause = errorCause(error);
  const path = getCloudUserCredentialsPath(getCloudAuthUsersDir(env), userId);
  let message =
    `Ravi Cloud credentials were saved to the private file store (${path}, mode 0600) because ` +
    `${BACKEND_LABELS[backend]} could not store them${cause ? `: ${cause}` : "."}`;
  if (survivingItem) {
    const deleteCause = errorCause(survivingItem);
    message +=
      ` An older ${BACKEND_LABELS[backend]} item for this user could not be removed` +
      `${deleteCause ? ` (${deleteCause})` : ""}; it will be deleted at the next logout.`;
  }
  emitWarning(message);
}

function warnBackendDeleteFailed(backend: CloudAuthBackendName, userId: string, error: unknown): void {
  const cause = errorCause(error);
  emitWarning(
    `The ${BACKEND_LABELS[backend]} item for Ravi Cloud user ${userId} could not be removed` +
      `${cause ? ` (${cause})` : ""}; run \`ravi logout\` again once ${BACKEND_LABELS[backend]} is unlocked.`,
  );
}

/** The backend's redacted `cause` message; never the payload. */
function errorCause(error: unknown): string {
  return error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
}

function emitWarning(message: string): void {
  if (backendTestDeps?.warn) backendTestDeps.warn(message);
  else process.stderr.write(`warning: ${message}\n`);
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
