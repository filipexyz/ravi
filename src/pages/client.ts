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

export interface PublishedPageListOptions extends PagesClientOptions {
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

export type PagePasswordReplacementVisibility = "public" | "private" | "protected_link";

export type PagePasswordManageOptions = PagesClientOptions & {
  project: string;
  site: string;
  path: string;
} & (
    | { action: "set"; password: string }
    | { action: "status" }
    | { action: "remove"; visibility: PagePasswordReplacementVisibility }
  );

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
export type PublishedPagePayload = Record<string, unknown>;

export interface PageSiteListResult {
  success: true;
  consoleUrl: string;
  projectRef: string;
  total: number;
  sites: PageSitePayload[];
  items: PageSitePayload[];
}

export interface PublishedPageListResult {
  success: true;
  consoleUrl: string;
  projectRef: string;
  total: number;
  pages: PublishedPagePayload[];
  items: PublishedPagePayload[];
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

export type PagePasswordPolicyPayload = {
  configured: boolean;
  id: string;
  rotatedAt: string;
  scope: "route";
  status: "active" | "disabled";
  version: number;
};

export type PagePasswordManagePayload = {
  action: "remove" | "set" | "status";
  configured: boolean;
  path: string;
  policy: PagePasswordPolicyPayload | null;
  projectRef: string;
  release: { id: string; number: number };
  route: {
    bindingId: string;
    effectiveVisibility: "password" | PagePasswordReplacementVisibility;
    id: string;
    path: string;
    visibility: "password" | PagePasswordReplacementVisibility;
  };
  scope: "route";
  site: { defaultHostname: string; id: string; projectId: string };
  siteRef: string;
  url: string;
};

export type PagePasswordManageResult = PagePasswordManagePayload & {
  consoleUrl: string;
  success: true;
};

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

