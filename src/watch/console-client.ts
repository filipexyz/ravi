import { randomUUID } from "node:crypto";
import { ConsoleApiClient, refreshCredentialsForStore } from "../cloud-auth/client.js";
import { isCloudAuthError } from "../cloud-auth/errors.js";
import { deleteCloudCredentials, readCloudCredentials, writeCloudCredentials } from "../cloud-auth/storage.js";
import type { CloudCredentials } from "../cloud-auth/types.js";
import { WatchApiError } from "./errors.js";
import type { ConsoleWatch, ConsoleWatchCreateRequest, WatchCapabilities } from "./types.js";

export interface ConsoleInstallation {
  id: string;
  providerInstallationId?: string;
  accountLogin?: string;
  accountType?: string;
  status?: string;
  [key: string]: unknown;
}

export interface ConsoleInstallationRepo {
  id: string;
  providerResourceId?: string;
  fullName?: string;
  owner?: string;
  name?: string;
  private?: boolean;
  selected?: boolean;
  [key: string]: unknown;
}

export interface AuthenticatedWatchClient {
  client: ConsoleApiClient;
  credentials: CloudCredentials;
  accessToken: string;
}

export async function authenticateWatchClient(): Promise<AuthenticatedWatchClient> {
  const credentials = readCloudCredentials();
  if (!credentials) {
    throw new WatchApiError("AUTH_REQUIRED", "Ravi Cloud login required. Run `ravi login`.");
  }
  const client = new ConsoleApiClient({ consoleUrl: credentials.consoleUrl });
  return { client, credentials, accessToken: credentials.accessToken };
}

export async function getWatchCapabilities(input: {
  provider: string;
  eventTypes?: string[];
}): Promise<WatchCapabilities> {
  const ctx = await authenticateWatchClient();
  const params = new URLSearchParams({ provider: input.provider });
  if (input.eventTypes?.length) params.set("eventTypes", input.eventTypes.join(","));
  return requestWithRefresh<WatchCapabilities>(ctx, "GET", `/api/cli/watches/capabilities?${params.toString()}`);
}

export async function listGithubInstallations(): Promise<ConsoleInstallation[]> {
  const ctx = await authenticateWatchClient();
  const result = await requestWithRefresh<{ installations?: ConsoleInstallation[]; items?: ConsoleInstallation[] }>(
    ctx,
    "GET",
    "/api/cli/watches/providers/github/installations",
  );
  return result.installations ?? result.items ?? [];
}

export async function listGithubInstallationRepos(input: {
  installationId: string;
  q?: string;
  limit?: number;
  cursor?: string;
}): Promise<{ repos: ConsoleInstallationRepo[]; nextCursor?: string | null }> {
  const ctx = await authenticateWatchClient();
  const params = new URLSearchParams();
  if (input.q) params.set("q", input.q);
  if (input.limit) params.set("limit", String(input.limit));
  if (input.cursor) params.set("cursor", input.cursor);
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  const result = await requestWithRefresh<{
    repos?: ConsoleInstallationRepo[];
    items?: ConsoleInstallationRepo[];
    nextCursor?: string | null;
  }>(
    ctx,
    "GET",
    `/api/cli/watches/providers/github/installations/${encodeURIComponent(input.installationId)}/repos${suffix}`,
  );
  return { repos: result.repos ?? result.items ?? [], nextCursor: result.nextCursor ?? null };
}

export async function createConsoleWatch(input: ConsoleWatchCreateRequest): Promise<ConsoleWatch> {
  const ctx = await authenticateWatchClient();
  const result = await requestWithRefresh<{ watch?: ConsoleWatch } | ConsoleWatch>(
    ctx,
    "POST",
    "/api/cli/watches",
    input,
    { "Idempotency-Key": input.idempotencyKey ?? input.clientRequestId ?? randomUUID() },
  );
  return unwrapConsoleWatch(result);
}

export async function listConsoleWatches(): Promise<ConsoleWatch[]> {
  const ctx = await authenticateWatchClient();
  const result = await requestWithRefresh<{ watches?: ConsoleWatch[]; items?: ConsoleWatch[] }>(
    ctx,
    "GET",
    "/api/cli/watches",
  );
  return result.watches ?? result.items ?? [];
}

