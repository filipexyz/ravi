import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { FleetError, idSchema, type SecretVault } from "./contract";

type Reference = Parameters<SecretVault["read"]>[0];
type Config = { address: string; mount: string; tokenFile: string };
export type VaultFetch = (url: string, init: RequestInit) => Promise<Response>;
const secretEnvelope = z.object({ data: z.object({ data: z.object({ value: z.string(), operationHash: z.string() }) }) });

export async function readProtectedToken(path: string) {
  if (!isAbsolute(path)) throw new FleetError("vault_not_configured", 503);
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size < 1 || stat.size > 4096) throw new Error();
    if (typeof process.getuid === "function" && ![0, process.getuid()].includes(stat.uid)) throw new Error();
    const token = (await file.readFile("utf8")).trim();
    if (!/^[A-Za-z0-9._-]+$/.test(token)) throw new Error();
    return token;
  } catch { throw new FleetError("vault_unavailable", 503); }
  finally { await file?.close(); }
}

export function vaultConfig(env: Record<string, string | undefined> = process.env): Config {
  try {
    const address = new URL(env.RAVI_FLEET_VAULT_ADDR ?? "");
    if (address.protocol !== "https:" || address.username || address.password || address.search || address.hash || address.pathname !== "/") throw new Error();
    const mount = env.RAVI_FLEET_VAULT_MOUNT ?? "console-fleet";
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(mount)) throw new Error();
    const tokenFile = env.RAVI_FLEET_VAULT_TOKEN_FILE ?? "";
    if (!isAbsolute(tokenFile)) throw new Error();
    return { address: address.origin, mount, tokenFile };
  } catch { throw new FleetError("vault_not_configured", 503); }
}

/** Vault HTTP adapter: TLS remains verified, redirects forbidden, responses bounded.
 * Each logical version is immutable (KV CAS=0). A retry after a DB rollback may
 * reuse the orphan only if its server-generated operation HMAC matches exactly.
 */
export class Kv2Vault implements SecretVault {
  constructor(private config: Config, private request: VaultFetch = fetch,
    private token: () => Promise<string> = () => readProtectedToken(config.tokenFile)) {}

  private path(ref: Reference) {
    if (!idSchema.safeParse(ref.organizationId).success || !idSchema.safeParse(ref.credentialId).success || !Number.isSafeInteger(ref.version) || ref.version < 1) {
      throw new FleetError("invalid_secret_reference");
    }
    return `${this.config.address}/v1/${this.config.mount}/data/${ref.organizationId}/${ref.credentialId}/${ref.version}`;
  }
  private async call(url: string, method: "GET" | "POST", body?: object) {
    try {
      const response = await this.request(url, { method, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(5000),
        headers: { "X-Vault-Token": await this.token(), "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined });
      if (response.status === 403 || response.status >= 500) {
        await response.body?.cancel();
        throw new FleetError("vault_unavailable", 503);
      }
      return response;
    } catch { throw new FleetError("vault_unavailable", 503); }
  }
  private async entry(ref: Reference) {
    const response = await this.call(this.path(ref), "GET");
    if (!response.ok) throw new FleetError("vault_unavailable", 503);
    const reader = response.body?.getReader();
    if (!reader) throw new FleetError("vault_unavailable", 503);
    let size = 0; const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.byteLength;
        if (size > 196_608) throw new Error();
        chunks.push(part.value);
      }
      return secretEnvelope.parse(JSON.parse(Buffer.concat(chunks).toString("utf8"))).data.data;
    } catch { throw new FleetError("vault_unavailable", 503); }
    finally { await reader.cancel().catch(() => {}); }
  }
  async put(ref: Reference, value: string, operationHash: string, legacyOperationHash?: string) {
    const response = await this.call(this.path(ref), "POST", { options: { cas: 0 }, data: { value, operationHash } });
    // Read no error bodies: Vault may echo paths or submitted values.
    await response.body?.cancel();
    if (response.ok) return;
    if (response.status === 400) {
      const existing = await this.entry(ref);
      // Old orphan KV version after DB commit loss: exact value/ref and exact
      // legacy operation only. Never overwrite/destroy or downgrade v2 metadata.
      const matchesLegacy = /^[a-f0-9]{64}$/.test(existing.operationHash) && existing.operationHash === legacyOperationHash;
      if ((existing.operationHash === operationHash || matchesLegacy) && existing.value === value) return;
    }
    throw new FleetError("vault_write_conflict", 409);
  }
  async read(ref: Reference) { return (await this.entry(ref)).value; }
}
