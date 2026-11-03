import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { CaptureBrowser } from "./browser";

/** Explicit local proof: binds a random loopback port, generates a test-only certificate,
 * pins its SPKI, launches real Chromium. Never uses blanket ignoreHTTPSErrors. */
test.skipIf(process.env.PAGES_BROWSER_TEST !== "1")("real TLS capture renders with host-only cookie and blocks off-origin subrequests", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pages-capture-proof-"));
  const key = join(dir, "test.key");
  const cert = join(dir, "test.crt");
  const generated = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=capture.pages.test", "-addext", "subjectAltName=DNS:capture.pages.test"], { stdio: "pipe" });
  expect(generated.status).toBe(0);
  const publicKey = spawnSync("openssl", ["x509", "-in", cert, "-pubkey", "-noout"], { stdio: "pipe" });
  const der = spawnSync("openssl", ["pkey", "-pubin", "-outform", "der"], { input: publicKey.stdout, stdio: "pipe" });
  expect(der.status).toBe(0);
  const pin = createHash("sha256").update(der.stdout).digest("base64");
  let cookieSeen = false;
  let captureMarkerSeen = false;
  let blockedHostRequests = 0;
  const untrusted = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() { blockedHostRequests++; return new Response("must not arrive"); } });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", tls: { key: readFileSync(key), cert: readFileSync(cert) }, fetch(request) {
    cookieSeen ||= request.headers.get("cookie")?.includes("__Host-ravi_page_session=synthetic-capture-cookie") ?? false;
    captureMarkerSeen ||= request.headers.get("x-ravi-pages-capture") === "thumbnail";
    return new Response(`<html><head><title>Capture proof</title></head><body style="background:#183025;color:white;font:48px sans-serif"><h1>Ravi Pages capture</h1><script>fetch(${JSON.stringify(untrusted.url.toString())}).catch(()=>{});</script></body></html>`, { headers: { "content-type": "text/html" } });
  } });
  try {
    const browser = new CaptureBrowser({ tlsSpki: pin, hostResolverRules: `MAP capture.pages.test 127.0.0.1:${server.port}`, executablePath: process.env.RAVI_PAGES_BROWSER_EXECUTABLE ?? (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined) });
    const result = await browser.quickAction("screenshot", {
      url: "https://capture.pages.test/page", cookies: [{ name: "__Host-ravi_page_session", value: "synthetic-capture-cookie", domain: "capture.pages.test", path: "/", secure: true, httpOnly: true, sameSite: "Lax" }],
      setExtraHTTPHeaders: { "x-ravi-pages-capture": "thumbnail" }, viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
      screenshotOptions: { type: "jpeg", quality: 82 }, actionTimeout: 10_000,
    });
    expect(result.status).toBe(200);
    const bytes = new Uint8Array(await result.arrayBuffer());
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8);
    expect(bytes.length).toBeGreaterThan(5000);
    expect(cookieSeen).toBe(true);
    expect(captureMarkerSeen).toBe(true);
    expect(blockedHostRequests).toBe(0);
  } finally { await server.stop(true); await untrusted.stop(true); rmSync(dir, { recursive: true }); }
}, 30_000);
