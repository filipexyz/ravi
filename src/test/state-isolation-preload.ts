/**
 * Default preload for every `bun test` (bunfig.toml). Test-only: never import from runtime code.
 * Gives the process a private state directory when the caller did not choose an isolated one.
 */
import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { needsIsolatedState } from "./state-isolation.js";

if (needsIsolatedState(process.env, homedir())) {
  const stateDir = mkdtempSync(join(tmpdir(), "ravi-test-state-"));
  process.env.RAVI_STATE_DIR = stateDir;
  // Under `bun test` (1.3.x) the `exit` and `beforeExit` events never fire; `afterAll` is the hook that does.
  afterAll(() => {
    try {
      rmSync(stateDir, { recursive: true, force: true });
    } catch {
      // Windows can retain SQLite mappings until teardown. Only this generated directory is ever removed.
    }
  });
}
