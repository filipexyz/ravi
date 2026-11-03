import { expect, test } from "bun:test";
import { mkdtemp, writeFile, chmod, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kv2Vault, readProtectedToken, vaultConfig, type VaultFetch } from "../../src/server/console/fleet/vault";

const config = { address: "https://vault.example.invalid", mount: "console-fleet", tokenFile: "/run/secrets/test-token" };
const ref = { organizationId: "00000000-0000-4000-8000-000000000001", credentialId: "00000000-0000-4000-8000-000000000002", version: 1 };
test("Vault endpoint requires TLS and a protected file, never credentials in URL", () => {
  for (const address of ["http://vault.test", "https://user:pass@vault.test", "https://vault.test/path", "https://vault.test?token=x"]) {
    expect(() => vaultConfig({ RAVI_FLEET_VAULT_ADDR: address, RAVI_FLEET_VAULT_TOKEN_FILE: "/run/token" })).toThrow("vault_not_configured");
  }
  expect(vaultConfig({ RAVI_FLEET_VAULT_ADDR: config.address, RAVI_FLEET_VAULT_TOKEN_FILE: config.tokenFile }).mount).toBe("console-fleet");
});
test("token file permissions and symlinks fail closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fleet-token-unit-")), file = join(dir, "token"), link = join(dir, "link");
  await writeFile(file, "synthetic-test-token", { mode: 0o600 }); expect(await readProtectedToken(file)).toBe("synthetic-test-token");
  await chmod(file, 0o644); await expect(readProtectedToken(file)).rejects.toThrow("vault_unavailable");
  await chmod(file, 0o600); await symlink(file, link); await expect(readProtectedToken(link)).rejects.toThrow("vault_unavailable");
});
test("Vault request uses CAS0, private header and no redirects; returns no secret", async () => {
  let calls = 0;
  const request = (async (url: string | URL | Request, init?: RequestInit) => {
    calls++; expect(String(url)).toContain(`/data/${ref.organizationId}/${ref.credentialId}/1`);
    expect(init?.redirect).toBe("error"); expect(init?.cache).toBe("no-store");
    expect((init?.headers as Record<string, string>)["X-Vault-Token"]).toBe("synthetic-token");
    expect(JSON.parse(String(init?.body))).toEqual({ options: { cas: 0 }, data: { value: "synthetic-value", operationHash: "synthetic-hash" } });
    return new Response("{}", { status: 200 });
  }) as VaultFetch;
  const vault = new Kv2Vault(config, request, async () => "synthetic-token");
  expect(await vault.put(ref, "synthetic-value", "synthetic-hash")).toBeUndefined(); expect(calls).toBe(1);
});
test("retry of orphan requires exact HMAC and value, backend failures are redacted", async () => {
  const request = (async (_url: unknown, init?: RequestInit) => init?.method === "POST" ? new Response("secret echoed by backend", { status: 400 })
    : Response.json({ data: { data: { value: "synthetic-value", operationHash: "same-hash" } } })) as VaultFetch;
  const vault = new Kv2Vault(config, request, async () => "synthetic-token");
  await vault.put(ref, "synthetic-value", "same-hash");
  await expect(vault.put(ref, "other-value", "same-hash")).rejects.toThrow("vault_write_conflict");
  const unavailable = new Kv2Vault(config, async () => new Response("private details", { status: 503 }), async () => "synthetic-token");
  await expect(unavailable.read(ref)).rejects.toThrow("vault_unavailable");
});
test("legacy orphan transition accepts only its exact ref/value/HMAC, without overwriting", async () => {
  const old = "a".repeat(64), current = `v2:${"b".repeat(64)}`;
  let stored = old;
  const request: VaultFetch = async (_url, init) => init.method === "POST" ? new Response(null, { status: 400 })
    : Response.json({ data: { data: { value: "synthetic-value", operationHash: stored } } });
  const vault = new Kv2Vault(config, request, async () => "synthetic-token");
  await vault.put(ref, "synthetic-value", current, old);
  await expect(vault.put(ref, "different", current, old)).rejects.toThrow("vault_write_conflict");
  await expect(vault.put(ref, "synthetic-value", current, "c".repeat(64))).rejects.toThrow("vault_write_conflict");
  stored = current;
  await expect(vault.put(ref, "synthetic-value", old, current)).rejects.toThrow("vault_write_conflict");
});
