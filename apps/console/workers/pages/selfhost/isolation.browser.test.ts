import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { chromium } from "playwright";
import worker, { type PagesWorkerEnv } from "../src/index";

/** Actual Worker and browser; synthetic Console/storage. NOT real IdP acceptance. */
test.skipIf(process.env.PAGES_BROWSER_TEST !== "1")("hostile Page A cannot obtain Page B credentials/context or call B's bridge", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pages-origin-proof-"));
  const key = join(dir, "test.key");
  const cert = join(dir, "test.crt");
  const hosts = ["alpha.pages.test", "beta.pages.test"];
  const generated = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=pages.test", "-addext", `subjectAltName=${hosts.map((host) => `DNS:${host}`).join(",")}`], { stdio: "pipe" });
  expect(generated.status).toBe(0);
  const publicKey = spawnSync("openssl", ["x509", "-in", cert, "-pubkey", "-noout"], { stdio: "pipe" });
  const der = spawnSync("openssl", ["pkey", "-pubin", "-outform", "der"], { input: publicKey.stdout, stdio: "pipe" });
  expect(der.status).toBe(0);
  const pin = createHash("sha256").update(der.stdout).digest("base64");
  const tokens = { "alpha.pages.test": "syntheticAlphaSession12345678901234567890", "beta.pages.test": "syntheticBetaSession12345678901234567890" };
  const forwarded: Array<Record<string, unknown>> = [];
  const requests: Array<{ host: string; cookie: string | null; path: string; status: number }> = [];
  const control = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const input = await request.json() as Record<string, unknown>;
    const host = input.host as keyof typeof tokens;
    if (request.url.includes("connectors/")) {
      forwarded.push(input);
      if (input.pagesSession !== tokens[host]) return Response.json({ error: "connector_unauthorized" }, { status: 401 });
      return Response.json({ ok: true, id: input.id, revision: 1, output: { host } });
    }
    return Response.json({ status: "ok", site: { id: host, organizationId: "org", projectId: "project", visibility: "private" }, release: { id: "release" },
      route: { id: "route", path: "/", matchType: "prefix", visibility: "private" },
      artifact: { id: "artifact", versionId: "version", entrypoint: "index.html" },
      object: { r2Key: "org/org/project/project/artifact/artifact/version/version/index.html", contentType: "text/html", cache: "private" } });
  } });
  const env: PagesWorkerEnv = { RAVI_CONSOLE_API_URL: control.url.toString(), RAVI_PAGES_CONTROL_TOKEN: "synthetic-control",
    RAVI_PAGES_ASSETS: { async get(key) {
      if (key.startsWith("sites/")) return null;
      return { body: new Response("<!doctype html><html><head><title>Origin fixture</title></head><body>Private Page origin fixture</body></html>").body!, httpMetadata: { contentType: "text/html" } };
    } } };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { key: readFileSync(key), cert: readFileSync(cert) }, async fetch(request) {
    const response = await worker.fetch(request, env);
    requests.push({ host: new URL(request.url).hostname, path: new URL(request.url).pathname, cookie: request.headers.get("cookie"), status: response.status });
    return response;
  } });
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true,
    executablePath: process.env.RAVI_PAGES_BROWSER_EXECUTABLE ?? (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined),
    args: [`--ignore-certificate-errors-spki-list=${pin}`, `--host-resolver-rules=${hosts.map((host) => `MAP ${host} 127.0.0.1:${server.port}`).join(",")}`],
  });
  try {
    const context = await browser.newContext({ serviceWorkers: "block" });
    await context.addCookies(hosts.map((host) => ({ name: "__Host-ravi_page_session", value: tokens[host as keyof typeof tokens],
      url: `https://${host}/`, secure: true, httpOnly: true, sameSite: "Lax" as const })));
    const a = await context.newPage();
    const response = await a.goto("https://alpha.pages.test/");
    expect(response?.status()).toBe(200);
    expect(await response?.headerValue("origin-agent-cluster")).toBe("?1");
    expect(await a.evaluate(() => document.cookie)).toBe("");
    expect(await a.evaluate(() => {
      try { document.domain = "pages.test"; } catch { /* refusal is fine */ }
      return document.domain;
    })).toBe("alpha.pages.test");

    // Both Pages already have the same human signed in. A simple cross-origin
    // POST needs no preflight, so only the actual bridge origin gate blocks it.
    const attack = await a.evaluate(async () => {
      try {
        const response = await fetch("https://beta.pages.test/_ravi/connectors/exec", { method: "POST", credentials: "include",
          headers: { "content-type": "text/plain" }, body: JSON.stringify({ id: "ravi.projects.list", input: {} }) });
        return { readable: true, status: response.status };
      } catch { return { readable: false }; }
    });
    expect(attack).toEqual({ readable: false });
    expect(requests.some(({ host, path, status }) => host === "beta.pages.test" && path.endsWith("/exec") && status === 401)).toBe(true);
    expect(forwarded).toHaveLength(0);
    expect(await a.evaluate(async () => {
      try { return await (await fetch("https://beta.pages.test/", { credentials: "include" })).text(); }
      catch { return "blocked"; }
    })).toBe("blocked");

    // Body-supplied identity is not trusted even on A's own same-origin bridge.
    const own = await a.evaluate(async () => (await fetch("/_ravi/connectors/exec", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "ravi.projects.list", input: {}, host: "beta.pages.test", pagesSession: "invented-other-host-secret" }),
    })).json());
    expect(own.output).toEqual({ host: "alpha.pages.test" });
    expect(forwarded.at(-1)).toMatchObject({ host: "alpha.pages.test", pagesSession: tokens["alpha.pages.test"], origin: "https://alpha.pages.test" });
    expect(requests.filter(({ host }) => host === "alpha.pages.test").every(({ cookie }) => !cookie?.includes(tokens["beta.pages.test"]))).toBe(true);
    const b = await context.newPage();
    expect((await b.goto("https://beta.pages.test/"))?.status()).toBe(200);
    expect(await b.evaluate(() => document.cookie)).toBe("");
    await context.close();
  } finally {
    await browser.close(); await server.stop(true); await control.stop(true);
    rmSync(dir, { recursive: true });
  }
}, 30_000);
