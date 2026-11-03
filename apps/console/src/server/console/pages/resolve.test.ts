import { describe, expect, test } from "bun:test";

import {
  authorizePagesResolveRequest,
  effectiveVisibility,
  pagesGuestCanViewPath,
  pagesRouteResolveRepositoryForDb,
  resolvePagesRoute,
  type PagesResolveFile,
  type PagesResolveRelease,
  type PagesResolveRoute,
  type PagesResolveSite,
  type PagesRouteResolveRepository,
} from "./resolve";

describe("Ravi Pages route resolver", () => {
  test("resolves an exact route to its entrypoint object", async () => {
    const repository = inMemoryPagesResolveRepository({
      sites: [site({ id: "site_home", projectId: "proj_1", host: "demo.ravi.page", activeReleaseId: "rel_1" })],
      releases: [release({ id: "rel_1" })],
      routes: [
        route({
          id: "binding_home",
          routeId: "route_home",
          releaseId: "rel_1",
          path: "/",
          matchType: "exact",
          entrypoint: "index.html",
          artifactId: "art_home",
          artifactVersionId: "ver_home",
        }),
      ],
      files: [file({ artifactId: "art_home", artifactVersionId: "ver_home", path: "index.html" })],
    });

    const response = await resolvePagesRoute({
      input: { host: "demo.ravi.page", path: "/", method: "GET" },
      repository,
    });

    expect(response).toMatchObject({
      status: "ok",
      object: {
        path: "index.html",
        r2Key: "org/org_1/project/proj_1/artifact/art_home/version/ver_home/index.html",
        contentType: "text/html; charset=utf-8",
        cache: "entrypoint",
      },
      route: {
        id: "route_home",
        bindingId: "binding_home",
      },
    });
  });

  test("projects only the typed device-motion permission from route config", async () => {
    const repository = inMemoryPagesResolveRepository({
      sites: [site({ activeReleaseId: "rel_1" })],
      releases: [release({ id: "rel_1" })],
      routes: [
        route({
          releaseId: "rel_1",
          routeConfigJson: {
            browserPermissions: { deviceMotion: "self", camera: "*" },
            headers: { "permissions-policy": "geolocation=*" },
          },
        }),
      ],
      files: [file()],
    });

    const response = await resolvePagesRoute({
      input: { host: "demo.ravi.page", path: "/" },
      repository,
    });

    expect(response).toMatchObject({
      status: "ok",
      route: { browserPermissions: { deviceMotion: "self" } },
    });
    if (response.status !== "ok") throw new Error("Expected resolved route.");
    expect(response.headers).not.toHaveProperty("permissions-policy");
    expect(response.route).not.toHaveProperty("headers");
  });

  test("resolves mounted prefix assets and keeps multi-site project hosts isolated", async () => {
    const repository = inMemoryPagesResolveRepository({
      sites: [
        site({ id: "site_docs", projectId: "proj_1", host: "docs.ravi.page", activeReleaseId: "rel_docs" }),
        site({ id: "site_app", projectId: "proj_1", host: "app.ravi.page", activeReleaseId: "rel_app" }),
      ],
      releases: [release({ id: "rel_docs" }), release({ id: "rel_app" })],
      routes: [
        route({
          id: "binding_docs",
          routeId: "route_docs",
          releaseId: "rel_docs",
          path: "/docs",
          matchType: "prefix",
          artifactId: "art_docs",
          artifactVersionId: "ver_docs",
        }),
        route({
          id: "binding_app",
          routeId: "route_app",
          releaseId: "rel_app",
          path: "/docs",
          matchType: "prefix",
          artifactId: "art_app",
          artifactVersionId: "ver_app",
        }),
      ],
      files: [
        file({
          artifactId: "art_docs",
          artifactVersionId: "ver_docs",
          path: "assets/app.js",
          mimeType: "application/javascript",
          storageJson: { r2Key: "org/org_1/project/proj_1/artifact/art_docs/version/ver_docs/assets/app.js" },
        }),
        file({
          artifactId: "art_app",
          artifactVersionId: "ver_app",
          path: "assets/app.js",
          mimeType: "application/javascript",
          storageJson: { r2Key: "org/org_1/project/proj_1/artifact/art_app/version/ver_app/assets/app.js" },
        }),
      ],
    });

    const response = await resolvePagesRoute({
      input: { host: "docs.ravi.page", path: "/docs/assets/app.js", method: "GET" },
      repository,
    });

    expect(response).toMatchObject({
      status: "ok",
      site: {
        id: "site_docs",
        projectId: "proj_1",
      },
      artifact: {
        id: "art_docs",
        versionId: "ver_docs",
      },
      object: {
        path: "assets/app.js",
        r2Key: "org/org_1/project/proj_1/artifact/art_docs/version/ver_docs/assets/app.js",
        cache: "immutable",
      },
    });
  });

  test("resolves reserved Ravi asset URLs only through active release route bindings", async () => {
    const repository = inMemoryPagesResolveRepository({
      sites: [site({ id: "site_docs", projectId: "proj_1", host: "docs.ravi.page", activeReleaseId: "rel_docs" })],
      releases: [release({ id: "rel_docs" })],
      routes: [
        route({
          id: "binding_docs",
          routeId: "route_docs",
          releaseId: "rel_docs",
          path: "/docs",
          matchType: "prefix",
          artifactId: "art_docs",
          artifactVersionId: "ver_docs",
        }),
      ],
      files: [
        file({
          artifactId: "art_docs",
          artifactVersionId: "ver_docs",
          path: "assets/app.js",
          mimeType: "application/javascript",
          storageJson: { r2Key: "org/org_1/project/proj_1/artifact/art_docs/version/ver_docs/assets/app.js" },
        }),
      ],
    });

    const response = await resolvePagesRoute({
      input: {
        host: "docs.ravi.page",
        path: "/_ravi/assets/art_docs/ver_docs/assets/app.js",
        method: "GET",
      },
      repository,
    });

    expect(response).toMatchObject({
      status: "ok",
      route: {
        id: "route_docs",
      },
      object: {
        path: "assets/app.js",
        r2Key: "org/org_1/project/proj_1/artifact/art_docs/version/ver_docs/assets/app.js",
        cache: "immutable",
      },
    });
  });

  test("fails closed instead of returning staging R2 keys", async () => {
    const repository = inMemoryPagesResolveRepository({
      sites: [site({ activeReleaseId: "rel_1" })],
      releases: [release({ id: "rel_1" })],
      routes: [route({ releaseId: "rel_1", path: "/", matchType: "prefix" })],
      files: [
        file({
          path: "index.html",
          storageJson: {
            r2Key: "staging/org/org_1/project/proj_1/upload/upl_1/index.html",
          },
        }),
      ],
    });

    const response = await resolvePagesRoute({
      input: { host: "demo.ravi.page", path: "/" },
      repository,
    });

    expect(response).toMatchObject({
      status: "error",
      httpStatus: 503,
      code: "resolved_non_final_object_key",
    });
  });

  test("fails closed when stored R2 keys point at a different artifact version", async () => {
    const repository = inMemoryPagesResolveRepository({
      sites: [site({ activeReleaseId: "rel_1" })],
      releases: [release({ id: "rel_1" })],
      routes: [route({ releaseId: "rel_1", path: "/", matchType: "prefix", artifactId: "art_1", artifactVersionId: "ver_1" })],
      files: [
        file({
          artifactId: "art_1",
          artifactVersionId: "ver_1",
          path: "index.html",
          storageJson: {
            r2Key: "org/org_1/project/proj_1/artifact/art_2/version/ver_2/index.html",
          },
        }),
      ],
    });

    const response = await resolvePagesRoute({
      input: { host: "demo.ravi.page", path: "/" },
      repository,
    });

    expect(response).toMatchObject({
      status: "error",
      httpStatus: 503,
      code: "resolved_non_final_object_key",
    });
  });

  test("falls back to the entrypoint only for SPA routes", async () => {
    const repository = inMemoryPagesResolveRepository({
      sites: [site({ activeReleaseId: "rel_1" })],
      releases: [release({ id: "rel_1" })],
      routes: [
        route({
          releaseId: "rel_1",
          path: "/app",
          matchType: "spa",
          artifactId: "art_spa",
          artifactVersionId: "ver_spa",
        }),
      ],
      files: [file({ artifactId: "art_spa", artifactVersionId: "ver_spa", path: "index.html" })],
    });

    const response = await resolvePagesRoute({
      input: { host: "demo.ravi.page", path: "/app/settings", method: "GET" },
      repository,
    });

    expect(response).toMatchObject({
      status: "ok",
      object: {
        path: "index.html",
        cache: "entrypoint",
      },
    });
  });

  test("returns not_found instead of the home page for unknown paths on a root SPA route", async () => {
    const repository = inMemoryPagesResolveRepository({
      sites: [site({ activeReleaseId: "rel_1" })],
      releases: [release({ id: "rel_1" })],
      routes: [
        route({ releaseId: "rel_1", path: "/", matchType: "spa", artifactId: "art_home", artifactVersionId: "ver_home" }),
        route({
          id: "binding_report",
          routeId: "route_report",
          releaseId: "rel_1",
          path: "/report",
          matchType: "spa",
          artifactId: "art_report",
          artifactVersionId: "ver_report",
        }),
      ],
      files: [
        file({ artifactId: "art_home", artifactVersionId: "ver_home", path: "index.html" }),
        file({ artifactId: "art_report", artifactVersionId: "ver_report", path: "index.html" }),
      ],
    });

    for (const path of ["/report;", "/missing-page", "/missing/deep"]) {
      const response = await resolvePagesRoute({ input: { host: "demo.ravi.page", path, method: "GET" }, repository });
      expect(response).toMatchObject({ status: "not_found" });
    }

    const home = await resolvePagesRoute({ input: { host: "demo.ravi.page", path: "/", method: "GET" }, repository });
    expect(home).toMatchObject({ status: "ok", artifact: { id: "art_home" }, object: { path: "index.html" } });
    const report = await resolvePagesRoute({
      input: { host: "demo.ravi.page", path: "/report", method: "GET" },
      repository,
    });
    expect(report).toMatchObject({ status: "ok", artifact: { id: "art_report" } });
  });

  test("returns coarse not_found for missing host, release, and files", async () => {
    const missingHost = await resolvePagesRoute({
      input: { host: "missing.ravi.page", path: "/" },
      repository: inMemoryPagesResolveRepository(),
    });

    const missingRelease = await resolvePagesRoute({
      input: { host: "demo.ravi.page", path: "/" },
      repository: inMemoryPagesResolveRepository({
        sites: [site({ activeReleaseId: null })],
      }),
    });

    const missingFile = await resolvePagesRoute({
      input: { host: "demo.ravi.page", path: "/assets/app.js" },
      repository: inMemoryPagesResolveRepository({
        sites: [site({ activeReleaseId: "rel_1" })],
        releases: [release({ id: "rel_1" })],
        routes: [route({ releaseId: "rel_1", path: "/", matchType: "prefix" })],
      }),
    });

    expect(missingHost).toMatchObject({ status: "not_found", code: "not_found" });
    expect(missingRelease).toMatchObject({ status: "not_found", code: "not_found" });
    expect(missingFile).toMatchObject({ status: "not_found", code: "not_found" });
  });

  test("returns a private placeholder without object metadata for private sites", async () => {
    const repository = inMemoryPagesResolveRepository({
      sites: [site({ activeReleaseId: "rel_1", defaultVisibility: "private" })],
      releases: [release({ id: "rel_1" })],
      routes: [route({ releaseId: "rel_1", path: "/", matchType: "prefix", visibility: "public" })],
      files: [file({ path: "index.html" })],
    });

    const response = await resolvePagesRoute({
      input: { host: "demo.ravi.page", path: "/" },
      repository,
    });

    expect(response).toEqual({
      status: "private",
      httpStatus: 401,
      code: "private_auth_required",
      headers: {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  });

  test("resolves private routes through a valid Pages session and keeps private cache", async () => {
    const repository = inMemoryPagesResolveRepository({
      sites: [site({ activeReleaseId: "rel_1", defaultVisibility: "private" })],
      releases: [release({ id: "rel_1" })],
      routes: [route({ releaseId: "rel_1", path: "/", matchType: "prefix", visibility: "public" })],
      files: [file({ path: "index.html" })],
    });

    const response = await resolvePagesRoute({
      input: { host: "demo.ravi.page", path: "/", pagesSession: "sessionabcdefghijklmnopqrstuvwxyz123456" },
      privateAccessVerifier: async ({ pagesSession, site: resolvedSite }) =>
        pagesSession === "sessionabcdefghijklmnopqrstuvwxyz123456" && resolvedSite.id === "site_1",
      repository,
    });

    expect(response).toMatchObject({
      status: "ok",
      object: {
        path: "index.html",
        cache: "private",
      },
      toolbar: {
        enabled: true,
        effectiveVisibility: "private",
        siteId: "site_1",
        projectId: "proj_1",
        routeId: "route_1",
      },
      headers: {
        "cache-control": "no-store",
      },
    });
  });

  test("returns a password challenge without object metadata", async () => {
    const repository = inMemoryPagesResolveRepository({
      sites: [site({ activeReleaseId: "rel_1" })],
      releases: [release({ id: "rel_1" })],
      routes: [route({ releaseId: "rel_1", path: "/report", matchType: "spa", visibility: "password" })],
      files: [file({ path: "index.html" })],
    });

    const response = await resolvePagesRoute({
      input: { host: "demo.ravi.page", path: "/report" },
      passwordAccessVerifier: async () => false,
      repository,
    });

    expect(response).toEqual({
      status: "password_required",
      httpStatus: 401,
      code: "password_required",
      headers: {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
    expect(JSON.stringify(response)).not.toContain("r2Key");
    expect(JSON.stringify(response)).not.toContain("artifact");
  });

  test("serves password routes only after the route-scoped session verifier succeeds", async () => {
    const repository = inMemoryPagesResolveRepository({
      sites: [site({ activeReleaseId: "rel_1" })],
      releases: [release({ id: "rel_1" })],
      routes: [route({ releaseId: "rel_1", path: "/report", matchType: "spa", visibility: "password" })],
      files: [file({ path: "index.html" })],
    });

    const response = await resolvePagesRoute({
      input: {
        host: "demo.ravi.page",
        path: "/report",
        pagesPasswordSession: "passwordabcdefghijklmnopqrstuvwxyz123456",
      },
      passwordAccessVerifier: async ({ pagesPasswordSession, routeId }) =>
        pagesPasswordSession === "passwordabcdefghijklmnopqrstuvwxyz123456" && routeId === "route_1",
      privateAccessVerifier: async () => false,
      repository,
    });

    expect(response).toMatchObject({
      status: "ok",
      object: { cache: "private", path: "index.html" },
      route: { id: "route_1", visibility: "password" },
    });
    expect("toolbar" in response ? response.toolbar : undefined).toBeUndefined();
  });

  test("lets an authorized Console operator bypass a page password and receive toolbar metadata", async () => {
    const repository = inMemoryPagesResolveRepository({
      sites: [site({ activeReleaseId: "rel_1" })],
      releases: [release({ id: "rel_1" })],
      routes: [route({ releaseId: "rel_1", path: "/report", matchType: "spa", visibility: "password" })],
      files: [file({ path: "index.html" })],
    });
    const response = await resolvePagesRoute({
      input: {
        host: "demo.ravi.page",
        path: "/report",
        pagesSession: "sessionabcdefghijklmnopqrstuvwxyz123456",
      },
      passwordAccessVerifier: async () => false,
      privateAccessVerifier: async () => true,
      repository,
    });

    expect(response).toMatchObject({
      status: "ok",
      toolbar: { enabled: true, effectiveVisibility: "password" },
    });
  });

  test("includes toolbar metadata on public routes only when a Pages session is authorized", async () => {
    const repository = inMemoryPagesResolveRepository({
      sites: [site({ activeReleaseId: "rel_1", defaultVisibility: "public" })],
      releases: [release({ id: "rel_1", releaseNumber: 12 })],
      routes: [route({ releaseId: "rel_1", path: "/", matchType: "spa", visibility: "public" })],
      files: [file({ path: "index.html", versionNumber: 7 })],
    });

    const anonymous = await resolvePagesRoute({
      input: { host: "demo.ravi.page", path: "/" },
      privateAccessVerifier: async () => false,
      repository,
    });
    expect(anonymous).toMatchObject({ status: "ok" });
    expect("toolbar" in anonymous ? anonymous.toolbar : undefined).toBeUndefined();

    const operator = await resolvePagesRoute({
      input: { host: "demo.ravi.page", path: "/", pagesSession: "sessionabcdefghijklmnopqrstuvwxyz123456" },
      privateAccessVerifier: async ({ pagesSession }) => pagesSession === "sessionabcdefghijklmnopqrstuvwxyz123456",
      repository,
    });

    expect(operator).toMatchObject({
      status: "ok",
      object: {
        cache: "entrypoint",
      },
      toolbar: {
        enabled: true,
        effectiveVisibility: "public",
        host: "demo.ravi.page",
        path: "/",
        releaseNumber: 12,
        artifactVersionNumber: 7,
      },
    });
  });

  test("fails closed when an active release contains ambiguous route ties", async () => {
    const repository = inMemoryPagesResolveRepository({
      sites: [site({ activeReleaseId: "rel_1" })],
      releases: [release({ id: "rel_1" })],
      routes: [
        route({ id: "binding_a", releaseId: "rel_1", path: "/app", matchType: "prefix", priority: 0 }),
        route({ id: "binding_b", releaseId: "rel_1", path: "/app", matchType: "spa", priority: 0 }),
      ],
      files: [file({ path: "index.html" })],
    });

    const response = await resolvePagesRoute({
      input: { host: "demo.ravi.page", path: "/app/settings" },
      repository,
    });

    expect(response).toMatchObject({
      status: "error",
      httpStatus: 503,
      code: "active_release_route_conflict",
    });
  });

  test("redirects apex custom domain bindings to the canonical hostname", async () => {
    const repository = inMemoryPagesResolveRepository({
      sites: [
        site({
          activeReleaseId: "rel_1",
          customDomain: {
            hostname: "customer.example",
            mode: "redirect",
            redirectToHostname: "www.customer.example",
          },
          host: "customer.example",
        }),
      ],
    });

    const response = await resolvePagesRoute({
      input: { host: "customer.example", path: "/docs", search: "?utm_source=mail&ref=abc", method: "GET" },
      repository,
    });

    expect(response).toEqual({
      status: "redirect",
      httpStatus: 308,
      code: "pages_domain_redirect",
      headers: {
        "cache-control": "public, max-age=300",
        location: "https://www.customer.example/docs?utm_source=mail&ref=abc",
        "x-content-type-options": "nosniff",
      },
      redirect: {
        location: "https://www.customer.example/docs?utm_source=mail&ref=abc",
      },
    });
  });
});

describe("Ravi Pages effective visibility", () => {
  test("a non-public route keeps its own policy and a public route follows the host default", () => {
    expect(effectiveVisibility("public", "private")).toBe("private");
    expect(effectiveVisibility("public", "protected_link")).toBe("protected_link");
    expect(effectiveVisibility("private", "password")).toBe("password");
    expect(effectiveVisibility("public", "public")).toBe("public");
    expect(effectiveVisibility("private", "public")).toBe("private");
    expect(effectiveVisibility("protected_link", "public")).toBe("protected_link");
    expect(effectiveVisibility("password", "public")).toBe("password");
  });
});

describe("Ravi Pages resolve boundary", () => {
  test("requires a matching bearer token", () => {
    const request = new Request("https://console.ravi.bot/api/internal/pages/resolve", {
      headers: {
        authorization: "Bearer test-control-token-32-bytes-minimum",
      },
    });

    expect(authorizePagesResolveRequest(request, "test-control-token-32-bytes-minimum")).toBe(true);
    expect(authorizePagesResolveRequest(request, "different-control-token-32-bytes-minimum")).toBe(false);
    expect(authorizePagesResolveRequest(request, null)).toBe(false);
  });

  test("database repository falls back to active Pages custom domain bindings", async () => {
    let selectCalls = 0;
    const customSite = customDomainSiteRow("www.customer.example", "customer.example");
    const database = {
      select() {
        selectCalls += 1;
        const callNumber = selectCalls;
        return {
          from() {
            return this;
          },
          innerJoin() {
            return this;
          },
          limit() {
            return Promise.resolve([]);
          },
          where() {
            return callNumber === 1 ? this : Promise.resolve([customSite]);
          },
        };
      },
    } as unknown as Parameters<typeof pagesRouteResolveRepositoryForDb>[0];

    const repository = pagesRouteResolveRepositoryForDb(database);
    const resolvedSite = await repository.findSiteByHost("www.customer.example");

    expect(resolvedSite).toMatchObject({
      activeReleaseId: "rel_custom",
      id: "site_custom",
    });
    expect(selectCalls).toBe(2);
  });

  test("database repository resolves wildcard Pages custom domain bindings", async () => {
    let selectCalls = 0;
    const wildcardSite = customDomainSiteRow("*.customer.example", "customer.example");
    const database = {
      select() {
        selectCalls += 1;
        const callNumber = selectCalls;
        return {
          from() {
            return this;
          },
          innerJoin() {
            return this;
          },
          limit() {
            return Promise.resolve([]);
          },
          where() {
            if (callNumber === 3) return Promise.resolve([wildcardSite]);
            return callNumber === 1 ? this : Promise.resolve([]);
          },
        };
      },
    } as unknown as Parameters<typeof pagesRouteResolveRepositoryForDb>[0];

    const repository = pagesRouteResolveRepositoryForDb(database);
    const resolvedSite = await repository.findSiteByHost("docs.customer.example");

    expect(resolvedSite).toMatchObject({
      customDomain: {
        hostname: "*.customer.example",
        mode: "serve",
      },
      id: "site_custom",
    });
    expect(selectCalls).toBe(3);
  });
});

describe("Ravi Pages for people given access (guests)", () => {
  const SESSION = "sessionabcdefghijklmnopqrstuvwxyz123456";

  function twoPrivatePages() {
    return inMemoryPagesResolveRepository({
      sites: [site({ activeReleaseId: "rel_1", defaultVisibility: "private" })],
      releases: [release({ id: "rel_1" })],
      routes: [
        route({ id: "binding_deck", routeId: "route_deck", path: "/deck", matchType: "exact", visibility: "private" }),
        route({
          id: "binding_plan",
          routeId: "route_plan",
          path: "/plan",
          matchType: "exact",
          visibility: "private",
          artifactId: "art_plan",
          artifactVersionId: "ver_plan",
          assetBase: "/_ravi/assets/art_plan/ver_plan/",
        }),
      ],
      files: [
        file({ path: "index.html" }),
        file({ artifactId: "art_1", artifactVersionId: "ver_1", path: "app.js", mimeType: "text/javascript" }),
        file({ artifactId: "art_plan", artifactVersionId: "ver_plan", path: "index.html" }),
      ],
    });
  }

  test("serves only the page given to them, without the Pages bar or Page Chat", async () => {
    const repository = twoPrivatePages();
    const checked: string[] = [];
    const guestAccessVerifier = async ({ routeId }: { routeId: string }) => {
      checked.push(routeId);
      return routeId === "route_deck";
    };

    const deck = await resolvePagesRoute({
      guestAccessVerifier,
      input: { host: "demo.ravi.page", path: "/deck", pagesSession: SESSION },
      pageChatAvailability: async () => true,
      privateAccessVerifier: async () => false,
      repository,
    });
    expect(deck).toMatchObject({ status: "ok", object: { cache: "private", path: "index.html" } });
    expect("toolbar" in deck ? deck.toolbar : undefined).toBeUndefined();
    expect(JSON.stringify(deck)).not.toContain("pageChat\":true");

    const plan = await resolvePagesRoute({
      guestAccessVerifier,
      input: { host: "demo.ravi.page", path: "/plan", pagesSession: SESSION },
      privateAccessVerifier: async () => false,
      repository,
    });
    expect(plan).toMatchObject({ status: "private" });
    expect(checked).toEqual(["route_deck", "route_plan"]);
  });

  test("serves the assets of the page given to them, and not others", async () => {
    const repository = twoPrivatePages();
    const guestAccessVerifier = async ({ routeId }: { routeId: string }) => routeId === "route_deck";

    const own = await resolvePagesRoute({
      guestAccessVerifier,
      input: { host: "demo.ravi.page", path: "/_ravi/assets/art_1/ver_1/app.js", pagesSession: SESSION },
      privateAccessVerifier: async () => false,
      repository,
    });
    expect(own).toMatchObject({ status: "ok", object: { path: "app.js" } });

    const other = await resolvePagesRoute({
      guestAccessVerifier,
      input: { host: "demo.ravi.page", path: "/_ravi/assets/art_plan/ver_plan/index.html", pagesSession: SESSION },
      privateAccessVerifier: async () => false,
      repository,
    });
    expect(other).toMatchObject({ status: "private" });
  });

  test("never consults grants without a session, for members, or on password pages", async () => {
    let calls = 0;
    const guestAccessVerifier = async () => {
      calls += 1;
      return true;
    };
    const repository = inMemoryPagesResolveRepository({
      sites: [site({ activeReleaseId: "rel_1", defaultVisibility: "private" })],
      releases: [release({ id: "rel_1" })],
      routes: [
        route({ id: "binding_deck", routeId: "route_deck", path: "/deck", matchType: "exact", visibility: "private" }),
        route({ id: "binding_pw", routeId: "route_pw", path: "/pw", matchType: "exact", visibility: "password" }),
      ],
      files: [file({ path: "index.html" })],
    });

    const anonymous = await resolvePagesRoute({
      guestAccessVerifier,
      input: { host: "demo.ravi.page", path: "/deck" },
      repository,
    });
    expect(anonymous).toMatchObject({ status: "private" });

    const member = await resolvePagesRoute({
      guestAccessVerifier,
      input: { host: "demo.ravi.page", path: "/deck", pagesSession: SESSION },
      pageChatAvailability: async () => false,
      privateAccessVerifier: async () => true,
      repository,
    });
    expect(member).toMatchObject({ status: "ok", toolbar: { enabled: true } });

    const password = await resolvePagesRoute({
      guestAccessVerifier,
      input: { host: "demo.ravi.page", path: "/pw", pagesSession: SESSION },
      passwordAccessVerifier: async () => false,
      privateAccessVerifier: async () => false,
      repository,
    });
    expect(password).toMatchObject({ status: "password_required" });
    expect(calls).toBe(0);
  });

  test("lets a guest sign in only on a private page that matches a route of the live release", async () => {
    const repository = twoPrivatePages();
    const authSite = {
      defaultHostname: "demo.ravi.page",
      defaultVisibility: "private" as const,
      id: "site_1",
      organizationId: "org_1",
      projectId: "proj_1",
      status: "active" as const,
    };
    // No grants exist for this fake user, so a matching route still says no;
    // a path with no route never reaches the grant lookup.
    expect(await pagesGuestCanViewPath({ path: "/nothing-here", site: authSite, userId: "user_guest" }, repository)).toBe(
      false,
    );
    expect(
      await pagesGuestCanViewPath({ path: "/deck", site: { ...authSite, id: "site_other" }, userId: "user_guest" }, repository),
    ).toBe(false);
  });
});

describe("Page Chat for guests on marked routes", () => {
  const SESSION = "sessionabcdefghijklmnopqrstuvwxyz123456";

  function guestRepository() {
    return inMemoryPagesResolveRepository({
      sites: [site({ activeReleaseId: "rel_1", defaultVisibility: "private" })],
      releases: [release({ id: "rel_1" })],
      routes: [
        // The release copy never carries the mark, even when someone put one there.
        route({
          id: "binding_trocas",
          routeId: "route_trocas",
          path: "/trocas",
          matchType: "exact",
          visibility: "private",
          routeConfigJson: { knowledge: { v: 1, state: "active", audiences: [{ kind: "page_viewers" }] } },
        }),
        route({
          id: "binding_data",
          routeId: "route_data",
          path: "/data.json",
          matchType: "exact",
          visibility: "private",
          entrypoint: "data.json",
        }),
      ],
      files: [file({ path: "index.html" }), file({ path: "data.json", mimeType: "application/json" })],
    });
  }

  const resolveAs = (
    path: string,
    options: {
      guest?: boolean;
      member?: boolean;
      marked?: (routeId: string) => Promise<boolean>;
      chat?: boolean;
    },
  ) =>
    resolvePagesRoute({
      guestAccessVerifier: async () => options.guest ?? false,
      guestChatMark: options.marked ?? (async (routeId) => routeId === "route_trocas"),
      input: { host: "demo.ravi.page", path, pagesSession: SESSION },
      pageChatAvailability: async () => options.chat ?? true,
      privateAccessVerifier: async () => options.member ?? false,
      repository: guestRepository(),
    });

  test("sets guestChat for a guest on a marked HTML route with chat available, never toolbar", async () => {
    const marks: string[] = [];
    const result = await resolveAs("/trocas", {
      guest: true,
      marked: async (routeId) => {
        marks.push(routeId);
        return routeId === "route_trocas";
      },
    });
    expect(result).toMatchObject({ status: "ok", guestChat: { enabled: true } });
    expect("toolbar" in result ? result.toolbar : undefined).toBeUndefined();
    // The mark is looked up by `page_routes.id` (route id), not the release binding id.
    expect(marks).toEqual(["route_trocas"]);
  });

  test("leaves guestChat out without the mark, chat, HTML or a guest", async () => {
    const unmarked = await resolveAs("/trocas", { guest: true, marked: async () => false });
    expect(unmarked).toMatchObject({ status: "ok" });
    expect("guestChat" in unmarked).toBe(false);

    const chatOff = await resolveAs("/trocas", { guest: true, chat: false });
    expect("guestChat" in chatOff).toBe(false);

    const json = await resolveAs("/data.json", { guest: true, marked: async () => true });
    expect(json).toMatchObject({ status: "ok", object: { path: "data.json" } });
    expect("guestChat" in json).toBe(false);

    const member = await resolveAs("/trocas", { member: true });
    expect(member).toMatchObject({ status: "ok", toolbar: { enabled: true, pageChat: { enabled: true } } });
    expect("guestChat" in member).toBe(false);

    const anonymous = await resolveAs("/trocas", {});
    expect(anonymous).toMatchObject({ status: "private" });
  });

  test("a failing mark lookup never breaks serving the page", async () => {
    const result = await resolveAs("/trocas", {
      guest: true,
      marked: async () => {
        throw new Error("db down");
      },
    });
    expect(result).toMatchObject({ status: "ok" });
    expect("guestChat" in result).toBe(false);
  });
});

type InMemoryOptions = {
  sites?: Array<PagesResolveSite & { host: string }>;
  releases?: PagesResolveRelease[];
  routes?: Array<PagesResolveRoute & { releaseId: string }>;
  files?: Array<PagesResolveFile & { artifactId: string; artifactVersionId: string }>;
};

function inMemoryPagesResolveRepository(options: InMemoryOptions = {}): PagesRouteResolveRepository {
  const sites = options.sites ?? [];
  const releases = options.releases ?? [];
  const routes = options.routes ?? [];
  const files = options.files ?? [];

  return {
    async findSiteByHost(host) {
      return sites.find((candidate) => candidate.host === host) ?? null;
    },

    async getActiveRelease(site) {
      return releases.find((candidate) => candidate.id === site.activeReleaseId && candidate.status === "active") ?? null;
    },

    async listReleaseRoutes(releaseId) {
      return routes.filter((candidate) => candidate.releaseId === releaseId);
    },

    async getArtifactVersionFile(input) {
      return (
        files.find(
          (candidate) =>
            candidate.artifactId === input.artifactId &&
            candidate.artifactVersionId === input.artifactVersionId &&
            candidate.path === input.path,
        ) ?? null
      );
    },
  };
}

function site(input: Partial<PagesResolveSite> & { host?: string } = {}): PagesResolveSite & { host: string } {
  return {
    id: input.id ?? "site_1",
    organizationId: input.organizationId ?? "org_1",
    projectId: input.projectId ?? "proj_1",
    defaultHostname: input.defaultHostname ?? input.host ?? "demo.ravi.page",
    defaultVisibility: input.defaultVisibility ?? "public",
    activeReleaseId: input.activeReleaseId === undefined ? "rel_1" : input.activeReleaseId,
    customDomain: input.customDomain,
    status: input.status ?? "active",
    host: input.host ?? "demo.ravi.page",
  };
}

function customDomainSiteRow(bindingHostname: string, claimDomain: string) {
  return {
    activeReleaseId: "rel_custom",
    bindingHostname,
    claimDomain,
    defaultHostname: "demo.ravi.page",
    defaultVisibility: "public" as const,
    id: "site_custom",
    organizationId: "org_1",
    policyJson: { mode: "serve", siteId: "site_custom" },
    projectId: "proj_1",
    status: "active" as const,
  };
}

function release(input: Partial<PagesResolveRelease> = {}): PagesResolveRelease {
  return {
    id: input.id ?? "rel_1",
    releaseNumber: input.releaseNumber ?? 1,
    status: input.status ?? "active",
  };
}

function route(input: Partial<PagesResolveRoute> & { releaseId?: string } = {}): PagesResolveRoute & { releaseId: string } {
  return {
    id: input.id ?? "binding_1",
    routeId: input.routeId ?? "route_1",
    path: input.path ?? "/",
    matchType: input.matchType ?? "prefix",
    priority: input.priority ?? 0,
    artifactId: input.artifactId ?? "art_1",
    artifactVersionId: input.artifactVersionId ?? "ver_1",
    entrypoint: input.entrypoint ?? "index.html",
    assetBase: input.assetBase ?? "/_ravi/assets/art_1/ver_1/",
    visibility: input.visibility ?? "public",
    routeConfigJson: input.routeConfigJson ?? {},
    releaseId: input.releaseId ?? "rel_1",
  };
}

function file(
  input: Partial<PagesResolveFile> & { artifactId?: string; artifactVersionId?: string } = {},
): PagesResolveFile & { artifactId: string; artifactVersionId: string } {
  const artifactId = input.artifactId ?? "art_1";
  const artifactVersionId = input.artifactVersionId ?? "ver_1";
  const path = input.path ?? "index.html";

  return {
    artifactStatus: input.artifactStatus ?? "active",
    versionStatus: input.versionStatus ?? "ready",
    versionNumber: input.versionNumber ?? 1,
    versionSha256: input.versionSha256 ?? "version-sha",
    assetId: input.assetId ?? "asset_1",
    path,
    mimeType: input.mimeType ?? "text/html; charset=utf-8",
    sizeBytes: input.sizeBytes ?? 123,
    sha256: input.sha256 ?? "asset-sha",
    storageJson:
      input.storageJson ?? { r2Key: `org/org_1/project/proj_1/artifact/${artifactId}/version/${artifactVersionId}/${path}` },
    artifactId,
    artifactVersionId,
  };
}
