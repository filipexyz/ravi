import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NextRequest, NextResponse } from "next/server";

import type { ConsoleAuthState } from "@/lib/auth/session";
import type { ConsoleWorkspace } from "@/server/console/workspace";

import {
  bindConnectBrowser,
  connectBrowserCookieName,
  connectTokenHash,
  ConnectStepError,
  continueConnectFlow,
  finishConnectFlow,
  getConnectPageState,
  isConnectBrowserBound,
  normalizeConnectToken,
  normalizePendingId,
  resolveConnectGrantAccess,
  type ConnectGrantDeps,
} from "./connect-grants";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const ME = "33333333-3333-4333-8333-333333333333";
const SOMEONE = "44444444-4444-4444-8444-444444444444";
const PENDING = "55555555-5555-4555-8555-555555555555";
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde";

const auth = { mode: "workos", viewer: { email: "me@example.test", mark: "M", name: "Me" } } as ConsoleAuthState;
const impersonated = {
  ...auth,
  initialAuth: { impersonator: { email: "support@example.test", reason: null } },
} as unknown as ConsoleAuthState;
const mine = { id: PENDING, organizationId: ORG_B, userId: ME };
const someoneElses = { id: PENDING, organizationId: ORG_B, userId: SOMEONE };

function workspace(organizationId: string): ConsoleWorkspace {
  return {
    membership: { role: "developer", status: "active" },
    mode: "workos",
    organization: { id: organizationId },
    user: { id: ME },
  } as unknown as ConsoleWorkspace;
}

function deps(overrides: Partial<ConnectGrantDeps> = {}): ConnectGrantDeps {
  return {
    currentUserId: async () => ME,
    featureDenial: async () => null,
    findOwner: async () => mine,
    selectedWorkspace: async () => workspace(ORG_A),
    workspaceIn: async (_auth, organizationId) => workspace(organizationId),
    ...overrides,
  };
}

const env = process.env;
const originalFetch = globalThis.fetch;
let calls: Array<{ path: string; body: Record<string, unknown> }> = [];
let reply: { status: number; body: unknown } = { status: 200, body: {} };

beforeEach(() => {
  calls = [];
  reply = { status: 200, body: {} };
  env.RAVI_CONNECTORS_VERCEL_HMAC_KEY_CURRENT_ID = "test-key";
  env.RAVI_CONNECTORS_VERCEL_HMAC_KEY_CURRENT = "test-secret-value";
  env.RAVI_CONNECTORS_LINK_URL = "https://link.example.test";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
      path: String(input).replace("https://link.example.test", ""),
    });
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete env.RAVI_CONNECTORS_VERCEL_HMAC_KEY_CURRENT_ID;
  delete env.RAVI_CONNECTORS_VERCEL_HMAC_KEY_CURRENT;
  delete env.RAVI_CONNECTORS_LINK_URL;
});

describe("token and id parsing", () => {
  test("accepts base64url tokens and UUID pending ids only", () => {
    expect(normalizeConnectToken(` ${TOKEN} `)).toBe(TOKEN);
    expect(normalizeConnectToken("short")).toBeNull();
    expect(normalizeConnectToken("has spaces in it but long enough")).toBeNull();
    expect(normalizePendingId(PENDING.toUpperCase())).toBe(PENDING);
    expect(normalizePendingId("not-a-uuid")).toBeNull();
  });

  test("hashes like the Worker: sha256, standard base64", () => {
    expect(connectTokenHash("abc")).toBe("ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=");
  });
});

