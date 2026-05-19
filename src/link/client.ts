/**
 * Ravi Link (`link.ravi.so`) — typed CLI client.
 *
 * The Ravi connectors Worker is hosted on `link.ravi.so` (see
 * `console/connectors/SPEC.md` in the Console repo). It accepts the same
 * CLI JWT bearer Console issues, so this client reuses the existing
 * cloud-auth credential store.
 *
 * Plaintext provider tokens never appear in this module; the Worker is
 * the only component that ever holds them.
 */

import { CloudAuthError, normalizeCloudAuthErrorCode, type CloudAuthErrorCode } from "../cloud-auth/errors.js";
import { fetchWithTimeout } from "../utils/paths.js";

export const DEFAULT_LINK_URL = "https://link.ravi.so";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface LinkApiClientOptions {
  linkUrl?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export class LinkApiClient {
  readonly linkUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: LinkApiClientOptions = {}) {
    this.linkUrl = normalizeLinkUrl(options.linkUrl ?? process.env.RAVI_LINK_URL ?? DEFAULT_LINK_URL);
    this.fetchImpl =
      options.fetch ??
      ((url, init) => {
        return fetchWithTimeout(url, init, options.timeoutMs ?? 30_000);
      });
  }

  async request<T>(method: string, path: string, accessToken: string, body?: unknown): Promise<T> {
    const init: RequestInit = {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
    };
    if (body !== undefined) init.body = JSON.stringify(body);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.linkUrl}${path}`, init);
    } catch (error) {
      throw new CloudAuthError("SERVER_UNAVAILABLE", `Ravi Link request failed: ${errMessage(error)}`, {
        cause: error,
      });
    }

    const payload = await readBody(response);
    if (!response.ok) {
      throw mapLinkError(response.status, payload);
    }
    return payload as T;
  }
}

export function normalizeLinkUrl(value: string): string {
  let url = value.trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url.replace(/\/$/, "");
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: "invalid_response", body: text };
  }
}

function mapLinkError(status: number, payload: unknown): CloudAuthError {
  const linkCode = stringField(payload, "error") ?? "unknown";
  const fallback = defaultCodeForStatus(status);
  const code = normalizeCloudAuthErrorCode(linkCode, fallback);
  return new CloudAuthError(code, `Ravi Link request failed (${status}): ${linkCode}`, {
    status,
  });
}

function defaultCodeForStatus(status: number): CloudAuthErrorCode {
  if (status === 401) return "AUTH_EXPIRED";
  if (status === 403) return "PROJECT_ACCESS_DENIED";
  if (status === 404) return "PAYLOAD_INVALID";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "SERVER_UNAVAILABLE";
  return "PAYLOAD_INVALID";
}

function stringField(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
