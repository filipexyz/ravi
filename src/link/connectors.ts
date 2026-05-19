/**
 * High-level connectors operations against `link.ravi.so`.
 *
 * Each helper wraps an auth-fresh accessToken acquire + a single Link API
 * call. The CLI commands consume these helpers so command-layer code
 * stays focused on UX and exits with consistent errors when the bearer
 * is missing or expired.
 */

import { ConsoleApiClient, getMeWithAutoRefresh } from "../cloud-auth/client.js";
import { CloudAuthError } from "../cloud-auth/errors.js";
import { deleteCloudCredentials, readCloudCredentials, writeCloudCredentials } from "../cloud-auth/storage.js";
import type { CloudCredentials } from "../cloud-auth/types.js";

import { LinkApiClient } from "./client.js";

export interface ConnectorHelperDeps {
  link?: LinkApiClient;
  consoleClient?: ConsoleApiClient;
  readCredentials?: typeof readCloudCredentials;
  writeCredentials?: typeof writeCloudCredentials;
  deleteCredentials?: typeof deleteCloudCredentials;
}

export interface ConnectorListItem {
  id: string;
  provider: string;
  displayName: string;
  status: string;
  requiresReauth: boolean;
  scopes: string[];
  createdAt: string;
}

export interface ConnectorDetail extends ConnectorListItem {
  capabilities: string[];
  externalAccountLogin: string | null;
  grantedAt: string;
  lastReauthAt: string | null;
}

export interface ConnectStartResult {
  connectUrl: string;
  pendingGrantId: string;
  expiresAt: string;
}

export interface ConnectStatusResult {
  status: "pending" | "consumed" | "expired" | "rejected";
  provider: string;
  connectorId: string | null;
  expiresAt: string;
}

export interface ExecResult {
  result: unknown;
  capability: string;
  refreshed: boolean;
}

export interface AuthenticatedLinkContext {
  link: LinkApiClient;
  accessToken: string;
}

async function authenticate(deps: ConnectorHelperDeps): Promise<AuthenticatedLinkContext> {
  const read = deps.readCredentials ?? readCloudCredentials;
  const write = deps.writeCredentials ?? writeCloudCredentials;
  const remove = deps.deleteCredentials ?? deleteCloudCredentials;
  const credentials = read();
  if (!credentials) {
    throw new CloudAuthError("AUTH_REQUIRED", "Ravi Cloud login required. Run `ravi cloud login`.");
  }
  const consoleClient = deps.consoleClient ?? new ConsoleApiClient({ consoleUrl: credentials.consoleUrl });
  const { credentials: fresh } = await getMeWithAutoRefresh({
    client: consoleClient,
    credentials,
    write: (c: CloudCredentials) => write(c),
    delete: () => remove(),
  });
  const link = deps.link ?? new LinkApiClient();
  return { link, accessToken: fresh.accessToken };
}

export async function startConnect(
  options: { provider: string; scopes?: string[]; displayName?: string },
  deps: ConnectorHelperDeps = {},
): Promise<ConnectStartResult> {
  const ctx = await authenticate(deps);
  return ctx.link.request<ConnectStartResult>("POST", "/cli/connect/start", ctx.accessToken, {
    provider: options.provider,
    scopes: options.scopes,
    displayName: options.displayName,
  });
}

export async function getConnectStatus(
  pendingId: string,
  deps: ConnectorHelperDeps = {},
): Promise<ConnectStatusResult> {
  const ctx = await authenticate(deps);
  return ctx.link.request<ConnectStatusResult>(
    "GET",
    `/cli/connect/status/${encodeURIComponent(pendingId)}`,
    ctx.accessToken,
  );
}

export async function listConnectors(
  options: { provider?: string } = {},
  deps: ConnectorHelperDeps = {},
): Promise<ConnectorListItem[]> {
  const ctx = await authenticate(deps);
  const path = options.provider
    ? `/cli/connect/list?provider=${encodeURIComponent(options.provider)}`
    : "/cli/connect/list";
  const result = await ctx.link.request<{ connections: ConnectorListItem[] }>("GET", path, ctx.accessToken);
  return result.connections;
}

export async function showConnector(id: string, deps: ConnectorHelperDeps = {}): Promise<ConnectorDetail> {
  const ctx = await authenticate(deps);
  const result = await ctx.link.request<{ connection: ConnectorDetail }>(
    "GET",
    `/cli/connect/show/${encodeURIComponent(id)}`,
    ctx.accessToken,
  );
  return result.connection;
}

export async function revokeConnector(id: string, deps: ConnectorHelperDeps = {}): Promise<void> {
  const ctx = await authenticate(deps);
  await ctx.link.request<{ revoked: boolean }>(
    "POST",
    `/cli/connect/revoke/${encodeURIComponent(id)}`,
    ctx.accessToken,
  );
}

export async function execCapability(
  options: { connectorId: string; capability: string; parameters: unknown },
  deps: ConnectorHelperDeps = {},
): Promise<ExecResult> {
  const ctx = await authenticate(deps);
  return ctx.link.request<ExecResult>("POST", `/cli/exec/${encodeURIComponent(options.connectorId)}`, ctx.accessToken, {
    capability: options.capability,
    parameters: options.parameters,
  });
}
