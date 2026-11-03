"use client";

import * as Sentry from "@sentry/nextjs";

import { organizationHeaders } from "./organization";

/**
 * Browser client for the Console's own APIs. It reads both error envelopes:
 * `/api/console/**` answers `{ error, fieldErrors?, eventId? }` and
 * `/api/internal/**` answers `{ status: "error", code, message? }`.
 * Every failure, GET included, throws an ApiError that screens can render.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: {
      eventId?: string;
      fieldErrors?: Record<string, string>;
      reason?: string;
      path?: string;
      body?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "ApiError";
  }

  get eventId() {
    return this.extra.eventId;
  }

  get fieldErrors() {
    return this.extra.fieldErrors;
  }
}

type ErrorBody = {
  error?: unknown;
  code?: unknown;
  message?: unknown;
  reason?: unknown;
  eventId?: unknown;
  fieldErrors?: unknown;
};

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function toApiError(response: Response, body: unknown, path: string) {
  const data = (body && typeof body === "object" ? body : {}) as ErrorBody;
  const code =
    (typeof data.error === "string" && data.error) ||
    (typeof data.code === "string" && data.code) ||
    `http_${response.status}`;
  const message =
    (typeof data.message === "string" && data.message) ||
    (typeof data.reason === "string" && data.reason) ||
    code;
  return new ApiError(response.status, code, message, {
    body,
    eventId: typeof data.eventId === "string" ? data.eventId : undefined,
    fieldErrors:
      data.fieldErrors && typeof data.fieldErrors === "object"
        ? (data.fieldErrors as Record<string, string>)
        : undefined,
    path,
    reason: typeof data.reason === "string" ? data.reason : undefined,
  });
}

async function request<T>(method: string, path: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        Accept: "application/json",
        ...organizationHeaders(),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...init.headers,
      },
      method,
    });
  } catch (cause) {
    throw new ApiError(0, "network_error", "Could not reach the Console. Check your connection and try again.", { path });
  }
  const parsed = await readBody(response);
  if (!response.ok) {
    const error = toApiError(response, parsed, path);
    if (response.status >= 500) {
      Sentry.captureMessage("Console API request failed", {
        level: "error",
        tags: { feature: "console-api", method, status: String(response.status), surface: "console-client" },
        contexts: { consoleApi: { code: error.code, eventId: error.eventId ?? null, path, status: response.status } },
      });
    }
    throw error;
  }
  return parsed as T;
}

export const api = {
  get: <T>(path: string, init?: RequestInit) => request<T>("GET", path, undefined, init),
  post: <T>(path: string, body: unknown = {}, init?: RequestInit) => request<T>("POST", path, body, init),
  patch: <T>(path: string, body: unknown = {}, init?: RequestInit) => request<T>("PATCH", path, body, init),
  delete: <T>(path: string, init?: RequestInit) => request<T>("DELETE", path, undefined, init),
};

const friendly: Record<string, string> = {
  unauthenticated: "Your session ended. Sign in again.",
  unauthorized: "Your session ended. Sign in again.",
  feature_unavailable: "This isn't enabled for this organization.",
  feature_forbidden: "Your role doesn't include this.",
  forbidden: "Your role doesn't allow this.",
  not_found: "It doesn't exist, or you don't have access to it.",
  workspace_selection_required: "Choose an organization first.",
  organization_selection_required: "Choose an organization first.",
  internal_error: "Something went wrong on our side.",
  server_not_configured: "This service isn't configured on this Console.",
  network_error: "Could not reach the Console. Check your connection and try again.",
};

/** One sentence a person can read, for any thrown value. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (friendly[error.code]) return friendly[error.code] as string;
    if (error.status === 403) return "Your role doesn't allow this.";
    if (error.status === 404) return "It doesn't exist, or you don't have access to it.";
    if (error.status >= 500) return "Something went wrong on our side.";
    if (error.message && error.message !== error.code) return error.message;
    return humanizeCode(error.code);
  }
  if (error instanceof Error && error.message) return error.message;
  return "Something went wrong.";
}

export function isAccessError(error: unknown) {
  return error instanceof ApiError && (error.status === 403 || error.code === "feature_forbidden");
}

export function isNotFound(error: unknown) {
  return error instanceof ApiError && error.status === 404;
}

function humanizeCode(code: string) {
  const text = code.replace(/[_-]+/g, " ").trim();
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}.` : "Something went wrong.";
}
