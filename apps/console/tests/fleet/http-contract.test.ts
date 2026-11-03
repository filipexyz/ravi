import { beforeEach, expect, mock, test } from "bun:test";
import { NextRequest } from "next/server";
import { FleetError } from "../../src/server/console/fleet/contract";

// Actual Next route functions; dependencies are explicitly synthetic. This is
// an HTTP-boundary unit test, not deployed/browser/IdP acceptance.
const origin = "https://console.example.invalid";
const owner = { mode: "oidc", organization: { id: "00000000-0000-4000-8000-000000000001" },
  user: { id: "00000000-0000-4000-8000-000000000002" }, membership: { role: "owner" } };
let authenticated = true, mode = "oidc", allowed = true, workspaceFailure = false;
let unavailable = false, initialized = 0;
const calls: Array<{ kind: string; actor: unknown; body?: unknown }> = [];
const observe = async (kind: string, actor: unknown, body?: unknown) => {
  if (!allowed) throw new FleetError("forbidden", 403);
  calls.push({ kind, actor, body });
  if (unavailable) throw new Error("synthetic-secret-must-not-leak");
  return { status: "draft", revision: 1 };
};
const sessionId = "00000000-0000-4000-8000-000000000003";
mock.module("@/lib/auth/session", () => ({ getConsoleApiAuthState: async () => authenticated ? { mode, oidc: { sessionId } } : null }));
mock.module("@/lib/auth/oidc-config", () => ({ getOidcOrigin: () => origin }));
mock.module("@/server/console/workspace", () => ({
  CONSOLE_ORGANIZATION_COOKIE: "ravi_console_org",
  ConsoleWorkspaceSelectionRequiredError: class extends Error {},
  getConsoleWorkspace: async () => { if (workspaceFailure) throw new FleetError("forbidden", 403); return owner; },
}));
mock.module("@/server/console/fleet/sso-service", () => ({ SSO_TEST_COOKIE: "__Host-ravi_fleet_oidc" }));
// Legacy endpoints must not initialize or invoke the bridge dependency graph.
const unexpectedBridge = async () => { throw new Error("unexpected bridge invocation in legacy route"); };
mock.module("@/server/console/fleet/gateway-authority", () => ({ gatewayOptions: unexpectedBridge }));
mock.module("@/server/console/fleet/gateway", () => ({ gatewayStream: unexpectedBridge, gatewayRequest: unexpectedBridge }));
mock.module("@/server/console/fleet/runtime", () => ({
  apiKeysService: () => ({ list: (actor: unknown) => observe("api-keys.read", actor) }),
  organizationAccess: (actor: unknown) => observe("access", actor),
  organizationMembersService: () => ({ list: (actor: unknown) => observe("members.read",actor),
    change: (actor: unknown, body: unknown) => observe("members.change",actor,body) }),
  onboardingService: () => ({ state: (actor: unknown) => observe("guide.state", actor),
    finish: (actor: unknown, body: unknown) => observe("guide.finish", actor, body) }),
  fleetSsoService: () => ({ state: (actor: unknown) => observe("sso.state", actor),
    save: (actor: unknown, _session: string, body: unknown) => observe("sso.save", actor, body),
    activate: (actor: unknown, _session: string, body: unknown) => observe("sso.activate", actor, body),
    beginTest: async (actor: unknown, _session: string, body: unknown) => {
      await observe("sso.test", actor, body); return { url: "https://idp.example.invalid/authorize", cookie: "synthetic-opaque-transaction" };
    } }),
  fleetService: () => {
    initialized++;
    if (unavailable) throw new Error("synthetic-secret-must-not-leak");
    return { state: (actor: unknown) => observe("fleet.state", actor),
      credentials: (actor: unknown) => observe("credentials.read", actor),
      installations: (actor: unknown) => observe("installations.read", actor),
      writeCredential: (actor: unknown, body: unknown) => observe("credential.save", actor, body),
      revokeCredential: (actor: unknown, body: unknown) => observe("credential.revoke", actor, body),
      writeInstallation: (actor: unknown, body: unknown) => observe("installation.save", actor, body),
      testInstallation: (actor: unknown, body: unknown) => observe("installation.test", actor, body),
      activateInstallation: (actor: unknown, body: unknown) => observe("installation.activate", actor, body) };
  },
}));
const { GET, POST } = await import("../../src/app/api/console/fleet/[[...segments]]/route");
const context = (path: string) => ({ params: Promise.resolve({ segments: path ? path.split("/") : [] }) });
const post = (path: string, body: unknown = {}, headers: Record<string, string> = {}) => POST(new NextRequest(`${origin}/api/console/fleet/${path}`, {
  method: "POST", headers: { origin, "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body),
}), context(path));
beforeEach(() => { authenticated = true; mode = "oidc"; allowed = true; workspaceFailure = false; unavailable = false; initialized = 0; calls.length = 0; });

test("API refuses anonymous/wrong workspace; consumer supplies policy denial, not legacy feature role", async () => {
  authenticated = false; expect((await post("credentials/save")).status).toBe(401);
  expect((await GET(new NextRequest(`${origin}/api/console/fleet`), context(""))).status).toBe(401);
  authenticated = true; mode = "anonymous"; expect((await post("credentials/save")).status).toBe(403);
  mode = "oidc"; allowed = false; expect((await post("credentials/save")).status).toBe(403);
  allowed = true; workspaceFailure = true; expect((await post("credentials/save")).status).toBe(403);
  expect(calls).toHaveLength(0); expect(initialized).toBe(1);
});
test("resource metadata routes delegate independent actions with a server actor", async () => {
  for (const path of ["access", "credentials", "installations"]) {
    expect((await GET(new NextRequest(`${origin}/api/console/fleet/${path}`), context(path))).status).toBe(200);
  }
  expect(calls.map(x => x.kind)).toEqual(["access", "credentials.read", "installations.read"]);
  for (const call of calls) expect(call.actor).toEqual({ mode: "oidc", userId: owner.user.id, organizationId: owner.organization.id, role: "owner", sessionId });
});
test("API binds origin and JSON media type, bounds actual stream bytes and rejects invalid JSON", async () => {
  expect((await post("credentials/save", {}, { origin: "https://other.example.invalid" })).status).toBe(403);
  expect((await post("credentials/save", {}, { "content-type": "text/plain" })).status).toBe(403);
  expect((await post("credentials/save", "{" )).status).toBe(400);
  expect((await post("credentials/save", JSON.stringify({ value: "x".repeat(65536) }))).status).toBe(413);
  expect(calls).toHaveLength(0); expect(initialized).toBe(0);
});
test("API derives actor from authenticated workspace, never a body claim", async () => {
  const response = await post("credentials/save", { userId: "attacker", role: "owner", organizationId: "other" });
  expect(response.status).toBe(200);
  expect(calls[0]!.actor).toEqual({ mode: "oidc", userId: owner.user.id, organizationId: owner.organization.id, role: "owner", sessionId });
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
});
test("onboarding and SSO metadata/actions do not initialize an unrelated transport consumer", async () => {
  expect((await post("onboarding/finish", { reviewed: true })).status).toBe(200);
  expect((await post("sso/save", {})).status).toBe(200);
  expect((await GET(new NextRequest(`${origin}/api/console/fleet/sso`), context("sso"))).status).toBe(200);
  expect(initialized).toBe(0);
  expect(calls.map(x => x.kind)).toEqual(["guide.finish", "sso.save", "sso.state"]);
});
test("SSO challenge returns only redirect URL and a secure HttpOnly bounded cookie", async () => {
  const response = await post("sso/test", {});
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ url: "https://idp.example.invalid/authorize" });
  const cookie = response.headers.get("set-cookie")!;
  expect(cookie).toContain("__Host-ravi_fleet_oidc="); expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("Secure"); expect(cookie).toContain("Max-Age=300"); expect(cookie).not.toContain("Domain=");
});
test("unexpected errors never expose backend/secret text and unknown paths are not operations", async () => {
  unavailable = true;
  const response = await post("credentials/save"); expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "fleet_unavailable" });
  unavailable = false;
  expect((await post("arbitrary/exec")).status).toBe(404);
  expect(initialized).toBe(1); // Only the failed, authorized credential action initialized its consumer.
  expect(calls).toHaveLength(0);
});

test("member HTTP boundary is current browser-only, same-origin, bounded and server-identified", async()=>{
  authenticated=false; expect((await post("members/status")).status).toBe(401);
  authenticated=true; mode="anonymous"; expect((await post("members/status")).status).toBe(403);
  mode="oidc";
  expect((await post("members/status",{}, {origin:"https://foreign.invalid"})).status).toBe(403);
  expect((await post("members/status",{}, {"content-type":"text/plain"})).status).toBe(403);
  expect((await post("members/status",JSON.stringify({data:"x".repeat(65536)}))).status).toBe(413);
  allowed=false; expect((await post("members/status")).status).toBe(403);
  allowed=true;
  expect((await GET(new NextRequest(`${origin}/api/console/fleet/members`),context("members"))).status).toBe(200);
  expect((await post("members/status",{userId:"target",actor:{userId:"forged"}})).status).toBe(200);
  expect(calls.map(x=>x.kind)).toEqual(["members.read","members.change"]);
  expect(calls[1]!.actor).toEqual({mode:"oidc",organizationId:owner.organization.id,userId:owner.user.id,role:"owner",sessionId});
  expect(initialized).toBe(0);
});
