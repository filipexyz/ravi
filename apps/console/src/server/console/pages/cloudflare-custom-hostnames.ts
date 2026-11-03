/**
 * Cloudflare for SaaS Custom Hostname provider for Ravi Pages.
 *
 * Required env vars:
 *   - `CLOUDFLARE_API_TOKEN` with `SSL and Certificates Write` on the
 *     `ravi.page` zone.
 *   - `RAVI_PAGES_CUSTOM_HOSTNAME_ZONE_ID` or `CLOUDFLARE_ZONE_ID_RAVI_PAGE`.
 *
 * If no zone id is configured, the provider can try a best-effort zone lookup
 * by name, but that also requires `Zone Read`; production should prefer the
 * explicit zone id to keep the token narrowly scoped.
 */

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";
const DEFAULT_ZONE_NAME = "ravi.page";

export class CloudflareCustomHostnameError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status?: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "CloudflareCustomHostnameError";
  }
}

export interface CloudflareCustomHostnameConfig {
  apiToken: string;
  customOriginServer?: string;
  zoneId?: string;
  zoneName: string;
  fetchImpl?: typeof fetch;
}

export interface CloudflareCustomHostname {
  id: string;
  hostname: string;
  ownership_verification?: {
    name?: string | null;
    type?: string | null;
    value?: string | null;
  } | null;
  status?: string | null;
  ssl?: {
    dcv_delegation_records?: CloudflareCustomHostnameValidationRecord[];
    id?: string | null;
    method?: string | null;
    status?: string | null;
    type?: string | null;
    validation_errors?: Array<{ message?: string | null }>;
    validation_records?: CloudflareCustomHostnameValidationRecord[];
  } | null;
}

export interface CloudflareCustomHostnameValidationRecord {
  cname?: string | null;
  cname_target?: string | null;
  txt_name?: string | null;
  txt_value?: string | null;
}

export function getCloudflareCustomHostnameConfig(
  env: NodeJS.ProcessEnv = process.env,
): CloudflareCustomHostnameConfig | null {
  const apiToken = env.CLOUDFLARE_API_TOKEN?.trim();
  if (!apiToken) return null;

  const zoneId = env.RAVI_PAGES_CUSTOM_HOSTNAME_ZONE_ID?.trim() || env.CLOUDFLARE_ZONE_ID_RAVI_PAGE?.trim() || undefined;
  const zoneName = env.RAVI_PAGES_CUSTOM_HOSTNAME_ZONE_NAME?.trim() || DEFAULT_ZONE_NAME;
  const customOriginServer = env.RAVI_PAGES_CUSTOM_HOSTNAME_ORIGIN_SERVER?.trim() || undefined;

  return {
    apiToken,
    customOriginServer,
    zoneId,
    zoneName,
  };
}

