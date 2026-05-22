import { ConsoleApiClient, getMeWithAutoRefresh, normalizeConsoleUrl } from "../cloud-auth/client.js";
import { CloudAuthError } from "../cloud-auth/errors.js";
import { deleteCloudCredentials, readCloudCredentials, writeCloudCredentials } from "../cloud-auth/storage.js";
import type { CloudCredentials } from "../cloud-auth/types.js";

const CAPABILITY_CLASSES = ["read", "write", "destructive"] as const;
const CAPABILITY_CLASS_SET = new Set<string>(CAPABILITY_CLASSES);

export type McpBridgeCapabilityClass = (typeof CAPABILITY_CLASSES)[number];
export type McpBridgePayload = Record<string, unknown>;

export interface McpBridgesClientOptions {
  console?: string;
}

export interface McpBridgeProjectOptions extends McpBridgesClientOptions {
  projectRef?: string;
}

export interface McpBridgeListOptions extends McpBridgeProjectOptions {}

export interface McpBridgeCreateOptions extends McpBridgeProjectOptions {
  allowedCapabilityClasses?: McpBridgeCapabilityClass[];
  description?: string;
  name?: string;
}

export interface McpBridgeRevokeOptions extends McpBridgesClientOptions {}

export interface McpBridgesClientDeps {
  client?: ConsoleApiClient;
  readCredentials?: typeof readCloudCredentials;
  writeCredentials?: typeof writeCloudCredentials;
  deleteCredentials?: typeof deleteCloudCredentials;
}

export interface AuthenticatedMcpBridgesContext {
  accessToken: string;
  client: ConsoleApiClient;
  consoleUrl: string;
}

export interface McpBridgeListResult {
  success: true;
  consoleUrl: string;
  projectRef: string;
  total: number;
  bridges: McpBridgePayload[];
  items: McpBridgePayload[];
}

export interface McpBridgeCreateResult {
  success: true;
  consoleUrl: string;
  projectRef: string;
  bridge: McpBridgePayload;
  bridgeToken: string | null;
  bridgeUrl: string | null;
}

export interface McpBridgeRevokeResult {
  success: true;
  consoleUrl: string;
  revoked: boolean;
  bridgeId: string;
}

export class RaviMcpBridgesClient {
  constructor(private readonly client: ConsoleApiClient) {}

  async listBridges(accessToken: string, projectRef: string): Promise<McpBridgePayload[]> {
    const payload = await this.request<unknown>(
      "GET",
      withQuery("/api/cli/mcp/bridges", { project: projectRef }),
      undefined,
      accessToken,
    );
    return normalizeBridgeListPayload(payload);
  }

  async createBridge(
    accessToken: string,
    options: McpBridgeCreateOptions & { projectRef: string },
  ): Promise<{ bridge: McpBridgePayload; bridgeToken: string | null; bridgeUrl: string | null }> {
    const payload = await this.request<unknown>(
      "POST",
      "/api/cli/mcp/bridges",
      {
        projectRef: requireText(options.projectRef, "project"),
        ...(optionalText(options.name) ? { name: optionalText(options.name) } : {}),
        ...(optionalText(options.description) ? { description: optionalText(options.description) } : {}),
        ...(options.allowedCapabilityClasses ? { allowedCapabilityClasses: options.allowedCapabilityClasses } : {}),
      },
      accessToken,
    );
    const record = objectValue(payload);
    return {
      bridge: normalizeBridgePayload(record?.bridge ?? payload),
      bridgeToken: stringValue(record?.bridgeToken),
      bridgeUrl: stringValue(record?.bridgeUrl),
    };
  }

  async revokeBridge(accessToken: string, bridgeId: string): Promise<{ revoked: boolean; bridgeId: string }> {
    const id = requireText(bridgeId, "bridge id");
    const payload = await this.request<unknown>(
      "POST",
      `/api/cli/mcp/bridges/${encodeURIComponent(id)}/revoke`,
      undefined,
      accessToken,
    );
    const record = objectValue(payload);
    return {
      revoked: booleanValue(record?.revoked) ?? true,
      bridgeId: stringValue(record?.bridgeId) ?? id,
    };
  }

  private async request<T>(method: string, path: string, body: unknown, accessToken: string): Promise<T> {
    try {
      return await this.client.requestJson<T>(method, path, body, accessToken);
    } catch (error) {
      throw normalizeMcpBridgeError(error);
    }
  }
}

export async function createAuthenticatedMcpBridgesContext(
  options: McpBridgesClientOptions = {},
  deps: McpBridgesClientDeps = {},
): Promise<AuthenticatedMcpBridgesContext> {
  const credentials = requireStoredCredentials((deps.readCredentials ?? readCloudCredentials)(), options.console);
  const client = deps.client ?? new ConsoleApiClient({ consoleUrl: credentials.consoleUrl });
  const auth = await getMeWithAutoRefresh({
    client,
    credentials,
    write: deps.writeCredentials ?? writeCloudCredentials,
    delete: deps.deleteCredentials ?? deleteCloudCredentials,
  });
  return {
    accessToken: auth.credentials.accessToken,
    client,
    consoleUrl: auth.credentials.consoleUrl,
  };
}

