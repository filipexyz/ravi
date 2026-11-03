import { describe, expect, test } from "bun:test";

import {
  authReturnToFromRecord,
  authReturnToFromUrl,
  safeAuthReturnTo,
  signInPathForReturnTo,
} from "./return-to";

describe("auth returnTo", () => {
  test("defaults to projects", () => {
    expect(authReturnToFromRecord(undefined)).toBe("/projects");
    expect(authReturnToFromUrl(new URLSearchParams())).toBe("/projects");
    expect(signInPathForReturnTo("/projects")).toBe("/sign-in");
  });

  test("accepts local return targets from returnTo or next", () => {
    expect(authReturnToFromRecord({ returnTo: "/p/proj/pages" })).toBe("/p/proj/pages");
    expect(authReturnToFromRecord({ next: "/connectors/step-up?challenge=abc" })).toBe("/connectors/step-up?challenge=abc");
    expect(authReturnToFromUrl(new URLSearchParams({ returnTo: "/cli/authorize?code=123" }))).toBe("/cli/authorize?code=123");
    expect(signInPathForReturnTo("/p/proj/pages")).toBe("/sign-in?returnTo=%2Fp%2Fproj%2Fpages");
  });

  test("rejects absolute and protocol-relative targets", () => {
    expect(safeAuthReturnTo("https://evil.example")).toBeNull();
    expect(safeAuthReturnTo("//evil.example")).toBeNull();
    expect(authReturnToFromRecord({ returnTo: "https://evil.example", next: "/projects/new" })).toBe("/projects/new");
  });

  test("rejects backslash and control-character targets that browsers resolve off-site", () => {
    expect(new URL("/\\evil.example", "https://console.ravi.bot").host).toBe("evil.example");
    expect(safeAuthReturnTo("/\\evil.example")).toBeNull();
    expect(safeAuthReturnTo("/\\/evil.example")).toBeNull();
    expect(safeAuthReturnTo("/\tevil.example")).toBeNull();
    expect(safeAuthReturnTo("/p/proj/pages?q=a%5Cb")).toBe("/p/proj/pages?q=a%5Cb");
  });
});