export function createCloudflareCustomHostnameProvider(config: CloudflareCustomHostnameConfig) {
  const fetchImpl = config.fetchImpl ?? fetch;
  const zoneCache = new Map<string, string>();

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const init: RequestInit = {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${config.apiToken}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
    };
    if (body !== undefined) init.body = JSON.stringify(body);

    let response: Response;
    try {
      response = await fetchImpl(`${CLOUDFLARE_API_BASE}${path}`, init);
    } catch (error) {
      throw new CloudflareCustomHostnameError(
        "CF_TRANSPORT_ERROR",
        `Cloudflare request failed: ${errMessage(error)}`,
        undefined,
        { cause: error },
      );
    }

    const payload = await readBody(response);
    if (!response.ok || !isSuccessEnvelope(payload)) {
      throw mapCloudflareError(response.status, payload);
    }
    return (payload as { result: T }).result;
  }

  async function resolveZoneId() {
    const explicit = config.zoneId?.trim();
    if (explicit) return explicit;

    const zoneName = config.zoneName.trim().toLowerCase();
    const cached = zoneCache.get(zoneName);
    if (cached) return cached;

    const escaped = encodeURIComponent(zoneName);
    const zones = await request<Array<{ id: string; name: string }>>("GET", `/zones?name=${escaped}`);
    const zone = zones.find((row) => row.name === zoneName);
    if (!zone) {
      throw new CloudflareCustomHostnameError(
        "CF_ZONE_NOT_FOUND",
        `Cloudflare zone not found for ${zoneName}`,
        404,
      );
    }
    zoneCache.set(zoneName, zone.id);
    return zone.id;
  }

  function customHostnameBody(hostname: string) {
    const wildcard = hostname.startsWith("*.");
    return {
      ...(config.customOriginServer ? { custom_origin_server: config.customOriginServer } : {}),
      hostname,
      ssl: {
        ...(hostname.length > 64 ? { cloudflare_branding: true } : {}),
        method: wildcard ? "txt" : "http",
        type: "dv",
        ...(wildcard ? { wildcard: true } : {}),
      },
    };
  }

  async function getCustomHostname(input: { customHostnameId: string; zoneId?: string }): Promise<CloudflareCustomHostname> {
    const zoneId = input.zoneId ?? (await resolveZoneId());
    return request<CloudflareCustomHostname>("GET", `/zones/${zoneId}/custom_hostnames/${input.customHostnameId}`);
  }

  async function listCustomHostnames(input: { hostname: string; zoneId?: string }): Promise<CloudflareCustomHostname[]> {
    const zoneId = input.zoneId ?? (await resolveZoneId());
    const escaped = encodeURIComponent(input.hostname.trim().toLowerCase());
    return request<CloudflareCustomHostname[]>("GET", `/zones/${zoneId}/custom_hostnames?hostname=${escaped}`);
  }

  async function createCustomHostname(input: { hostname: string; zoneId?: string }): Promise<CloudflareCustomHostname> {
    const zoneId = input.zoneId ?? (await resolveZoneId());
    return request<CloudflareCustomHostname>("POST", `/zones/${zoneId}/custom_hostnames`, customHostnameBody(input.hostname));
  }

  async function refreshCustomHostname(input: {
    customHostnameId: string;
    hostname: string;
    zoneId?: string;
  }): Promise<CloudflareCustomHostname> {
    const zoneId = input.zoneId ?? (await resolveZoneId());
    return request<CloudflareCustomHostname>(
      "PATCH",
      `/zones/${zoneId}/custom_hostnames/${input.customHostnameId}`,
      customHostnameBody(input.hostname),
    );
  }

  async function ensureCustomHostname(input: { hostname: string; zoneId?: string }): Promise<CloudflareCustomHostname> {
    const zoneId = input.zoneId ?? (await resolveZoneId());
    const hostname = input.hostname.trim().toLowerCase();
    const existing = (await listCustomHostnames({ hostname, zoneId })).find((row) => row.hostname === hostname);

    if (!existing) {
      return createCustomHostname({ hostname, zoneId });
    }

    if (isCloudflareCustomHostnameReady(existing)) {
      return existing;
    }

    return refreshCustomHostname({
      customHostnameId: existing.id,
      hostname,
      zoneId,
    });
  }

  async function lookupZoneIdByName(zoneName: string): Promise<string | null> {
    const normalized = zoneName.trim().toLowerCase();
    const escaped = encodeURIComponent(normalized);
    const zones = await request<Array<{ id: string; name: string }>>("GET", `/zones?name=${escaped}`);
    return zones.find((row) => row.name === normalized)?.id ?? null;
  }

  return {
    createCustomHostname,
    ensureCustomHostname,
    getCustomHostname,
    listCustomHostnames,
    lookupZoneIdByName,
    refreshCustomHostname,
  };
}

export type CloudflareCustomHostnameProvider = ReturnType<typeof createCloudflareCustomHostnameProvider>;

export function isCloudflareCustomHostnameReady(hostname: CloudflareCustomHostname) {
  return hostname.status === "active" && hostname.ssl?.status === "active";
}

function isSuccessEnvelope(payload: unknown): payload is { result: unknown; success: true } {
  return Boolean(payload) && typeof payload === "object" && (payload as { success?: boolean }).success === true;
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

function mapCloudflareError(status: number, payload: unknown): CloudflareCustomHostnameError {
  const errors = (payload as { errors?: Array<{ code?: number; message?: string }> } | null)?.errors;
  const first = errors?.[0];
  const code = first?.code ? `CF_${first.code}` : statusCode(status);
  const message = first?.message ?? `Cloudflare request failed with status ${status}`;
  return new CloudflareCustomHostnameError(code, message, status, payload);
}

function statusCode(status: number): string {
  if (status === 401) return "CF_UNAUTHORIZED";
  if (status === 403) return "CF_FORBIDDEN";
  if (status === 404) return "CF_NOT_FOUND";
  if (status === 409) return "CF_CONFLICT";
  if (status === 429) return "CF_RATE_LIMITED";
  if (status >= 500) return "CF_SERVER_ERROR";
  return "CF_REQUEST_FAILED";
}

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
