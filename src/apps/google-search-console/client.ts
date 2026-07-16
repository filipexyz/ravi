import { resolveCredentialSecret } from "../../credentials/broker.js";

export interface GoogleSearchConsoleCredential {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface GscClientOptions {
  connection?: string;
  fetch?: typeof globalThis.fetch;
  /** In-process credential injection for migrations and isolated validation. */
  credential?: GoogleSearchConsoleCredential;
}

const SEARCH_CONSOLE = "https://searchconsole.googleapis.com";
const SITE_VERIFICATION = "https://www.googleapis.com/siteVerification/v1";

export class GoogleSearchConsoleClient {
  readonly #connection: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #credential?: GoogleSearchConsoleCredential;
  #accessToken: string | null = null;

  constructor(options: GscClientOptions = {}) {
    this.#connection = options.connection ?? "default";
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#credential = options.credential;
  }

  async listSites() {
    return this.request("/webmasters/v3/sites");
  }

  async getSite(siteUrl: string) {
    return this.request(`/webmasters/v3/sites/${encodeURIComponent(siteUrl)}`);
  }

  async addSite(siteUrl: string) {
    return this.request(`/webmasters/v3/sites/${encodeURIComponent(siteUrl)}`, { method: "PUT" });
  }

  async deleteSite(siteUrl: string) {
    return this.request(`/webmasters/v3/sites/${encodeURIComponent(siteUrl)}`, { method: "DELETE" });
  }

  async query(siteUrl: string, body: Record<string, unknown>) {
    return this.request(`/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async inspect(siteUrl: string, inspectionUrl: string, languageCode?: string) {
    return this.request("/v1/urlInspection/index:inspect", {
      method: "POST",
      body: JSON.stringify({ siteUrl, inspectionUrl, languageCode }),
    });
  }

  async listSitemaps(siteUrl: string) {
    return this.request(`/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/sitemaps`);
  }

  async getSitemap(siteUrl: string, feedpath: string) {
    return this.request(`/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/sitemaps/${encodeURIComponent(feedpath)}`);
  }

  async submitSitemap(siteUrl: string, feedpath: string) {
    return this.request(
      `/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/sitemaps/${encodeURIComponent(feedpath)}`,
      {
        method: "PUT",
      },
    );
  }

  async deleteSitemap(siteUrl: string, feedpath: string) {
    return this.request(
      `/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/sitemaps/${encodeURIComponent(feedpath)}`,
      {
        method: "DELETE",
      },
    );
  }

  async verificationToken(site: { type: "SITE" | "INET_DOMAIN"; identifier: string }, method: string) {
    return this.requestAbsolute(`${SITE_VERIFICATION}/token`, {
      method: "POST",
      body: JSON.stringify({ site, verificationMethod: method }),
    });
  }

  async verifySite(site: { type: "SITE" | "INET_DOMAIN"; identifier: string }, method: string) {
    return this.requestAbsolute(`${SITE_VERIFICATION}/webResource?verificationMethod=${encodeURIComponent(method)}`, {
      method: "POST",
      body: JSON.stringify({ site }),
    });
  }

  private request(path: string, init: RequestInit = {}) {
    return this.requestAbsolute(`${SEARCH_CONSOLE}${path}`, init);
  }

  private async requestAbsolute(url: string, init: RequestInit): Promise<unknown> {
    const token = await this.accessToken();
    const response = await this.#fetch(url, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Google Search Console request failed (${response.status}): ${redact(text)}`);
    return text ? JSON.parse(text) : {};
  }

  private async accessToken(): Promise<string> {
    if (this.#accessToken) return this.#accessToken;
    const credential =
      this.#credential ??
      parseCredential(
        (
          await resolveCredentialSecret({
            provider: "google-search-console",
            connection: this.#connection,
            action: "auth.check",
          })
        ).secret,
      );
    const response = await this.#fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: credential.clientId,
        client_secret: credential.clientSecret,
        refresh_token: credential.refreshToken,
        grant_type: "refresh_token",
      }),
    });
    const payload = (await response.json()) as { access_token?: string; error?: string };
    if (!response.ok || !payload.access_token)
      throw new Error(`Google OAuth refresh failed: ${payload.error ?? response.status}`);
    this.#accessToken = payload.access_token;
    return payload.access_token;
  }
}

export function parseCredential(value: string): GoogleSearchConsoleCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Google Search Console credential must be JSON.");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("Google Search Console credential must be an object.");
  const record = parsed as Record<string, unknown>;
  for (const field of ["clientId", "clientSecret", "refreshToken"] as const) {
    if (typeof record[field] !== "string" || !record[field])
      throw new Error(`Google Search Console credential misses ${field}.`);
  }
  return record as unknown as GoogleSearchConsoleCredential;
}

function redact(value: string): string {
  return value
    .replace(/("(?:access_token|refresh_token|client_secret)"\s*:\s*")[^"]+/gi, "$1[redacted]")
    .slice(0, 1000);
}
