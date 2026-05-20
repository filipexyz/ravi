/**
 * HTTP client for the Console agent-inbox CLI endpoints.
 *
 * All requests carry a bearer access token. The caller is responsible for
 * passing a token that has the relevant `console.inbox.*` scopes; the Console
 * itself enforces scope and authorization.
 */

import { ConsoleApiClient } from "../cloud-auth/client.js";
import { CloudAuthError } from "../cloud-auth/errors.js";
import type { ConsolePollResponse, ConsolePulseResponse, ConsoleSubscriptionPayload } from "./types.js";

export interface PulseConditional {
  generation?: number | null;
  latestSequence?: number | null;
  lastDeliveredSequence?: number | null;
  etag?: string | null;
}

export interface PulseResult {
  status: number;
  pulse: ConsolePulseResponse | null;
  etag: string | null;
  generation: number | null;
  latestSequence: number | null;
}

/**
 * Send a cheap pulse check. Returns either the fresh pulse payload (200), a
 * not-modified signal (304/204) without body, or throws on auth/transport
 * errors.
 */
export async function fetchInboxPulse(
  client: ConsoleApiClient,
  accessToken: string,
  conditional?: PulseConditional,
): Promise<PulseResult> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${accessToken}`,
  };
  if (conditional?.generation !== undefined && conditional.generation !== null) {
    headers["X-Ravi-Inbox-Generation"] = String(conditional.generation);
  }
  if (conditional?.lastDeliveredSequence !== undefined && conditional.lastDeliveredSequence !== null) {
    headers["X-Ravi-Inbox-Last-Delivered-Sequence"] = String(conditional.lastDeliveredSequence);
  }
  if (conditional?.etag) {
    headers["If-None-Match"] = conditional.etag;
  }

  const response = await rawFetch(client, "GET", "/api/cli/inbox/pulse", undefined, headers);

  if (response.status === 304 || response.status === 204) {
    return {
      status: response.status,
      pulse: null,
      etag: response.headers.get("etag"),
      generation: numberHeader(response, "x-ravi-inbox-generation"),
      latestSequence: numberHeader(response, "x-ravi-inbox-latest-sequence"),
    };
  }

  if (!response.ok) {
    const payload = await readBody(response);
    throw mapInboxError(response.status, payload, "inbox pulse failed");
  }

  const payload = (await readBody(response)) as ConsolePulseResponse;
  return {
    status: response.status,
    pulse: payload,
    etag: response.headers.get("etag"),
    generation: numberHeader(response, "x-ravi-inbox-generation"),
    latestSequence: numberHeader(response, "x-ravi-inbox-latest-sequence"),
  };
}

/**
 * Upsert the global Console inbox subscription. Idempotent.
 */
export async function upsertGlobalInboxSubscription(
  client: ConsoleApiClient,
  accessToken: string,
  body?: Record<string, unknown>,
): Promise<{ subscription: ConsoleSubscriptionPayload }> {
  return jsonRequest<{ subscription: ConsoleSubscriptionPayload }>(
    client,
    "PUT",
    "/api/cli/inbox/subscriptions/global",
    accessToken,
    body ?? {},
  );
}

/**
 * Lease the next batch of inbox items. The Console returns at most `limit`
 * items and a lease that expires after a fixed window; the runner must ack
 * each item before that lease expires.
 */
export async function pollInboxItems(
  client: ConsoleApiClient,
  accessToken: string,
  input: { limit?: number; subscriptionId?: string | null } = {},
): Promise<ConsolePollResponse> {
  const body: Record<string, unknown> = {};
  if (input.limit !== undefined) body.limit = input.limit;
  if (input.subscriptionId) body.subscriptionId = input.subscriptionId;
  return jsonRequest<ConsolePollResponse>(client, "POST", "/api/cli/inbox/poll", accessToken, body);
}

/**
 * Acknowledge one or more inbox items. The Console advances the subscription
 * cursor once all preceding items are acked.
 */
export async function ackInboxItems(
  client: ConsoleApiClient,
  accessToken: string,
  input: {
    acks: Array<{
      itemId: string;
      status?: "delivered" | "read" | "resolved" | "failed" | "skipped";
      leaseId?: string;
      errorCode?: string;
      localEventId?: string;
    }>;
    subscriptionId?: string | null;
  },
): Promise<{ acked: number }> {
  const body: Record<string, unknown> = { acks: input.acks };
  if (input.subscriptionId) body.subscriptionId = input.subscriptionId;
  return jsonRequest<{ acked: number }>(client, "POST", "/api/cli/inbox/ack", accessToken, body);
}

async function rawFetch(
  client: ConsoleApiClient,
  method: string,
  path: string,
  body: unknown | undefined,
  headers: Record<string, string>,
): Promise<Response> {
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { ...headers, "Content-Type": "application/json" };
  }
  try {
    return await fetch(`${client.consoleUrl}${path}`, init);
  } catch (error) {
    throw new CloudAuthError("SERVER_UNAVAILABLE", `Console inbox request failed: ${errMsg(error)}`, {
      cause: error,
    });
  }
}

async function jsonRequest<T>(
  client: ConsoleApiClient,
  method: string,
  path: string,
  accessToken: string,
  body: unknown,
): Promise<T> {
  const response = await rawFetch(client, method, path, body, {
    Accept: "application/json",
    Authorization: `Bearer ${accessToken}`,
  });
  const payload = await readBody(response);
  if (!response.ok) {
    throw mapInboxError(response.status, payload, `inbox ${method} ${path} failed`);
  }
  return (payload ?? {}) as T;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text };
  }
}

function numberHeader(response: Response, name: string): number | null {
  const raw = response.headers.get(name);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function mapInboxError(status: number, payload: unknown, fallback: string): CloudAuthError {
  const data = isObject(payload) ? payload : null;
  const code = stringValue(data?.code) ?? stringValue((data?.error as Record<string, unknown> | undefined)?.code);
  const message = stringValue(data?.message) ?? stringValue(data?.error_description) ?? fallback;

  if (status === 401) {
    return new CloudAuthError(normalizeAuth(code) ?? "AUTH_EXPIRED", message, { status });
  }
  if (status === 403) return new CloudAuthError("ORG_ACCESS_DENIED", message, { status });
  if (status === 410) return new CloudAuthError("INSTALLATION_REVOKED", message, { status });
  if (status === 429) return new CloudAuthError("RATE_LIMITED", message, { status });
  if (status >= 500) return new CloudAuthError("SERVER_UNAVAILABLE", message, { status });
  return new CloudAuthError("PAYLOAD_INVALID", message, { status });
}

function normalizeAuth(code: string | null): "AUTH_REQUIRED" | "AUTH_EXPIRED" | "INSTALLATION_REVOKED" | null {
  if (!code) return null;
  const normalized = code.toUpperCase();
  if (normalized === "AUTH_REQUIRED") return "AUTH_REQUIRED";
  if (normalized === "AUTH_EXPIRED") return "AUTH_EXPIRED";
  if (normalized === "INSTALLATION_REVOKED") return "INSTALLATION_REVOKED";
  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
