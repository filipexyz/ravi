import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Reconcile only non-secret settings in already-generated runtime secret files.
// Preserve original credential bytes; no value or exception payload is emitted.
const root = join(import.meta.dir, ".private");
function appendMissing(file: string, key: string, expected: string) {
  const path = join(root, file);
  const raw = readFileSync(path, "utf8");
  const lines = raw.split("\n").filter(line => line.startsWith(`${key}=`));
  if (lines.length > 1) throw new Error("duplicate_setting");
  const existing = lines[0];
  if (existing !== undefined) {
    if (JSON.parse(existing.slice(key.length + 1)) !== expected) throw new Error("setting_conflict");
    return;
  }
  const backup = `${path}.${key}.pre-runtime-reconcile`;
  if (existsSync(backup)) throw new Error("backup_exists_without_setting");
  copyFileSync(path, backup);
  chmodSync(backup, 0o600);
  writeFileSync(path, `${raw.endsWith("\n") ? raw : raw + "\n"}${key}=${JSON.stringify(expected)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}
try {
  appendMissing("executor.env", "EXECUTOR_DELEGATION_ISSUER", "https://console.nba-console.test");
  appendMissing("executor.env", "PORT", "4788");
  const pin = readFileSync(join(root, "tls/spki.txt"), "utf8").trim();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(pin)) throw new Error("invalid_public_pin");
  appendMissing("pages.env", "RAVI_PAGES_BROWSER_TLS_SPKI", pin);
  appendMissing("pages.env", "RAVI_PAGES_BROWSER_HOST_RESOLVER_RULES", "MAP *.pages.nba-console.test proxy");
  console.log("Runtime public issuer and isolated browser TLS pin reconciled; credentials preserved.");
} catch {
  console.error("Runtime config reconciliation stopped; inspect structure without printing secrets.");
  process.exitCode = 1;
}
