import { ConsoleApiClient, getMeWithAutoRefresh, normalizeConsoleUrl } from "../cloud-auth/client.js";
import { CloudAuthError } from "../cloud-auth/errors.js";
import { deleteCloudCredentials, readCloudCredentials, writeCloudCredentials } from "../cloud-auth/storage.js";
import type { CloudCredentials } from "../cloud-auth/types.js";

export type CloudProjectVisibility = "public" | "private" | "protected_link";

export interface CloudProjectsClientOptions {
  console?: string;
}

export interface CloudProjectListOptions extends CloudProjectsClientOptions {}

export interface CloudProjectCreateOptions extends CloudProjectsClientOptions {
  defaultPageSite?: boolean | string;
  defaultVisibility?: CloudProjectVisibility;
  description?: string;
  name?: string;
  slug: string;
}

export interface CloudProjectsClientDeps {
  client?: ConsoleApiClient;
  readCredentials?: typeof readCloudCredentials;
  writeCredentials?: typeof writeCloudCredentials;
  deleteCredentials?: typeof deleteCloudCredentials;
}

export interface AuthenticatedCloudProjectsContext {
  accessToken: string;
  client: ConsoleApiClient;
  consoleUrl: string;
}

export type CloudProjectPayload = Record<string, unknown>;

export interface CloudProjectListResult {
  success: true;
  consoleUrl: string;
  total: number;
  projects: CloudProjectPayload[];
  items: CloudProjectPayload[];
}

export interface CloudProjectCreateResult {
  success: true;
  consoleUrl: string;
  project: CloudProjectPayload;
  redirectTo: string | null;
}

export class RaviCloudProjectsClient {
  constructor(private readonly client: ConsoleApiClient) {}

  async listProjects(accessToken: string): Promise<CloudProjectPayload[]> {
    const payload = await this.request<unknown>("GET", "/api/cli/projects", undefined, accessToken);
    return normalizeProjectListPayload(payload);
  }

  async createProject(
    accessToken: string,
    options: CloudProjectCreateOptions,
  ): Promise<{ project: CloudProjectPayload; redirectTo: string | null }> {
    const defaultPageSite = normalizeDefaultPageSite(options.defaultPageSite);
    const payload = await this.request<unknown>(
      "POST",
      "/api/cli/projects",
      {
        name: requireText(options.name ?? options.slug, "name"),
        slug: requireText(options.slug, "slug"),
        description: optionalText(options.description),
        defaultVisibility: options.defaultVisibility ?? "private",
        createDefaultPageSite: defaultPageSite.enabled,
        ...(defaultPageSite.slug ? { defaultPageSiteSlug: defaultPageSite.slug } : {}),
      },
      accessToken,
    );
    const record = objectValue(payload);
    return {
      project: normalizeProjectPayload(record?.project ?? payload),
      redirectTo: stringValue(record?.redirectTo),
    };
  }

  private async request<T>(method: string, path: string, body: unknown, accessToken: string): Promise<T> {
    try {
      return await this.client.requestJson<T>(method, path, body, accessToken);
    } catch (error) {
      throw normalizeCloudProjectsError(error);
    }
  }
}

export async function createAuthenticatedCloudProjectsContext(
  options: CloudProjectsClientOptions = {},
  deps: CloudProjectsClientDeps = {},
): Promise<AuthenticatedCloudProjectsContext> {
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

export async function listCloudProjects(
  options: CloudProjectListOptions = {},
  deps: CloudProjectsClientDeps = {},
): Promise<CloudProjectListResult> {
  const auth = await createAuthenticatedCloudProjectsContext(options, deps);
  const projects = await new RaviCloudProjectsClient(auth.client).listProjects(auth.accessToken);
  return {
    success: true,
    consoleUrl: auth.consoleUrl,
    total: projects.length,
    projects,
    items: projects,
  };
}

export async function createCloudProject(
  options: CloudProjectCreateOptions,
  deps: CloudProjectsClientDeps = {},
): Promise<CloudProjectCreateResult> {
  const auth = await createAuthenticatedCloudProjectsContext(options, deps);
  const result = await new RaviCloudProjectsClient(auth.client).createProject(auth.accessToken, options);
  return {
    success: true,
    consoleUrl: auth.consoleUrl,
    project: result.project,
    redirectTo: result.redirectTo,
  };
}

export function normalizeCloudProjectVisibility(value: string | undefined): CloudProjectVisibility | undefined {
  if (!value?.trim()) return undefined;
  const normalized = value.trim().toLowerCase().replace(/-/g, "_");
  if (normalized === "public" || normalized === "private" || normalized === "protected_link") return normalized;
  throw new CloudAuthError("PAYLOAD_INVALID", "--visibility must be one of: public, private, protected_link.");
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

function normalizeCloudProjectsError(error: unknown): CloudAuthError {
  if (error instanceof CloudAuthError) return error;
  return new CloudAuthError("SERVER_UNAVAILABLE", error instanceof Error ? error.message : String(error), {
    cause: error,
  });
}

function normalizeDefaultPageSite(value: boolean | string | undefined): { enabled: boolean; slug: string | null } {
  if (value === undefined || value === false) return { enabled: false, slug: null };
  if (value === true) return { enabled: true, slug: null };
  const slug = value.trim();
  if (!slug) return { enabled: true, slug: null };
  return { enabled: true, slug };
}

function normalizeProjectListPayload(payload: unknown): CloudProjectPayload[] {
  if (Array.isArray(payload)) return payload.map(normalizeProjectPayload);
  const record = objectValue(payload);
  if (Array.isArray(record?.projects)) return record.projects.map(normalizeProjectPayload);
  if (Array.isArray(record?.items)) return record.items.map(normalizeProjectPayload);
  return [];
}

function normalizeProjectPayload(payload: unknown): CloudProjectPayload {
  return objectValue(payload) ?? {};
}

function requireText(value: string | undefined, label: string): string {
  const text = value?.trim();
  if (!text) throw new CloudAuthError("PAYLOAD_INVALID", `Missing ${label}.`);
  return text;
}

function optionalText(value: string | undefined): string | null {
  const text = value?.trim();
  return text || null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
