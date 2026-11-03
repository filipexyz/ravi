import { chromium, type Browser } from "playwright";
import type { BrowserRunLike } from "../src/index";

/** Bounded, same-origin capture, isolated from public browser/SSR work. */
export class CaptureBrowser implements BrowserRunLike {
  private busy = false;
  constructor(private readonly config: { executablePath?: string; tlsSpki?: string; hostResolverRules?: string } = {}) {
    if (config.tlsSpki && !config.tlsSpki.split(",").every((pin) => /^[A-Za-z0-9+/]{43}=$/.test(pin))) throw new Error("pages_capture_tls_pin_invalid");
  }
  async quickAction(_action: "screenshot", raw: Record<string, unknown>): Promise<Response> {
    if (this.busy) return new Response(null, { status: 429 });
    this.busy = true;
    let browser: Browser | undefined;
    try {
      const target = new URL(String(raw.url));
      if (target.protocol !== "https:" || target.username || target.password || target.port) throw new Error("capture_target_invalid");
      const viewport = raw.viewport as { width: number; height: number; deviceScaleFactor?: number };
      const timeout = Math.min(30_000, Math.max(1000, Number(raw.actionTimeout) || 15_000));
      const screenshot = raw.screenshotOptions as { quality?: number };
      const cookies = raw.cookies as Array<{ name: string; value: string; domain: string; path: string; httpOnly: boolean; secure: boolean; sameSite: "Lax" }>;
      browser = await chromium.launch({
        headless: true,
        executablePath: this.config.executablePath,
        chromiumSandbox: true,
        args: [
          ...(this.config.tlsSpki ? [`--ignore-certificate-errors-spki-list=${this.config.tlsSpki}`] : []),
          ...(this.config.hostResolverRules ? [`--host-resolver-rules=${this.config.hostResolverRules}`] : []),
        ],
        timeout,
      });
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
        serviceWorkers: "block",
        acceptDownloads: false,
        extraHTTPHeaders: raw.setExtraHTTPHeaders as Record<string, string>,
      });
      await context.addCookies(cookies);
      await context.route("**/*", async (route) => {
        let allowed = false;
        try { allowed = new URL(route.request().url()).origin === target.origin; } catch { /* fail closed */ }
        if (allowed) await route.continue(); else await route.abort("blockedbyclient");
      });
      // No outgoing WebSockets are needed to render a static capture. Blocking
      // them also prevents a page using WS as an off-origin network escape.
      await context.routeWebSocket("**/*", (socket) => socket.close());
      const page = await context.newPage();
      page.setDefaultTimeout(timeout);
      page.setDefaultNavigationTimeout(timeout);
      const response = await page.goto(target.toString(), { waitUntil: "domcontentloaded", timeout });
      if (!response?.ok() || new URL(page.url()).origin !== target.origin) throw new Error("capture_navigation_failed");
      // An always-open poll must not hold captures forever.
      await page.waitForLoadState("networkidle", { timeout: Math.min(timeout, 3000) }).catch(() => undefined);
      const bytes = await page.screenshot({ type: "jpeg", quality: screenshot.quality ?? 82, fullPage: false, timeout });
      return new Response(new Uint8Array(bytes), { headers: { "content-type": "image/jpeg" } });
    } finally { await browser?.close().catch(() => undefined); this.busy = false; }
  }
}