export async function getConsoleWatch(id: string): Promise<ConsoleWatch> {
  const ctx = await authenticateWatchClient();
  const result = await requestWithRefresh<{ watch?: ConsoleWatch } | ConsoleWatch>(
    ctx,
    "GET",
    `/api/cli/watches/${encodeURIComponent(id)}`,
  );
  return unwrapConsoleWatch(result);
}

export async function setConsoleWatchEnabled(id: string, enabled: boolean): Promise<ConsoleWatch> {
  const ctx = await authenticateWatchClient();
  const result = await requestWithRefresh<{ watch?: ConsoleWatch } | ConsoleWatch>(
    ctx,
    "POST",
    `/api/cli/watches/${encodeURIComponent(id)}/${enabled ? "enable" : "disable"}`,
  );
  return unwrapConsoleWatch(result);
}

export async function deleteConsoleWatch(id: string): Promise<void> {
  const ctx = await authenticateWatchClient();
  await requestWithRefresh<Record<string, unknown>>(ctx, "DELETE", `/api/cli/watches/${encodeURIComponent(id)}`);
}

async function requestWithRefresh<T>(
  ctx: AuthenticatedWatchClient,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<T> {
  try {
    return await watchRequest<T>(ctx.client, method, path, ctx.accessToken, body, extraHeaders);
  } catch (error) {
    if (isWatchApiErrorCode(error, "AUTH_EXPIRED")) {
      const refreshed = await refreshCredentialsForStore({
        client: ctx.client,
        credentials: ctx.credentials,
        write: writeCloudCredentials,
        delete: deleteCloudCredentials,
      });
      ctx.credentials = refreshed;
      ctx.accessToken = refreshed.accessToken;
      return watchRequest<T>(ctx.client, method, path, refreshed.accessToken, body, extraHeaders);
    }
    throw error;
  }
}

async function watchRequest<T>(
  client: ConsoleApiClient,
  method: string,
  path: string,
  accessToken: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${client.consoleUrl}${path}`, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(extraHeaders ?? {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    throw new WatchApiError("SERVER_UNAVAILABLE", `Console watch request failed: ${message(error)}`, { cause: error });
  }

  const payload = await readBody(response);
  if (!response.ok) {
    throw watchErrorFromResponse(response.status, payload);
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

function watchErrorFromResponse(status: number, payload: unknown): WatchApiError {
  const data = asObject(payload);
  const nested = asObject(data?.error);
  const code = stringValue(data?.code) ?? stringValue(nested?.code) ?? fallbackCode(status);
  const errorMessage = stringValue(data?.message) ?? stringValue(nested?.message) ?? defaultMessage(code);
  const details = data ? { ...data } : undefined;
  return new WatchApiError(code, errorMessage, { status, details });
}

function isWatchApiErrorCode(error: unknown, code: string): boolean {
  if (error instanceof WatchApiError) return error.code === code;
  if (isCloudAuthError(error)) return error.code === code;
  return false;
}

function fallbackCode(status: number): string {
  if (status === 401) return "AUTH_REQUIRED";
  if (status === 403) return "PROVIDER_PERMISSION_MISSING";
  if (status === 404) return "PROVIDER_RESOURCE_UNAVAILABLE";
  if (status === 409) return "PROVIDER_CONNECTION_UNAVAILABLE";
  if (status === 422) return "WATCH_UNSUPPORTED_EVENT";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "SERVER_UNAVAILABLE";
  return "PAYLOAD_INVALID";
}

function defaultMessage(code: string): string {
  if (code === "AUTH_REQUIRED") return "Login required. Run `ravi login`.";
  return `Console watch request failed: ${code}`;
}

function unwrapConsoleWatch(result: { watch?: ConsoleWatch } | ConsoleWatch): ConsoleWatch {
  const nested = (result as { watch?: ConsoleWatch }).watch;
  return nested ?? (result as ConsoleWatch);
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
