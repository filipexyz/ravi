import { fetchWithTimeout } from "../utils/paths.js";
import { CloudAuthError, normalizeCloudAuthErrorCode } from "./errors.js";
import type {
  CloudAuthOrganization,
  CloudAuthUser,
  CloudCredentials,
  ConsoleAuthConfig,
  ConsoleMeResponse,
  CredentialExchangeInput,
  CredentialRefreshInput,
  DeviceAuthorizationResponse,
  DeviceTokenResponse,
  LogoutInput,
} from "./types.js";
import { DEFAULT_CONSOLE_URL } from "./types.js";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ConsoleApiClientOptions {
  consoleUrl?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export class ConsoleApiClient {
  readonly consoleUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: ConsoleApiClientOptions = {}) {
    this.consoleUrl = normalizeConsoleUrl(options.consoleUrl ?? DEFAULT_CONSOLE_URL);
    this.fetchImpl =
      options.fetch ??
      ((url, init) => {
        return fetchWithTimeout(url, init, options.timeoutMs);
      });
  }

  async getAuthConfig(): Promise<ConsoleAuthConfig> {
    return this.requestJson<ConsoleAuthConfig>("GET", "/api/cli/auth/config");
  }

  async startDeviceAuthorization(config: ConsoleAuthConfig): Promise<DeviceAuthorizationResponse> {
    const endpoint = requireAuthEndpoint(config, "deviceAuthorization");
    const clientId = requireClientId(config);
    const body = new URLSearchParams({ client_id: clientId });
    const scopes = stringArray(config.scopes);
    if (scopes?.length) body.set("scope", scopes.join(" "));

    const response = await this.requestFormJson<unknown>("POST", endpoint, body);
    return deviceAuthorizationFromResponse(response);
  }

  async pollDeviceToken(config: ConsoleAuthConfig, deviceCode: string): Promise<DeviceTokenResponse> {
    const endpoint = requireAuthEndpoint(config, "token");
    const clientId = requireClientId(config);
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
      client_id: clientId,
    });

    const response = await this.requestFormJson<unknown>("POST", endpoint, body);
    return deviceTokenFromResponse(response);
  }

  async exchange(input: CredentialExchangeInput): Promise<CloudCredentials> {
    const response = await this.requestJson<unknown>("POST", "/api/cli/auth/exchange", input);
    return credentialsFromConsoleResponse(response, this.consoleUrl, input.installationId);
  }

  async refresh(input: CredentialRefreshInput, previous?: CloudCredentials | null): Promise<CloudCredentials> {
    const response = await this.requestJson<unknown>("POST", "/api/cli/auth/refresh", input);
    return credentialsFromConsoleResponse(response, this.consoleUrl, input.installationId, previous);
  }

  async logout(input: LogoutInput, accessToken?: string): Promise<{ success: true }> {
    await this.requestJson<unknown>("POST", "/api/cli/auth/logout", input, accessToken);
    return { success: true };
  }

  async me(accessToken: string): Promise<ConsoleMeResponse> {
    return this.requestJson<ConsoleMeResponse>("GET", "/api/cli/me", undefined, accessToken);
  }

  async createPageUploadSession(
    input: PageUploadSessionCreateInput,
    accessToken: string,
  ): Promise<PageUploadSessionCreateResponse> {
    return this.requestJson<PageUploadSessionCreateResponse>(
      "POST",
      "/api/cli/artifacts/upload-sessions",
      input,
      accessToken,
    );
  }

  async finalizeArtifactPublish(
    input: ArtifactPublishFinalizeInput,
    accessToken: string,
  ): Promise<ArtifactPublishFinalizeResponse> {
    return this.requestJson<ArtifactPublishFinalizeResponse>("POST", "/api/cli/artifacts/publish", input, accessToken);
  }

  async activatePageSiteRelease(
    input: PageSiteReleaseActivateInput,
    accessToken: string,
  ): Promise<PageSiteReleaseActivateResponse> {
    return this.requestJson<PageSiteReleaseActivateResponse>("POST", "/api/cli/artifacts/publish", input, accessToken);
  }

  async requestJson<T>(method: string, path: string, body?: unknown, accessToken?: string): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.consoleUrl}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      throw new CloudAuthError("SERVER_UNAVAILABLE", `Console request failed: ${errorMessage(error)}`, {
        cause: error,
      });
    }

    const payload = await readJsonBody(response);
    if (!response.ok) {
      throw mapConsoleError(response.status, payload);
    }
    return (payload ?? {}) as T;
  }

  private async requestFormJson<T>(method: string, url: string, body: URLSearchParams): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      });
    } catch (error) {
      throw new CloudAuthError("SERVER_UNAVAILABLE", `Provider auth request failed: ${errorMessage(error)}`, {
        cause: error,
      });
    }

    const payload = await readJsonBody(response);
    if (!response.ok) {
      throw mapOAuthDeviceError(response.status, payload);
    }
    return (payload ?? {}) as T;
  }
}