  async listPublishedPages(accessToken: string, options: PublishedPageListOptions): Promise<PublishedPagePayload[]> {
    const payload = await this.request<unknown>(
      "GET",
      `/api/cli/projects/${encodeURIComponent(requireText(options.project, "project"))}/pages/published`,
      undefined,
      accessToken,
    );
    return normalizePublishedPageListPayload(payload);
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

  async manageRoutePassword(
    accessToken: string,
    options: PagePasswordManageOptions,
  ): Promise<PagePasswordManagePayload> {
    const body = {
      action: options.action,
      path: requireText(options.path, "path"),
      siteRef: requireText(options.site, "site"),
      ...(options.action === "set" ? { password: options.password } : {}),
      ...(options.action === "remove" ? { visibility: options.visibility } : {}),
    };
    const payload = await this.request<unknown>(
      "POST",
      `/api/cli/projects/${encodeURIComponent(requireText(options.project, "project"))}/pages/password`,
      body,
      accessToken,
    );
    return normalizePagePasswordPayload(payload);
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

export async function listPublishedPages(
  options: PublishedPageListOptions,
  deps: PagesClientDeps = {},
): Promise<PublishedPageListResult> {
  const auth = await createAuthenticatedPagesContext(options, deps);
  const pages = await new RaviPagesClient(auth.client).listPublishedPages(auth.accessToken, options);
  return {
    success: true,
    consoleUrl: auth.consoleUrl,
    projectRef: requireText(options.project, "project"),
    total: pages.length,
    pages,
    items: pages,
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

export async function managePagePassword(
  options: PagePasswordManageOptions,
  deps: PagesClientDeps = {},
): Promise<PagePasswordManageResult> {
  const auth = await createAuthenticatedPagesContext(options, deps);
  const result = await new RaviPagesClient(auth.client).manageRoutePassword(auth.accessToken, options);
  return {
    ...result,
    consoleUrl: auth.consoleUrl,
    success: true,
  };
}

export function normalizePageVisibility(value: string | undefined): PageVisibility | undefined {
  if (!value?.trim()) return undefined;
  const normalized = value.trim().toLowerCase().replace(/-/g, "_");
  if (normalized === "public" || normalized === "private" || normalized === "protected_link") return normalized;
  throw new CloudAuthError("PAYLOAD_INVALID", "--visibility must be one of: public, private, protected_link.");
}

export function normalizePagePasswordReplacementVisibility(
  value: string | undefined,
): PagePasswordReplacementVisibility {
  const visibility = normalizePageVisibility(value);
  if (!visibility) {
    throw new CloudAuthError(
      "PAYLOAD_INVALID",
      "Missing --visibility. Choose the access mode that replaces password protection.",
    );
  }
  return visibility;
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

function normalizePublishedPageListPayload(payload: unknown): PublishedPagePayload[] {
  if (Array.isArray(payload)) return payload.map(normalizeSitePayload);
  const record = objectValue(payload);
  if (Array.isArray(record?.pages)) return record.pages.map(normalizeSitePayload);
  if (Array.isArray(record?.items)) return record.items.map(normalizeSitePayload);
  return [];
}

function normalizeSitePayload(payload: unknown): PageSitePayload {
  const record = objectValue(payload);
  const nested = objectValue(record?.site);
  return nested ?? record ?? {};
}

function normalizePagePasswordPayload(payload: unknown): PagePasswordManagePayload {
  const record = requireObject(payload, "Pages password response");
  const action = enumValue(record.action, ["remove", "set", "status"] as const, "action");
  const policyRecord =
    record.policy === null || record.policy === undefined ? null : requireObject(record.policy, "policy");
  const policy = policyRecord
    ? {
        configured: booleanValue(policyRecord.configured, "policy.configured"),
        id: requiredStringValue(policyRecord.id, "policy.id"),
        rotatedAt: requiredStringValue(policyRecord.rotatedAt, "policy.rotatedAt"),
        scope: enumValue(policyRecord.scope, ["route"] as const, "policy.scope"),
        status: enumValue(policyRecord.status, ["active", "disabled"] as const, "policy.status"),
        version: nonNegativeInteger(policyRecord.version, "policy.version"),
      }
    : null;
  const release = requireObject(record.release, "release");
  const route = requireObject(record.route, "route");
  const site = requireObject(record.site, "site");
  const visibilities = ["password", "public", "private", "protected_link"] as const;
  return {
    action,
    configured: booleanValue(record.configured, "configured"),
    path: requiredStringValue(record.path, "path"),
    policy,
    projectRef: requiredStringValue(record.projectRef, "projectRef"),
    release: {
      id: requiredStringValue(release.id, "release.id"),
      number: nonNegativeInteger(release.number, "release.number"),
    },
    route: {
      bindingId: requiredStringValue(route.bindingId, "route.bindingId"),
      effectiveVisibility: enumValue(route.effectiveVisibility, visibilities, "route.effectiveVisibility"),
      id: requiredStringValue(route.id, "route.id"),
      path: requiredStringValue(route.path, "route.path"),
      visibility: enumValue(route.visibility, visibilities, "route.visibility"),
    },
    scope: enumValue(record.scope, ["route"] as const, "scope"),
    site: {
      defaultHostname: requiredStringValue(site.defaultHostname, "site.defaultHostname"),
      id: requiredStringValue(site.id, "site.id"),
      projectId: requiredStringValue(site.projectId, "site.projectId"),
    },
    siteRef: requiredStringValue(record.siteRef, "siteRef"),
    url: requiredStringValue(record.url, "url"),
  };
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
  // The publish op is braked (Manual v2 write brake): teach the flag that
  // actually performs the upload, so agents don't stop at the dry-run.
  return `ravi pages publish ${projectRef} ${siteRef} ./site --route / --visibility ${visibility} --entrypoint index.html --execute`;
}

function requireText(value: string | undefined, label: string): string {
  const text = value?.trim();
  if (!text) throw new CloudAuthError("PAYLOAD_INVALID", `Missing ${label}.`);
  return text;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  const record = objectValue(value);
  if (!record) throw invalidConsoleResponse(label);
  return record;
}

function requiredStringValue(value: unknown, label: string): string {
  const text = stringValue(value);
  if (!text) throw invalidConsoleResponse(label);
  return text;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw invalidConsoleResponse(label);
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) throw invalidConsoleResponse(label);
  return Number(value);
}

function enumValue<const T extends readonly string[]>(value: unknown, values: T, label: string): T[number] {
  if (typeof value === "string" && values.includes(value)) return value as T[number];
  throw invalidConsoleResponse(label);
}

function invalidConsoleResponse(label: string): CloudAuthError {
  return new CloudAuthError("SERVER_UNAVAILABLE", `Console returned an invalid ${label}.`);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
