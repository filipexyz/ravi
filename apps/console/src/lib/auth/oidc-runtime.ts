import { getOidcBaseConfig, getOidcConfig, oidcModeEnabled } from "./oidc-config";
import { loadManagedOidc } from "@/server/console/fleet/sso-service";
import { Kv2Vault, vaultConfig } from "@/server/console/fleet/vault";
import { readAuthSecretFile } from "./secret-file";

/** Metadata-only reads deliberately do not depend on Vault being unsealed, so
 * an existing administrator can inspect/recover a coffer outage. */
export async function getRuntimeOidcConfig(includeSecret = true) {
  const { dbClient } = await import("@/server/db");
  const vault = { put: (...args: Parameters<Kv2Vault["put"]>) => new Kv2Vault(vaultConfig()).put(...args),
    read: (...args: Parameters<Kv2Vault["read"]>) => new Kv2Vault(vaultConfig()).read(...args) };
  const managed = await loadManagedOidc(dbClient, vault, getOidcBaseConfig(), includeSecret);
  if (managed) return managed;
  const file = process.env.RAVI_OIDC_CLIENT_SECRET_FILE;
  if (file) return getOidcConfig({ ...process.env, RAVI_OIDC_CLIENT_SECRET: includeSecret ? await readAuthSecretFile(file) : "metadata-only" });
  return getOidcConfig();
}
export async function isRuntimeOidcConfigured() {
  if (!oidcModeEnabled()) return false;
  try { await getRuntimeOidcConfig(false); return true; } catch { return false; }
}