export interface PageUploadSessionCreateInput {
  projectRef: string;
  siteRef?: string | null;
  idempotencyKey?: string | null;
  packageManifest?: {
    entrypoint?: string;
    basePath?: string;
    assetBase?: string;
    files: Array<{
      path: string;
      sha256?: string | null;
      sizeBytes?: number | null;
      contentType?: string | null;
      stagingKey?: string | null;
      cache?: string;
    }>;
  };
  uploadPolicy?: Record<string, unknown>;
}

export interface PageUploadSessionCreateResponse {
  uploadSession: Record<string, unknown>;
  uploadPolicy: Record<string, unknown>;
}

export interface ArtifactPublishFinalizeInput {
  uploadSessionId: string;
  idempotencyKey?: string | null;
  artifact?: {
    id?: string | null;
    slug?: string | null;
    name?: string | null;
    description?: string | null;
    localArtifactId?: string | null;
  };
  packageManifest: {
    entrypoint?: string;
    basePath?: string;
    assetBase?: string;
    files: Array<{
      path: string;
      sha256?: string | null;
      sizeBytes?: number | null;
      contentType?: string | null;
      stagingKey?: string | null;
      cache?: string;
    }>;
  };
  publish?: {
    siteRef: string;
    activate?: boolean;
    route?: {
      path?: string;
      matchType?: string;
      priority?: number;
      visibility?: string;
    };
    routes?: Array<{
      path: string;
      matchType?: string;
      priority?: number;
      visibility?: string;
    }>;
    replaceRelease?: boolean;
    reason?: string | null;
    visibility?: string;
  };
  source?: Record<string, unknown>;
}

export type ArtifactPublishFinalizeResponse = Record<string, unknown>;

export interface PageSiteReleaseActivateInput {
  siteRef: string;
  releaseId: string;
}

export type PageSiteReleaseActivateResponse = Record<string, unknown>;

