import { afterEach, describe, expect, mock, test } from "bun:test";

import worker, { __resetPagesWorkerEdgeManifestCacheForTests, type PagesWorkerEnv } from "./index";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  __resetPagesWorkerEdgeManifestCacheForTests();
});

describe("ravi pages worker", () => {
  test("redirects HTTP requests to HTTPS before route resolution", async () => {
    const resolveFetch = mock(async () => Response.json({ status: "error" }, { status: 500 }));
    globalThis.fetch = resolveFetch as unknown as typeof fetch;
    const assetReads: string[] = [];

    const response = await worker.fetch(
      new Request("http://demo.ravi.page/docs?utm_source=mail"),
      env({ onGet: (key) => assetReads.push(key) }),
    );

    expect(response.status).toBe(308);
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(response.headers.get("location")).toBe("https://demo.ravi.page/docs?utm_source=mail");
    expect(resolveFetch).not.toHaveBeenCalled();
    expect(assetReads).toEqual([]);
  });

  test("redirects requests marked HTTP by Cloudflare headers", async () => {
    const resolveFetch = mock(async () => Response.json({ status: "error" }, { status: 500 }));
    globalThis.fetch = resolveFetch as unknown as typeof fetch;

    const response = await worker.fetch(
      request("/stage?x=1", {
        headers: {
          "cf-visitor": JSON.stringify({ scheme: "http" }),
          "x-forwarded-proto": "http",
        },
      }),
      env(),
    );

    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("https://demo.ravi.page/stage?x=1");
    expect(resolveFetch).not.toHaveBeenCalled();
  });

  test("serves health from the reserved namespace", async () => {
    const response = await worker.fetch(request("/_ravi/health"), env());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      service: "ravi-pages",
      host: "demo.ravi.page",
    });
  });

  test("forwards connector catalog through the Console control plane off the edge-manifest path", async () => {
    const pagesSession = "sessionabcdefghijklmnopqrstuvwxyz123456";
    const catalogFetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.toString()).toBe("https://console.ravi.bot/api/internal/pages/connectors/catalog");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer control_token");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        host: "demo.ravi.page",
        ids: "ravi.pages.sites.list",
        pagesSession,
      });
      return Response.json({
        schemaVersion: 1,
        siteId: "site_1",
        projectId: "proj_1",
        actions: [{ id: "ravi.pages.sites.list", executable: true }],
      });
    });
    globalThis.fetch = catalogFetch as unknown as typeof fetch;

    const response = await worker.fetch(
      request("/_ravi/connectors/catalog?ids=ravi.pages.sites.list", {
        headers: {
          cookie: `__Host-ravi_page_session=${pagesSession}`,
          origin: "https://demo.ravi.page",
        },
      }),
      env({ controlToken: "control_token" }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({
      schemaVersion: 1,
      actions: [{ id: "ravi.pages.sites.list" }],
    });
    expect(catalogFetch).toHaveBeenCalledTimes(1);
  });

  test("forwards connector exec with the viewer Pages session", async () => {
    const pagesSession = "sessionabcdefghijklmnopqrstuvwxyz123456";
    const execFetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://console.ravi.bot/api/internal/pages/connectors/exec");
      expect(JSON.parse(String(init?.body))).toEqual({
        host: "demo.ravi.page",
        id: "ravi.pages.sites.list",
        input: {},
        origin: "https://demo.ravi.page",
        pagesSession,
      });
      return Response.json({
        ok: true,
        id: "ravi.pages.sites.list",
        revision: 1,
        output: { items: [] },
      });
    });
    globalThis.fetch = execFetch as unknown as typeof fetch;

    const response = await worker.fetch(
      request("/_ravi/connectors/exec", {
        method: "POST",
        headers: {
          cookie: `__Host-ravi_page_session=${pagesSession}`,
          "content-type": "application/json",
          origin: "https://demo.ravi.page",
        },
        body: JSON.stringify({ id: "ravi.pages.sites.list", input: {} }),
      }),
      env({ controlToken: "control_token" }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ ok: true, id: "ravi.pages.sites.list" });
    expect(execFetch).toHaveBeenCalledTimes(1);
  });

  test("rejects connector exec without a Pages session", async () => {
    const execFetch = mock(async () => Response.json({ ok: true }));
    globalThis.fetch = execFetch as unknown as typeof fetch;

    const response = await worker.fetch(
      request("/_ravi/connectors/exec", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://demo.ravi.page",
        },
        body: JSON.stringify({ id: "ravi.pages.sites.list", input: {} }),
      }),
      env({ controlToken: "control_token" }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ error: "connector_session_required" });
    expect(execFetch).not.toHaveBeenCalled();
  });

  test("rejects connector exec on Origin mismatch", async () => {
    const execFetch = mock(async () => Response.json({ ok: true }));
    globalThis.fetch = execFetch as unknown as typeof fetch;

    const response = await worker.fetch(
      request("/_ravi/connectors/exec", {
        method: "POST",
        headers: {
          cookie: "__Host-ravi_page_session=sessionabcdefghijklmnopqrstuvwxyz123456",
          "content-type": "application/json",
          origin: "https://evil.example",
        },
        body: JSON.stringify({ id: "ravi.pages.sites.list", input: {} }),
      }),
      env({ controlToken: "control_token" }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "connector_unauthorized" });
    expect(execFetch).not.toHaveBeenCalled();
  });

  test("captures a Pages thumbnail through Browser Run and writes the immutable image to R2", async () => {
    const browser = {
      quickAction: mock(async (action: "screenshot", input: Record<string, unknown>) => {
        expect(action).toBe("screenshot");
        expect(input).toMatchObject({
          url: "https://demo.ravi.page/docs",
          setExtraHTTPHeaders: { "x-ravi-pages-capture": "thumbnail" },
          screenshotOptions: { type: "jpeg", quality: 82, fullPage: false },
          viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
        });
        return new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      }),
    };
    const writes: Array<{ key: string; size: number }> = [];
    const response = await worker.fetch(
      request("/_ravi/internal/captures", {
        method: "POST",
        headers: {
          authorization: "Bearer control-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          organizationId: "00000000-0000-4000-8000-000000000001",
          projectId: "00000000-0000-4000-8000-000000000002",
          captureSetId: "00000000-0000-4000-8000-000000000003",
          captureArtifactId: "00000000-0000-4000-8000-000000000004",
          captureArtifactVersionId: "00000000-0000-4000-8000-000000000005",
          path: "/docs",
          pagesSession: "sessionabcdefghijklmnopqrstuvwxyz123456",
          mode: "thumbnail",
          config: {
            viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
            format: "jpeg",
            quality: 82,
            timeoutMs: 30000,
          },
        }),
      }),
      env({
        browser,
        controlToken: "control-secret",
        onPut: (key, value) => writes.push({ key, size: value.byteLength }),
      }),
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      filename: "thumbnail.jpg",
      role: "thumbnail",
      mimeType: "image/jpeg",
      width: 1440,
      height: 900,
      sizeBytes: 4,
      storageKey:
        "org/00000000-0000-4000-8000-000000000001/project/00000000-0000-4000-8000-000000000002/artifact/00000000-0000-4000-8000-000000000004/version/00000000-0000-4000-8000-000000000005/thumbnail.jpg",
    });
    expect(browser.quickAction).toHaveBeenCalledTimes(1);
    expect(writes).toEqual([
      {
        key:
          "org/00000000-0000-4000-8000-000000000001/project/00000000-0000-4000-8000-000000000002/artifact/00000000-0000-4000-8000-000000000004/version/00000000-0000-4000-8000-000000000005/thumbnail.jpg",
        size: 4,
      },
    ]);
  });

  test("rejects internal capture requests without the shared control token", async () => {
    const response = await worker.fetch(
      request("/_ravi/internal/captures", { method: "POST", body: "{}" }),
      env({ controlToken: "control-secret" }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "capture_unauthorized" });
  });

  test("serves generated capture bytes only through the control-token image endpoint", async () => {
    const key =
      "org/00000000-0000-4000-8000-000000000001/project/00000000-0000-4000-8000-000000000002/artifact/00000000-0000-4000-8000-000000000004/version/00000000-0000-4000-8000-000000000005/thumbnail.jpg";
    const response = await worker.fetch(
      request(
        "/_ravi/internal/captures/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002/00000000-0000-4000-8000-000000000004/00000000-0000-4000-8000-000000000005/thumbnail.jpg",
        { headers: { authorization: "Bearer control-secret" } },
      ),
      env({ controlToken: "control-secret", assets: { [key]: r2Object("jpeg-bytes", { contentType: "image/jpeg" }) } }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(await response.text()).toBe("jpeg-bytes");
  });

  test("serves the standard Ravi Pages product page from the apex host", async () => {
    const resolveFetch = mock(async () => Response.json({ status: "error" }, { status: 500 }));
    globalThis.fetch = resolveFetch as unknown as typeof fetch;

    const response = await worker.fetch(request("/", undefined, "ravi.page"), env());
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(text).toContain("Publish a page from any Ravi project.");
    expect(text).toContain("ravi pages publish core ./site --route / --visibility public --entrypoint index.html");
    expect(resolveFetch).not.toHaveBeenCalled();
  });

  test("resolves a public artifact and serves the R2 object with immutable cache", async () => {
    const resolveFetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      const headers = new Headers(init?.headers);
      expect(headers.get("x-ravi-pages-edge-resolve")).toBe("fallback");
      expect(headers.get("x-ravi-pages-edge-miss-reason")).toBe("manifest_missing");
      expect(JSON.parse(String(init?.body))).toEqual({
        host: "demo.ravi.page",
        path: "/assets/app.js",
        method: "GET",
      });

      return Response.json({
        status: "ok",
        site: {
          organizationId: "org_1",
          projectId: "proj_1",
        },
        artifact: {
          id: "art_1",
          versionId: "ver_1",
        },
        object: {
          r2Key: "org/org_1/project/proj_1/artifact/art_1/version/ver_1/assets/app.js",
          contentType: "application/javascript",
          cache: "immutable",
        },
      });
    });
    globalThis.fetch = resolveFetch as unknown as typeof fetch;

    const response = await worker.fetch(
      request("/assets/app.js"),
      env({
        assets: {
          "org/org_1/project/proj_1/artifact/art_1/version/ver_1/assets/app.js": r2Object("console.log('ok');"),
        },
      }),
    );

    const body = JSON.parse(String(resolveFetch.mock.calls[0]?.[1]?.body));
    expect(body.pagesSession).toBeUndefined();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/javascript");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("content-security-policy")).toBeNull();
    expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(response.headers.get("x-frame-options")).toBeNull();
    expect(await response.text()).toBe("console.log('ok');");
    expect(resolveFetch).toHaveBeenCalledTimes(1);
  });

  test("passes customer custom hostnames through the control-plane resolver", async () => {
    const assetReads: string[] = [];
    const resolveFetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("x-ravi-pages-edge-resolve")).toBe("fallback");
      expect(headers.get("x-ravi-pages-edge-miss-reason")).toBe("manifest_missing");
      expect(JSON.parse(String(init?.body))).toEqual({
        host: "www.filipe.ai",
        path: "/",
        method: "GET",
      });

      return Response.json({ status: "not_found" });
    });
    globalThis.fetch = resolveFetch as unknown as typeof fetch;

    const response = await worker.fetch(
      request("/", undefined, "www.filipe.ai"),
      env({ onGet: (key) => assetReads.push(key) }),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await response.text()).toContain("Page not found");
    expect(resolveFetch).toHaveBeenCalledTimes(1);
    expect(assetReads).toEqual(["sites/www.filipe.ai/active.json"]);
  });

  test("serves public routes from the edge manifest without calling the control plane", async () => {
    const resolveFetch = mock(async () => Response.json({ status: "error" }, { status: 500 }));
    globalThis.fetch = resolveFetch as unknown as typeof fetch;

    const response = await worker.fetch(
      request("/assets/app.js"),
      env({
        assets: {
          "sites/demo.ravi.page/active.json": r2Object(JSON.stringify(edgeManifest())),
          "org/org_1/project/proj_1/artifact/art_1/version/ver_1/assets/app.js": r2Object("console.log('edge');"),
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/javascript");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await response.text()).toBe("console.log('edge');");
    expect(resolveFetch).not.toHaveBeenCalled();
  });

  test("starts operator toolbar auth bootstrap on public pages when requested without a Pages session", async () => {
    const resolveFetch = mock(async () => Response.json({ status: "error" }, { status: 500 }));
    globalThis.fetch = resolveFetch as unknown as typeof fetch;
    const assetReads: string[] = [];

    const response = await worker.fetch(request("/docs?ravi_toolbar=1&utm=campaign"), env({ onGet: (key) => assetReads.push(key) }));

    expect(response.status).toBe(302);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin).toBe("https://console.ravi.bot");
    expect(location.pathname).toBe("/api/pages/auth/start");
    const returnTo = new URL(location.searchParams.get("returnTo") ?? "");
    expect(returnTo.toString()).toBe("https://demo.ravi.page/docs?utm=campaign");
    expect(resolveFetch).not.toHaveBeenCalled();
    expect(assetReads).toEqual([]);
  });

  test("auto-starts optional operator auth for browser public HTML navigations", async () => {
    const resolveFetch = mock(async () => Response.json({ status: "error" }, { status: 500 }));
    globalThis.fetch = resolveFetch as unknown as typeof fetch;
    const assetReads: string[] = [];

    const response = await worker.fetch(
      request("/?utm=campaign", {
        headers: {
          accept: "text/html,application/xhtml+xml",
          "sec-fetch-dest": "document",
          "sec-fetch-mode": "navigate",
        },
      }),
      env({
        assets: {
          "sites/demo.ravi.page/active.json": r2Object(JSON.stringify(edgeManifest())),
        },
        onGet: (key) => assetReads.push(key),
      }),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin).toBe("https://console.ravi.bot");
    expect(location.pathname).toBe("/api/pages/auth/optional");
    const returnTo = new URL(location.searchParams.get("returnTo") ?? "");
    expect(returnTo.toString()).toBe("https://demo.ravi.page/?utm=campaign");
    expect(resolveFetch).not.toHaveBeenCalled();
    expect(assetReads).toEqual(["sites/demo.ravi.page/active.json"]);
  });

  test("marks optional operator auth as checked before serving public pages without overlay", async () => {
    const resolveFetch = mock(async () => Response.json({ status: "error" }, { status: 500 }));
    globalThis.fetch = resolveFetch as unknown as typeof fetch;

    const checked = await worker.fetch(request("/?utm=campaign&_ravi_operator_checked=1"), env());

    expect(checked.status).toBe(302);
    expect(checked.headers.get("location")).toBe("https://demo.ravi.page/?utm=campaign");
    expect(checked.headers.get("set-cookie")).toContain("__Host-ravi_page_operator_checked=v2");
    expect(checked.headers.get("set-cookie")).toContain("Max-Age=300");

    const publicResponse = await worker.fetch(
      request("/?utm=campaign", {
        headers: {
          accept: "text/html,application/xhtml+xml",
          cookie: "__Host-ravi_page_operator_checked=v2",
          "sec-fetch-dest": "document",
          "sec-fetch-mode": "navigate",
        },
      }),
      env({
        assets: {
          "sites/demo.ravi.page/active.json": r2Object(JSON.stringify(edgeManifest())),
          "org/org_1/project/proj_1/artifact/art_1/version/ver_1/index.html": r2Object("<!doctype html><body>Public</body>"),
        },
      }),
    );

    expect(publicResponse.status).toBe(200);
    expect(publicResponse.headers.get("x-ravi-pages-toolbar")).toBeNull();
    expect(await publicResponse.text()).toBe("<!doctype html><body>Public</body>");
    expect(resolveFetch).not.toHaveBeenCalled();
  });

  test("ignores legacy optional operator checked cookies so operators can retry bootstrap", async () => {
    const resolveFetch = mock(async () => Response.json({ status: "error" }, { status: 500 }));
    globalThis.fetch = resolveFetch as unknown as typeof fetch;

    const response = await worker.fetch(
      request("/?utm=campaign", {
        headers: {
          accept: "text/html,application/xhtml+xml",
          cookie: "__Host-ravi_page_operator_checked=1",
          "sec-fetch-dest": "document",
          "sec-fetch-mode": "navigate",
        },
      }),
      env({
        assets: {
          "sites/demo.ravi.page/active.json": r2Object(JSON.stringify(edgeManifest())),
        },
      }),
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin).toBe("https://console.ravi.bot");
    expect(location.pathname).toBe("/api/pages/auth/optional");
    const returnTo = new URL(location.searchParams.get("returnTo") ?? "");
    expect(returnTo.toString()).toBe("https://demo.ravi.page/?utm=campaign");
    expect(resolveFetch).not.toHaveBeenCalled();
  });

  test("strips operator toolbar bootstrap query once a Pages session exists", async () => {
    const resolveFetch = mock(async () => Response.json({ status: "error" }, { status: 500 }));
    globalThis.fetch = resolveFetch as unknown as typeof fetch;
    const pagesSession = "sessionabcdefghijklmnopqrstuvwxyz123456";

    const response = await worker.fetch(
      request("/docs?utm=campaign&_ravi_toolbar=1", {
        headers: { cookie: `__Host-ravi_page_session=${pagesSession}` },
      }),
      env(),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://demo.ravi.page/docs?utm=campaign");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(resolveFetch).not.toHaveBeenCalled();
  });

  test("injects the operator toolbar for authorized Pages sessions on public HTML routes", async () => {
    const pagesSession = "sessionabcdefghijklmnopqrstuvwxyz123456";
    const resolveFetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("x-ravi-pages-edge-resolve")).toBe("fallback");
      expect(headers.get("x-ravi-pages-edge-miss-reason")).toBe("toolbar_session");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        host: "demo.ravi.page",
        path: "/",
        method: "GET",
        pagesSession,
      });

      return Response.json({
        status: "ok",
        site: {
          id: "site_1",
          organizationId: "org_1",
          projectId: "proj_1",
          visibility: "public",
        },
        release: {
          id: "release_1",
          number: 5,
        },
        route: {
          id: "route_1",
          bindingId: "binding_1",
          path: "/",
          matchType: "spa",
          visibility: "public",
        },
        artifact: {
          id: "art_1",
          versionId: "ver_1",
          versionNumber: 2,
        },
        object: {
          r2Key: "org/org_1/project/proj_1/artifact/art_1/version/ver_1/index.html",
          path: "index.html",
          contentType: "text/html; charset=utf-8",
          cache: "entrypoint",
          sizeBytes: 41,
        },
        toolbar: {
          enabled: true,
          host: "demo.ravi.page",
          path: "/",
          effectiveVisibility: "public",
          siteId: "site_1",
          projectId: "proj_1",
          routeId: "route_1",
          releaseId: "release_1",
          releaseNumber: 5,
          artifactId: "art_1",
          artifactVersionId: "ver_1",
          artifactVersionNumber: 2,
        },
      });
    });
    globalThis.fetch = resolveFetch as unknown as typeof fetch;

    const response = await worker.fetch(
      request("/", { headers: { cookie: `__Host-ravi_page_session=${pagesSession}` } }),
      env({
        assets: {
          "sites/demo.ravi.page/active.json": r2Object(JSON.stringify(edgeManifest())),
          "org/org_1/project/proj_1/artifact/art_1/version/ver_1/index.html": r2Object("<!doctype html><body><main>Page</main></body>"),
        },
      }),
    );

    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("vary")).toContain("Cookie");
    expect(response.headers.get("x-ravi-pages-toolbar")).toBe("1");
    expect(response.headers.get("content-length")).toBeNull();
    expect(html).toContain("ravi-pages-toolbar");
    expect(html).toContain("Ravi Page");
    expect(html).toContain("Visibilidade da p&aacute;gina");
    expect(html).toContain("Comentar item");
    expect(html).toContain("ravi-pages-comment-pin");
    expect(html).toContain("ravi-pages-comment-composer");
    expect(html).toContain("Apagar coment\\u00e1rio");
    expect(html).not.toContain("window.confirm");
    expect(html).not.toContain("<span>Route</span>");
    expect(html).not.toContain("Route visibility");
    expect(html).toContain("/_ravi/operator/comments");
    expect(html).toContain("/_ravi/operator/visibility");
    expect(html).toContain("/_ravi/operator/releases");
    expect(html).toContain('data-k="releases"');
    expect(html).toContain("Hist&oacute;rico de releases");
    expect(html).toContain("https://console.ravi.bot/p/proj_1/pages/site_1");

    const toolbarScript = html.match(/<script data-ravi-pages-toolbar="1">([\s\S]*?)<\/script>/)?.[1] ?? "";
    expect(toolbarScript.length).toBeGreaterThan(0);
    expect(/^[\x00-\x7f]*$/.test(toolbarScript)).toBe(true);
    expect(toolbarScript).not.toContain("`");
    expect(toolbarScript).not.toContain("${");
    expect(toolbarScript).toContain('raviOperatorUi = "offset"');
    expect(toolbarScript).toContain("margin-top:");
    expect(toolbarScript).toContain('data-k="collapse"');
    expect(toolbarScript).toContain('data-k="expand"');
    expect(toolbarScript).toContain('data-k="menu"');
    expect(toolbarScript).toContain('data-k="select"');
    expect(toolbarScript).not.toContain("window.confirm");
    expect(toolbarScript).not.toContain("Route visibility");
    expect(toolbarScript).not.toContain("<span>Route</span>");
    expect(resolveFetch).toHaveBeenCalledTimes(1);
  });

  test("injects only the guest talk button when resolve sets guestChat, and lets the page be framed by its origin", async () => {
    const pagesSession = "sessionabcdefghijklmnopqrstuvwxyz123456";
    const resolved = (guestChat: boolean) => ({
      status: "ok",
      site: { id: "site_1", organizationId: "org_1", projectId: "proj_1", visibility: "private" },
      release: { id: "release_1", number: 5 },
      route: { id: "route_1", bindingId: "binding_1", path: "/", matchType: "spa", visibility: "private" },
      artifact: { id: "art_1", versionId: "ver_1", versionNumber: 2 },
      object: {
        r2Key: "org/org_1/project/proj_1/artifact/art_1/version/ver_1/index.html",
        path: "index.html",
        contentType: "text/html; charset=utf-8",
        cache: "private",
        sizeBytes: 60,
      },
      ...(guestChat ? { guestChat: { enabled: true } } : {}),
    });
    const serve = async (guestChat: boolean) => {
      globalThis.fetch = (async () => Response.json(resolved(guestChat))) as unknown as typeof fetch;
      return worker.fetch(
        request("/", { headers: { cookie: `__Host-ravi_page_session=${pagesSession}` } }),
        env({
          assets: {
            "sites/demo.ravi.page/active.json": r2Object(
              JSON.stringify(edgeManifest({ siteVisibility: "private", routeVisibility: "private" })),
            ),
            "org/org_1/project/proj_1/artifact/art_1/version/ver_1/index.html": r2Object(
              "<!doctype html><head></head><body><main>Trocas</main></body>",
            ),
          },
        }),
      );
    };

    const response = await serve(true);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("x-ravi-pages-guest-chat")).toBe("1");
    expect(response.headers.get("x-ravi-pages-toolbar")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("vary")).toContain("Cookie");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
    expect(response.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(html).not.toContain("ravi-pages-toolbar");
    const script = html.match(/<script data-ravi-page-guest-chat="1">([\s\S]*?)<\/script>/)?.[1] ?? "";
    expect(script).toContain("Falar com o assistente");
    expect(script).toContain("aria-label");
    expect(script).toContain("/_ravi/page-chat?path=");
    expect(script).toContain("focus-visible");
    expect(script).toContain("prefers-reduced-motion:no-preference");
    expect(/^[\x00-\x7f]*$/.test(script)).toBe(true);
    expect(script).not.toContain("<");
    expect(() => new Function(script)).not.toThrow();
    expect(html.indexOf("data-ravi-page-guest-chat")).toBeLessThan(html.indexOf("</body>"));

    const plain = await serve(false);
    const plainHtml = await plain.text();
    expect(plainHtml).not.toContain("data-ravi-page-guest-chat");
    expect(plain.headers.get("x-ravi-pages-guest-chat")).toBeNull();
    expect(plain.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  test("keeps the operator toolbar script ASCII-only when toolbar data has non-ASCII text", async () => {
    const pagesSession = "sessionabcdefghijklmnopqrstuvwxyz123456";
    globalThis.fetch = (async () =>
      Response.json({
        status: "ok",
        site: { id: "site_1", organizationId: "org_1", projectId: "proj_1", visibility: "public" },
        release: { id: "release_1", number: 5 },
        route: { id: "route_1", bindingId: "binding_1", path: "/", matchType: "spa", visibility: "public" },
        artifact: { id: "art_1", versionId: "ver_1", versionNumber: 2 },
        object: {
          r2Key: "org/org_1/project/proj_1/artifact/art_1/version/ver_1/index.html",
          path: "index.html",
          contentType: "text/html; charset=utf-8",
          cache: "entrypoint",
          sizeBytes: 41,
        },
        toolbar: {
          enabled: true,
          host: "relat\u00f3rio.ravi.page</script><b>x\u{1F600}",
          path: "/relat\u00f3rio\u2028",
          effectiveVisibility: "public",
          siteId: "site_1",
          projectId: "proj_1",
          routeId: "route_1",
          releaseId: "release_1",
          releaseNumber: 5,
          artifactId: "art_1",
          artifactVersionId: "ver_1",
          artifactVersionNumber: 2,
        },
      })) as unknown as typeof fetch;

    const response = await worker.fetch(
      request("/", { headers: { cookie: `__Host-ravi_page_session=${pagesSession}` } }),
      env({
        assets: {
          "sites/demo.ravi.page/active.json": r2Object(JSON.stringify(edgeManifest())),
          "org/org_1/project/proj_1/artifact/art_1/version/ver_1/index.html": r2Object("<!doctype html><body><main>Page</main></body>"),
        },
      }),
    );

    const html = await response.text();
    expect(response.headers.get("x-ravi-pages-toolbar")).toBe("1");
    const toolbarScript = html.match(/<script data-ravi-pages-toolbar="1">([\s\S]*?)<\/script>/)?.[1] ?? "";
    expect(toolbarScript).toContain("})();");
    expect(/^[\x00-\x7f]*$/.test(toolbarScript)).toBe(true);
    expect(toolbarScript).toContain("relat\\u00f3rio.ravi.page\\u003c/script>\\u003cb>x\\ud83d\\ude00");
    expect(toolbarScript).toContain("/relat\\u00f3rio\\u2028");
    // Runbooks depend on the visibility option values and the PT-BR labels.
    expect(toolbarScript).toContain('["public", "password", "protected_link", "private"]');
    expect(toolbarScript).toContain('password: "Com senha"');
    expect(toolbarScript).toContain('protected_link: "Protegida"');
    // RTL Pages must not mirror the bar (all:initial does not reset direction).
    expect(toolbarScript).toContain(":host{all:initial;direction:ltr;");
    // The capture above stops at the first "</script>": the injected script must end with its own
    // closing tag, so exactly one "</script>" follows the marker.
    const afterMarker = html.slice(html.indexOf("data-ravi-pages-toolbar"));
    expect(afterMarker.split("</script>").length - 1).toBe(1);
    expect(toolbarScript.trimEnd().endsWith("})();")).toBe(true);
  });

  test("clears stale Pages sessions and restarts optional auth when public HTML resolves without toolbar", async () => {
    const pagesSession = "sessionabcdefghijklmnopqrstuvwxyz123456";
    const assetReads: string[] = [];
    const resolveFetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.toString()).toBe("https://console.ravi.bot/api/internal/pages/resolve");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        host: "demo.ravi.page",
        method: "GET",
        pagesSession,
        path: "/",
      });

      return Response.json({
        status: "ok",
        site: {
          id: "site_1",
          organizationId: "org_1",
          projectId: "proj_1",
          visibility: "public",
        },
        release: {
          id: "release_1",
          number: 5,
        },
        route: {
          id: "route_1",
          path: "/",
          visibility: "public",
        },
        object: {
          r2Key: "org/org_1/project/proj_1/artifact/art_1/version/ver_1/index.html",
          path: "index.html",
          contentType: "text/html; charset=utf-8",
          cache: "entrypoint",
        },
      });
    });
    globalThis.fetch = resolveFetch as unknown as typeof fetch;

    const response = await worker.fetch(
      request("/", {
        headers: {
          accept: "text/html,application/xhtml+xml",
          cookie: `__Host-ravi_page_session=${pagesSession}`,
          "sec-fetch-dest": "document",
          "sec-fetch-mode": "navigate",
        },
      }),
      env({
        assets: {
          "sites/demo.ravi.page/active.json": r2Object(JSON.stringify(edgeManifest())),
          "org/org_1/project/proj_1/artifact/art_1/version/ver_1/index.html": r2Object("<!doctype html><body>Public</body>"),
        },
        onGet: (key) => assetReads.push(key),
      }),
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin).toBe("https://console.ravi.bot");
    expect(location.pathname).toBe("/api/pages/auth/optional");
    expect(response.headers.get("set-cookie")).toContain("__Host-ravi_page_session=;");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(resolveFetch).toHaveBeenCalledTimes(1);
    expect(assetReads).toEqual(["sites/demo.ravi.page/active.json"]);
  });

  test("requires a Pages session before forwarding operator visibility changes", async () => {
    const operatorFetch = mock(async () => Response.json({ status: "ok" }));
    globalThis.fetch = operatorFetch as unknown as typeof fetch;

    const response = await worker.fetch(
      request("/_ravi/operator/visibility", {
        method: "POST",
        body: JSON.stringify({ path: "/", visibility: "private" }),
      }),
      env({ controlToken: "control_token" }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ status: "error", error: "pages_session_required" });
    expect(operatorFetch).not.toHaveBeenCalled();
  });

  test("forwards operator visibility changes through the Console control plane", async () => {
    const pagesSession = "sessionabcdefghijklmnopqrstuvwxyz123456";
    const operatorFetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      expect(url.toString()).toBe("https://console.ravi.bot/api/internal/pages/operator/visibility");
      expect(init?.method).toBe("POST");
      expect(headers.get("authorization")).toBe("Bearer control_token");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        host: "demo.ravi.page",
        pagesSession,
        path: "/",
        visibility: "private",
      });
      return Response.json({
        status: "ok",
        changed: true,
        route: { visibility: "private", effectiveVisibility: "private" },
        release: { id: "release_2", number: 6 },
      });
    });
    globalThis.fetch = operatorFetch as unknown as typeof fetch;

    const response = await worker.fetch(
      request("/_ravi/operator/visibility", {
        method: "POST",
        headers: {
          cookie: `__Host-ravi_page_session=${pagesSession}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ path: "/", visibility: "private" }),
      }),
      env({ controlToken: "control_token" }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      status: "ok",
      changed: true,
      route: { visibility: "private" },
    });
    expect(operatorFetch).toHaveBeenCalledTimes(1);
  });

  test("requires a Pages session before forwarding operator password changes", async () => {
    const operatorFetch = mock(async () => Response.json({ status: "ok" }));
    globalThis.fetch = operatorFetch as unknown as typeof fetch;

    const response = await worker.fetch(
      request("/_ravi/operator/password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "set", path: "/", password: "private report" }),
      }),
      env({ controlToken: "control_token" }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ status: "error", error: "pages_session_required" });
    expect(operatorFetch).not.toHaveBeenCalled();
  });

  test("forwards an inline password update through the authenticated Console boundary", async () => {
    const pagesSession = "sessionabcdefghijklmnopqrstuvwxyz123456";
    const operatorFetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      expect(url.toString()).toBe("https://console.ravi.bot/api/internal/pages/operator/password");
      expect(init?.method).toBe("POST");
      expect(headers.get("authorization")).toBe("Bearer control_token");
      expect(JSON.parse(String(init?.body))).toEqual({
        action: "set",
        host: "demo.ravi.page",
        pagesSession,
        password: "private report",
        path: "/report",
        scope: "route",
      });
      return Response.json({
        status: "ok",
        policy: { configured: true, scope: "route", version: 2 },
      });
    });
    globalThis.fetch = operatorFetch as unknown as typeof fetch;

    const response = await worker.fetch(
      request("/_ravi/operator/password", {
        method: "POST",
        headers: {
          cookie: `__Host-ravi_page_session=${pagesSession}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          action: "set",
          password: "private report",
          path: "/report",
          scope: "route",
        }),
      }),
      env({ controlToken: "control_token" }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      status: "ok",
      policy: { configured: true, version: 2 },
    });
    expect(operatorFetch).toHaveBeenCalledTimes(1);
  });

  test("requires a Pages session before forwarding operator comments", async () => {
    const operatorFetch = mock(async () => Response.json({ status: "ok" }));
    globalThis.fetch = operatorFetch as unknown as typeof fetch;

    const response = await worker.fetch(
      request("/_ravi/operator/comments?path=/", {
        method: "GET",
      }),
      env({ controlToken: "control_token" }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ status: "error", error: "pages_session_required" });
    expect(operatorFetch).not.toHaveBeenCalled();
  });

  test("forwards operator comment reads through the Console control plane", async () => {
    const pagesSession = "sessionabcdefghijklmnopqrstuvwxyz123456";
    const operatorFetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      expect(url.toString()).toBe("https://console.ravi.bot/api/internal/pages/operator/comments");
      expect(init?.method).toBe("POST");
      expect(headers.get("authorization")).toBe("Bearer control_token");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        action: "list",
        host: "demo.ravi.page",
        pagesSession,
        path: "/docs",
      });
      return Response.json({ status: "ok", comments: [] });
    });
    globalThis.fetch = operatorFetch as unknown as typeof fetch;

    const response = await worker.fetch(
      request("/_ravi/operator/comments?path=%2Fdocs", {
        method: "GET",
        headers: {
          cookie: `__Host-ravi_page_session=${pagesSession}`,
        },
      }),
      env({ controlToken: "control_token" }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ status: "ok", comments: [] });
    expect(operatorFetch).toHaveBeenCalledTimes(1);
  });

  test("forwards operator comment creation through the Console control plane", async () => {
    const pagesSession = "sessionabcdefghijklmnopqrstuvwxyz123456";
    const operatorFetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      expect(url.toString()).toBe("https://console.ravi.bot/api/internal/pages/operator/comments");
      expect(init?.method).toBe("POST");
      expect(headers.get("authorization")).toBe("Bearer control_token");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        action: "create",
        body: "Check this CTA",
        host: "demo.ravi.page",
        pagesSession,
        path: "/docs",
        target: {
          selector: "main > button",
        },
      });
      return Response.json(
        {
          status: "ok",
          comment: {
            id: "comment_1",
            body: "Check this CTA",
          },
        },
        { status: 201 },
      );
    });
    globalThis.fetch = operatorFetch as unknown as typeof fetch;

    const response = await worker.fetch(
      request("/_ravi/operator/comments", {
        method: "POST",
        headers: {
          cookie: `__Host-ravi_page_session=${pagesSession}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          action: "create",
          body: "Check this CTA",
          path: "/docs",
          target: { selector: "main > button" },
        }),
      }),
      env({ controlToken: "control_token" }),
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      status: "ok",
      comment: { id: "comment_1" },
    });
    expect(operatorFetch).toHaveBeenCalledTimes(1);
  });

  test("forwards operator comment replies through the Console control plane", async () => {
    const pagesSession = "sessionabcdefghijklmnopqrstuvwxyz123456";
    const parentId = "11111111-1111-4111-8111-111111111111";
    const operatorFetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      expect(url.toString()).toBe("https://console.ravi.bot/api/internal/pages/operator/comments");
      expect(init?.method).toBe("POST");
      expect(headers.get("authorization")).toBe("Bearer control_token");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        action: "create",
        body: "Reply inline",
        host: "demo.ravi.page",
        pagesSession,
        parentId,
        path: "/docs",
      });
      return Response.json(
        {
          status: "ok",
          comment: {
            id: "comment_2",
            body: "Reply inline",
            parentId,
          },
        },
        { status: 201 },
      );
    });
    globalThis.fetch = operatorFetch as unknown as typeof fetch;

    const response = await worker.fetch(
      request("/_ravi/operator/comments", {
        method: "POST",
        headers: {
          cookie: `__Host-ravi_page_session=${pagesSession}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          action: "create",
          body: "Reply inline",
          parentId,
          path: "/docs",
        }),
      }),
      env({ controlToken: "control_token" }),
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      status: "ok",
      comment: { parentId },
    });
    expect(operatorFetch).toHaveBeenCalledTimes(1);
  });

  test("forwards operator release history requests through the Console control plane", async () => {
    const pagesSession = "sessionabcdefghijklmnopqrstuvwxyz123456";
    const releaseId = "44444444-4444-4444-8444-444444444444";
    const operatorFetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      expect(url.toString()).toBe("https://console.ravi.bot/api/internal/pages/operator/releases");
      expect(init?.method).toBe("POST");
      expect(headers.get("authorization")).toBe("Bearer control_token");
      expect(JSON.parse(String(init?.body))).toEqual({
        action: "restore",
        baseReleaseId: null,
        host: "demo.ravi.page",
        pagesSession,
        path: "/docs",
        releaseId,
      });
      return Response.json({ status: "ok", release: { id: releaseId, number: 4 } });
    });
    globalThis.fetch = operatorFetch as unknown as typeof fetch;

    const send = (body: Record<string, unknown>, cookie = `__Host-ravi_page_session=${pagesSession}`) =>
      worker.fetch(
        request("/_ravi/operator/releases", {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        env({ controlToken: "control_token" }),
      );

    const response = await send({ action: "restore", releaseId, baseReleaseId: null, path: "/docs", host: "evil.example" });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ status: "ok", release: { number: 4 } });

    expect((await send({ action: "delete_everything", releaseId })).status).toBe(400);
    const crossSite = await worker.fetch(
      request("/_ravi/operator/releases", {
        method: "POST",
        headers: {
          cookie: `__Host-ravi_page_session=${pagesSession}`,
          "content-type": "text/plain",
          origin: "https://other-customer.ravi.page",
        },
        body: JSON.stringify({ action: "restore", releaseId }),
      }),
      env({ controlToken: "control_token" }),
    );
    expect(crossSite.status).toBe(403);
    for (const path of ["/_ravi/operator/visibility", "/_ravi/operator/password", "/_ravi/operator/comments"]) {
      const rejected = await worker.fetch(
        request(path, {
          method: "POST",
          headers: { cookie: `__Host-ravi_page_session=${pagesSession}`, "sec-fetch-site": "same-site" },
          body: "{}",
        }),
        env({ controlToken: "control_token" }),
      );
      expect(rejected.status).toBe(403);
    }
    expect((await send({ action: "list" }, "")).status).toBe(401);
    expect(operatorFetch).toHaveBeenCalledTimes(1);
  });

  test("forwards operator comment deletes through the Console control plane", async () => {
    const pagesSession = "sessionabcdefghijklmnopqrstuvwxyz123456";
    const commentId = "33333333-3333-4333-8333-333333333333";
    const operatorFetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      expect(url.toString()).toBe("https://console.ravi.bot/api/internal/pages/operator/comments");
      expect(init?.method).toBe("POST");
      expect(headers.get("authorization")).toBe("Bearer control_token");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        action: "delete",
        commentId,
        host: "demo.ravi.page",
        pagesSession,
        path: "/docs",
      });
      return Response.json({
        status: "ok",
        comment: {
          id: commentId,
          status: "deleted",
        },
      });
    });
    globalThis.fetch = operatorFetch as unknown as typeof fetch;

    const response = await worker.fetch(
      request("/_ravi/operator/comments", {
        method: "POST",
        headers: {
          cookie: `__Host-ravi_page_session=${pagesSession}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          action: "delete",
          commentId,
          path: "/docs",
        }),
      }),
      env({ controlToken: "control_token" }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "ok",
      comment: { id: commentId, status: "deleted" },
    });
    expect(operatorFetch).toHaveBeenCalledTimes(1);
  });

  test("emits provider-neutral usage for edge manifest served assets", async () => {
    const usageFetch = mock(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ status: "ok" }));
    globalThis.fetch = usageFetch as unknown as typeof fetch;
    const waitUntil = waitUntilContext();

    const response = await worker.fetch(
      request("/assets/app.js"),
      env({
        controlToken: "control_token",
        usagePath: "/api/internal/usage/events",
        assets: {
          "sites/demo.ravi.page/active.json": r2Object(JSON.stringify(edgeManifest())),
          "org/org_1/project/proj_1/artifact/art_1/version/ver_1/assets/app.js": r2Object("console.log('edge');"),
        },
      }),
      waitUntil.ctx,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("console.log('edge');");
    await waitUntil.done();

    expect(usageFetch).toHaveBeenCalledTimes(1);
    expect(String(usageFetch.mock.calls[0]?.[0])).toBe("https://console.ravi.bot/api/internal/usage/events");
    expect((usageFetch.mock.calls[0]?.[1]?.headers as Record<string, string>).authorization).toBe("Bearer control_token");
    const payload = JSON.parse(String(usageFetch.mock.calls[0]?.[1]?.body));
    expect(payload.events.map((event: { metricKey: string }) => event.metricKey).sort()).toEqual([
      "pages.bytes_served",
      "pages.requests.public",
    ]);
    expect(payload.events[0]).toMatchObject({
      organizationId: "org_1",
      projectId: "proj_1",
      siteId: "site_1",
      releaseId: "release_1",
      routeId: "route_1",
      artifactId: "art_1",
      artifactVersionId: "ver_1",
      source: "pages_worker",
    });
    expect(JSON.stringify(payload)).not.toContain("Cloudflare");
    expect(JSON.stringify(payload)).not.toContain("R2");
    expect(JSON.stringify(payload)).not.toContain("r2Key");
    expect(JSON.stringify(payload)).not.toContain("org/org_1/project/proj_1/artifact/art_1/version/ver_1/assets/app.js");
  });

  test("enqueues usage events when a usage queue binding is configured", async () => {
    const resolveFetch = mock(async () => Response.json({ status: "error" }, { status: 500 }));
    globalThis.fetch = resolveFetch as unknown as typeof fetch;
    const waitUntil = waitUntilContext();
    const queuedMessages: unknown[] = [];

    const response = await worker.fetch(
      request("/assets/app.js"),
      env({
        controlToken: "control_token",
        usageQueue: {
          async send(message) {
            queuedMessages.push(message);
          },
        },
        assets: {
          "sites/demo.ravi.page/active.json": r2Object(JSON.stringify(edgeManifest())),
          "org/org_1/project/proj_1/artifact/art_1/version/ver_1/assets/app.js": r2Object("console.log('edge');"),
        },
      }),
      waitUntil.ctx,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("console.log('edge');");
    await waitUntil.done();

    expect(resolveFetch).not.toHaveBeenCalled();
    expect(queuedMessages).toHaveLength(1);
    expect(queuedMessages[0]).toMatchObject({
      schemaVersion: 1,
      source: "pages_worker",
    });
    expect((queuedMessages[0] as { events: Array<{ metricKey: string }> }).events.map((event) => event.metricKey).sort()).toEqual([
      "pages.bytes_served",
      "pages.requests.public",
    ]);
  });

  test("flushes queued usage in Console ingest batches", async () => {
    const usageFetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as { events: unknown[] };
      expect(payload.events.length).toBeLessThanOrEqual(50);
      return Response.json({ status: "ok" });
    });
    globalThis.fetch = usageFetch as unknown as typeof fetch;

    const events = Array.from({ length: 53 }, (_, index) => usageEvent(`req_${index}`));

    await worker.queue(
      {
        messages: [
          {
            body: {
              schemaVersion: 1,
              source: "pages_worker",
              requestId: "queued_req",
              enqueuedAt: "2026-05-11T03:00:00.000Z",
              events,
            },
          },
        ],
      },
      env({ controlToken: "control_token" }),
    );

    expect(usageFetch).toHaveBeenCalledTimes(2);
    expect(String(usageFetch.mock.calls[0]?.[0])).toBe("https://console.ravi.bot/api/internal/usage/events");
    expect((usageFetch.mock.calls[0]?.[1]?.headers as Record<string, string>).authorization).toBe("Bearer control_token");
  });

  test("isolates invalid queued usage messages after Console validation failure", async () => {
    const usageFetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as { events: Array<{ requestId: string }> };
      if (payload.events.length > 1 || payload.events[0]?.requestId === "bad_req") {
        return Response.json({ status: "error" }, { status: 400 });
      }
      return Response.json({ status: "ok" });
    });
    globalThis.fetch = usageFetch as unknown as typeof fetch;

    await worker.queue(
      {
        messages: [
          {
            body: {
              schemaVersion: 1,
              source: "pages_worker",
              requestId: "good_req",
              enqueuedAt: "2026-05-11T03:00:00.000Z",
              events: [usageEvent("good_req")],
            },
          },
          {
            body: {
              schemaVersion: 1,
              source: "pages_worker",
              requestId: "bad_req",
              enqueuedAt: "2026-05-11T03:00:00.000Z",
              events: [usageEvent("bad_req")],
            },
          },
        ],
      },
      env({ controlToken: "control_token" }),
    );

    expect(usageFetch).toHaveBeenCalledTimes(3);
  });

  test("emits fallback and private auth usage when serving through Console resolve", async () => {
    const pagesSession = "sessionabcdefghijklmnopqrstuvwxyz123456";
    const fetchMock = mock(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/internal/pages/resolve")) {
        return Response.json({
          status: "ok",
          site: {
            id: "site_1",
            organizationId: "org_1",
            projectId: "proj_1",
            visibility: "private",
          },
          release: {
            id: "release_1",
            number: 1,
          },
          route: {
            id: "route_1",
            bindingId: "release_route_1",
            path: "/",
            matchType: "spa",
            visibility: "private",
          },
          artifact: {
            id: "art_1",
            versionId: "ver_1",
            versionNumber: 1,
          },
          object: {
            path: "index.html",
            r2Key: "org/org_1/project/proj_1/artifact/art_1/version/ver_1/index.html",
            contentType: "text/html; charset=utf-8",
            cache: "private",
            sizeBytes: 15,
          },
          headers: {},
        });
      }
      if (url.endsWith("/api/internal/usage/events")) {
        return Response.json({ status: "ok" });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const waitUntil = waitUntilContext();

    const response = await worker.fetch(
      request("/", { headers: { cookie: `__Host-ravi_page_session=${pagesSession}` } }),
      env({
        controlToken: "control_token",
        usagePath: "/api/internal/usage/events",
        assets: {
          "org/org_1/project/proj_1/artifact/art_1/version/ver_1/index.html": r2Object("<!doctype html>"),
        },
      }),
      waitUntil.ctx,
    );

    expect(response.status).toBe(200);
    await response.text();
    await waitUntil.done();

    const usageCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith("/api/internal/usage/events"));
    const usageInit = usageCall?.[1] as RequestInit | undefined;
    const payload = JSON.parse(String(usageInit?.body));
    expect(payload.events.map((event: { metricKey: string }) => event.metricKey).sort()).toEqual([
      "pages.bytes_served",
      "pages.private_auth_checks",
      "pages.requests.private",
      "pages.resolve.fallbacks",
    ]);
    const fallbackEvent = payload.events.find((event: { metricKey: string }) => event.metricKey === "pages.resolve.fallbacks");
    expect(fallbackEvent.metadataJson).toEqual({ edgeMissReason: "manifest_missing" });
  });

  test("does not cache edge manifests by default", async () => {
    const assetReads: string[] = [];
    const resolveFetch = mock(async () => Response.json({ status: "error" }, { status: 500 }));
    globalThis.fetch = resolveFetch as unknown as typeof fetch;

    for (const body of ["console.log('v1');", "console.log('v2');"]) {
      const response = await worker.fetch(
        request("/assets/app.js"),
        env({
          assets: {
            "sites/demo.ravi.page/active.json": r2Object(JSON.stringify(edgeManifest())),
            "org/org_1/project/proj_1/artifact/art_1/version/ver_1/assets/app.js": r2Object(body),
          },
          onGet: (key) => assetReads.push(key),
        }),
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(body);
    }

    expect(assetReads.filter((key) => key === "sites/demo.ravi.page/active.json")).toHaveLength(2);
    expect(resolveFetch).not.toHaveBeenCalled();
  });

  test("redirects private edge manifest routes without calling the control plane when no Pages session exists", async () => {
    const resolveFetch = mock(async () => Response.json({ status: "error" }, { status: 500 }));
    globalThis.fetch = resolveFetch as unknown as typeof fetch;

    const response = await worker.fetch(
      request("/"),
      env({
        assets: {
          "sites/demo.ravi.page/active.json": r2Object(JSON.stringify(edgeManifest({ siteVisibility: "private", routeVisibility: "private" }))),
        },
      }),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://console.ravi.bot/api/pages/auth/start?returnTo=https%3A%2F%2Fdemo.ravi.page%2F",
    );
    expect(resolveFetch).not.toHaveBeenCalled();
  });

  test("shows a password challenge without reading page bytes", async () => {
    const controlFetch = mock(async () => Response.json({ status: "error" }, { status: 500 }));
    globalThis.fetch = controlFetch as unknown as typeof fetch;
    const reads: string[] = [];
    const response = await worker.fetch(
      request("/private-report", {
        headers: {
          accept: "text/html",
          cookie: "__Host-ravi_page_operator_checked=v2",
        },
      }),
      env({
        onGet: (key) => reads.push(key),
        assets: {
          "sites/demo.ravi.page/active.json": r2Object(JSON.stringify(edgeManifest({ routeVisibility: "password" }))),
        },
      }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-robots-tag")).toContain("noindex");
    expect(response.headers.get("set-cookie")).toContain("__Host-ravi_page_password_challenge=");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly; Secure; SameSite=Lax");
    const html = await response.text();
    expect(html).toContain('<html lang="pt-BR">');
    expect(html).toContain("Esta página é protegida");
    expect(html).toContain("Senha da página");
    expect(html).toContain("Acessar página");
    expect(html).toContain('name="challenge"');
    expect(html).not.toContain("Password required");
    expect(reads).toEqual(["sites/demo.ravi.page/active.json"]);
    expect(controlFetch).not.toHaveBeenCalled();
  });

  test("validates password sessions through the control plane before serving R2", async () => {
    const passwordSession = "passwordabcdefghijklmnopqrstuvwxyz123456";
    const resolveFetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        host: "demo.ravi.page",
        path: "/",
        pagesPasswordSession: passwordSession,
      });
      return Response.json({
        status: "ok",
        site: { id: "site_1", organizationId: "org_1", projectId: "proj_1", visibility: "public" },
        route: { id: "route_1", path: "/", matchType: "spa", visibility: "password" },
        artifact: { id: "art_1", versionId: "ver_1" },
        object: {
          path: "index.html",
          r2Key: "org/org_1/project/proj_1/artifact/art_1/version/ver_1/index.html",
          contentType: "text/html; charset=utf-8",
          cache: "private",
        },
      });
    });
    globalThis.fetch = resolveFetch as unknown as typeof fetch;
    const response = await worker.fetch(
      request("/", { headers: { cookie: `__Host-ravi_page_password_session=${passwordSession}` } }),
      env({
        assets: {
          "sites/demo.ravi.page/active.json": r2Object(JSON.stringify(edgeManifest({ routeVisibility: "password" }))),
          "org/org_1/project/proj_1/artifact/art_1/version/ver_1/index.html": r2Object("<!doctype html>"),
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("vary")).toContain("Cookie");
    expect(await response.text()).toBe("<!doctype html>");
    expect(resolveFetch).toHaveBeenCalledTimes(1);
  });

  test("exchanges a page password for a host-only opaque session", async () => {
    const verifyFetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({ host: "demo.ravi.page", password: "correct horse", path: "/report" });
      return Response.json({
        status: "ok",
        cookie: "__Host-ravi_page_password_session=passwordabcdefghijklmnopqrstuvwxyz123456; Path=/; Max-Age=3600; HttpOnly; Secure; SameSite=Lax",
      });
    });
    globalThis.fetch = verifyFetch as unknown as typeof fetch;
    const response = await worker.fetch(
      request("/_ravi/auth/password", {
        method: "POST",
        headers: {
          accept: "text/html",
          origin: "https://demo.ravi.page",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ returnTo: "https://demo.ravi.page/report", password: "correct horse" }),
      }),
      env({ controlToken: "control_token" }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://demo.ravi.page/report");
    expect(response.headers.get("set-cookie")).toStartWith("__Host-ravi_page_password_session=");
    expect(verifyFetch).toHaveBeenCalledTimes(1);
  });

  test("accepts a matching host-bound challenge when Origin is unavailable", async () => {
    const challenge = "challengeabcdefghijklmnopqrstuvwxyz1234567890";
    const verifyFetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        host: "demo.ravi.page",
        password: "correct horse",
        path: "/report",
      });
      return Response.json({
        status: "ok",
        cookie: "__Host-ravi_page_password_session=passwordabcdefghijklmnopqrstuvwxyz123456; Path=/; Max-Age=3600; HttpOnly; Secure; SameSite=Lax",
      });
    });
    globalThis.fetch = verifyFetch as unknown as typeof fetch;

    const response = await worker.fetch(
      request("/_ravi/auth/password", {
        method: "POST",
        headers: {
          accept: "text/html",
          cookie: `__Host-ravi_page_password_challenge=${challenge}`,
          origin: "null",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          returnTo: "https://demo.ravi.page/report",
          password: "correct horse",
          challenge,
        }),
      }),
      env({ controlToken: "control_token" }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("set-cookie")).toContain("__Host-ravi_page_password_session=");
    expect(response.headers.get("set-cookie")).toContain("__Host-ravi_page_password_challenge=; Path=/; Max-Age=0");
    expect(verifyFetch).toHaveBeenCalledTimes(1);
  });

  test("accepts an already-open same-origin browser form through Fetch Metadata", async () => {
    const verifyFetch = mock(async () =>
      Response.json({
        status: "ok",
        cookie: "__Host-ravi_page_password_session=passwordabcdefghijklmnopqrstuvwxyz123456; Path=/; Max-Age=3600; HttpOnly; Secure; SameSite=Lax",
      }),
    );
    globalThis.fetch = verifyFetch as unknown as typeof fetch;

    const response = await worker.fetch(
      request("/_ravi/auth/password", {
        method: "POST",
        headers: {
          accept: "text/html",
          "content-type": "application/x-www-form-urlencoded",
          "sec-fetch-dest": "document",
          "sec-fetch-mode": "navigate",
          "sec-fetch-site": "same-origin",
        },
        body: new URLSearchParams({
          returnTo: "https://demo.ravi.page/report",
          password: "correct horse",
        }),
      }),
      env({ controlToken: "control_token" }),
    );

    expect(response.status).toBe(303);
    expect(verifyFetch).toHaveBeenCalledTimes(1);
  });

  test("returns a coarse challenge error when the page password is wrong", async () => {
    const verifyFetch = mock(async () =>
      Response.json({ status: "error", error: "invalid_credentials" }, { status: 401 }),
    );
    globalThis.fetch = verifyFetch as unknown as typeof fetch;

    const response = await worker.fetch(
      request("/_ravi/auth/password", {
        method: "POST",
        headers: {
          accept: "text/html",
          origin: "https://demo.ravi.page",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ returnTo: "https://demo.ravi.page/report", password: "wrong password" }),
      }),
      env({ controlToken: "control_token" }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toContain("__Host-ravi_page_password_challenge=");
    expect(response.headers.get("set-cookie")).not.toContain("__Host-ravi_page_password_session=");
    const html = await response.text();
    expect(html).toContain("Senha incorreta.");
    expect(html).not.toContain("invalid_credentials");
    expect(verifyFetch).toHaveBeenCalledTimes(1);
  });

  test("rejects cross-origin page password submissions before the control plane", async () => {
    const verifyFetch = mock(async () => Response.json({ status: "ok" }));
    globalThis.fetch = verifyFetch as unknown as typeof fetch;

    const response = await worker.fetch(
      request("/_ravi/auth/password", {
        method: "POST",
        headers: {
          accept: "text/html",
          origin: "https://attacker.example",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ returnTo: "https://demo.ravi.page/report", password: "correct horse" }),
      }),
      env({ controlToken: "control_token" }),
    );

    expect(response.status).toBe(403);
    expect(await response.text()).toContain("Não foi possível verificar a solicitação.");
    expect(verifyFetch).not.toHaveBeenCalled();
  });

  test("rejects origin-less submissions without a challenge or same-origin Fetch Metadata", async () => {
    const verifyFetch = mock(async () => Response.json({ status: "ok" }));
    globalThis.fetch = verifyFetch as unknown as typeof fetch;

    const response = await worker.fetch(
      request("/_ravi/auth/password", {
        method: "POST",
        headers: {
          accept: "text/html",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ returnTo: "https://demo.ravi.page/report", password: "correct horse" }),
      }),
      env({ controlToken: "control_token" }),
    );

    expect(response.status).toBe(403);
    expect(await response.text()).toContain("Não foi possível verificar a solicitação.");
    expect(verifyFetch).not.toHaveBeenCalled();
  });

  test("rejects oversized page password submissions before the control plane", async () => {
    const verifyFetch = mock(async () => Response.json({ status: "ok" }));
    globalThis.fetch = verifyFetch as unknown as typeof fetch;

    const response = await worker.fetch(
      request("/_ravi/auth/password", {
        method: "POST",
        headers: {
          origin: "https://demo.ravi.page",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          returnTo: "https://demo.ravi.page/report",
          password: "x".repeat(2_100),
        }),
      }),
      env({ controlToken: "control_token" }),
    );

    expect(response.status).toBe(400);
    expect(verifyFetch).not.toHaveBeenCalled();
  });

  test("falls back to Console resolve when edge manifest is pending", async () => {
    const resolveFetch = mock(async () =>
      Response.json({
        status: "ok",
        site: {
          organizationId: "org_1",
          projectId: "proj_1",
        },
        artifact: {
          id: "art_1",
          versionId: "ver_1",
        },
        object: {
          r2Key: "org/org_1/project/proj_1/artifact/art_1/version/ver_1/index.html",
          contentType: "text/html; charset=utf-8",
          cache: "entrypoint",
        },
      }),
    );
    globalThis.fetch = resolveFetch as unknown as typeof fetch;

    const response = await worker.fetch(
      request("/"),
      env({
        assets: {
          "sites/demo.ravi.page/active.json": r2Object(JSON.stringify(edgeManifest({ edgeState: "pending" }))),
          "org/org_1/project/proj_1/artifact/art_1/version/ver_1/index.html": r2Object("<!doctype html>"),
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<!doctype html>");
    expect(resolveFetch).toHaveBeenCalledTimes(1);
  });

  test("falls back to Console resolve when edge manifest state is invalid", async () => {
    const resolveFetch = mock(async () =>
      Response.json({
        status: "ok",
        site: {
          organizationId: "org_1",
          projectId: "proj_1",
        },
        artifact: {
          id: "art_1",
          versionId: "ver_1",
        },
        object: {
          r2Key: "org/org_1/project/proj_1/artifact/art_1/version/ver_1/index.html",
          contentType: "text/html; charset=utf-8",
          cache: "entrypoint",
        },
      }),
    );
    globalThis.fetch = resolveFetch as unknown as typeof fetch;

    const response = await worker.fetch(
      request("/"),
      env({
        assets: {
          "sites/demo.ravi.page/active.json": r2Object(JSON.stringify({ ...edgeManifest(), edgeState: "unknown" })),
          "org/org_1/project/proj_1/artifact/art_1/version/ver_1/index.html": r2Object("<!doctype html>"),
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<!doctype html>");
    expect(resolveFetch).toHaveBeenCalledTimes(1);
  });

  test("does not serve the root SPA entrypoint for unknown paths from the edge manifest", async () => {
    const resolveFetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("x-ravi-pages-edge-miss-reason")).toBe("file_miss");
      return Response.json({ status: "not_found" }, { status: 404 });
    });
    globalThis.fetch = resolveFetch as unknown as typeof fetch;

    for (const path of ["/route-a;", "/missing-page"]) {
      const response = await worker.fetch(
        request(path),
        env({
          assets: {
            "sites/demo.ravi.page/active.json": r2Object(JSON.stringify(edgeManifest())),
            "org/org_1/project/proj_1/artifact/art_1/version/ver_1/index.html": r2Object("<!doctype html><main>Home</main>"),
          },
        }),
      );

      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("Home");
    }
    expect(resolveFetch).toHaveBeenCalledTimes(2);
  });

  test("falls back to Console resolve when edge manifest state is missing", async () => {
    const resolveFetch = mock(async () =>
      Response.json({
        status: "ok",
        site: {
          organizationId: "org_1",
          projectId: "proj_1",
        },
        artifact: {
          id: "art_1",
          versionId: "ver_1",
        },
        object: {
          r2Key: "org/org_1/project/proj_1/artifact/art_1/version/ver_1/index.html",
          contentType: "text/html; charset=utf-8",
          cache: "entrypoint",
        },
      }),
    );
    globalThis.fetch = resolveFetch as unknown as typeof fetch;

    const manifest = { ...edgeManifest() } as Record<string, unknown>;
    delete manifest.edgeState;

    const response = await worker.fetch(
      request("/"),
      env({
        assets: {
          "sites/demo.ravi.page/active.json": r2Object(JSON.stringify(manifest)),
          "org/org_1/project/proj_1/artifact/art_1/version/ver_1/index.html": r2Object("<!doctype html>"),
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<!doctype html>");
    expect(resolveFetch).toHaveBeenCalledTimes(1);
  });

  test("falls back to Console resolve when edge manifest routes include local files", async () => {
    const resolveFetch = mock(async () =>
      Response.json({
        status: "ok",
        site: {
          organizationId: "org_1",
          projectId: "proj_1",
        },
        artifact: {
          id: "art_1",
          versionId: "ver_1",
        },
        object: {
          r2Key: "org/org_1/project/proj_1/artifact/art_1/version/ver_1/index.html",
          contentType: "text/html; charset=utf-8",
          cache: "entrypoint",
        },
      }),
    );
    globalThis.fetch = resolveFetch as unknown as typeof fetch;

    const manifest = edgeManifest() as unknown as { routes: Array<Record<string, unknown>> };
    manifest.routes[0] = {
      ...manifest.routes[0],
      files: [
        {
          path: "index.html",
          r2Key: "org/org_1/project/proj_1/artifact/art_1/version/ver_1/index.html",
        },
      ],
    };

    const response = await worker.fetch(
      request("/"),
      env({
        assets: {
          "sites/demo.ravi.page/active.json": r2Object(JSON.stringify(manifest)),
          "org/org_1/project/proj_1/artifact/art_1/version/ver_1/index.html": r2Object("<!doctype html>"),
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<!doctype html>");
    expect(resolveFetch).toHaveBeenCalledTimes(1);
  });

  test("serves route entrypoints with conservative cache", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({
        site: {
          organizationId: "org_1",
          projectId: "proj_1",
        },
        artifact: {
          id: "art_1",
          versionId: "ver_1",
        },
        object: {
          r2Key: "org/org_1/project/proj_1/artifact/art_1/version/ver_1/index.html",
          contentType: "text/html; charset=utf-8",
          cache: "entrypoint",
        },
      }),
    ) as unknown as typeof fetch;

    const response = await worker.fetch(
      request("/"),
      env({
        assets: {
          "org/org_1/project/proj_1/artifact/art_1/version/ver_1/index.html": r2Object("<!doctype html>"),
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("content-security-policy")).toContain("object-src 'none'");
    const permissionsPolicy = response.headers.get("permissions-policy");
    expect(permissionsPolicy).toContain("camera=(self)");
    expect(permissionsPolicy).toContain("microphone=(self)");
    expect(permissionsPolicy).not.toContain("camera=()");
    expect(permissionsPolicy).not.toContain("microphone=()");
    expect(permissionsPolicy).toContain("geolocation=()");
    expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });

  test("enables device motion only for an opted-in edge-manifest route", async () => {
    globalThis.fetch = mock(async () => Response.json({ status: "error" }, { status: 500 })) as unknown as typeof fetch;
    const manifest = edgeManifest();
    const motionRoute = Object.assign({
      ...manifest.routes[0]!,
      id: "route_motion",
      bindingId: "release_route_motion",
      path: "/motion",
      priority: 1,
    }, {
      browserPermissions: { deviceMotion: "self" },
      headers: { "permissions-policy": "geolocation=*" },
    });
    manifest.routes.push(motionRoute);

    const requestEnv = () => env({
      assets: {
        "sites/demo.ravi.page/active.json": r2Object(JSON.stringify(manifest)),
        "org/org_1/project/proj_1/artifact/art_1/version/ver_1/index.html": r2Object("<!doctype html>"),
      },
    });
    const optedInResponse = await worker.fetch(request("/motion/"), requestEnv());
    const defaultResponse = await worker.fetch(request("/"), requestEnv());

    const optedInPolicy = optedInResponse.headers.get("permissions-policy");
    const defaultPolicy = defaultResponse.headers.get("permissions-policy");
    expect(optedInResponse.status).toBe(200);
    expect(optedInPolicy).toContain("accelerometer=(self)");
    expect(optedInPolicy).toContain("gyroscope=(self)");
    expect(optedInPolicy).toContain("geolocation=()");
    expect(optedInPolicy).not.toContain("geolocation=*");
    expect(defaultPolicy).toContain("accelerometer=()");
    expect(defaultPolicy).toContain("gyroscope=()");
    expect(defaultPolicy).not.toContain("accelerometer=(self)");
    expect(defaultPolicy).not.toContain("gyroscope=(self)");
  });

  test("sanitizes fallback permissions and ignores arbitrary response headers", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({
        headers: { "permissions-policy": "accelerometer=*, gyroscope=*, geolocation=*" },
        site: {
          organizationId: "org_1",
          projectId: "proj_1",
        },
        route: {
          browserPermissions: { deviceMotion: "self", geolocation: "*" },
        },
        artifact: {
          id: "art_1",
          versionId: "ver_1",
        },
        object: {
          r2Key: "org/org_1/project/proj_1/artifact/art_1/version/ver_1/index.html",
          contentType: "text/html; charset=utf-8",
          cache: "entrypoint",
        },
      }),
    ) as unknown as typeof fetch;

    const response = await worker.fetch(
      request("/"),
      env({
        assets: {
          "org/org_1/project/proj_1/artifact/art_1/version/ver_1/index.html": r2Object("<!doctype html>"),
        },
      }),
    );

    const permissionsPolicy = response.headers.get("permissions-policy");
    expect(response.status).toBe(200);
    expect(permissionsPolicy).toContain("accelerometer=(self)");
    expect(permissionsPolicy).toContain("gyroscope=(self)");
    expect(permissionsPolicy).toContain("geolocation=()");
    expect(permissionsPolicy).not.toContain("geolocation=*");
  });

  test("canonicalizes a mounted SPA before serving relative assets below the route", async () => {
    const resolveFetch = mock(async () => Response.json({ status: "error" }, { status: 500 }));
    globalThis.fetch = resolveFetch as unknown as typeof fetch;
    const manifest = edgeManifest();
    manifest.routes[0]!.path = "/planejamento";
    manifest.artifacts[0]!.files.push({
      path: "app.js",
      r2Key: "org/org_1/project/proj_1/artifact/art_1/version/ver_1/app.js",
      contentType: "application/javascript",
      cache: "immutable",
      etag: '"sha256:root-app"',
      sha256: "root-app",
      sizeBytes: 21,
    });

    const requestEnv = () =>
      env({
        assets: {
          "sites/demo.ravi.page/active.json": r2Object(JSON.stringify(manifest)),
          "org/org_1/project/proj_1/artifact/art_1/version/ver_1/index.html": r2Object(
            '<!doctype html><script src="./app.js"></script>',
          ),
          "org/org_1/project/proj_1/artifact/art_1/version/ver_1/app.js": r2Object("globalThis.ready=true;"),
        },
      });

    const canonical = await worker.fetch(request("/planejamento?mode=criteria"), requestEnv());
    expect(canonical.status).toBe(308);
    expect(canonical.headers.get("location")).toBe("https://demo.ravi.page/planejamento/?mode=criteria");
    expect(canonical.headers.get("cache-control")).toBe("no-store");

    const entrypoint = await worker.fetch(request("/planejamento/"), requestEnv());
    expect(entrypoint.status).toBe(200);
    expect(await entrypoint.text()).toContain('src="./app.js"');

    const asset = await worker.fetch(request("/planejamento/app.js"), requestEnv());
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await asset.text()).toBe("globalThis.ready=true;");
    expect(resolveFetch).not.toHaveBeenCalled();
  });

  test("does not canonicalize exact routes", async () => {
    const manifest = edgeManifest();
    manifest.routes[0]!.path = "/download";
    manifest.routes[0]!.matchType = "exact";

    const response = await worker.fetch(
      request("/download"),
      env({
        assets: {
          "sites/demo.ravi.page/active.json": r2Object(JSON.stringify(manifest)),
          "org/org_1/project/proj_1/artifact/art_1/version/ver_1/index.html": r2Object("<!doctype html>"),
        },
      }),
    );

    expect(response.status).toBe(200);
  });

  test("canonicalizes protected mounts only after an authorized resolve", async () => {
    const pagesSession = "sessionabcdefghijklmnopqrstuvwxyz123456";
    const resolveFetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        host: "demo.ravi.page",
        path: "/planejamento",
        pagesSession,
      });

      return Response.json({
        status: "ok",
        site: {
          id: "site_1",
          organizationId: "org_1",
          projectId: "proj_1",
          visibility: "public",
        },
        route: {
          id: "route_1",
          path: "/planejamento",
          matchType: "spa",
          visibility: "protected_link",
        },
        artifact: {
          id: "art_1",
          versionId: "ver_1",
        },
        object: {
          path: "index.html",
          r2Key: "org/org_1/project/proj_1/artifact/art_1/version/ver_1/index.html",
          contentType: "text/html; charset=utf-8",
          cache: "private",
        },
      });
    });
    globalThis.fetch = resolveFetch as unknown as typeof fetch;

    const response = await worker.fetch(
      request("/planejamento", {
        headers: { cookie: `__Host-ravi_page_session=${pagesSession}` },
      }),
      env(),
    );

    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("https://demo.ravi.page/planejamento/");
    expect(resolveFetch).toHaveBeenCalledTimes(1);
  });

  test("serves reserved Ravi asset URLs through the resolve API", async () => {
    const resolveFetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        host: "demo.ravi.page",
        path: "/_ravi/assets/art_1/ver_1/assets/app.js",
        method: "GET",
      });

      return Response.json({
        status: "ok",
        site: {
          organizationId: "org_1",
          projectId: "proj_1",
        },
        artifact: {
          id: "art_1",
          versionId: "ver_1",
        },
        object: {
          r2Key: "org/org_1/project/proj_1/artifact/art_1/version/ver_1/assets/app.js",
          contentType: "application/javascript",
          cache: "immutable",
        },
      });
    });
    globalThis.fetch = resolveFetch as unknown as typeof fetch;

    const response = await worker.fetch(
      request("/_ravi/assets/art_1/ver_1/assets/app.js"),
      env({
        assets: {
          "org/org_1/project/proj_1/artifact/art_1/version/ver_1/assets/app.js": r2Object("console.log('ok');"),
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("console.log('ok');");
    expect(resolveFetch).toHaveBeenCalledTimes(1);
  });

  test("serves transferred final object keys returned by the control plane", async () => {
    const assetReads: string[] = [];
    globalThis.fetch = mock(async () =>
      Response.json({
        status: "ok",
        site: {
          organizationId: "org_new",
          projectId: "proj_new",
        },
        artifact: {
          id: "art_1",
          versionId: "ver_1",
        },
        object: {
          path: "index.html",
          r2Key: "org/org_old/project/proj_old/artifact/art_1/version/ver_1/index.html",
          contentType: "text/html; charset=utf-8",
          cache: "entrypoint",
        },
      }),
    ) as unknown as typeof fetch;

    const response = await worker.fetch(
      request("/"),
      env({
        assets: {
          "org/org_old/project/proj_old/artifact/art_1/version/ver_1/index.html": r2Object("<!doctype html>"),
        },
        onGet: (key) => assetReads.push(key),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<!doctype html>");
    expect(assetReads).toEqual([
      "sites/demo.ravi.page/active.json",
      "org/org_old/project/proj_old/artifact/art_1/version/ver_1/index.html",
    ]);
  });

  test("does not serve staging object keys returned by the control plane", async () => {
    const assetReads: string[] = [];
    globalThis.fetch = mock(async () =>
      Response.json({
        status: "ok",
        site: {
          organizationId: "org_1",
          projectId: "proj_1",
        },
        artifact: {
          id: "art_1",
          versionId: "ver_1",
        },
        object: {
          r2Key: "staging/org/org_1/project/proj_1/upload/upl_1/index.html",
          contentType: "text/html; charset=utf-8",
          cache: "entrypoint",
        },
      }),
    ) as unknown as typeof fetch;

    const response = await worker.fetch(
      request("/"),
      env({
        assets: {
          "staging/org/org_1/project/proj_1/upload/upl_1/index.html": r2Object("<!doctype html>"),
        },
        onGet: (key) => assetReads.push(key),
      }),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const text = await response.text();
    expect(text).toContain("Page temporarily unavailable");
    expect(text).not.toContain("pages_control_plane_invalid_object_key");
    expect(assetReads).toEqual(["sites/demo.ravi.page/active.json"]);
  });

  test("does not serve final-looking keys without control-plane ownership metadata", async () => {
    const assetReads: string[] = [];
    globalThis.fetch = mock(async () =>
      Response.json({
        status: "ok",
        object: {
          r2Key: "org/org_1/project/proj_1/artifact/art_1/version/ver_1/index.html",
          contentType: "text/html; charset=utf-8",
          cache: "entrypoint",
        },
      }),
    ) as unknown as typeof fetch;

    const response = await worker.fetch(
      request("/"),
      env({
        assets: {
          "org/org_1/project/proj_1/artifact/art_1/version/ver_1/index.html": r2Object("<!doctype html>"),
        },
        onGet: (key) => assetReads.push(key),
      }),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const text = await response.text();
    expect(text).toContain("Page temporarily unavailable");
    expect(text).not.toContain("pages_control_plane_invalid_object_key");
    expect(assetReads).toEqual(["sites/demo.ravi.page/active.json"]);
  });

  test("does not serve keys for a sibling artifact returned by the control plane", async () => {
    const assetReads: string[] = [];
    globalThis.fetch = mock(async () =>
      Response.json({
        status: "ok",
        site: {
          organizationId: "org_1",
          projectId: "proj_1",
        },
        artifact: {
          id: "art_1",
          versionId: "ver_1",
        },
        object: {
          r2Key: "org/org_1/project/proj_1/artifact/art_2/version/ver_2/index.html",
          contentType: "text/html; charset=utf-8",
          cache: "entrypoint",
        },
      }),
    ) as unknown as typeof fetch;

    const response = await worker.fetch(
      request("/"),
      env({
        assets: {
          "org/org_1/project/proj_1/artifact/art_2/version/ver_2/index.html": r2Object("<!doctype html>"),
        },
        onGet: (key) => assetReads.push(key),
      }),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const text = await response.text();
    expect(text).toContain("Page temporarily unavailable");
    expect(text).not.toContain("pages_control_plane_invalid_object_key");
    expect(assetReads).toEqual(["sites/demo.ravi.page/active.json"]);
  });

  test("redirects private resolve states to Console auth when no Pages session exists", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({
        status: "private",
      }),
    ) as unknown as typeof fetch;

    const response = await worker.fetch(request("/"), env());

    expect(response.status).toBe(302);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("location")).toBe(
      "https://console.ravi.bot/api/pages/auth/start?returnTo=https%3A%2F%2Fdemo.ravi.page%2F",
    );
  });

  test("turns resolve redirect states into edge redirects", async () => {
    const resolveFetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        host: "demo.ravi.page",
        method: "GET",
        path: "/docs",
        search: "?utm_source=mail",
      });
      return Response.json({
        status: "redirect",
        redirect: {
          location: "https://www.customer.example/docs?utm_source=mail",
        },
      });
    });
    globalThis.fetch = resolveFetch as unknown as typeof fetch;

    const response = await worker.fetch(request("/docs?utm_source=mail"), env());

    expect(response.status).toBe(308);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(response.headers.get("location")).toBe("https://www.customer.example/docs?utm_source=mail");
  });

  test("passes the Pages session cookie to the resolve API and restarts auth when it is denied", async () => {
    const pagesSession = "abcdefghijklmnopqrstuvwxyzABCDEF1234567890";
    const resolveFetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        pagesSession,
      });
      return Response.json({
        status: "private",
      });
    });
    globalThis.fetch = resolveFetch as unknown as typeof fetch;

    const response = await worker.fetch(
      request("/", { headers: { cookie: `__Host-ravi_page_session=${pagesSession}` } }),
      env(),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://console.ravi.bot/api/pages/auth/start?returnTo=https%3A%2F%2Fdemo.ravi.page%2F",
    );
    expect(response.headers.get("set-cookie")).toContain("__Host-ravi_page_session=;");
    expect(resolveFetch).toHaveBeenCalledTimes(1);
  });

  test("claims one-time auth codes through the control plane and redirects to the clean URL", async () => {
    const code = "claimcodeabcdefghijklmnopqrstuvwxyz123456";
    const sessionCookie =
      "__Host-ravi_page_session=sessionabcdefghijklmnopqrstuvwxyz123456; Path=/; Max-Age=3600; HttpOnly; Secure; SameSite=Lax";
    const claimFetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(_input)).toBe("https://console.ravi.bot/api/internal/pages/auth/claim");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        code,
        host: "demo.ravi.page",
      });
      return Response.json({
        status: "ok",
        returnTo: "https://demo.ravi.page/private-test",
        session: {
          cookie: sessionCookie,
        },
      });
    });
    globalThis.fetch = claimFetch as unknown as typeof fetch;

    const response = await worker.fetch(request(`/_ravi/auth/claim?code=${code}`), env());

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://demo.ravi.page/private-test");
    expect(response.headers.get("set-cookie")).toBe(sessionCookie);
    expect(claimFetch).toHaveBeenCalledTimes(1);
  });

  test("rejects malformed claim codes without calling the control plane", async () => {
    const resolveFetch = mock(async () => Response.json({ status: "ok" }));
    globalThis.fetch = resolveFetch as unknown as typeof fetch;

    const response = await worker.fetch(request("/_ravi/auth/claim?code=not-valid"), env());

    expect(response.status).toBe(404);
    expect(response.headers.get("set-cookie")).toContain("__Host-ravi_page_session=;");
    expect(resolveFetch).not.toHaveBeenCalled();
  });

  test("rejects claim responses with unsafe session cookie attributes", async () => {
    const code = "claimcodeabcdefghijklmnopqrstuvwxyz123456";
    globalThis.fetch = mock(async () =>
      Response.json({
        status: "ok",
        returnTo: "https://demo.ravi.page/private-test",
        session: {
          cookie: "__Host-ravi_page_session=sessionabcdefghijklmnopqrstuvwxyz123456; Domain=.ravi.page; Path=/; Secure",
        },
      }),
    ) as unknown as typeof fetch;

    const response = await worker.fetch(request(`/_ravi/auth/claim?code=${code}`), env());

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("set-cookie")).toContain("__Host-ravi_page_session=;");
  });

  test("surfaces control-plane auth failures as service unavailable", async () => {
    globalThis.fetch = mock(async () => Response.json({ status: "error" }, { status: 401 })) as unknown as typeof fetch;

    const response = await worker.fetch(request("/"), env());

    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const text = await response.text();
    expect(text).toContain("Page temporarily unavailable");
    expect(text).not.toContain("pages_control_plane_auth_failed");
  });

  test("does not serve unsafe leading-dot paths", async () => {
    const resolveFetch = mock(async () => Response.json({ status: "ok" }));
    globalThis.fetch = resolveFetch as unknown as typeof fetch;

    const response = await worker.fetch(request("/.env"), env());

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await response.text()).toContain("Page not found");
    expect(resolveFetch).not.toHaveBeenCalled();
  });

  test("returns a generic unavailable response when the control plane fails", async () => {
    globalThis.fetch = mock(async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch;

    const response = await worker.fetch(request("/"), env());

    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const text = await response.text();
    expect(text).toContain("Page temporarily unavailable");
    expect(text).not.toContain("pages_control_plane_error");
  });
});

function request(path: string, init?: RequestInit, host = "demo.ravi.page"): Request {
  return new Request(`https://${host}${path}`, init);
}

function env(
  options: {
    assets?: Record<string, R2ObjectBody>;
    browser?: PagesWorkerEnv["RAVI_PAGES_BROWSER"];
    controlToken?: string;
    onGet?: (key: string) => void;
    onPut?: (key: string, value: ArrayBuffer) => void;
    usageQueue?: PagesWorkerEnv["RAVI_PAGES_USAGE_QUEUE"];
    usagePath?: string;
  } = {},
): PagesWorkerEnv {
  return {
    RAVI_CONSOLE_API_URL: "https://console.ravi.bot",
    RAVI_PAGES_BROWSER: options.browser,
    RAVI_PAGES_CONTROL_TOKEN: options.controlToken,
    RAVI_PAGES_USAGE_QUEUE: options.usageQueue,
    RAVI_PAGES_USAGE_PATH: options.usagePath,
    RAVI_PAGES_ASSETS: {
      async get(key: string) {
        options.onGet?.(key);
        return options.assets?.[key] ?? null;
      },
      async put(key: string, value: ArrayBuffer | ArrayBufferView | ReadableStream | string) {
        const buffer: ArrayBuffer = value instanceof ArrayBuffer
          ? value
          : ArrayBuffer.isView(value)
            ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice().buffer
            : typeof value === "string"
              ? new TextEncoder().encode(value).buffer
              : await new Response(value).arrayBuffer();
        options.onPut?.(key, buffer);
        return {};
      },
    },
  };
}

function usageEvent(requestId: string) {
  return {
    organizationId: "00000000-0000-4000-8000-000000000001",
    projectId: "00000000-0000-4000-8000-000000000002",
    siteId: "00000000-0000-4000-8000-000000000003",
    releaseId: "00000000-0000-4000-8000-000000000004",
    routeId: "00000000-0000-4000-8000-000000000005",
    artifactId: "00000000-0000-4000-8000-000000000006",
    artifactVersionId: "00000000-0000-4000-8000-000000000007",
    source: "pages_worker" as const,
    eventType: "pages.request_served",
    metricKey: "pages.requests.public",
    quantity: 1,
    unit: "count",
    dimensionsJson: {
      service: "pages",
      visibility: "public",
    },
    measurementsJson: {
      statusCode: 200,
    },
    evidenceJson: {
      resolver: "edge_manifest",
    },
    metadataJson: {},
    idempotencyKey: `${requestId}:request_served`,
    requestId,
    occurredAt: "2026-05-11T03:00:00.000Z",
  };
}

function waitUntilContext() {
  const promises: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil(promise: Promise<unknown>) {
        promises.push(promise);
      },
    },
    async done() {
      await Promise.all(promises);
    },
  };
}

function r2Object(body: string, metadata: R2ObjectBody["httpMetadata"] = {}): R2ObjectBody {
  return {
    body: new Response(body).body as ReadableStream,
    httpMetadata: metadata,
  };
}

function edgeManifest(
  options: {
    edgeState?: "pending" | "ready" | "failed";
    siteVisibility?: "public" | "private" | "protected_link" | "password";
    routeVisibility?: "public" | "private" | "protected_link" | "password";
  } = {},
) {
  const edgeState = options.edgeState ?? "ready";
  const siteVisibility = options.siteVisibility ?? "public";
  const routeVisibility = options.routeVisibility ?? "public";
  return {
    schemaVersion: 1,
    edgeState,
    generatedAt: "2026-05-10T12:00:00.000Z",
    site: {
      id: "site_1",
      organizationId: "org_1",
      projectId: "proj_1",
      defaultHostname: "demo.ravi.page",
      defaultVisibility: siteVisibility,
      status: "active",
      activeReleaseId: "release_1",
    },
    release: {
      id: "release_1",
      number: 1,
      manifestHash: "hash_1",
    },
    artifacts: [
      {
        id: "art_1",
        versionId: "ver_1",
        versionNumber: 1,
        files: [
          {
            path: "index.html",
            r2Key: "org/org_1/project/proj_1/artifact/art_1/version/ver_1/index.html",
            contentType: "text/html; charset=utf-8",
            cache: "entrypoint",
            etag: "\"sha256:index\"",
            sha256: "index",
            sizeBytes: 15,
          },
          {
            path: "assets/app.js",
            r2Key: "org/org_1/project/proj_1/artifact/art_1/version/ver_1/assets/app.js",
            contentType: "application/javascript",
            cache: "immutable",
            etag: "\"sha256:app\"",
            sha256: "app",
            sizeBytes: 20,
          },
        ],
      },
    ],
    routes: [
      {
        id: "route_1",
        bindingId: "release_route_1",
        path: "/",
        matchType: "spa",
        priority: 0,
        visibility: routeVisibility,
        artifact: {
          id: "art_1",
          versionId: "ver_1",
          versionNumber: 1,
          entrypoint: "index.html",
          assetBase: "/_ravi/assets/art_1/ver_1/",
        },
      },
    ],
  };
}

interface R2ObjectBody {
  body: ReadableStream;
  httpMetadata?: {
    contentType?: string;
    cacheControl?: string;
    contentEncoding?: string;
    contentLanguage?: string;
  };
}

describe("Page chat rooms", () => {
  const session = "sessionabcdefghijklmnopqrstuvwxyz123456";
  const cookie = `__Host-ravi_page_session=${session}`;
  const roomId = "33333333-3333-4333-8333-333333333333";

  type RoomCall = { name: string; path: string; headers: Headers; body: string };
  function rooms(calls: RoomCall[] = []) {
    return {
      idFromName: (name: string) => ({ toString: () => name }),
      get: (id: { toString(): string }) => ({
        fetch: async (input: Request | string, init?: RequestInit) => {
          const url = new URL(typeof input === "string" ? input : input.url);
          calls.push({ name: id.toString(), path: url.pathname, headers: new Headers(init?.headers), body: String(init?.body ?? "") });
          return Response.json({ ok: true, path: url.pathname });
        },
      }),
    };
  }
  function chatEnv(extra: Partial<PagesWorkerEnv> = {}): PagesWorkerEnv {
    return { ...env({ controlToken: "control-token" }), RAVI_PAGES_CHAT_ROOMS: rooms(), ...extra };
  }
  function opened() {
    return {
      room: { id: roomId, kind: "shared", siteId: "site_1", routeId: "route_1", path: "/relatorio", replyPolicy: "mention" },
      viewer: { userId: "user_ana", displayName: "Ana Lima", role: "member" },
      members: [],
      assistantName: "Ravi",
      messages: [],
      lastSeq: 0,
      lastReadSeq: 0,
      voiceEnabled: false,
    };
  }

  test("serves the panel shell with a nonce CSP, same-origin framing and the room query", async () => {
    const response = await worker.fetch(request("/_ravi/chat?path=%2Frelatorio%3Fa%3D1&mode=page&kind=private"), chatEnv());
    const html = await response.text();
    const csp = response.headers.get("content-security-policy") ?? "";
    const nonce = csp.match(/script-src 'nonce-([^']+)'/)?.[1];

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain("connect-src 'self' wss://demo.ravi.page");
    expect(nonce).toBeTruthy();
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).toContain('"path":"/relatorio"');
    expect(html).toContain('"mode":"page"');
    expect(html).toContain('"kind":"private"');
    expect(html).toContain("https://console.ravi.bot/api/pages/auth/start?returnTo=https%3A%2F%2Fdemo.ravi.page%2Frelatorio");
    expect(html).toContain('lang="pt-BR"');

    const post = await worker.fetch(request("/_ravi/chat", { method: "POST" }), chatEnv());
    expect(post.status).toBe(405);
  });

  test("on the isolated chat origin the shell is framed only by the page host it serves", async () => {
    const chatOriginEnv = chatEnv({ RAVI_PAGES_CHAT_ORIGIN: "https://chat.ravi.page" });
    const response = await worker.fetch(request("/_ravi/chat?path=%2F&host=demo.ravi.page", undefined, "chat.ravi.page"), chatOriginEnv);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors https://demo.ravi.page");
    expect(response.headers.get("x-frame-options")).toBeNull();
    const html = await response.text();
    expect(html).toContain('"host":"demo.ravi.page"');
    expect(html).toContain('"parentOrigin":"https://demo.ravi.page"');

    const missing = await worker.fetch(request("/_ravi/chat?path=%2F", undefined, "chat.ravi.page"), chatOriginEnv);
    expect(missing.status).toBe(400);
  });

  test("refuses the room socket without a Pages session, from another origin or without an upgrade", async () => {
    const consoleFetch = mock(async () => Response.json(opened()));
    globalThis.fetch = consoleFetch as unknown as typeof fetch;
    const calls: RoomCall[] = [];
    const roomsEnv = chatEnv({ RAVI_PAGES_CHAT_ROOMS: rooms(calls) });
    const socketPath = `/_ravi/chat/socket?roomId=${roomId}&path=%2Frelatorio&kind=shared`;
    const upgrade = { upgrade: "websocket" };

    const anonymous = await worker.fetch(request(socketPath, { headers: { ...upgrade, origin: "https://demo.ravi.page" } }), roomsEnv);
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual({ error: "chat_session_required" });

    const crossSite = await worker.fetch(request(socketPath, { headers: { ...upgrade, cookie, origin: "https://evil.example" } }), roomsEnv);
    expect(crossSite.status).toBe(403);

    const noOrigin = await worker.fetch(request(socketPath, { headers: { ...upgrade, cookie } }), roomsEnv);
    expect(noOrigin.status).toBe(403);

    const plain = await worker.fetch(request(socketPath, { headers: { cookie, origin: "https://demo.ravi.page" } }), roomsEnv);
    expect(plain.status).toBe(426);

    expect(consoleFetch).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  test("opens the room through the Console and hands the socket to that room's Durable Object", async () => {
    const consoleBodies: unknown[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://console.ravi.bot/api/internal/pages/chat/rooms/open");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer control-token");
      consoleBodies.push(JSON.parse(String(init?.body)));
      return Response.json(opened());
    }) as unknown as typeof fetch;
    const calls: RoomCall[] = [];
    const roomsEnv = chatEnv({ RAVI_PAGES_CHAT_ROOMS: rooms(calls) });
    const headers = { upgrade: "websocket", cookie, origin: "https://demo.ravi.page" };

    const other = await worker.fetch(
      request("/_ravi/chat/socket?roomId=someone-elses-room&path=%2Frelatorio&kind=shared", { headers }),
      roomsEnv,
    );
    expect(other.status).toBe(403);
    expect(calls).toHaveLength(0);

    const response = await worker.fetch(request(`/_ravi/chat/socket?roomId=${roomId}&path=%2Frelatorio%3Fx%3D1&kind=private`, { headers }), roomsEnv);
    expect(response.status).toBe(200);
    expect(consoleBodies.at(-1)).toEqual({ host: "demo.ravi.page", path: "/relatorio", pagesSession: session, kind: "private" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe(roomId);
    expect(calls[0]!.path).toBe("/connect");
    expect(calls[0]!.headers.get("upgrade")).toBe("websocket");
    expect(JSON.parse(decodeURIComponent(calls[0]!.headers.get("x-ravi-chat-viewer") ?? ""))).toEqual({
      userId: "user_ana",
      displayName: "Ana Lima",
      role: "member",
    });
  });

  test("passes the Console's refusal of a socket through", async () => {
    globalThis.fetch = mock(async () => Response.json({ error: "chat_forbidden" }, { status: 403 })) as unknown as typeof fetch;
    const calls: RoomCall[] = [];
    const response = await worker.fetch(
      request(`/_ravi/chat/socket?roomId=${roomId}`, { headers: { upgrade: "websocket", cookie, origin: "https://demo.ravi.page" } }),
      chatEnv({ RAVI_PAGES_CHAT_ROOMS: rooms(calls) }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "chat_forbidden" });
    expect(calls).toHaveLength(0);
  });

  test("proxies panel writes same-origin with the cookie's Pages session, never one from the body", async () => {
    const forwarded: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      forwarded.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return Response.json({ error: "chat_rate_limited" }, { status: 429 });
    }) as unknown as typeof fetch;
    const send = (path: string, body: unknown, headers: Record<string, string> = { cookie, origin: "https://demo.ravi.page" }) =>
      worker.fetch(request(path, { method: "POST", headers, body: JSON.stringify(body) }), chatEnv());

    const anonymous = await send("/_ravi/chat/send", { roomId }, { origin: "https://demo.ravi.page" });
    expect(anonymous.status).toBe(401);
    const crossSite = await send("/_ravi/chat/send", { roomId }, { cookie, origin: "https://evil.example" });
    expect(crossSite.status).toBe(403);
    expect(forwarded).toHaveLength(0);

    const response = await send("/_ravi/chat/send", {
      roomId,
      clientMessageId: "c1",
      text: "Oi @ravi",
      pagesSession: "stolen-session-from-the-body",
      host: "evil.example",
      extra: "ignored",
    });
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "chat_rate_limited" });
    expect(forwarded[0]).toEqual({
      url: "https://console.ravi.bot/api/internal/pages/chat/rooms/messages/send",
      body: { roomId, clientMessageId: "c1", text: "Oi @ravi", host: "demo.ravi.page", pagesSession: session },
    });

    const routes: Array<[string, unknown, string]> = [
      ["list", { roomId, afterSeq: 4 }, "/messages/list"],
      ["delete", { roomId, messageId: "m1" }, "/messages/delete"],
      ["read", { roomId, seq: 9 }, "/read"],
      ["confirm", { roomId, confirmationId: "k1", decision: "confirm" }, "/confirm"],
      ["widgets", { refs: ["org/kpi"] }, "/widgets"],
      ["open", { path: "/_ravi/x", kind: "weird" }, "/open"],
    ];
    for (const [name, body, consolePath] of routes) {
      await send(`/_ravi/chat/${name}`, body);
      expect(forwarded.at(-1)!.url).toBe(`https://console.ravi.bot/api/internal/pages/chat/rooms${consolePath}`);
      expect(forwarded.at(-1)!.body.pagesSession).toBe(session);
    }
    expect(forwarded.at(-1)!.body).toEqual({ path: "/", kind: "shared", host: "demo.ravi.page", pagesSession: session });

    const oversized = await worker.fetch(
      request("/_ravi/chat/send", {
        method: "POST",
        headers: { cookie, origin: "https://demo.ravi.page", "content-length": "999999" },
        body: "{}",
      }),
      chatEnv(),
    );
    expect(oversized.status).toBe(413);
    const big = await send("/_ravi/chat/send", { roomId, text: "x".repeat(40_000) });
    expect(big.status).toBe(413);
    const get = await worker.fetch(request("/_ravi/chat/send", { headers: { cookie } }), chatEnv());
    expect(get.status).toBe(405);
  });

  test("relays Console room events to the room only with the control token", async () => {
    const calls: RoomCall[] = [];
    const roomsEnv = chatEnv({ RAVI_PAGES_CHAT_ROOMS: rooms(calls) });
    const events = { events: [{ type: "message.delta", messageId: "m1", text: "Ol" }] };
    const post = (authorization: string | null, body: unknown = events, path = `/_ravi/chat/internal/rooms/${roomId}/events`) =>
      worker.fetch(
        request(path, {
          method: "POST",
          headers: authorization ? { authorization } : {},
          body: JSON.stringify(body),
        }),
        roomsEnv,
      );

    expect((await post(null)).status).toBe(401);
    expect((await post("Bearer wrong-token")).status).toBe(401);
    expect(calls).toHaveLength(0);

    const ok = await post("Bearer control-token");
    expect(ok.status).toBe(200);
    expect(calls).toEqual([
      expect.objectContaining({ name: roomId, path: "/events", body: JSON.stringify(events) }),
    ]);

    expect((await post("Bearer control-token", { events: [{ type: "drop.tables" }] })).status).toBe(400);
    expect((await post("Bearer control-token", events, "/_ravi/chat/internal/rooms/bad%20id/events")).status).toBe(400);
    const get = await worker.fetch(request(`/_ravi/chat/internal/rooms/${roomId}/events`, { headers: { authorization: "Bearer control-token" } }), roomsEnv);
    expect(get.status).toBe(405);
  });

  function resolvedPage(options: { toolbar?: boolean; pageChat?: boolean; guestChat?: boolean; sizeBytes: number }) {
    return {
      status: "ok",
      site: { id: "site_1", organizationId: "org_1", projectId: "proj_1", visibility: "private" },
      release: { id: "release_1", number: 5 },
      route: { id: "route_1", bindingId: "binding_1", path: "/", matchType: "spa", visibility: "private" },
      artifact: { id: "art_1", versionId: "ver_1", versionNumber: 2 },
      object: {
        r2Key: "org/org_1/project/proj_1/artifact/art_1/version/ver_1/index.html",
        path: "index.html",
        contentType: "text/html; charset=utf-8",
        cache: "private",
        sizeBytes: options.sizeBytes,
      },
      ...(options.toolbar
        ? {
            toolbar: {
              enabled: true,
              host: "demo.ravi.page",
              path: "/",
              effectiveVisibility: "private",
              siteId: "site_1",
              projectId: "proj_1",
              ...(options.pageChat ? { pageChat: { enabled: true } } : {}),
            },
          }
        : {}),
      ...(options.guestChat ? { guestChat: { enabled: true } } : {}),
    };
  }
  async function servePage(page: string, options: { toolbar?: boolean; pageChat?: boolean; guestChat?: boolean; withSession?: boolean; aiFlag?: string }) {
    globalThis.fetch = (async () => Response.json(resolvedPage({ ...options, sizeBytes: new TextEncoder().encode(page).length }))) as unknown as typeof fetch;
    return worker.fetch(
      request("/", { headers: options.withSession === false ? {} : { cookie } }),
      chatEnv({
        RAVI_PAGES_AI_ENABLED: options.aiFlag,
        RAVI_PAGES_ASSETS: {
          async get(key: string) {
            return key.endsWith("index.html") ? r2Object(page) : null;
          },
        },
      }),
    );
  }

  test("installation exclusion suppresses AI despite toolbar/guest metadata while preserving the toolbar and widgets", async () => {
    for (const toolbar of [true, false]) {
      const response = await servePage('<!doctype html><head></head><body><ravi-chat></ravi-chat><ravi-view id="records"></ravi-view><button>Operate</button></body>', {
        toolbar, pageChat: true, guestChat: true, withSession: false, aiFlag: "0",
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).not.toContain('data-ravi-chat-dock="1"');
      expect(html).not.toContain('class="ravi-chat-frame"');
      expect(html).not.toContain('class="ravi-chat-note"');
      expect(html).not.toContain('<ravi-chat');
      expect(html).toContain('<ravi-view id="records"></ravi-view><button>Operate</button>');
      if (toolbar) {
        expect(html).toContain('data-ravi-pages-toolbar');
        expect(html).toContain('"chatUrl":null');
        expect(html).toContain('"pageChatUrl":null');
        expect(html).toContain('/_ravi/operator/releases');
      }
    }
  });

  test("shows the bar entry and turns <ravi-chat> into the room iframe when chat is on", async () => {
    const response = await servePage(
      '<!doctype html><head></head><body><section><ravi-chat height="480"></ravi-chat></section><ravi-chat/></body>',
      { toolbar: true, pageChat: true },
    );
    const html = await response.text();
    expect(response.headers.get("x-ravi-pages-toolbar")).toBe("1");
    expect(html).not.toContain("<ravi-chat");
    expect(html).toContain('<iframe class="ravi-chat-frame" src="/_ravi/chat?mode=page&amp;kind=shared&amp;path=%2F"');
    expect(html).toContain("height:480px");
    expect(html).toContain("height:600px");
    expect(html).toContain('<script data-ravi-chat-dock="1">');
    expect(html).toContain('"chatUrl":"/_ravi/chat"');
    const toolbarScript = html.match(/<script data-ravi-pages-toolbar="1">([\s\S]*?)<\/script>/)?.[1] ?? "";
    expect(toolbarScript).toContain('data-k="chat"');
    expect(toolbarScript).toContain("Fale com o Ravi");
    expect(toolbarScript).toContain("__raviChatDock");
    expect(toolbarScript).toContain('data-k="talk"');
    expect(/^[\x00-\x7f]*$/.test(toolbarScript)).toBe(true);
    const dock = html.match(/<script data-ravi-chat-dock="1">([\s\S]*?)<\/script>/)?.[1] ?? "";
    expect(/^[\x00-\x7f]*$/.test(dock)).toBe(true);
    expect(() => new Function(dock)).not.toThrow();
    expect(dock).toContain("/_ravi/chat");
    expect(dock).toContain('"barId":"ravi-pages-toolbar"');
    expect(html.indexOf("data-ravi-chat-dock")).toBeLessThan(html.indexOf("data-ravi-pages-toolbar"));
  });

  test("keeps the bar without the chat entry and replaces <ravi-chat> with a note when chat is off", async () => {
    const response = await servePage("<!doctype html><body><ravi-chat></ravi-chat></body>", { toolbar: true, pageChat: false });
    const html = await response.text();
    expect(html).toContain('"chatUrl":null');
    expect(html).not.toContain('<script data-ravi-chat-dock="1">');
    expect(html).not.toContain("ravi-chat-frame");
    expect(html).toContain("A conversa n&atilde;o est&aacute; dispon&iacute;vel nesta p&aacute;gina.");
  });

  test("asks anonymous visitors to sign in where a page embeds <ravi-chat>, and leaves other pages byte for byte", async () => {
    const response = await servePage("<!doctype html><body><p>Oi</p><RAVI-CHAT></RAVI-CHAT></body>", { withSession: false });
    const html = await response.text();
    expect(html).toContain("Entre para conversar");
    expect(html).toContain('href="https://console.ravi.bot/api/pages/auth/start?returnTo=https%3A%2F%2Fdemo.ravi.page%2F"');
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("vary")).toContain("Cookie");

    const page = "<!doctype html><body><p>Olá, sem conversa</p></body>";
    const untouched = await servePage(page, { withSession: false });
    expect(await untouched.text()).toBe(page);
    expect(untouched.headers.get("content-length")).toBe(String(new TextEncoder().encode(page).length));
  });

  test("gives guests the dock behind the existing floating button", async () => {
    const response = await servePage("<!doctype html><head></head><body><ravi-chat></ravi-chat></body>", { guestChat: true });
    const html = await response.text();
    expect(response.headers.get("x-ravi-pages-guest-chat")).toBe("1");
    expect(html).toContain('<script data-ravi-chat-dock="1">');
    expect(html).toContain('"barId":null');
    expect(html).toContain("ravi-chat-frame");
    const guest = html.match(/<script data-ravi-page-guest-chat="1">([\s\S]*?)<\/script>/)?.[1] ?? "";
    expect(guest).toContain("window.__raviChatDock");
    expect(guest).toContain("dock.toggle(link)");
    expect(html).not.toContain("ravi-pages-toolbar\"");
  });
});
