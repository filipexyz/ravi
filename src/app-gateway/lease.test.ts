import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { acquireRelayLease, relayLeaseKey, releaseRelayLease, renewRelayLease } from "./lease.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-app-gateway-lease-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

describe("Pages app gateway relay lease", () => {
  it("lets one owner hold (consoleUrl, installationId) until it expires or is released", () => {
    const lockKey = relayLeaseKey("https://console.ravi.bot/", "installation-1");
    expect(lockKey).toBe(relayLeaseKey("https://console.ravi.bot", "installation-1"));

    expect(acquireRelayLease({ lockKey, ownerId: "a", ttlMs: 60_000, now: 1_000 })).toBe(true);
    expect(acquireRelayLease({ lockKey, ownerId: "b", ttlMs: 60_000, now: 2_000 })).toBe(false);
    expect(renewRelayLease({ lockKey, ownerId: "a", ttlMs: 60_000, now: 20_000 })).toBe(true);
    expect(renewRelayLease({ lockKey, ownerId: "b", ttlMs: 60_000, now: 20_000 })).toBe(false);
    // a's renewal moved the expiry to 80 s.
    expect(acquireRelayLease({ lockKey, ownerId: "b", ttlMs: 60_000, now: 79_999 })).toBe(false);
    expect(acquireRelayLease({ lockKey, ownerId: "b", ttlMs: 60_000, now: 80_000 })).toBe(true);
    expect(renewRelayLease({ lockKey, ownerId: "a", ttlMs: 60_000, now: 80_001 })).toBe(false);

    expect(releaseRelayLease(lockKey, "a")).toBe(false);
    expect(releaseRelayLease(lockKey, "b")).toBe(true);
    expect(acquireRelayLease({ lockKey, ownerId: "a", ttlMs: 60_000, now: 80_002 })).toBe(true);

    const otherInstallation = relayLeaseKey("https://console.ravi.bot", "installation-2");
    expect(acquireRelayLease({ lockKey: otherInstallation, ownerId: "b", ttlMs: 60_000, now: 80_003 })).toBe(true);
  });
});