export function normalizeConsoleUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new CloudAuthError("PAYLOAD_INVALID", `Invalid Console URL: ${value}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new CloudAuthError("PAYLOAD_INVALID", `Invalid Console URL protocol: ${parsed.protocol}. Use http or https.`);
  }
  if (parsed.protocol === "http:" && !isAllowedInsecureConsoleUrl(parsed)) {
    throw new CloudAuthError(
      "PAYLOAD_INVALID",
      "Insecure Console URL is only allowed for localhost. Use https or set RAVI_ALLOW_INSECURE_CONSOLE_URL=true for development.",
    );
  }
  parsed.hash = "";
  parsed.search = "";
  return parsed.toString().replace(/\/+$/, "");
}

function isAllowedInsecureConsoleUrl(url: URL) {
  if (process.env.RAVI_ALLOW_INSECURE_CONSOLE_URL === "true") return true;
  return (
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "[::1]"
  );
}

export function credentialsFromConsoleResponse(
  response: unknown,
  consoleUrl: string,
  fallbackInstallationId: string,
  previous?: CloudCredentials | null,
): CloudCredentials {
  const root = objectValue(response);
  if (!root) {
    throw new CloudAuthError("PAYLOAD_INVALID", "Console did not return a credentials object.");
  }
  const source = objectValue(root.credentials) ?? root;
  const now = new Date().toISOString();

  const accessToken = stringValue(source.accessToken) ?? stringValue(source.access_token);
  const refreshToken = stringValue(source.refreshToken) ?? stringValue(source.refresh_token);
  if (!accessToken || !refreshToken) {
    throw new CloudAuthError("PAYLOAD_INVALID", "Console did not return Ravi CLI credentials.");
  }

  const installation =
    objectValue(source.installation) ??
    objectValue(root.installation) ??
    ({ id: stringValue(source.installationId) ?? stringValue(root.installationId) } as Record<string, unknown>);

  return {
    version: 1,
    consoleUrl,
    installationId:
      stringValue(source.installationId) ??
      stringValue(root.installationId) ??
      stringValue(installation.id) ??
      stringValue(installation.installationId) ??
      fallbackInstallationId,
    accessToken,
    refreshToken,
    accessTokenExpiresAt:
      stringValue(source.accessTokenExpiresAt) ??
      stringValue(source.access_token_expires_at) ??
      stringValue(source.expiresAt) ??
      stringValue(root.accessTokenExpiresAt) ??
      expiresInToIso(numberValue(source.expiresIn) ?? numberValue(source.expires_in)),
    refreshTokenExpiresAt:
      stringValue(source.refreshTokenExpiresAt) ??
      stringValue(source.refresh_token_expires_at) ??
      stringValue(root.refreshTokenExpiresAt) ??
      previous?.refreshTokenExpiresAt ??
      null,
    scopes: stringArray(source.scopes) ?? stringArray(root.scopes) ?? previous?.scopes ?? [],
    user: userValue(source.user) ?? userValue(root.user) ?? previous?.user ?? null,
    organization:
      organizationValue(source.organization) ??
      organizationValue(source.org) ??
      organizationValue(root.organization) ??
      organizationValue(root.org) ??
      previous?.organization ??
      null,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
}

export async function refreshCredentialsForStore(input: {
  client: ConsoleApiClient;
  credentials: CloudCredentials;
  write: (credentials: CloudCredentials) => void;
  delete: () => void;
}): Promise<CloudCredentials> {
  try {
    const refreshed = await input.client.refresh(
      {
        refreshToken: input.credentials.refreshToken,
        installationId: input.credentials.installationId,
      },
      input.credentials,
    );
    input.write(refreshed);
    return refreshed;
  } catch (error) {
    const cloudError = mapRefreshFailure(error);
    if (
      cloudError.code === "AUTH_REQUIRED" ||
      cloudError.code === "AUTH_EXPIRED" ||
      cloudError.code === "INSTALLATION_REVOKED" ||
      cloudError.code === "CREDENTIALS_INVALID"
    ) {
      input.delete();
    }
    throw cloudError;
  }
}

export async function getMeWithAutoRefresh(input: {
  client: ConsoleApiClient;
  credentials: CloudCredentials;
  write: (credentials: CloudCredentials) => void;
  delete: () => void;
}): Promise<{ me: ConsoleMeResponse; credentials: CloudCredentials }> {
  try {
    return { me: await input.client.me(input.credentials.accessToken), credentials: input.credentials };
  } catch (error) {
    if (!(error instanceof CloudAuthError) || error.code !== "AUTH_EXPIRED") {
      throw error;
    }
  }

  const refreshed = await refreshCredentialsForStore(input);
  return { me: await input.client.me(refreshed.accessToken), credentials: refreshed };
}

function mapRefreshFailure(error: unknown): CloudAuthError {
  if (error instanceof CloudAuthError) {
    if (error.code === "PAYLOAD_INVALID") {
      return new CloudAuthError("CREDENTIALS_INVALID", "Console refresh returned invalid credentials.", {
        status: error.status,
        cause: error,
      });
    }
    return error;
  }
  return new CloudAuthError("SERVER_UNAVAILABLE", `Console refresh failed: ${errorMessage(error)}`, { cause: error });
}

async function readJsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    if (response.ok) {
      throw new CloudAuthError("PAYLOAD_INVALID", "Console returned invalid JSON.");
    }
    return { message: text };
  }
}

function mapConsoleError(status: number, payload: unknown): CloudAuthError {
  const data = objectValue(payload);
  const nested = objectValue(data?.error);
  const rawCode = data?.code ?? nested?.code ?? data?.error;
  const fallback = statusToErrorCode(status);
  const code = normalizeCloudAuthErrorCode(rawCode, fallback);
  const message =
    stringValue(data?.message) ??
    stringValue(nested?.message) ??
    stringValue(data?.error_description) ??
    defaultErrorMessage(code);
  return new CloudAuthError(code, message, { status });
}

function mapOAuthDeviceError(status: number, payload: unknown): CloudAuthError {
  const data = objectValue(payload);
  const rawCode = stringValue(data?.error);
  const rawDescription = stringValue(data?.error_description) ?? stringValue(data?.message);
  const normalized = rawCode?.toLowerCase();

  if (normalized === "authorization_pending" || normalized === "slow_down") {
    return new CloudAuthError("AUTH_PENDING", rawDescription ?? "Login is still pending.", { status });
  }
  if (normalized === "expired_token") {
    return new CloudAuthError("AUTH_EXPIRED", rawDescription ?? "Login code expired.", { status });
  }
  if (normalized === "access_denied") {
    return new CloudAuthError("ORG_ACCESS_DENIED", rawDescription ?? "Login was denied.", { status });
  }
  if (normalized === "invalid_client") {
    return new CloudAuthError("SERVER_UNAVAILABLE", rawDescription ?? "Console CLI auth client is misconfigured.", {
      status,
    });
  }

  const fallback = statusToErrorCode(status);
  const code = normalizeCloudAuthErrorCode(rawCode, fallback);
  return new CloudAuthError(code, rawDescription ?? defaultErrorMessage(code), { status });
}

function statusToErrorCode(status: number) {
  if (status === 401) return "AUTH_REQUIRED";
  if (status === 403) return "ORG_ACCESS_DENIED";
  if (status === 408 || status === 409 || status === 425) return "AUTH_PENDING";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "SERVER_UNAVAILABLE";
  return "PAYLOAD_INVALID";
}

function defaultErrorMessage(code: string): string {
  switch (code) {
    case "AUTH_REQUIRED":
      return "Login required. Run `ravi login`.";
    case "AUTH_PENDING":
      return "Login is still pending.";
    case "AUTH_EXPIRED":
      return "Ravi Cloud credentials expired.";
    case "INSTALLATION_REVOKED":
      return "This local Ravi installation was revoked. Run `ravi login` again.";
    case "RATE_LIMITED":
      return "Console rate limit reached. Try again later.";
    case "SERVER_UNAVAILABLE":
      return "Console is unavailable. Try again later.";
    default:
      return "Console request failed.";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function objectValue(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((item): item is string => typeof item === "string");
}

function userValue(value: unknown): CloudAuthUser | null {
  return objectValue(value) as CloudAuthUser | null;
}

function organizationValue(value: unknown): CloudAuthOrganization | null {
  return objectValue(value) as CloudAuthOrganization | null;
}

function expiresInToIso(value: number | null): string | null {
  if (!value) return null;
  return new Date(Date.now() + value * 1000).toISOString();
}

function requireClientId(config: ConsoleAuthConfig): string {
  const clientId = stringValue(config.clientId);
  if (config.configured === false || !clientId) {
    throw new CloudAuthError("SERVER_UNAVAILABLE", "Console CLI auth is not configured.");
  }
  return clientId;
}

function requireAuthEndpoint(config: ConsoleAuthConfig, key: "deviceAuthorization" | "token"): string {
  const endpoint = stringValue(config.endpoints?.[key]);
  if (config.configured === false || !endpoint) {
    throw new CloudAuthError("SERVER_UNAVAILABLE", "Console CLI auth is not configured.");
  }
  return endpoint;
}

function deviceAuthorizationFromResponse(response: unknown): DeviceAuthorizationResponse {
  const data = objectValue(response);
  const deviceCode = stringValue(data?.deviceCode) ?? stringValue(data?.device_code);
  const userCode = stringValue(data?.userCode) ?? stringValue(data?.user_code);
  const verificationUri = stringValue(data?.verificationUri) ?? stringValue(data?.verification_uri);
  const verificationUriComplete =
    stringValue(data?.verificationUriComplete) ?? stringValue(data?.verification_uri_complete) ?? verificationUri;

  if (!deviceCode || !userCode || !verificationUri || !verificationUriComplete) {
    throw new CloudAuthError("PAYLOAD_INVALID", "Provider did not return device authorization metadata.");
  }

  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete,
    expiresIn: numberValue(data?.expiresIn) ?? numberValue(data?.expires_in),
    interval: numberValue(data?.interval),
  };
}

function deviceTokenFromResponse(response: unknown): DeviceTokenResponse {
  const data = objectValue(response);
  const accessToken = stringValue(data?.accessToken) ?? stringValue(data?.access_token);
  if (!accessToken) {
    throw new CloudAuthError("PAYLOAD_INVALID", "Provider did not return an access token.");
  }

  return {
    accessToken,
    refreshToken: stringValue(data?.refreshToken) ?? stringValue(data?.refresh_token),
    idToken: stringValue(data?.idToken) ?? stringValue(data?.id_token),
    tokenType: stringValue(data?.tokenType) ?? stringValue(data?.token_type),
    expiresIn: numberValue(data?.expiresIn) ?? numberValue(data?.expires_in),
  };
}
