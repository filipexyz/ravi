import { beforeEach, expect, mock, test } from "bun:test";
import { NextRequest } from "next/server";
const origin = "https://console.example.invalid";
const sessionToken = "s".repeat(43);
let role = "viewer", grant = true, available = true, authenticated = true;
const calls: unknown[][] = [];
mock.module("@/lib/auth/session", () => ({ getConsoleApiAuthState: async () => authenticated ? { mode: "oidc" } : null }));
mock.module("@/lib/auth/oidc-config", () => ({ getOidcOrigin: () => origin }));
mock.module("@/server/console/workspace", () => ({ getConsoleWorkspace: async () => ({ user: { id: "trusted-user" }, organization: { id: "trusted-org" }, membership: { role } }) }));
mock.module("@/server/console/feature-access", () => ({
  assertConsoleFeatureAvailable: async () => { if (!available) throw new Error("feature_disabled"); },
  assertConsoleFeatureAccess: async () => { throw new Error("legacy-role-gate-must-not-run"); },
}));
mock.module("@/server/console/fleet/sso-service", () => ({ SSO_TEST_CALLBACK: "/callback/fleet", SSO_TEST_COOKIE: "__Host-ravi_fleet_oidc" }));
mock.module("@/server/console/fleet/runtime", () => ({ fleetSsoService: () => ({ completeTest: async (...args: unknown[]) => {
  calls.push(args); if (!grant) throw new Error("forbidden");
} }) }));
const { GET } = await import("../../src/app/(auth)/callback/fleet/route");
const { hashBrowserSessionToken, OIDC_SESSION_COOKIE } = await import("../../src/lib/auth/oidc-transaction");
const request = () => new NextRequest(`${origin}/callback/fleet?state=synthetic-state&code=synthetic-code`, {
  headers: { cookie: `${OIDC_SESSION_COOKIE}=${sessionToken}; __Host-ravi_fleet_oidc=synthetic-transaction` },
});
beforeEach(() => { role = "viewer"; grant = true; available = true; authenticated = true; calls.length = 0; });
test("actual callback routes a custom-role identity to policy authority with exact state/session", async () => {
  const response = await GET(request());
  expect(response.headers.get("location")).toBe(`${origin}/org/sso?test=validated`);
  expect(calls).toHaveLength(1);
  expect(calls[0]![0]).toEqual({ mode: "oidc", role: "viewer", userId: "trusted-user", organizationId: "trusted-org" });
  expect(calls[0]![1]).toBe(hashBrowserSessionToken(sessionToken));
  expect(String(calls[0]![2])).toBe(`${origin}/callback/fleet?state=synthetic-state&code=synthetic-code`);
  expect(calls[0]![3]).toBe("synthetic-transaction");
  expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  expect(response.headers.get("cache-control")).toBe("no-store");
});
test("owner/admin name cannot bypass a policy denial", async () => {
  grant = false;
  for (role of ["owner", "admin"]) expect((await GET(request())).headers.get("location")).toBe(`${origin}/org/sso?test=failed`);
  expect(calls).toHaveLength(2);
});
test("anonymous or unavailable feature never reaches policy completion", async () => {
  authenticated = false; await GET(request()); authenticated = true; available = false; await GET(request());
  expect(calls).toHaveLength(0);
});
