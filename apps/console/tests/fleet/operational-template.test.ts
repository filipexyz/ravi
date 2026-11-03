import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("manual Vault overlay parses with base, segregates mounts/network and never initializes/unseals", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleet-compose-test-"));
  const config = join(root, "config"), secrets = join(root, "secrets");
  await mkdir(config, { mode: 0o700 }); await mkdir(secrets, { mode: 0o700 });
  for (const name of ["compose.yaml", "vault-manual.compose.yaml", "vault-server.hcl"]) {
    await writeFile(join(config, name), await readFile(join(import.meta.dir, "../../deploy/selfhost", name)), { mode: 0o600 });
  }
  // Public, empty parse-only fixtures. No user env/secret files are read.
  for (const name of ["postgres", "keycloak", "s3", "console", "pages", "executor"]) await writeFile(join(secrets, `${name}.env`), "", { mode: 0o600 });
  const digest = `sha256:${"0".repeat(64)}`; // intentionally non-runnable placeholder, no image pulls.
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", POSTGRES_IMAGE: `postgres@${digest}`, KEYCLOAK_IMAGE: `quay.io/keycloak/keycloak@${digest}`,
    SEAWEED_IMAGE: `chrislusf/seaweedfs@${digest}`, CADDY_IMAGE: `caddy@${digest}`, VAULT_IMAGE: `hashicorp/vault@${digest}` };
  const child = Bun.spawn(["docker", "compose", "-f", join(config, "compose.yaml"), "-f", join(config, "vault-manual.compose.yaml"),
    "--profile", "apps", "--profile", "vault-manual", "config", "--no-env-resolution", "--format", "json"], { env, stdout: "pipe", stderr: "pipe" });
  const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code) throw new Error(`Compose parse-only validation failed: ${error}`);
  const model = JSON.parse(output), vault = model.services.vault, consoleApp = model.services.console;
  expect(vault.ports ?? []).toEqual([]);
  expect(Object.keys(vault.networks)).toEqual(["fleet_secrets"]);
  expect(Object.keys(consoleApp.networks).sort()).toEqual(["backend", "fleet_secrets"]);
  expect(model.networks.fleet_secrets.internal).toBe(true);
  expect(vault.user).toBe("10004:10004"); expect(vault.read_only).toBe(true);
  expect(vault.cap_drop).toEqual(["ALL"]); expect(vault.memswap_limit).toBe(vault.mem_limit);
  // Compose JSON omits zero-valued limit fields. Assert the exact YAML contract;
  // applying the RLIMIT at runtime is a separate deployment check.
  const raw = Bun.YAML.parse(await readFile(join(config, "vault-manual.compose.yaml"), "utf8")) as { services: { vault: {
    ulimits: { core: { soft: number; hard: number } }; volumes: Array<{ bind: { create_host_path: boolean } }>; } } };
  expect(raw.services.vault.ulimits.core).toEqual({ soft: 0, hard: 0 });
  expect(vault.command).toEqual(["server", "-config=/vault/config/server.hcl"]);
  expect(Object.keys(vault.environment).sort()).toEqual(["VAULT_ADDR", "VAULT_CACERT"]);
  // False booleans are omitted in Compose's normalized JSON too; test source
  // explicitly and reject a true override in the merged model.
  expect(raw.services.vault.volumes.every(volume => volume.bind.create_host_path === false)).toBe(true);
  expect(vault.volumes.every((volume: { bind: { create_host_path?: boolean } }) => volume.bind.create_host_path !== true)).toBe(true);
  const clientMount = consoleApp.volumes.find((volume: { target: string }) => volume.target === "/run/fleet-vault");
  expect(clientMount.read_only).toBe(true); expect(clientMount.source.endsWith("/secrets/fleet-vault-client")).toBe(true);
  expect(consoleApp.environment.RAVI_PAGES_AI_ENABLED).toBe("0");
  for (const name of ["pages", "executor"]) expect(Object.keys(model.services[name].networks)).toEqual(["backend"]);
  const hcl = await readFile(join(config, "vault-server.hcl"), "utf8");
  expect(hcl).toContain('storage "raft"'); expect(hcl).toContain('tls_min_version = "tls12"');
  expect(hcl).not.toMatch(/tls_disable\s*=\s*(?:true|1)|seal\s+"|dev_root_token_id/);
});
