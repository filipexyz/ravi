import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "bun:test";
import { closeRouterDb, getDb } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "./ravi-state.js";

describe("isolated Ravi state", () => {
  it("restores the outer sandbox before a later database consumer runs", async () => {
    const previousStateDir = process.env.RAVI_STATE_DIR;
    const outerStateDir = mkdtempSync(join(tmpdir(), "ravi-state-outer-test-"));
    let innerStateDir: string | null = null;
    try {
      process.env.RAVI_STATE_DIR = outerStateDir;
      innerStateDir = await createIsolatedRaviState("ravi-state-inner-test-");
      expect(process.env.RAVI_STATE_DIR).toBe(innerStateDir);
      await cleanupIsolatedRaviState(innerStateDir);
      innerStateDir = null;

      // Assert before getDb: a regression must never open the operator's DB.
      expect(process.env.RAVI_STATE_DIR).toBe(outerStateDir);
      const databases = getDb().query("PRAGMA database_list").all() as { name: string; file: string }[];
      expect(databases.find((database) => database.name === "main")?.file).toBe(
        realpathSync(join(outerStateDir, "ravi.db")),
      );
      expect(existsSync(outerStateDir)).toBe(true);
    } finally {
      if (innerStateDir) await cleanupIsolatedRaviState(innerStateDir);
      closeRouterDb();
      if (previousStateDir === undefined) delete process.env.RAVI_STATE_DIR;
      else process.env.RAVI_STATE_DIR = previousStateDir;
      rmSync(outerStateDir, { recursive: true, force: true });
    }
  });

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