export async function listMcpBridges(
  options: McpBridgeListOptions = {},
  deps: McpBridgesClientDeps = {},
): Promise<McpBridgeListResult> {
  const projectRef = resolveBridgeProjectRef(options.projectRef);
  const auth = await createAuthenticatedMcpBridgesContext(options, deps);
  const bridges = await new RaviMcpBridgesClient(auth.client).listBridges(auth.accessToken, projectRef);
  return {
    success: true,
    consoleUrl: auth.consoleUrl,
    projectRef,
    total: bridges.length,
    bridges,
    items: bridges,
  };
}

export async function createMcpBridge(
  options: McpBridgeCreateOptions,
  deps: McpBridgesClientDeps = {},
): Promise<McpBridgeCreateResult> {
  const projectRef = resolveBridgeProjectRef(options.projectRef);
  const auth = await createAuthenticatedMcpBridgesContext(options, deps);
  const result = await new RaviMcpBridgesClient(auth.client).createBridge(auth.accessToken, {
    ...options,
    projectRef,
  });
  return {
    success: true,
    consoleUrl: auth.consoleUrl,
    projectRef,
    bridge: result.bridge,
    bridgeToken: result.bridgeToken,
    bridgeUrl: result.bridgeUrl,
  };
}

export async function revokeMcpBridge(
  bridgeId: string,
  options: McpBridgeRevokeOptions = {},
  deps: McpBridgesClientDeps = {},
): Promise<McpBridgeRevokeResult> {
  const auth = await createAuthenticatedMcpBridgesContext(options, deps);
  const result = await new RaviMcpBridgesClient(auth.client).revokeBridge(auth.accessToken, bridgeId);
  return {
    success: true,
    consoleUrl: auth.consoleUrl,
    revoked: result.revoked,
    bridgeId: result.bridgeId,
  };
}

export function resolveBridgeProjectRef(
  projectRef?: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const value = projectRef?.trim() || env.RAVI_PROJECT?.trim();
  if (!value) throw new CloudAuthError("PAYLOAD_INVALID", "Missing --project (or RAVI_PROJECT).");
  return value;
}

export function normalizeBridgeCapabilityClasses(
  value: string | string[] | undefined,
): McpBridgeCapabilityClass[] | undefined {
  const raw = Array.isArray(value) ? value.join(",") : value;
  if (!raw?.trim()) return undefined;

  const classes: McpBridgeCapabilityClass[] = [];
  for (const part of raw.split(",")) {
    const normalized = part.trim().toLowerCase();
    if (!normalized) continue;
    if (!CAPABILITY_CLASS_SET.has(normalized)) {
      throw new CloudAuthError("PAYLOAD_INVALID", `--allow must include only: ${CAPABILITY_CLASSES.join(", ")}.`);
    }
    if (!classes.includes(normalized as McpBridgeCapabilityClass)) {
      classes.push(normalized as McpBridgeCapabilityClass);
    }
  }
  return classes.length ? classes : undefined;
}

function requireStoredCredentials(credentials: CloudCredentials | null, consoleUrl?: string): CloudCredentials {
  if (!credentials) {
    throw new CloudAuthError("AUTH_REQUIRED", "No Ravi Cloud CLI credentials found. Run `ravi login`.");
  }
  if (consoleUrl && normalizeConsoleUrl(consoleUrl) !== credentials.consoleUrl) {
    throw new CloudAuthError(
      "AUTH_REQUIRED",
      `No Ravi Cloud CLI credentials found for ${normalizeConsoleUrl(consoleUrl)}. Run \`ravi login --console ${normalizeConsoleUrl(
        consoleUrl,
      )}\`.`,
    );
  }
  return credentials;
}

function normalizeMcpBridgeError(error: unknown): CloudAuthError {
  if (error instanceof CloudAuthError) return error;
  return new CloudAuthError("SERVER_UNAVAILABLE", error instanceof Error ? error.message : String(error), {
    cause: error,
  });
}

function normalizeBridgeListPayload(payload: unknown): McpBridgePayload[] {
  if (Array.isArray(payload)) return payload.map(normalizeBridgePayload);
  const record = objectValue(payload);
  if (Array.isArray(record?.bridges)) return record.bridges.map(normalizeBridgePayload);
  if (Array.isArray(record?.items)) return record.items.map(normalizeBridgePayload);
  return [];
}

function normalizeBridgePayload(payload: unknown): McpBridgePayload {
  return objectValue(payload) ?? {};
}

function requireText(value: string | undefined, label: string): string {
  const text = value?.trim();
  if (!text) throw new CloudAuthError("PAYLOAD_INVALID", `Missing ${label}.`);
  return text;
}

function optionalText(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text || undefined;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function withQuery(path: string, query: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === "") continue;
    params.set(key, value);
  }
  const search = params.toString();
  return search ? `${path}?${search}` : path;
}
