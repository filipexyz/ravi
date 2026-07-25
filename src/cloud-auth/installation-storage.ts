import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getCloudAuthDir } from "./storage.js";
import {
  RemoteInstallationCredentialSchema,
  normalizeRemoteLoginEndpoint,
  type RemoteInstallationCredential,
} from "./remote-login.js";
import { CloudAuthError } from "./errors.js";

const STORE_DIR_MODE = 0o700;
const CREDENTIALS_FILE_MODE = 0o600;
const INSTALLATION_CREDENTIALS_FILE = "installation-credentials.json";

export interface StoredRemoteInstallationCredential {
  readonly endpointUrl: string;
  readonly credential: RemoteInstallationCredential;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RemoteInstallationCredentialState {
  readonly version: 1;
  readonly clientInstallationId: string;
  readonly activeEndpointUrl?: string;
  readonly connections: Record<string, StoredRemoteInstallationCredential>;
}

export interface SafeRemoteInstallationCredential {
  readonly endpointUrl: string;
  readonly provider: string;
  readonly credentialId: string;
  readonly publicMetadata?: Record<string, unknown>;
  readonly expiresAt?: string;
}

export function getRemoteInstallationCredentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getCloudAuthDir(env), INSTALLATION_CREDENTIALS_FILE);
}

export function readRemoteInstallationCredentialState(
  env: NodeJS.ProcessEnv = process.env,
): RemoteInstallationCredentialState | null {
  const path = getRemoteInstallationCredentialsPath(env);
  if (!existsSync(path)) return null;
  assertUserOnlyFileMode(path);
  let decoded: unknown;
  try {
    decoded = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw invalidCredentials(error);
  }
  return normalizeState(decoded);
}

export function ensureRemoteClientInstallationId(
  seed: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  idFactory: () => string = () => crypto.randomUUID(),
): string {
  const current = readRemoteInstallationCredentialState(env);
  if (current) return current.clientInstallationId;
  const clientInstallationId = normalizeOpaqueId(seed ?? idFactory());
  writeState(
    {
      version: 1,
      clientInstallationId,
      connections: {},
    },
    env,
  );
  return clientInstallationId;
}

export function readRemoteInstallationCredential(
  endpointUrl?: string,
  env: NodeJS.ProcessEnv = process.env,
): StoredRemoteInstallationCredential | null {
  const state = readRemoteInstallationCredentialState(env);
  if (!state) return null;
  const endpoint = endpointUrl ? normalizeRemoteLoginEndpoint(endpointUrl) : state.activeEndpointUrl;
  if (!endpoint) return null;
  return state.connections[endpoint] ?? null;
}

export function writeRemoteInstallationCredential(
  endpointUrl: string,
  clientInstallationId: string,
  credentialInput: RemoteInstallationCredential,
  env: NodeJS.ProcessEnv = process.env,
  now: () => string = () => new Date().toISOString(),
): StoredRemoteInstallationCredential {
  const endpoint = normalizeRemoteLoginEndpoint(endpointUrl);
  const credential = RemoteInstallationCredentialSchema.parse(credentialInput);
  const current = readRemoteInstallationCredentialState(env);
  const normalizedInstallationId = normalizeOpaqueId(clientInstallationId);
  if (current && current.clientInstallationId !== normalizedInstallationId) {
    throw new CloudAuthError(
      "CREDENTIALS_INVALID",
      "Stored remote installation identity does not match the active Ravi installation.",
    );
  }
  const timestamp = now();
  const previous = current?.connections[endpoint];
  const stored: StoredRemoteInstallationCredential = {
    endpointUrl: endpoint,
    credential,
    createdAt: previous?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
  writeState(
    {
      version: 1,
      clientInstallationId: normalizedInstallationId,
      activeEndpointUrl: endpoint,
      connections: {
        ...(current?.connections ?? {}),
        [endpoint]: stored,
      },
    },
    env,
  );
  return stored;
}

export function toSafeRemoteInstallationCredential(
  stored: StoredRemoteInstallationCredential,
): SafeRemoteInstallationCredential {
  return {
    endpointUrl: stored.endpointUrl,
    provider: stored.credential.provider,
    credentialId: stored.credential.credentialId,
    ...(stored.credential.publicMetadata === undefined
      ? {}
      : { publicMetadata: structuredClone(stored.credential.publicMetadata) }),
    ...(stored.credential.expiresAt === undefined ? {} : { expiresAt: stored.credential.expiresAt }),
  };
}

function normalizeState(value: unknown): RemoteInstallationCredentialState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidCredentials();
  }
  const input = value as Record<string, unknown>;
  if (input.version !== 1 || typeof input.clientInstallationId !== "string") {
    throw invalidCredentials();
  }
  const rawConnections = input.connections;
  if (!rawConnections || typeof rawConnections !== "object" || Array.isArray(rawConnections)) {
    throw invalidCredentials();
  }
  const connections: Record<string, StoredRemoteInstallationCredential> = {};
  for (const [rawEndpoint, rawStored] of Object.entries(rawConnections)) {
    const endpointUrl = normalizeRemoteLoginEndpoint(rawEndpoint);
    if (!rawStored || typeof rawStored !== "object" || Array.isArray(rawStored)) {
      throw invalidCredentials();
    }
    const stored = rawStored as Record<string, unknown>;
    if (
      stored.endpointUrl !== endpointUrl ||
      typeof stored.createdAt !== "string" ||
      typeof stored.updatedAt !== "string"
    ) {
      throw invalidCredentials();
    }
    const credential = RemoteInstallationCredentialSchema.safeParse(stored.credential);
    if (!credential.success) throw invalidCredentials();
    connections[endpointUrl] = {
      endpointUrl,
      credential: credential.data,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
    };
  }
  const activeEndpointUrl =
    typeof input.activeEndpointUrl === "string" ? normalizeRemoteLoginEndpoint(input.activeEndpointUrl) : undefined;
  if (activeEndpointUrl && !connections[activeEndpointUrl]) {
    throw invalidCredentials();
  }
  return {
    version: 1,
    clientInstallationId: normalizeOpaqueId(input.clientInstallationId),
    ...(activeEndpointUrl ? { activeEndpointUrl } : {}),
    connections,
  };
}

function writeState(state: RemoteInstallationCredentialState, env: NodeJS.ProcessEnv): void {
  const dir = getCloudAuthDir(env);
  const path = getRemoteInstallationCredentialsPath(env);
  mkdirSync(dir, { recursive: true, mode: STORE_DIR_MODE });
  chmodSync(dir, STORE_DIR_MODE);
  const temporaryPath = join(dir, `.installation-credentials.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: CREDENTIALS_FILE_MODE });
  chmodSync(temporaryPath, CREDENTIALS_FILE_MODE);
  renameSync(temporaryPath, path);
  chmodSync(path, CREDENTIALS_FILE_MODE);
}

function normalizeOpaqueId(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/.test(normalized)) {
    throw invalidCredentials();
  }
  return normalized;
}

function assertUserOnlyFileMode(path: string): void {
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077) {
    throw new CloudAuthError(
      "CREDENTIALS_INVALID",
      `Stored remote installation credentials file has mode 0${mode.toString(8).padStart(3, "0")}; expected 0600.`,
    );
  }
}

function invalidCredentials(cause?: unknown): CloudAuthError {
  return new CloudAuthError(
    "CREDENTIALS_INVALID",
    "Stored remote installation credentials are invalid.",
    cause === undefined ? {} : { cause },
  );
}
