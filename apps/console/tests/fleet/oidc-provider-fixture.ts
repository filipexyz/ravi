import { mkdtemp, readFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { node24Binary, browserBinary } from "./binaries";
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { chromium } from "playwright";

/** Real oidc-provider in Node24; TLS trust is per disposable browser/fetch.
 * No system trust/hosts/env, real IdP or existing Chrome profile is changed. */
export async function oidcProviderFixture(options: { callbackOrigin?: string; interceptFetch?: boolean; email?: string } = {}) {
  const email = options.email ?? "owner@example.invalid";
  const root = await mkdtemp(join(tmpdir(), "fleet-idp-test-"));
  const keyPath = join(root, "key.pem"), certPath = join(root, "cert.pem");
  const command = Bun.spawn(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath,
    "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdout: "ignore", stderr: "ignore" });
  if (await command.exited !== 0) throw new Error("Test TLS generation failed");
  await chmod(keyPath, 0o600);
  const cert = await readFile(certPath);
  const spki = createHash("sha256").update(new X509Certificate(cert).publicKey.export({ type: "spki", format: "der" })).digest("base64");
  const password = randomBytes(24).toString("base64url"), clientSecret = randomBytes(32).toString("base64url");
  const child = Bun.spawn([await node24Binary(), join(import.meta.dir, "oidc-provider-server.ts")], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  child.stdin.write(JSON.stringify({ root, password, clientSecret, email, callbackOrigin: options.callbackOrigin })); child.stdin.end();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const originalFetch = globalThis.fetch;
  const close = async () => { globalThis.fetch = originalFetch; await browser?.close(); child.kill("SIGTERM"); await child.exited; };
  try {
    const reader = child.stdout.getReader(); let ready = "";
    const timeout = setTimeout(() => child.kill("SIGTERM"), 15000);
    try {
      while (!ready.includes("\n")) { const next = await reader.read(); if (next.done) throw new Error("Isolated IdP failed before ready"); ready += new TextDecoder().decode(next.value); }
    } finally { clearTimeout(timeout); reader.releaseLock(); }
    const { origin } = JSON.parse(ready) as { origin: string };
    if (!/^https:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new Error("Invalid fixture origin");
    browser = await chromium.launch({ executablePath: browserBinary(), headless: true,
      chromiumSandbox: true, args: [`--ignore-certificate-errors-spki-list=${spki}`] });
    const page = await browser.newPage();
    await page.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const localFetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (new URL(url).origin !== origin) throw new Error("Test fetch outside isolated IdP refused");
      return originalFetch(input, { ...init, tls: { ca: cert.toString() } });
    }) as typeof fetch;
    localFetch.preconnect = originalFetch.preconnect;
    if (options.interceptFetch !== false) globalThis.fetch = localFetch;
    let logins = 0;
    return { root, origin, clientSecret, password, certPath, keyPath, spki, get logins() { return logins; }, close,
      async login(url: string) {
        // Every invocation proves a fresh credential entry. Only this disposable
        // fixture context is cleared; the real operator browser is never used.
        await page.context().clearCookies();
        await page.goto(url);
        await page.getByLabel("Email", { exact: true }).fill(email);
        await page.getByLabel("Password", { exact: true }).fill(password);
        await page.getByRole("button", { name: "Sign in", exact: true }).click();
        await page.getByRole("heading", { name: "Callback received", exact: true }).waitFor();
        logins = (await (await fetch(`${origin}/fixture/status`)).json() as { logins: number }).logins;
        return new URL(page.url());
      },
    };
  } catch (error) { await close(); throw error; }
}
