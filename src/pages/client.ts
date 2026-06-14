import { ConsoleApiClient, getMeWithAutoRefresh, normalizeConsoleUrl } from "../cloud-auth/client.js";
import { CloudAuthError } from "../cloud-auth/errors.js";
import { deleteCloudCredentials, readCloudCredentials, writeCloudCredentials } from "../cloud-auth/storage.js";
import type { CloudCredentials } from "../cloud-auth/types.js";

export type PageVisibility = "public" | "private" | "protected_link";

export interface PagesClientOptions {
  console?: string;
}

export interface PageSiteListOptions extends PagesClientOptions {
  project: string;
}

export interface PageSiteCreateOptions extends PagesClientOptions {
  defaultVisibility?: PageVisibility;
  isDefault?: boolean;
  project: string;
  slug: string;
}

export interface PageSiteUpdateOptions extends PagesClientOptions {
  defaultVisibility?: PageVisibility;
  project: string;
  site: string;
}

export interface PageDomainBindOptions extends PagesClientOptions {
  check?: boolean;
  hostnames: string[];
  project: string;
  site: string;
}

export interface PagesClientDeps {
  client?: ConsoleApiClient;
  readCredentials?: typeof readCloudCredentials;
  writeCredentials?: typeof writeCloudCredentials;
  deleteCredentials?: typeof deleteCloudCredentials;
}

export interface AuthenticatedPagesContext {
  accessToken: string;
  client: ConsoleApiClient;
  consoleUrl: string;
}

export type PageSitePayload = Record<string, unknown>;

export interface PageSiteListResult {
  success: true;
  consoleUrl: string;
  projectRef: string;
  total: number;
  sites: PageSitePayload[];
  items: PageSitePayload[];
}

export interface PageSiteCreateResult {
  success: true;
  contentPublishCommand: string | null;
  consoleUrl: string;
  projectRef: string;
  site: PageSitePayload;
  url: string | null;
}

export interface PageSiteUpdateResult {
  success: true;
  consoleUrl: string;
  projectRef: string;
  siteRef: string;
  site: PageSitePayload;
  edgeManifestRepair: unknown;
  url: string | null;
}

export interface PageDomainBindResult {
  success: true;
  bindings: PageSitePayload[];
  consoleUrl: string;
  hostnames: string[];
  projectRef: string;
  site: PageSitePayload;
  siteRef: string;
  total: number;
}

export class RaviPagesClient {
  constructor(private readonly client: ConsoleApiClient) {}

  async listSites(accessToken: string, options: PageSiteListOptions): Promise<PageSitePayload[]> {
    const payload = await this.request<unknown>(
      "GET",
      `/api/cli/projects/${encodeURIComponent(requireText(options.project, "project"))}/pages`,
      undefined,
      accessToken,
    );
    return normalizeSiteListPayload(payload);
  }

  async createSite(accessToken: string, options: PageSiteCreateOptions): Promise<PageSitePayload> {
    const payload = await this.request<unknown>(
      "POST",
      `/api/cli/projects/${encodeURIComponent(requireText(options.project, "project"))}/pages`,
      {
        slug: requireText(options.slug, "slug"),
        ...(options.defaultVisibility ? { defaultVisibility: options.defaultVisibility } : {}),
        ...(options.isDefault !== undefined ? { isDefault: options.isDefault } : {}),
      },
      accessToken,
    );
    return normalizeSitePayload(payload);
  }

  async updateSite(
    accessToken: string,
    options: PageSiteUpdateOptions,
  ): Promise<{
    edgeManifestRepair: unknown;
    site: PageSitePayload;
  }> {
    const payload = await this.request<unknown>(
      "PATCH",
      `/api/cli/projects/${encodeURIComponent(requireText(options.project, "project"))}/pages`,
      {
        siteRef: requireText(options.site, "site"),
        defaultVisibility: requirePageVisibility(options.defaultVisibility),
      },
      accessToken,
    );
    const record = objectValue(payload);
    return {
      site: normalizeSitePayload(payload),
      edgeManifestRepair: record?.edgeManifestRepair ?? null,
    };
  }

  async bindDomains(
    accessToken: string,
    options: PageDomainBindOptions,
  ): Promise<{
    bindings: PageSitePayload[];
    hostnames: string[];
    site: PageSitePayload;
    total: number;
  }> {
    const payload = await this.request<unknown>(
      "POST",
      `/api/cli/projects/${encodeURIComponent(requireText(options.project, "project"))}/pages/${encodeURIComponent(
        requireText(options.site, "site"),
      )}/domains`,
      {
        ...(options.check ? { check: true } : {}),
        hostnames: normalizeHostnames(options.hostnames),
      },
      accessToken,
    );
    const record = objectValue(payload);
    const bindings = Array.isArray(record?.bindings) ? record.bindings.map(normalizeSitePayload) : [];
    const hostnames = Array.isArray(record?.hostnames)
      ? record.hostnames.map((value) => (typeof value === "string" ? value : "")).filter(Boolean)
      : [];
    return {
      bindings,
      hostnames,
      site: normalizeSitePayload(record?.site),
      total: typeof record?.total === "number" ? record.total : bindings.length,
    };
  }

