import { createHash, randomBytes } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kv2Vault, type VaultFetch } from "../../src/server/console/fleet/vault";

// Isolated test fixture, NOT the recommended production Vault release/topology.
// Archive checksum from https://releases.hashicorp.com/vault/1.21.0/vault_1.21.0_SHA256SUMS
const fixtureVersion = "1.21.0";
const archiveSha = "fd1b26fcbc78c04c2d76d35a13a9564d450074f2547871b2046ddb95bbd7ea9c";
const providedBinary = process.env.FLEET_TEST_VAULT_BIN;
if (!providedBinary && (process.platform !== "darwin" || process.arch !== "arm64")) throw new Error("Set FLEET_TEST_VAULT_BIN to a provisioned Vault1.21.0 for this platform; no global install is performed");
const root = await mkdtemp(join(tmpdir(), "fleet-vault-test-"));
const useRaft = process.argv.includes("--raft");
const clusterReservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const clusterPort = clusterReservation.port; clusterReservation.stop(true);
const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "en_US.UTF-8" };
const report: string[] = [];
const assert = (pass: unknown, name: string) => { if (!pass) throw new Error(`Vault integration assertion failed: ${name}`); report.push(name); };
async function command(args: string[]) {
  const process = Bun.spawn(args, { env, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
  if (code) throw new Error(`Public tool failed (${args[0]}, exit ${code}); private output retained, not emitted.`);
  return stdout + stderr;
}
const binary = providedBinary ?? join(root, "bin/vault");
if (providedBinary) {
  if (!(await command([providedBinary, "version"])).startsWith(`Vault v${fixtureVersion} `)) throw new Error("Fixture requires provisioned Vault1.21.0");
  assert(true, "explicit_platform_binary_version");
} else {
const zip = join(root, "vault.zip");
const archive = await fetch(`https://releases.hashicorp.com/vault/${fixtureVersion}/vault_${fixtureVersion}_darwin_arm64.zip`, { redirect: "error", signal: AbortSignal.timeout(60_000) });
if (!archive.ok) throw new Error("Vault fixture download failed");
const bytes = Buffer.from(await archive.arrayBuffer());
assert(createHash("sha256").update(bytes).digest("hex") === archiveSha, "official_archive_checksum");
await writeFile(zip, bytes, { mode: 0o600 });
const names = (await command(["/usr/bin/unzip", "-Z1", zip])).trim().split("\n");
assert(names.every(name => ["vault", "LICENSE.txt"].includes(name)), "archive_paths_allowlist");
await command(["/usr/bin/unzip", "-q", zip, "-d", join(root, "bin")]);
}
await writeFile(join(root, "openssl.cnf"), `[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:true\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\n`, { mode: 0o600 });
await command(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-config", join(root, "openssl.cnf"), "-keyout", join(root, "tls.key"), "-out", join(root, "tls.crt")]);
const ca = await readFile(join(root, "tls.crt"), "utf8");
let running: Bun.Subprocess | null = null;
const outputs: Promise<unknown>[] = [];
async function stop() {
  if (!running) return;
  const child = running; running = null; child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try { await child.exited; } finally { clearTimeout(timer); }
}
async function start(data: string, label: string) {
  await mkdir(data, { recursive: true, mode: 0o700 });
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port; reservation.stop(true);
  const address = `https://127.0.0.1:${port}`;
  const config = join(root, `${label}.hcl`);
  const storage = useRaft ? `cluster_addr = "https://127.0.0.1:${clusterPort}"\nstorage "raft" {\npath = "${data}"\nnode_id = "local-fixture-1"\n}` : `storage "file" { path = "${data}" }`;
  await writeFile(config, `disable_mlock = true\nui = false\napi_addr = "${address}"\n${storage}\nlistener "tcp" {\naddress = "127.0.0.1:${port}"\ncluster_address = "127.0.0.1:${clusterPort}"\ntls_cert_file = "${join(root, "tls.crt")}"\ntls_key_file = "${join(root, "tls.key")}"\n}\n`, { mode: 0o600 });
  const child = Bun.spawn([binary, "server", `-config=${config}`], { env, stdout: "pipe", stderr: "pipe" });
  running = child;
  outputs.push(Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]).then(async ([out, err]) => {
    await writeFile(join(root, `${label}.log`), out + err, { mode: 0o600 });
  }));
  const request: VaultFetch = (url, init) => fetch(url, { ...init, tls: { ca }, signal: init.signal ?? AbortSignal.timeout(5000) });
  let ready = false;
  for (let n = 0; n < 60; n++) {
    if (child.exitCode !== null) throw new Error("Vault fixture exited; private local log preserved");
    try { const response = await request(`${address}/v1/sys/health`, { redirect: "error" }); await response.body?.cancel(); ready = true; break; }
    catch { await Bun.sleep(250); }
  }
  if (!ready) throw new Error("Vault fixture did not listen within limit");
  return { address, request };
}
async function api(target: Awaited<ReturnType<typeof start>>, path: string, body?: unknown, token?: string) {
  const response = await target.request(`${target.address}/v1/${path}`, { method: body === undefined ? "GET" : "POST", redirect: "error",
    // Administrative init/unseal can include a Raft election. The application's
    // five-second secret-operation deadline remains unchanged in Kv2Vault.
    signal: AbortSignal.timeout(30000),
    headers: { "Content-Type": "application/json", ...(token ? { "X-Vault-Token": token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Vault control operation failed: ${path}, status ${response.status}`); }
  return response.status === 204 ? null : response.json();
}
async function leaderReady(target: Awaited<ReturnType<typeof start>>) {
  for (let n = 0; n < 80; n++) {
    const response = await target.request(`${target.address}/v1/sys/health`, { redirect: "error" });
    const ready = response.status === 200; await response.body?.cancel();
    if (ready) return;
    await Bun.sleep(250);
  }
  throw new Error("Local Vault did not become an active unsealed leader");
}
const ref = { organizationId: "00000000-0000-4000-8000-000000000001", credentialId: "00000000-0000-4000-8000-000000000002", version: 1 };
const value = randomBytes(32).toString("hex"), nextValue = randomBytes(32).toString("hex");
try {
  const sourceData = join(root, "source-data");
  let target = await start(sourceData, "source");
  // Shares/root token are in memory only, synthetic, local, and not application credentials.
  const init = await api(target, "sys/init", { secret_shares: 1, secret_threshold: 1 });
  const unseal = init.keys_base64[0] as string, adminToken = init.root_token as string;
  await api(target, "sys/unseal", { key: unseal });
  await leaderReady(target);
  await api(target, "sys/audit/file", { type: "file", options: { file_path: join(root, "audit.jsonl") } }, adminToken);
  await api(target, "sys/mounts/console-fleet", { type: "kv", options: { version: "2" } }, adminToken);
  await api(target, "sys/policies/acl/fleet-test", { policy: `path "console-fleet/data/${ref.organizationId}/*" { capabilities = ["create", "update", "read"] }` }, adminToken);
  const auth = await api(target, "auth/token/create", { policies: ["fleet-test"], no_default_policy: true, ttl: "10m", renewable: false }, adminToken);
  const appToken = auth.auth.client_token as string;
  const tokenFile = join(root, "app-token"); await writeFile(tokenFile, appToken, { mode: 0o600 });
  const vault = () => new Kv2Vault({ address: target.address, mount: "console-fleet", tokenFile }, target.request);
  await vault().put(ref, value, "synthetic-operation-hash-v1");
  assert(await vault().read(ref) === value, "real_tls_kv2_write_read");
  await vault().put(ref, value, "synthetic-operation-hash-v1"); report.push("cas0_exact_retry");
  try { await vault().put(ref, nextValue, "different-operation"); throw new Error("unexpected_success"); }
  catch (error) { assert(error instanceof Error && error.message === "vault_write_conflict", "cas0_conflict_refused"); }
  await vault().put({ ...ref, version: 2 }, nextValue, "synthetic-operation-hash-v2");
  assert(await vault().read({ ...ref, version: 2 }) === nextValue && await vault().read(ref) === value, "versioned_replacement_preserves_old");
  try { await vault().read({ ...ref, organizationId: "00000000-0000-4000-8000-000000000099" }); throw new Error("unexpected_success"); }
  catch (error) { assert(error instanceof Error && error.message === "vault_unavailable", "app_token_cross_org_denied_redacted"); }
  await api(target, "sys/seal", {}, adminToken);
  try { await vault().read(ref); throw new Error("unexpected_success"); }
  catch (error) { assert(error instanceof Error && error.message === "vault_unavailable", "sealed_coffer_fail_closed"); }
  await api(target, "sys/unseal", { key: unseal });
  await leaderReady(target);
  await stop();
  const backupData = join(root, "backup-data"), restoreData = join(root, "restore-data");
  await cp(sourceData, backupData, { recursive: true, errorOnExist: true, force: false });
  await cp(backupData, restoreData, { recursive: true, errorOnExist: true, force: false });
  target = await start(restoreData, "restore");
  const health = await api(target, "sys/seal-status"); assert(health.sealed === true, "restored_store_starts_sealed");
  await api(target, "sys/unseal", { key: unseal });
  await leaderReady(target);
  assert(await vault().read(ref) === value && await vault().read({ ...ref, version: 2 }) === nextValue, "isolated_restore_recovers_both_versions");
  await api(target, "auth/token/revoke", { token: appToken }, adminToken);
  try { await vault().read(ref); throw new Error("unexpected_success"); }
  catch (error) { assert(error instanceof Error && error.message === "vault_unavailable", "revoked_app_token_refused"); }
  await stop(); await Promise.all(outputs);
  const audit = await readFile(join(root, "audit.jsonl"), "utf8");
  assert(![value, nextValue, appToken, adminToken, unseal].some(secret => audit.includes(secret)), "vault_audit_values_hmac_redacted");
  for (const file of (await readdir(root)).filter(x => x.endsWith(".log"))) {
    const logs = await readFile(join(root, file), "utf8");
    assert(![value, nextValue, appToken, adminToken, unseal].some(secret => logs.includes(secret)), `${file}_no_literal_secrets`);
  }
  console.log(JSON.stringify({ result: "PASS", root, fixtureVersion, archiveSha, checks: report, topology: `local-loopback-TLS-${useRaft ? "raft" : "file"}-backend`, backup: "quiescent-copy-not-live-snapshot", production: false }));
} finally { await stop(); await Promise.all(outputs); }