describe("who can connect", () => {
  test("uses the grant's organization, not the selected one", async () => {
    const access = await resolveConnectGrantAccess(auth, { connectToken: TOKEN }, deps());
    expect(access).toMatchObject({ actor: { organizationId: ORG_B, userId: ME }, kind: "ok", pendingId: PENDING });
  });

  test("someone else's grant is a mismatch, named in an organization the person belongs to", async () => {
    const member = await resolveConnectGrantAccess(auth, { connectToken: TOKEN }, deps({ findOwner: async () => someoneElses }));
    expect(member).toEqual({ actor: { organizationId: ORG_B, userId: ME }, kind: "user_mismatch" });

    // Not a member of the grant's organization: the Console never vouches for it.
    const outsider = await resolveConnectGrantAccess(
      auth,
      { connectToken: TOKEN },
      deps({ findOwner: async () => someoneElses, workspaceIn: async () => null }),
    );
    expect(outsider).toEqual({ actor: { organizationId: ORG_A, userId: ME }, kind: "user_mismatch" });

    const nowhere = await resolveConnectGrantAccess(
      auth,
      { connectToken: TOKEN },
      deps({ findOwner: async () => someoneElses, selectedWorkspace: async () => null, workspaceIn: async () => null }),
    );
    expect(nowhere).toEqual({ actor: null, kind: "user_mismatch" });
  });

  test("an impersonation session is refused before anything is looked up", async () => {
    let looked = false;
    const access = await resolveConnectGrantAccess(
      impersonated,
      { connectToken: TOKEN },
      deps({
        findOwner: async () => {
          looked = true;
          return mine;
        },
      }),
    );
    expect(access).toEqual({ kind: "denied", reason: "impersonation" });
    expect(looked).toBe(false);
  });

  test("the initiator must still be an active member with connectors in their role", async () => {
    expect(
      await resolveConnectGrantAccess(auth, { connectToken: TOKEN }, deps({ workspaceIn: async () => null })),
    ).toEqual({ kind: "denied", reason: "not_member" });
    expect(
      await resolveConnectGrantAccess(
        auth,
        { connectToken: TOKEN },
        deps({ featureDenial: async () => "feature_forbidden" }),
      ),
    ).toEqual({ kind: "denied", reason: "feature_forbidden" });
  });

  test("an unknown grant falls back to the selected workspace", async () => {
    expect(
      await resolveConnectGrantAccess(auth, { pendingId: PENDING }, deps({ findOwner: async () => null })),
    ).toMatchObject({ actor: { organizationId: ORG_A }, kind: "ok" });
    expect(
      await resolveConnectGrantAccess(
        auth,
        { pendingId: PENDING },
        deps({ findOwner: async () => null, selectedWorkspace: async () => null }),
      ),
    ).toEqual({ kind: "invalid" });
  });
});