  private async request<T>(method: string, path: string, body: unknown, accessToken: string): Promise<T> {
    try {
      return await this.client.requestJson<T>(method, path, body, accessToken);
    } catch (error) {
      throw normalizePagesError(error);
    }
  }
}

export async function createAuthenticatedPagesContext(
  options: PagesClientOptions = {},
  deps: PagesClientDeps = {},
): Promise<AuthenticatedPagesContext> {
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

export async function listPageSites(
  options: PageSiteListOptions,
  deps: PagesClientDeps = {},
): Promise<PageSiteListResult> {
  const auth = await createAuthenticatedPagesContext(options, deps);
  const sites = await new RaviPagesClient(auth.client).listSites(auth.accessToken, options);
  return {
    success: true,
    consoleUrl: auth.consoleUrl,
    projectRef: requireText(options.project, "project"),
    total: sites.length,
    sites,
    items: sites,
  };
}

export async function createPageSite(
  options: PageSiteCreateOptions,
  deps: PagesClientDeps = {},
): Promise<PageSiteCreateResult> {
  const auth = await createAuthenticatedPagesContext(options, deps);
  const site = await new RaviPagesClient(auth.client).createSite(auth.accessToken, options);
  const projectRef = requireText(options.project, "project");
  return {
    success: true,
    contentPublishCommand: contentPublishCommandForSite(projectRef, site),
    consoleUrl: auth.consoleUrl,
    projectRef,
    site,
    url: hostedSiteUrl(site),
  };
}

export async function updatePageSite(
  options: PageSiteUpdateOptions,
  deps: PagesClientDeps = {},
): Promise<PageSiteUpdateResult> {
  const auth = await createAuthenticatedPagesContext(options, deps);
  const result = await new RaviPagesClient(auth.client).updateSite(auth.accessToken, options);
  return {
    success: true,
    consoleUrl: auth.consoleUrl,
    projectRef: requireText(options.project, "project"),
    siteRef: requireText(options.site, "site"),
    site: result.site,
    edgeManifestRepair: result.edgeManifestRepair,
    url: hostedSiteUrl(result.site),
  };
}

export async function bindPageDomains(
  options: PageDomainBindOptions,
  deps: PagesClientDeps = {},
): Promise<PageDomainBindResult> {
  const auth = await createAuthenticatedPagesContext(options, deps);
  const result = await new RaviPagesClient(auth.client).bindDomains(auth.accessToken, options);
  return {
    success: true,
    bindings: result.bindings,
    consoleUrl: auth.consoleUrl,
    hostnames: result.hostnames,
    projectRef: requireText(options.project, "project"),
    site: result.site,
    siteRef: requireText(options.site, "site"),
    total: result.total,
  };
}

export function normalizePageVisibility(value: string | undefined): PageVisibility | undefined {
  if (!value?.trim()) return undefined;
  const normalized = value.trim().toLowerCase().replace(/-/g, "_");
  if (normalized === "public" || normalized === "private" || normalized === "protected_link") return normalized;
  throw new CloudAuthError("PAYLOAD_INVALID", "--visibility must be one of: public, private, protected_link.");
}

function requirePageVisibility(value: PageVisibility | undefined): PageVisibility {
  if (!value) throw new CloudAuthError("PAYLOAD_INVALID", "Missing --visibility.");
  return value;
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

function normalizePagesError(error: unknown): CloudAuthError {
  if (error instanceof CloudAuthError) return error;
  return new CloudAuthError("SERVER_UNAVAILABLE", error instanceof Error ? error.message : String(error), {
    cause: error,
  });
}

function normalizeSiteListPayload(payload: unknown): PageSitePayload[] {
  if (Array.isArray(payload)) return payload.map(normalizeSitePayload);
  const record = objectValue(payload);
  if (Array.isArray(record?.sites)) return record.sites.map(normalizeSitePayload);
  if (Array.isArray(record?.items)) return record.items.map(normalizeSitePayload);
  return [];
}

function normalizeSitePayload(payload: unknown): PageSitePayload {
  const record = objectValue(payload);
  const nested = objectValue(record?.site);
  return nested ?? record ?? {};
}

function normalizeHostnames(values: string[]): string[] {
  const hostnames = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  if (hostnames.length === 0) throw new CloudAuthError("PAYLOAD_INVALID", "Missing hostname.");
  if (hostnames.length > 20) throw new CloudAuthError("PAYLOAD_INVALID", "Bind at most 20 hostnames per request.");
  return hostnames;
}

function hostedSiteUrl(site: PageSitePayload): string | null {
  const hostname = stringValue(site.defaultHostname) ?? stringValue(site.hostname);
  return hostname ? `https://${hostname}/` : null;
}

function contentPublishCommandForSite(projectRef: string, site: PageSitePayload): string | null {
  const siteRef = stringValue(site.slug) ?? stringValue(site.id);
  if (!siteRef) return null;
  const visibility = stringValue(site.defaultVisibility) ?? stringValue(site.visibility) ?? "public";
  return `ravi pages publish ${projectRef} ${siteRef} ./site --route / --visibility ${visibility} --entrypoint index.html`;
}

function requireText(value: string | undefined, label: string): string {
  const text = value?.trim();
  if (!text) throw new CloudAuthError("PAYLOAD_INVALID", `Missing ${label}.`);
  return text;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
