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

export class LinkStepUpRequiredError extends Error {
  constructor(public readonly details: { challengeId: string; verificationUrl: string; expiresAt: string }) {
    super("Step-up authentication required");
    this.name = "LinkStepUpRequiredError";
  }
}

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

  async request<T>(
    method: string,
    path: string,
    accessToken: string,
    body?: unknown,
    options: { headers?: Record<string, string> } = {},
  ): Promise<T> {
    const init: RequestInit = {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(options.headers ?? {}),
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
    if (response.status === 409 && stringField(payload, "error") === "connector_stepup_required") {
      const challengeId = stringField(payload, "challengeId") ?? "";
      const verificationUrl = stringField(payload, "verificationUrl") ?? "";
      const expiresAt = stringField(payload, "expiresAt") ?? new Date().toISOString();
      throw new LinkStepUpRequiredError({ challengeId, verificationUrl, expiresAt });
    }
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
  const details =
    code === "CONNECTOR_APPROVAL_REQUIRED" || code === "CONNECTOR_APPROVAL_PENDING"
      ? approvalDetails(payload)
      : code === "CONNECTOR_PERMISSION_REQUIRED"
        ? permissionDetails(payload)
        : code === "CONNECTOR_CONSENT_REQUIRED"
          ? consentDetails(payload)
          : REFUSAL_REASON_CODES.has(code) || linkCode === "connector_unavailable"
            ? reasonDetails(payload)
            : null;
  return new CloudAuthError(code, `Ravi Link request failed (${status}): ${linkCode}`, {
    status,
    ...(details ? { details } : {}),
  });
}

export const APPROVAL_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const APPROVAL_REASON_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * What an approval answer may carry onward: the approval id, its expiry and a
 * short reason code. The approval page is rebuilt from the Console the CLI is
 * logged in to, so the link Link sends is not kept.
 */
function approvalDetails(payload: unknown): Record<string, string> | null {
  const approvalId = stringField(payload, "approvalId");
  if (!approvalId || !APPROVAL_ID_PATTERN.test(approvalId)) return null;
  const details: Record<string, string> = { approvalId };
  const expiresAt = stringField(payload, "expiresAt");
  if (expiresAt && Number.isFinite(Date.parse(expiresAt))) details.expiresAt = expiresAt;
  const reason = stringField(payload, "reason");
  if (reason && APPROVAL_REASON_PATTERN.test(reason)) details.reason = reason;
  return details;
}

/** Token of a Console consent page (`/connectors/consent/<token>`, base64url). */
export const CONSENT_REF_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;
const CONSENT_PATH_PATTERN = /\/connectors\/consent\/([A-Za-z0-9_-]{16,256})$/;

/**
 * A consent answer keeps the token of the consent page and its expiry. The
 * page itself is rebuilt from the Console the CLI is logged in to, so the
 * rest of the link Link sends is not kept.
 */
function consentDetails(payload: unknown): Record<string, string> | null {
  const consentUrl = stringField(payload, "consentUrl");
  if (!consentUrl) return null;
  let pathname: string;
  try {
    pathname = new URL(consentUrl).pathname;
  } catch {
    return null;
  }
  const ref = CONSENT_PATH_PATTERN.exec(pathname)?.[1];
  if (!ref) return null;
  const details: Record<string, string> = { consentRef: ref };
  const expiresAt = stringField(payload, "expiresAt");
  if (expiresAt && Number.isFinite(Date.parse(expiresAt))) details.expiresAt = expiresAt;
  return details;
}

/**
 * Agent exec refusals keep their short reason code (`speaker_not_member`,
 * `conversation_not_shared`, ...); so does `connector_unavailable`, which
 * has no code of its own (`shared_connection_unavailable`: the shared
 * account was revoked or paused).
 */
const REFUSAL_REASON_CODES: ReadonlySet<CloudAuthErrorCode> = new Set([
  "CONNECTOR_NOT_LINKED",
  "CONNECTOR_FORBIDDEN",
  "CONNECTOR_GROUP_BLOCKED",
  "CONNECTOR_SPEAKER_NOT_OWNER",
]);

function reasonDetails(payload: unknown): Record<string, string> | null {
  const reason = stringField(payload, "reason");
  return reason && APPROVAL_REASON_PATTERN.test(reason) ? { reason } : null;
}

/** A permission answer keeps only whether the connection is read only. */
function permissionDetails(payload: unknown): Record<string, string> | null {
  return stringField(payload, "accessMode") === "read_only" ? { accessMode: "read_only" } : null;
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