describe("the connect page", () => {
  test("resolves through the Worker for the initiator", async () => {
    reply = {
      status: 200,
      body: {
        accessMode: "read_only",
        expiresAt: "2026-10-10T10:10:00.000Z",
        installationName: "laptop",
        origin: "cli",
        provider: "google",
        reconnect: null,
        scopeKind: "user",
        state: "pending",
      },
    };
    const state = await getConnectPageState(auth, TOKEN, deps());
    expect(state).toMatchObject({ installationName: "laptop", state: "pending" });
    expect(calls).toEqual([
      { body: { connectToken: TOKEN, organizationId: ORG_B, userId: ME }, path: "/ui/connect/resolve" },
    ]);
  });

  test("never asks the Worker for a malformed token or a non-member initiator", async () => {
    expect(await getConnectPageState(auth, "nope", deps())).toEqual({ state: "invalid" });
    expect(await getConnectPageState(auth, TOKEN, deps({ workspaceIn: async () => null }))).toEqual({
      reason: "not_member",
      state: "denied",
    });
    expect(calls).toHaveLength(0);
  });

  test("someone else's link is a mismatch whatever the Worker answers; the Worker is told so it can record it", async () => {
    reply = { status: 200, body: { expiresAt: "x", provider: "google", state: "pending" } };
    expect(
      await getConnectPageState(auth, TOKEN, deps({ findOwner: async () => someoneElses })),
    ).toEqual({ state: "user_mismatch" });
    expect(calls).toEqual([
      { body: { connectToken: TOKEN, organizationId: ORG_B, userId: ME }, path: "/ui/connect/resolve" },
    ]);
  });

  test("an outsider's visit is recorded in their own organization; with none, the Worker isn't asked", async () => {
    reply = { status: 200, body: { state: "user_mismatch" } };
    expect(
      await getConnectPageState(
        auth,
        TOKEN,
        deps({ findOwner: async () => someoneElses, workspaceIn: async () => null }),
      ),
    ).toEqual({ state: "user_mismatch" });
    expect(calls).toEqual([
      { body: { connectToken: TOKEN, organizationId: ORG_A, userId: ME }, path: "/ui/connect/resolve" },
    ]);
    calls = [];
    expect(
      await getConnectPageState(
        auth,
        TOKEN,
        deps({ findOwner: async () => someoneElses, selectedWorkspace: async () => null, workspaceIn: async () => null }),
      ),
    ).toEqual({ state: "user_mismatch" });
    expect(calls).toHaveLength(0);
  });

  test("an impersonation session sees a blocked page and offers no Continue", async () => {
    expect(await getConnectPageState(impersonated, TOKEN, deps())).toEqual({ reason: "impersonation", state: "denied" });
    expect(calls).toHaveLength(0);
  });

  test("a Worker that can't be reached is unavailable, a refused token is invalid", async () => {
    reply = { status: 502, body: { error: "internal_error" } };
    expect(await getConnectPageState(auth, TOKEN, deps())).toEqual({ code: "internal_error", state: "unavailable" });
    reply = { status: 404, body: { error: "not_found" } };
    expect(await getConnectPageState(auth, TOKEN, deps())).toEqual({ state: "invalid" });
  });

  test("a Worker that refuses the Console's signature is unavailable, not the person's fault", async () => {
    reply = { status: 401, body: { error: "connector_unauthorized" } };
    expect(await getConnectPageState(auth, TOKEN, deps())).toEqual({
      code: "connector_service_unavailable",
      state: "unavailable",
    });
  });
});

