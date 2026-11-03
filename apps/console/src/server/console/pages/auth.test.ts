import { afterEach, describe, expect, test } from "bun:test";

import {
  clearPagesSessionCookies,
  consumePagesClaimCode,
  createPagesClaimCode as createPagesClaimCodeWithPolicy,
  createPagesGuestClaimCode,
  pagesSessionCookie,
  PAGES_AUTH_CLAIM_PATH,
  PAGES_CLAIM_CODE_QUERY_PARAM,
  PAGES_SESSION_COOKIE_NAME,
  resolvePagesGuestViewer,
  resolvePagesReturnTargetForAuthStart,
  verifyPagesGuestSessionForRoute,
  verifyPagesSessionForSite as verifyPagesSessionForSiteWithPolicy,
  type PagesAuthSite,
  type PagesClaimCodeRecord,
  type PagesPrivateAuthRepository,
  type PagesSessionRecord,
} from "./auth";

const originalSecret = process.env.RAVI_PAGES_AUTH_SESSION_SECRET;

// Private-auth unit fixture has no policy DB. Supply an explicit exact-resource
// observation, not owner/admin inference. Real policy/DB cases live in the
// authorization consumer suite; production defaults still call canAccessProject.
let fixtureReadGranted = true;
const fixtureCanRead: NonNullable<Parameters<typeof createPagesClaimCodeWithPolicy>[0]["canReadProject"]> = async (workspace, projectId, action) =>
  fixtureReadGranted && workspace.organization.id === "org_1" && workspace.user.id === "user_1"
  && projectId === "proj_1" && action === "read";
const createPagesClaimCode = (input: Parameters<typeof createPagesClaimCodeWithPolicy>[0]) =>
  createPagesClaimCodeWithPolicy({ ...input, canReadProject: input.canReadProject ?? fixtureCanRead });
const verifyPagesSessionForSite = (input: Parameters<typeof verifyPagesSessionForSiteWithPolicy>[0]) =>
  verifyPagesSessionForSiteWithPolicy({ ...input, canReadProject: input.canReadProject ?? fixtureCanRead });

afterEach(() => {
  fixtureReadGranted = true;
  if (originalSecret === undefined) {
    delete process.env.RAVI_PAGES_AUTH_SESSION_SECRET;
  } else {
    process.env.RAVI_PAGES_AUTH_SESSION_SECRET = originalSecret;
  }
});

