import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { dbSetSetting, getAnnounceCompaction } from "./router-db.js";

describe("getAnnounceCompaction", () => {
  let stateDir: string | null = null;

  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("announce-compaction-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("defaults to false when the setting is unset", () => {
    expect(getAnnounceCompaction()).toBe(false);
  });

  it("stays false when explicitly disabled", () => {
    dbSetSetting("announceCompaction", "false");
    expect(getAnnounceCompaction()).toBe(false);
  });

  it("is true only when explicitly enabled", () => {
    dbSetSetting("announceCompaction", "true");
    expect(getAnnounceCompaction()).toBe(true);
  });
});
