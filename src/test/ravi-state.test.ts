import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "./ravi-state.js";

describe("isolated Ravi state", () => {
  it("removes its temporary directory during cleanup", async () => {
    let stateDir: string | null = null;

    try {
      stateDir = await createIsolatedRaviState("ravi-state-cleanup-test-");
      writeFileSync(join(stateDir, "fixture.txt"), "test fixture");

      await cleanupIsolatedRaviState(stateDir);
      expect(existsSync(stateDir)).toBe(false);
      stateDir = null;
    } finally {
      if (stateDir) await cleanupIsolatedRaviState(stateDir);
    }
  });
});
