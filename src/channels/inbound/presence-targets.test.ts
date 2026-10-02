import { describe, expect, it } from "bun:test";
import { createNoopPresenceTargets } from "./presence-targets.js";

describe("createNoopPresenceTargets", () => {
  it("implements the gateway presence surface as safe no-ops", async () => {
    const targets = createNoopPresenceTargets();

    expect(targets.getActiveTarget("agent:main:main")).toBeUndefined();
    await expect(targets.renewActiveTarget("agent:main:main")).resolves.toBe(false);
    await expect(targets.clearActiveTarget("agent:main:main")).resolves.toBeUndefined();
  });

  it("keeps no state between calls", async () => {
    const targets = createNoopPresenceTargets();

    await targets.clearActiveTarget("agent:main:main");
    await targets.renewActiveTarget("agent:main:main");

    expect(targets.getActiveTarget("agent:main:main")).toBeUndefined();
    expect(createNoopPresenceTargets()).not.toBe(targets);
  });
});
