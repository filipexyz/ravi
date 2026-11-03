import { describe, expect, test } from "bun:test";

import type { PagePresentation } from "@/shared/widgets/types";

import { compareVersions, outdatedTheme, type OutdatedTheme } from "./outdated";

const ACME = "44444444-4444-4444-8444-444444444444";
const NOITE = "55555555-5555-4555-8555-555555555555";

const theme = (itemId: string, ref: string, version: number, hash: string): OutdatedTheme => ({ itemId, ref, version, hash: hash.repeat(64) });

const acme2 = theme(ACME, "org/acme", 2, "a");
const acme3 = theme(ACME, "org/acme", 3, "b");
const noite1 = theme(NOITE, "org/noite", 1, "c");

const shipped = (pinned: OutdatedTheme | null, themeSource?: PagePresentation["themeSource"]) => ({ theme: pinned, themeSource });

describe("outdatedTheme", () => {
  test("effective: behind when the effective theme's hash differs, from or to no theme too", () => {
    const none = new Map<string, OutdatedTheme>();
    expect(outdatedTheme(shipped(acme2, "effective"), { effective: acme2, explicit: none })).toBeNull();
    expect(outdatedTheme(shipped(acme2, "effective"), { effective: acme3, explicit: none })).toEqual({ pinned: acme2, current: acme3 });
    expect(outdatedTheme(shipped(acme2, "effective"), { effective: noite1, explicit: none })).toEqual({ pinned: acme2, current: noite1 });
    // Shipped while no theme applied; a theme was set since.
    expect(outdatedTheme(shipped(null, "effective"), { effective: acme2, explicit: none })).toEqual({ pinned: null, current: acme2 });
    // The pointer was cleared since.
    expect(outdatedTheme(shipped(acme2, "effective"), { effective: null, explicit: none })).toEqual({ pinned: acme2, current: null });
    expect(outdatedTheme(shipped(null, "effective"), { effective: null, explicit: none })).toBeNull();
  });

  test("presentations stored before themeSource read as effective", () => {
    const none = new Map<string, OutdatedTheme>();
    expect(outdatedTheme(shipped(null), { effective: acme2, explicit: none })).toEqual({ pinned: null, current: acme2 });
    expect(outdatedTheme(shipped(acme2), { effective: acme3, explicit: none })).toEqual({ pinned: acme2, current: acme3 });
  });

  test("explicit: behind only when the pinned item has a newer version with another hash", () => {
    const newer = new Map([[ACME, acme3]]);
    // The effective theme does not matter.
    expect(outdatedTheme(shipped(acme2, "explicit"), { effective: noite1, explicit: new Map() })).toBeNull();
    expect(outdatedTheme(shipped(acme2, "explicit"), { effective: noite1, explicit: newer })).toEqual({ pinned: acme2, current: acme3 });
    expect(outdatedTheme(shipped({ ...acme2, itemId: ACME.toUpperCase() }, "explicit"), { effective: null, explicit: newer })).toEqual({
      pinned: { ...acme2, itemId: ACME.toUpperCase() },
      current: acme3,
    });
    // A newer version that compiles to the same CSS needs no re-ship.
    expect(outdatedTheme(shipped(acme2, "explicit"), { effective: null, explicit: new Map([[ACME, { ...acme3, hash: acme2.hash }]]) })).toBeNull();
    expect(outdatedTheme(shipped(acme3, "explicit"), { effective: null, explicit: new Map([[ACME, acme2]]) })).toBeNull();
  });

  test("none: never theme-outdated", () => {
    expect(outdatedTheme(shipped(null, "none"), { effective: acme2, explicit: new Map() })).toBeNull();
  });
});

describe("compareVersions", () => {
  test("orders major.minor.patch numerically", () => {
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.2.0", "1.10.0")).toBe(-1);
    expect(compareVersions("2.0.0", "1.9.9")).toBe(1);
  });
});
