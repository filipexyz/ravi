import { spawnSync } from "node:child_process";
import type { CredentialBackend } from "./types.ts";

export interface SecretWriteInput {
  backend: CredentialBackend;
  provider: string;
  connection: string;
  secret: string;
  vaultMount?: string;
  vaultPath?: string;
  vaultKey?: string;
}

const DEFAULT_KEYCHAIN_SERVICE = "ravi.credentials.poc";

export async function readSecretFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const secret = Buffer.concat(chunks).toString("utf8").trim();
  if (!secret) throw new Error("No secret received on stdin.");
  return secret;
}

export async function writeSecret(input: SecretWriteInput): Promise<string> {
  if (input.backend === "keychain") {
    return writeKeychainSecret(input.provider, input.connection, input.secret);
  }
  return writeVaultSecret(input);
}

export async function readSecret(secretRef: string): Promise<string> {
  if (secretRef.startsWith("keychain:")) return readKeychainSecret(secretRef);
  if (secretRef.startsWith("vault:")) return readVaultSecret(secretRef);
  throw new Error(`Unsupported secret ref: ${redactSecretRef(secretRef)}`);
}

export async function deleteSecret(secretRef: string): Promise<boolean> {
  if (secretRef.startsWith("keychain:")) return deleteKeychainSecret(secretRef);
  if (secretRef.startsWith("vault:")) return deleteVaultSecret(secretRef);
  throw new Error(`Unsupported secret ref: ${redactSecretRef(secretRef)}`);
}

export function redactSecretRef(secretRef: string): string {
  if (secretRef.startsWith("keychain:")) return secretRef;
  if (secretRef.startsWith("vault:")) {
    const hashIndex = secretRef.indexOf("#");
    return hashIndex === -1 ? secretRef : `${secretRef.slice(0, hashIndex)}#[redacted-key]`;
  }
  const [kind] = secretRef.split(":", 1);
  return kind ? `${kind}:[redacted]` : "[redacted]";
}

function keychainRef(provider: string, connection: string): string {
  const service = process.env.RAVI_CREDENTIALS_POC_KEYCHAIN_SERVICE?.trim() || DEFAULT_KEYCHAIN_SERVICE;
  return `keychain:${service}/${provider}:${connection}`;
}

function parseKeychainRef(secretRef: string): { service: string; account: string } {
  const value = secretRef.slice("keychain:".length);
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) throw new Error(`Invalid keychain secret ref: ${secretRef}`);
  return { service: value.slice(0, slash), account: value.slice(slash + 1) };
}

function writeKeychainSecret(provider: string, connection: string, secret: string): string {
  const secretRef = keychainRef(provider, connection);
  const { service, account } = parseKeychainRef(secretRef);
  runSecurity(["add-generic-password", "-a", account, "-s", service, "-w", secret, "-U"]);
  return secretRef;
}

function readKeychainSecret(secretRef: string): string {
  const { service, account } = parseKeychainRef(secretRef);
  return runSecurity(["find-generic-password", "-a", account, "-s", service, "-w"]).trim();
}

function deleteKeychainSecret(secretRef: string): boolean {
  const { service, account } = parseKeychainRef(secretRef);
  const result = spawnSync("security", ["delete-generic-password", "-a", account, "-s", service], {
    encoding: "utf8",
  });
  if (result.status === 0) return true;
  if ((result.stderr ?? "").includes("could not be found")) return false;
  throw new Error(`security failed: ${redactSecurityError(result.stderr || result.stdout)}`);
}

function runSecurity(args: string[]): string {
  const result = spawnSync("security", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`security failed: ${redactSecurityError(result.stderr || result.stdout)}`);
  }
  return result.stdout ?? "";
}

function redactSecurityError(value: string): string {
  return value.replace(/(-w\s+)\S+/g, "$1[redacted]").trim();
}

function vaultRef(input: Pick<SecretWriteInput, "provider" | "connection" | "vaultMount" | "vaultPath" | "vaultKey">) {
  const mount = input.vaultMount?.trim() || "secret";
  const path = input.vaultPath?.trim() || `ravi/credentials/${input.provider}/${input.connection}`;
  const key = input.vaultKey?.trim() || "token";
  return `vault:${mount}/${path}#${key}`;
}

function parseVaultRef(secretRef: string): { mount: string; path: string; key: string } {
  const value = secretRef.slice("vault:".length);
  const hash = value.lastIndexOf("#");
  if (hash <= 0 || hash === value.length - 1) throw new Error(`Invalid vault secret ref: ${redactSecretRef(secretRef)}`);
  const pathPart = value.slice(0, hash);
  const slash = pathPart.indexOf("/");
  if (slash <= 0 || slash === pathPart.length - 1) {
    throw new Error(`Invalid vault secret ref: ${redactSecretRef(secretRef)}`);
  }
  return { mount: pathPart.slice(0, slash), path: pathPart.slice(slash + 1), key: value.slice(hash + 1) };
}

async function writeVaultSecret(input: SecretWriteInput): Promise<string> {
  const secretRef = vaultRef(input);
  const parsed = parseVaultRef(secretRef);
  const existing = (await readVaultData(parsed, { allowNotFound: true })) ?? {};
  await writeVaultData(parsed, { ...existing, [parsed.key]: input.secret });
  return secretRef;
}

async function readVaultSecret(secretRef: string): Promise<string> {
  const parsed = parseVaultRef(secretRef);
  const data = await readVaultData(parsed, { allowNotFound: false });
  if (!data) throw new Error(`Vault secret key not found: ${redactSecretRef(secretRef)}`);
  const value = data[parsed.key];
  if (typeof value !== "string" || !value) {
    throw new Error(`Vault secret key not found: ${redactSecretRef(secretRef)}`);
  }
  return value;
}

async function deleteVaultSecret(secretRef: string): Promise<boolean> {
  const parsed = parseVaultRef(secretRef);
  const existing = await readVaultData(parsed, { allowNotFound: true });
  if (!existing || !(parsed.key in existing)) return false;
  const next = { ...existing };
  delete next[parsed.key];
  if (Object.keys(next).length === 0) {
    await vaultRequest("DELETE", parsed);
    return true;
  }
  await writeVaultData(parsed, next);
  return true;
}

async function readVaultData(
  ref: { mount: string; path: string },
  options: { allowNotFound: boolean },
): Promise<Record<string, unknown> | null> {
  const payload = await vaultRequest("GET", ref, undefined, options);
  if (!payload) return null;
  const envelope = asRecord(payload);
  const outerData = asRecord(envelope.data);
  return asRecord(outerData.data);
}

async function writeVaultData(ref: { mount: string; path: string }, data: Record<string, unknown>): Promise<void> {
  await vaultRequest("POST", ref, { data });
}

async function vaultRequest(
  method: string,
  ref: { mount: string; path: string },
  body?: unknown,
  options: { allowNotFound?: boolean } = {},
): Promise<unknown | null> {
  const addr = process.env.VAULT_ADDR?.replace(/\/+$/, "");
  const token = process.env.VAULT_TOKEN;
  if (!addr || !token) throw new Error("VAULT_ADDR and VAULT_TOKEN are required for the vault backend.");
  const url = `${addr}/v1/${encodeURIComponent(ref.mount)}/data/${ref.path
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
  const response = await fetch(url, {
    method,
    headers: {
      "content-type": "application/json",
      "x-vault-token": token,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status === 404 && options.allowNotFound) return null;
  if (!response.ok) {
    throw new Error(`Vault request failed (${response.status}) for ${ref.mount}/${ref.path}`);
  }
  if (response.status === 204) return {};
  return response.json();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
