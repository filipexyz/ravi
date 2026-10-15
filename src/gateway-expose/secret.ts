// The tunnel credentials Console returns once at expose/rotate
// (`{AccountTag, TunnelID, TunnelSecret}`, the cloudflared credentials-file
// object of a locally managed tunnel). Stored under the Keychain / Secret
// Service name `ravi.gateway-tunnel` with the same backend selection as cloud
// auth (`RAVI_CLOUD_AUTH_BACKEND`, the stdin-only `security -i` write) and the
// 0600 file store under `~/.ravi/gateway/` as the fallback.
//
// Nothing here prints, logs or puts the secret in argv. The tunnel runner
// hands the JSON to cloudflared only through the child's environment
// (`TUNNEL_CRED_CONTENTS`); no credentials file is materialised for it.

import { lstatSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  type CloudAuthBackendDeps,
  type CloudAuthSecretBackend,
  createBackend,
  getCloudUserCredentialsPath,
  selectCloudAuthBackend,
} from "../cloud-auth/secret-backends.js";
import { getRaviStateDir } from "../utils/paths.js";

export const GATEWAY_TUNNEL_SECRET_SERVICE = "ravi.gateway-tunnel";
/** The single stored item's account name (one tunnel per installation). */
export const GATEWAY_TUNNEL_SECRET_ACCOUNT = "tunnel";

export interface TunnelCredentials {
  AccountTag: string;
  TunnelID: string;
  TunnelSecret: string;
}

export function gatewayStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(getRaviStateDir(env), "gateway");
}

export type TunnelSecretDeps = Omit<CloudAuthBackendDeps, "usersDir" | "service" | "label"> & {
  /** Defaults to `~/.ravi/gateway`. */
  gatewayDir?: string;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCOUNT_TAG_RE = /^[0-9a-f]{32}$/i;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Strict: exactly the three string fields, a UUID tunnel id and a base64 secret of at least 32 bytes. */
export function parseTunnelCredentials(value: unknown): TunnelCredentials | null {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "AccountTag,TunnelID,TunnelSecret") return null;
  const { AccountTag, TunnelID, TunnelSecret } = record;
  if (typeof AccountTag !== "string" || !ACCOUNT_TAG_RE.test(AccountTag)) return null;
  if (typeof TunnelID !== "string" || !UUID_RE.test(TunnelID)) return null;
  if (typeof TunnelSecret !== "string" || !BASE64_RE.test(TunnelSecret)) return null;
  if (Buffer.from(TunnelSecret, "base64").byteLength < 32) return null;
  return { AccountTag, TunnelID: TunnelID.toLowerCase(), TunnelSecret };
}

/** Compact JSON, the exact value cloudflared reads from `TUNNEL_CRED_CONTENTS`. */
export function serializeTunnelCredentials(credentials: TunnelCredentials): string {
  return JSON.stringify({
    AccountTag: credentials.AccountTag,
    TunnelID: credentials.TunnelID,
    TunnelSecret: credentials.TunnelSecret,
  });
}

function backendDeps(deps: TunnelSecretDeps): CloudAuthBackendDeps {
  const { gatewayDir, ...rest } = deps;
  return {
    ...rest,
    env: deps.env ?? process.env,
    usersDir: gatewayDir ?? gatewayStateDir(deps.env ?? process.env),
    service: GATEWAY_TUNNEL_SECRET_SERVICE,
    label: () => "Ravi gateway tunnel",
  };
}

export function tunnelCredentialsFilePath(deps: TunnelSecretDeps = {}): string {
  return getCloudUserCredentialsPath(backendDeps(deps).usersDir, GATEWAY_TUNNEL_SECRET_ACCOUNT);
}

export type StoredTunnelBackend = CloudAuthSecretBackend["name"];

/**
 * Writes the credentials to the selected backend; when an optional backend
 * (Keychain, Secret Service) refuses, falls back to the 0600 file. Whatever
 * other copy existed is deleted, so exactly one store holds the secret.
 */
export function storeTunnelCredentials(
  credentials: TunnelCredentials,
  deps: TunnelSecretDeps = {},
): { backend: StoredTunnelBackend } {
  const valid = parseTunnelCredentials(credentials);
  if (!valid) throw new Error("Refusing to store malformed tunnel credentials.");
  const payload = serializeTunnelCredentials(valid);
  const resolved = backendDeps(deps);
  const selected = selectCloudAuthBackend(resolved);
  const file = createBackend("file", resolved);
  if (selected.name !== "file") {
    try {
      selected.write(GATEWAY_TUNNEL_SECRET_ACCOUNT, payload);
      file.delete(GATEWAY_TUNNEL_SECRET_ACCOUNT);
      return { backend: selected.name };
    } catch {
      try {
        selected.delete(GATEWAY_TUNNEL_SECRET_ACCOUNT);
      } catch {
        // Best effort: the file store below becomes the one reads use.
      }
    }
  }
  file.write(GATEWAY_TUNNEL_SECRET_ACCOUNT, payload);
  return { backend: "file" };
}

export type ReadTunnelCredentialsResult =
  | { found: true; credentials: TunnelCredentials; backend: StoredTunnelBackend }
  | { found: false; reason: "missing" | "invalid" | "file_mode_unsafe" };

/** The selected optional backend first, then the 0600 file (refused when it is not private to this user). */
export function readTunnelCredentials(deps: TunnelSecretDeps = {}): ReadTunnelCredentialsResult {
  const resolved = backendDeps(deps);
  const selected = selectCloudAuthBackend(resolved);
  if (selected.name !== "file") {
    const raw = selected.read(GATEWAY_TUNNEL_SECRET_ACCOUNT);
    if (raw !== null) {
      const credentials = parseTunnelCredentials(raw);
      return credentials ? { found: true, credentials, backend: selected.name } : { found: false, reason: "invalid" };
    }
  }
  const path = tunnelCredentialsFilePath(deps);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    return { found: false, reason: "missing" };
  }
  const uid = process.getuid?.();
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (uid !== undefined && stat.uid !== uid)) {
    return { found: false, reason: "file_mode_unsafe" };
  }
  const credentials = parseTunnelCredentials(readFileSync(path, "utf8"));
  return credentials ? { found: true, credentials, backend: "file" } : { found: false, reason: "invalid" };
}

/** Removes the credentials from every backend (unexpose, 05b). */
export function deleteTunnelCredentials(deps: TunnelSecretDeps = {}): void {
  const resolved = backendDeps(deps);
  const selected = selectCloudAuthBackend(resolved);
  if (selected.name !== "file") {
    try {
      selected.delete(GATEWAY_TUNNEL_SECRET_ACCOUNT);
    } catch {
      // Best effort; the file copy below is removed regardless.
    }
  }
  rmSync(join(resolved.usersDir, GATEWAY_TUNNEL_SECRET_ACCOUNT), { recursive: true, force: true });
}