describe("continue and finish", () => {
  test("continue is refused for anyone but the initiator, even if the Worker answered a URL", async () => {
    reply = { status: 200, body: { authorizationUrl: "https://accounts.example/auth" } };
    const error = await continueConnectFlow(
      auth,
      TOKEN,
      deps({ findOwner: async () => someoneElses }),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConnectStepError);
    expect(error).toMatchObject({ code: "user_mismatch", status: 403 });
    expect(calls.map((call) => call.path)).toEqual(["/ui/connect/continue"]);
  });

  test("continue is not forwarded for a non-member initiator", async () => {
    const error = await continueConnectFlow(auth, TOKEN, deps({ featureDenial: async () => "feature_forbidden" })).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ code: "feature_forbidden", status: 403 });
    expect(calls).toHaveLength(0);
  });

  test("continue answers the provider's sign-in URL and names the grant", async () => {
    reply = { status: 200, body: { authorizationUrl: "https://accounts.example/auth" } };
    expect(await continueConnectFlow(auth, TOKEN, deps())).toEqual({
      authorizationUrl: "https://accounts.example/auth",
      pendingId: PENDING,
    });
    expect(calls[0]).toEqual({ body: { connectToken: TOKEN, organizationId: ORG_B, userId: ME }, path: "/ui/connect/continue" });
  });

  test("continue and finish refuse an impersonation session without a Worker call", async () => {
    expect(await continueConnectFlow(impersonated, TOKEN, deps()).catch((caught: unknown) => caught)).toMatchObject({
      code: "impersonation",
      status: 403,
    });
    expect(
      await finishConnectFlow(impersonated, { browserBound: true, pendingId: PENDING, resultToken: "r" }, deps()).catch(
        (caught: unknown) => caught,
      ),
    ).toMatchObject({ code: "impersonation", status: 403 });
    expect(calls).toHaveLength(0);
  });

  test("finish forwards a mismatch so the Worker rejects it and drops the code", async () => {
    reply = { status: 200, body: { reason: "user_mismatch", state: "rejected" } };
    const result = await finishConnectFlow(
      auth,
      { browserBound: false, pendingId: PENDING, resultToken: "r" },
      deps({ findOwner: async () => someoneElses }),
    );
    expect(result).toEqual({ reason: "user_mismatch", state: "rejected" });
    expect(calls[0]).toEqual({
      body: { organizationId: ORG_B, pendingId: PENDING, resultToken: "r", userId: ME },
      path: "/ui/connect/finish",
    });
  });

  test("finish for someone in no organization is rejected without vouching for one", async () => {
    const result = await finishConnectFlow(
      auth,
      { browserBound: false, pendingId: PENDING, resultToken: "r" },
      deps({ findOwner: async () => someoneElses, selectedWorkspace: async () => null, workspaceIn: async () => null }),
    );
    expect(result).toEqual({ reason: "user_mismatch", state: "rejected" });
    expect(calls).toHaveLength(0);
  });

  test("the initiator finishes only from the browser that started or continued the grant", async () => {
    const error = await finishConnectFlow(auth, { browserBound: false, pendingId: PENDING, resultToken: "r" }, deps()).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ConnectStepError);
    expect(error).toMatchObject({ code: "connect_other_browser", status: 403 });
    expect(calls).toHaveLength(0);

    reply = { status: 200, body: { connectionId: "c", state: "connected" } };
    expect(await finishConnectFlow(auth, { browserBound: true, pendingId: PENDING, resultToken: "r" }, deps())).toMatchObject({
      connectionId: "c",
      state: "connected",
    });
    expect(calls).toHaveLength(1);
  });

  test("finish for a non-member initiator is refused without a Worker call", async () => {
    const error = await finishConnectFlow(
      auth,
      { browserBound: true, pendingId: PENDING, resultToken: "r" },
      deps({ workspaceIn: async () => null }),
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "not_member", status: 403 });
    expect(calls).toHaveLength(0);
  });

  test("finish with a malformed pending id is invalid without a Worker call", async () => {
    expect(await finishConnectFlow(auth, { browserBound: true, pendingId: "x", resultToken: "r" }, deps())).toEqual({
      state: "invalid",
    });
    expect(calls).toHaveLength(0);
  });
});

describe("the browser a grant belongs to", () => {
  test("start and continue mark the browser with a short-lived cookie per grant", () => {
    const response = bindConnectBrowser(NextResponse.json({}), PENDING.toUpperCase());
    const header = response.headers.get("set-cookie") ?? "";
    expect(header).toContain(`${connectBrowserCookieName(PENDING)}=1`);
    expect(header).toContain("Max-Age=600");
    expect(header).toContain("Path=/");
    expect(header.toLowerCase()).toContain("httponly");
    expect(header.toLowerCase()).toContain("samesite=lax");
    expect(bindConnectBrowser(NextResponse.json({}), "not-a-uuid").headers.get("set-cookie")).toBeNull();
  });

  test("the cookie is __Host- over HTTPS", () => {
    expect(connectBrowserCookieName(PENDING, true)).toBe(`__Host-ravi_connect_${PENDING.replace(/-/g, "")}`);
    expect(connectBrowserCookieName(PENDING, false)).toBe(`ravi_connect_${PENDING.replace(/-/g, "")}`);
  });

  test("only the marked browser counts as bound, for that grant only", () => {
    const marked = new NextRequest("https://console.example.test/x", {
      headers: { cookie: `${connectBrowserCookieName(PENDING)}=1` },
    });
    expect(isConnectBrowserBound(marked, PENDING)).toBe(true);
    expect(isConnectBrowserBound(marked, "66666666-6666-4666-8666-666666666666")).toBe(false);
    expect(isConnectBrowserBound(new NextRequest("https://console.example.test/x"), PENDING)).toBe(false);
  });
});
