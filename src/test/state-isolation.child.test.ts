/**
 * Run as a child by state-isolation.test.ts with a controlled environment, and harmless on its own:
 * the invariant holds under any caller environment because bunfig.toml preloads the isolation.
 */
import { expect, it } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { canonicalPath, isWithin } from "./state-isolation.js";

it("runs with a state directory that is not the real one", () => {
  const dir = process.env.RAVI_STATE_DIR;
  expect(dir).toBeTruthy();
  expect(isWithin(canonicalPath(dir!), canonicalPath(join(homedir(), ".ravi")))).toBe(false);
  const marker = process.env.RAVI_STATE_ISOLATION_MARKER;
  // CI picks a directory that tests create lazily, so existence is reported to the parent, never asserted here.
  if (marker) writeFileSync(marker, JSON.stringify({ dir, existed: existsSync(dir!) }));
});
