import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareBridgeCodexProfile } from "./codex-profile.js";

const previous = { state: process.env.RAVI_STATE_DIR, provider: process.env.RAVI_BRIDGE_CODEX_PROVIDER_FILE };
const dirs: string[] = [];
afterEach(() => {
  for (const [key, value] of Object.entries({
    RAVI_STATE_DIR: previous.state,
    RAVI_BRIDGE_CODEX_PROVIDER_FILE: previous.provider,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "bridge-provider-"));
  dirs.push(dir);
  const key = join(dir, "api-key"),
    config = join(dir, "provider.json"),
    cwd = join(dir, randomUUID());
  const provider = { id: "deepseek", baseUrl: "https://api.deepseek.com", apiKeyFile: key };
  writeFileSync(key, "synthetic-provider-test-key", { mode: 0o600 });
  writeFileSync(config, JSON.stringify(provider), { mode: 0o600 });
  process.env.RAVI_STATE_DIR = dir;
  process.env.RAVI_BRIDGE_CODEX_PROVIDER_FILE = config;
  return { dir, key, config, cwd, provider };
}
test("custom Responses provider uses a private file and never embeds the key in TOML or shell-inherited RAVI env", () => {
  const f = fixture(),
    profile = prepareBridgeCodexProfile(f.cwd);
  const config = readFileSync(join(profile.configDir, "config.toml"), "utf8");
  expect(config).toContain('base_url = "https://api.deepseek.com"');
  expect(config).not.toContain("synthetic-provider-test-key");
  expect(profile.env.BRIDGE_MODEL_API_KEY).toBe("synthetic-provider-test-key");
  expect(
    Object.entries(profile.env)
      .filter(([key]) => key.startsWith("RAVI_"))
      .some(([, value]) => value.includes("synthetic-provider")),
  ).toBe(false);
  expect(existsSync(join(profile.configDir, "auth.json"))).toBe(false);
  expect(prepareBridgeCodexProfile(f.cwd)).toEqual(profile);
  writeFileSync(f.config, JSON.stringify({ ...f.provider, baseUrl: "https://different.invalid" }));
  expect(() => prepareBridgeCodexProfile(f.cwd)).toThrow("new conversation");
});
test("custom provider rejects insecure origins, public credentials and symlinks", () => {
  const f = fixture();
  writeFileSync(f.config, JSON.stringify({ ...f.provider, baseUrl: "http://api.deepseek.com" }));
  expect(() => prepareBridgeCodexProfile(f.cwd)).toThrow();
  writeFileSync(f.config, JSON.stringify(f.provider));
  chmodSync(f.key, 0o644);
  expect(() => prepareBridgeCodexProfile(f.cwd)).toThrow("Invalid private");
  chmodSync(f.key, 0o600);
  const link = join(f.dir, "key-link");
  symlinkSync(f.key, link);
  writeFileSync(f.config, JSON.stringify({ ...f.provider, apiKeyFile: link }));
  expect(() => prepareBridgeCodexProfile(f.cwd)).toThrow();
});
