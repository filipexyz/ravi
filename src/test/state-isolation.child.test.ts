/**
 * Run as a child by state-isolation.test.ts with a controlled environment, and harmless on its own:
 * the invariant holds under any caller environment because bunfig.toml preloads the isolation.
 */
import { expect, it } from "bun:test";
import { statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { canonicalPath, isWithin } from "./state-isolation.js";

it("runs with a state directory that is not the real one", () => {
  const dir = process.env.RAVI_STATE_DIR;
  expect(dir).toBeTruthy();
  expect(statSync(dir!).isDirectory()).toBe(true);
  expect(isWithin(canonicalPath(dir!), canonicalPath(join(homedir(), ".ravi")))).toBe(false);
  const marker = process.env.RAVI_STATE_ISOLATION_MARKER;
  if (marker) writeFileSync(marker, dir!);
});
