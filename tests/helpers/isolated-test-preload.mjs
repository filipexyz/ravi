import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

// This module must execute before test imports can load adapters or state stores.
const root = process.env.RAVI_TEST_SANDBOX_ROOT;
if (!root || !isAbsolute(root)) throw new Error("Missing isolated-test root; refusing to load tests.");
const realRoot = realpathSync(root);
const insideRoot = (path) => {
  const suffix = relative(realRoot, realpathSync(path));
  return suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
};
const directoryKeys = [
  "HOME", "USERPROFILE", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "APPDATA", "LOCALAPPDATA",
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR",
  "RAVI_STATE_DIR", "RAVI_DIR", "TMPDIR", "TMP", "TEMP", "BUN_INSTALL_CACHE_DIR", "npm_config_cache",
];
for (const key of directoryKeys) {
  const value = process.env[key];
  if (!value || !isAbsolute(value) || !insideRoot(value)) {
    throw new Error(`Test path ${key} is not isolated; refusing to load tests.`);
  }
}
if (resolve(homedir()) !== resolve(process.env.HOME) || resolve(homedir()) !== resolve(process.env.USERPROFILE)) {
  throw new Error("os.homedir() does not resolve to the isolated test home; refusing to load tests.");
}
if (!insideRoot(process.cwd())) throw new Error("Test cwd is outside the isolated root.");
if (process.env.RAVI_LIVE_TESTS !== undefined || process.env.RAVI_CONTEXT_KEY !== undefined) {
  throw new Error("A live runtime capability reached the test child.");
}
process.env.RAVI_TEST_PREFLIGHT_VERIFIED = "1";
if (import.meta.main) console.log(JSON.stringify({ type: "preflight-verified", isolatedHome: true, directoryCount: directoryKeys.length }));
