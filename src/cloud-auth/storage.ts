import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getRaviStateDir } from "../utils/paths.js";
import { CloudAuthError } from "./errors.js";
import type { CloudCredentials, SafeCloudAuthSession } from "./types.js";

const STORE_DIR_MODE = 0o700;
const CREDENTIALS_FILE_MODE = 0o600;
const CREDENTIALS_FILE = "credentials.json";

export function getCloudAuthDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(getRaviStateDir(env), "cloud-auth");
}

export function getCloudCredentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getCloudAuthDir(env), CREDENTIALS_FILE);
}

export function readCloudCredentials(env: NodeJS.ProcessEnv = process.env): CloudCredentials | null {
  const path = getCloudCredentialsPath(env);
  if (!existsSync(path)) return null;
  assertUserOnlyFileMode(path);

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new CloudAuthError(
      "CREDENTIALS_INVALID",
      "Stored Ravi Cloud credentials are invalid. Run `ravi logout` and login again.",
      {
        cause: error,
      },
    );
  }

  return normalizeStoredCredentials(parsed);
}

export function writeCloudCredentials(credentials: CloudCredentials, env: NodeJS.ProcessEnv = process.env): void {
  const dir = getCloudAuthDir(env);
  const path = getCloudCredentialsPath(env);
  mkdirSync(dir, { recursive: true, mode: STORE_DIR_MODE });
  chmodSync(dir, STORE_DIR_MODE);

  const tmpPath = join(dir, `.credentials.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmpPath, `${JSON.stringify(credentials, null, 2)}\n`, { mode: CREDENTIALS_FILE_MODE });
  chmodSync(tmpPath, CREDENTIALS_FILE_MODE);
  renameSync(tmpPath, path);
  chmodSync(path, CREDENTIALS_FILE_MODE);
}

export function deleteCloudCredentials(env: NodeJS.ProcessEnv = process.env): void {
  rmSync(getCloudCredentialsPath(env), { force: true });
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