describe("Ravi Pages private auth", () => {
  test("revoked explicit project access denies a prior host-bound session even for owner", async () => {
    process.env.RAVI_PAGES_AUTH_SESSION_SECRET = "test-pages-session-secret-32-bytes";
    const repository = inMemoryPagesPrivateAuthRepository();
    const claim = await createPagesClaimCode({ repository, requestId: "claim-before-revoke", returnTo: "https://demo.ravi.page/", workspace: ownerWorkspace() });
    const code = new URL(claim.claimUrl).searchParams.get("code")!;
    const session = await consumePagesClaimCode({ code, host: "demo.ravi.page", repository, requestId: "redeem-before-revoke" });
    expect(session).not.toBeNull();
    fixtureReadGranted = false;
    expect(await verifyPagesSessionForSite({ repository, host: "demo.ravi.page", requestId: "after-revoke", sessionToken: session!.sessionToken, site: repository.site })).toBeNull();
    await expect(createPagesClaimCode({ repository, requestId: "new-after-revoke", returnTo: "https://demo.ravi.page/", workspace: ownerWorkspace() }))
      .rejects.toMatchObject({ status: 403, payload: { reason: "project_forbidden" } });
    expect(repository.claimCodes).toHaveLength(1);
  });
  test("a hostile sibling cannot redeem a claim or reuse a host-bound session, including same-site aliases", async () => {
    process.env.RAVI_PAGES_AUTH_SESSION_SECRET = "test-pages-session-secret-32-bytes";
    const repository = inMemoryPagesPrivateAuthRepository({ customHosts: ["sibling.ravi.page"] });
    const claim = await createPagesClaimCode({ repository, requestId: "claim-a", returnTo: "https://demo.ravi.page/", workspace: ownerWorkspace() });
    const code = new URL(claim.claimUrl).searchParams.get("code")!;
    expect(await consumePagesClaimCode({ code, host: "sibling.ravi.page", repository, requestId: "redeem-b" })).toBeNull();
    const session = await consumePagesClaimCode({ code, host: "demo.ravi.page", repository, requestId: "redeem-a" });
    expect(session).not.toBeNull();
    expect(await verifyPagesSessionForSite({ host: "sibling.ravi.page", repository, requestId: "reuse-b", sessionToken: session!.sessionToken, site: repository.site })).toBeNull();
    expect(await verifyPagesSessionForSite({ host: "demo.ravi.page", repository, requestId: "reuse-site-b", sessionToken: session!.sessionToken, site: { ...repository.site, id: "site_2" } })).toBeNull();
    expect(await verifyPagesSessionForSite({ host: "demo.ravi.page", repository, requestId: "legit-a", sessionToken: session!.sessionToken, site: repository.site })).not.toBeNull();
    const cookie = pagesSessionCookie(session!.sessionToken, session!.expiresAt);
    expect(cookie).toContain("Secure"); expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax"); expect(cookie).not.toMatch(/domain=/i);
  });
  test("creates one-time claim codes without putting session material in the URL", async () => {
    process.env.RAVI_PAGES_AUTH_SESSION_SECRET = "test-pages-session-secret-32-bytes";
    const repository = inMemoryPagesPrivateAuthRepository();

    const claim = await createPagesClaimCode({
      repository,
      requestId: "req_claim",
      returnTo: "https://demo.ravi.page/private-test?view=1",
      workspace: ownerWorkspace(),
    });

    const claimUrl = new URL(claim.claimUrl);
    expect(claimUrl.origin).toBe("https://demo.ravi.page");
    expect(claimUrl.pathname).toBe(PAGES_AUTH_CLAIM_PATH);
    expect(claimUrl.searchParams.get(PAGES_CLAIM_CODE_QUERY_PARAM)).toMatch(/^[A-Za-z0-9_-]{32,256}$/);
    expect(repository.claimCodes).toHaveLength(1);
    expect(repository.claimCodes[0]?.returnUrl).toBe("https://demo.ravi.page/private-test?view=1");
    expect(repository.claimCodes[0]?.codeHash).not.toContain(claimUrl.searchParams.get(PAGES_CLAIM_CODE_QUERY_PARAM) ?? "");
  });

  test("accepts active custom Pages hostnames as return targets", async () => {
    process.env.RAVI_PAGES_AUTH_SESSION_SECRET = "test-pages-session-secret-32-bytes";
    const repository = inMemoryPagesPrivateAuthRepository({ customHosts: ["rbbt.filipe.ai"] });

    const claim = await createPagesClaimCode({
      repository,
      requestId: "req_custom_claim",
      returnTo: "https://rbbt.filipe.ai/term-sheet?view=private",
      workspace: ownerWorkspace(),
    });

    const claimUrl = new URL(claim.claimUrl);
    expect(claimUrl.origin).toBe("https://rbbt.filipe.ai");
    expect(claimUrl.pathname).toBe(PAGES_AUTH_CLAIM_PATH);
    expect(repository.claimCodes[0]?.returnUrl).toBe("https://rbbt.filipe.ai/term-sheet?view=private");
    expect(repository.claimCodes[0]?.requestedHost).toBe("rbbt.filipe.ai");
  });

  test("resolves the target organization before Console workspace selection", async () => {
    const repository = inMemoryPagesPrivateAuthRepository({ customHosts: ["rbbt.filipe.ai"] });

    await expect(
      resolvePagesReturnTargetForAuthStart({
        repository,
        returnTo: "https://rbbt.filipe.ai/term-sheet?view=private",
      }),
    ).resolves.toEqual({
      host: "rbbt.filipe.ai",
      organizationId: "org_1",
      projectId: "proj_1",
      siteId: "site_1",
    });

    await expect(
      resolvePagesReturnTargetForAuthStart({
        repository,
        returnTo: "https://evil.example/private-test",
      }),
    ).resolves.toBeNull();
  });

  test("consumes a claim code once and verifies the resulting revocable Pages session", async () => {
    process.env.RAVI_PAGES_AUTH_SESSION_SECRET = "test-pages-session-secret-32-bytes";
    const repository = inMemoryPagesPrivateAuthRepository();
    const claim = await createPagesClaimCode({
      repository,
      requestId: "req_claim",
      returnTo: "https://demo.ravi.page/private-test",
      workspace: ownerWorkspace(),
    });
    const code = new URL(claim.claimUrl).searchParams.get(PAGES_CLAIM_CODE_QUERY_PARAM);
    if (!code) throw new Error("Expected claim code.");

    const session = await consumePagesClaimCode({
      code,
      host: "demo.ravi.page",
      repository,
      requestId: "req_consume",
    });
    const replay = await consumePagesClaimCode({
      code,
      host: "demo.ravi.page",
      repository,
      requestId: "req_replay",
    });

    expect(session).toMatchObject({
      returnTo: "https://demo.ravi.page/private-test",
    });
    expect(session?.sessionToken).toMatch(/^[A-Za-z0-9_-]{32,256}$/);
    expect(replay).toBeNull();
    expect(repository.sessions).toHaveLength(1);
    expect(pagesSessionCookie(session?.sessionToken ?? "", session?.expiresAt ?? new Date())).toContain(
      `${PAGES_SESSION_COOKIE_NAME}=`,
    );

    const verified = await verifyPagesSessionForSite({
      host: "demo.ravi.page",
      repository,
      requestId: "req_verify",
      sessionToken: session?.sessionToken,
      site: repository.site,
    });

    expect(verified).toMatchObject({
      user: { id: "user_1" },
      organization: { id: "org_1" },
    });
    expect(repository.sessions[0]?.lastRequestId).toBe("req_verify");
  });

  test("rejects org mismatch as pages_access_denied/org_forbidden", async () => {
    process.env.RAVI_PAGES_AUTH_SESSION_SECRET = "test-pages-session-secret-32-bytes";
    const repository = inMemoryPagesPrivateAuthRepository();

    await expect(
      createPagesClaimCode({
        repository,
        requestId: "req_org_denied",
        returnTo: "https://demo.ravi.page/private-test",
        workspace: {
          ...ownerWorkspace(),
          organization: { id: "org_other" },
        },
      }),
    ).rejects.toMatchObject({
      payload: { error: "pages_access_denied", reason: "org_forbidden" },
      status: 403,
    });
    expect(repository.claimCodes).toHaveLength(0);
  });

  test("rejects project read denial as pages_access_denied/project_forbidden", async () => {
    process.env.RAVI_PAGES_AUTH_SESSION_SECRET = "test-pages-session-secret-32-bytes";
    const repository = inMemoryPagesPrivateAuthRepository();

    await expect(
      createPagesClaimCode({
        canReadProject: async () => false,
        repository,
        requestId: "req_project_denied",
        returnTo: "https://demo.ravi.page/private-test",
        workspace: ownerWorkspace(),
      }),
    ).rejects.toMatchObject({
      payload: { error: "pages_access_denied", reason: "project_forbidden" },
      status: 403,
    });
    expect(repository.claimCodes).toHaveLength(0);
  });

  test("rejects arbitrary return targets before creating a claim code", async () => {
    process.env.RAVI_PAGES_AUTH_SESSION_SECRET = "test-pages-session-secret-32-bytes";
    const repository = inMemoryPagesPrivateAuthRepository();

    await expect(
      createPagesClaimCode({
        repository,
        requestId: "req_bad",
        returnTo: "https://evil.example/private-test",
        workspace: ownerWorkspace(),
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(repository.claimCodes).toHaveLength(0);
  });

  test("clear cookies include the Pages cookie name", () => {
    expect(clearPagesSessionCookies()).toEqual([
      "__Host-ravi_page_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
    ]);
  });
});

describe("Ravi Pages sign-in for people given a page", () => {
  test("a guest signs in only on the page given to them and gets no workspace", async () => {
    process.env.RAVI_PAGES_AUTH_SESSION_SECRET = "test-pages-session-secret-32-bytes";
    const repository = inMemoryPagesPrivateAuthRepository({ membership: null });
    const allowedPaths = new Set(["/deck"]);

    expect(
      await errorPayload(
        createPagesGuestClaimCode({
          canViewPath: async ({ path }) => allowedPaths.has(path),
          repository,
          requestId: "req_guest",
          returnTo: "https://demo.ravi.page/plan",
          userId: "user_guest",
        }),
      ),
    ).toEqual({ error: "pages_access_denied", reason: "org_forbidden" });

    const claim = await createPagesGuestClaimCode({
      canViewPath: async ({ path, userId }) => allowedPaths.has(path) && userId === "user_guest",
      repository,
      requestId: "req_guest",
      returnTo: "https://demo.ravi.page/deck",
      userId: "user_guest",
    });
    expect(repository.claimCodes[0]).toMatchObject({ metadataJson: { access: "guest" }, userId: "user_guest" });

    const code = new URL(claim.claimUrl).searchParams.get(PAGES_CLAIM_CODE_QUERY_PARAM) ?? "";
    const session = await consumePagesClaimCode({ code, host: "demo.ravi.page", repository, requestId: "req_consume" });
    if (!session) throw new Error("Expected a guest session.");

    // The member path refuses: a guest is not in the organization.
    expect(
      await verifyPagesSessionForSite({
        host: "demo.ravi.page",
        repository,
        requestId: "req_member",
        sessionToken: session.sessionToken,
        site: repository.site,
      }),
    ).toBeNull();

    const canViewRoute = async ({ routeId, userId }: { routeId: string; userId: string }) =>
      routeId === "route_deck" && userId === "user_guest";
    const verify = (routeId: string, sessionToken = session.sessionToken) =>
      verifyPagesGuestSessionForRoute({
        canViewRoute,
        host: "demo.ravi.page",
        repository,
        requestId: "req_guest_verify",
        routeId,
        sessionToken,
        site: repository.site,
      });
    expect(await verify("route_deck")).toBe(true);
    expect(await verify("route_plan")).toBe(false);
    expect(await verify("route_deck", "not-a-session-token-but-long-enough-0000")).toBe(false);

    const otherSite = { ...repository.site, id: "site_2" };
    expect(
      await verifyPagesGuestSessionForRoute({
        canViewRoute: async () => true,
        host: "demo.ravi.page",
        repository,
        requestId: "req_other_site",
        routeId: "route_deck",
        sessionToken: session.sessionToken,
        site: otherSite,
      }),
    ).toBe(false);
  });
});

describe("Ravi Pages guest viewer for Page Chat", () => {
  test("names the guest behind a human_viewer session of this site and never a workspace", async () => {
    process.env.RAVI_PAGES_AUTH_SESSION_SECRET = "test-pages-session-secret-32-bytes";
    const repository = inMemoryPagesPrivateAuthRepository({ membership: null });
    const claim = await createPagesGuestClaimCode({
      canViewPath: async () => true,
      repository,
      requestId: "req_guest",
      returnTo: "https://demo.ravi.page/deck",
      userId: "user_guest",
    });
    const code = new URL(claim.claimUrl).searchParams.get(PAGES_CLAIM_CODE_QUERY_PARAM) ?? "";
    const session = await consumePagesClaimCode({ code, host: "demo.ravi.page", repository, requestId: "req_consume" });
    if (!session) throw new Error("Expected a guest session.");

    const resolve = (overrides: { sessionToken?: string | null; site?: PagesAuthSite; host?: string } = {}) =>
      resolvePagesGuestViewer({
        host: overrides.host ?? "demo.ravi.page",
        requestId: "req_guest_viewer",
        repository,
        sessionToken: overrides.sessionToken === undefined ? session.sessionToken : overrides.sessionToken,
        site: overrides.site ?? repository.site,
      });

    expect(await resolve()).toEqual({ userId: "user_guest", sessionId: repository.sessions[0]!.id });
    expect(await resolve({ sessionToken: null })).toBeNull();
    expect(await resolve({ sessionToken: "not-a-session-token-but-long-enough-0000" })).toBeNull();
    expect(await resolve({ site: { ...repository.site, id: "site_2" } })).toBeNull();
    expect(await resolve({ host: "other.ravi.page" })).toBeNull();

    // A capture or other non-viewer session is never a guest viewer.
    repository.sessions[0]!.metadataJson = { source: "pages.capture" };
    expect(await resolve()).toBeNull();
    repository.sessions[0]!.metadataJson = {};

    repository.sessions[0]!.expiresAt = new Date(Date.now() - 1000);
    expect(await resolve()).toBeNull();
  });
});

async function errorPayload(promise: Promise<unknown>) {
  try {
    await promise;
    return null;
  } catch (error) {
    return (error as { payload?: unknown }).payload ?? error;
  }
}

function ownerWorkspace() {
  return {
    mode: "workos" as const,
    user: { id: "user_1" },
    organization: { id: "org_1" },
    membership: { role: "owner" },
  };
}

function inMemoryPagesPrivateAuthRepository(
  options: {
    customHosts?: string[];
    membership?: { role: string; status: string } | null;
  } = {},
): PagesPrivateAuthRepository & {
  claimCodes: PagesClaimCodeRecord[];
  sessions: PagesSessionRecord[];
  site: PagesAuthSite;
} {
  const now = new Date("2026-05-10T21:00:00.000Z");
  const site: PagesAuthSite = {
    id: "site_1",
    organizationId: "org_1",
    projectId: "proj_1",
    defaultHostname: "demo.ravi.page",
    defaultVisibility: "private",
    status: "active",
  };
  const claimCodes: PagesClaimCodeRecord[] = [];
  const sessions: PagesSessionRecord[] = [];

  return {
    claimCodes,
    sessions,
    site,
    async transaction(_organizationId, fn) { return fn(this); },
    async assertBrowserSource() { throw new Error("unexpected_oidc_source"); },
    async findClaimCodeByHash(hash) { return claimCodes.find(claim => claim.codeHash === hash) ?? null; },
    async consumeClaimCode(input) {
      const claimCode = claimCodes.find(
        (candidate) =>
          candidate.codeHash === input.codeHash &&
          candidate.requestedHost === input.host &&
          candidate.status === "active" &&
          candidate.expiresAt > input.now,
      );
      if (!claimCode) return null;
      Object.assign(claimCode, {
        status: "consumed",
        consumedAt: input.now,
        consumedRequestId: input.requestId,
        updatedAt: input.now,
      });
      return claimCode;
    },
    async findOrganizationMembership() {
      return options.membership === undefined ? { role: "owner", status: "active" } : options.membership;
    },
    async findSessionByHash(sessionTokenHash) {
      return sessions.find((session) => session.sessionTokenHash === sessionTokenHash) ?? null;
    },
    async findSiteByHost(host) {
      if (host === "demo.ravi.page") return site;
      return options.customHosts?.includes(host) ? site : null;
    },
    async insertAudit() {},
    async insertClaimCode(input) {
      const claimCode: PagesClaimCodeRecord = {
        id: `claim_${claimCodes.length + 1}`,
        routeId: null,
        artifactId: null,
        artifactVersionId: null,
        status: "active",
        consumedAt: null,
        consumedRequestId: null,
        createdAt: now,
        updatedAt: now,
        ...input,
      };
      claimCodes.push(claimCode);
      return claimCode;
    },
    async insertSession(input) {
      const session: PagesSessionRecord = {
        id: `session_${sessions.length + 1}`,
        status: "active",
        revokedAt: null,
        lastUsedAt: null,
        lastRequestId: null,
        metadataJson: {},
        createdAt: now,
        updatedAt: now,
        ...input,
      };
      sessions.push(session);
      return session;
    },
    async markSessionExpired(sessionId, updatedAt, requestId) {
      const session = sessions.find((candidate) => candidate.id === sessionId);
      if (session) Object.assign(session, { status: "expired", lastRequestId: requestId, updatedAt });
    },
    async touchSession(sessionId, updatedAt, requestId) {
      const session = sessions.find((candidate) => candidate.id === sessionId);
      if (session) Object.assign(session, { lastRequestId: requestId, lastUsedAt: updatedAt, updatedAt });
    },
  };
}
