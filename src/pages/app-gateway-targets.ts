import { isAppId, isAudience, isOperationId, isUuid, MAX_GRANT_OPERATIONS } from "../app-gateway/constants.js";
import { CloudAuthError } from "../cloud-auth/errors.js";
import { normalizeAssertionOrigins } from "./assertion-audiences.js";
import { createAuthenticatedPagesContext, type PagesClientDeps, type PagesClientOptions } from "./client.js";

/**
 * Console contract `.ravi/specs/console/pages/app-gateway/cli/SPEC.md`
 * (Target Registry HTTP). Console owns the registry, grant signing, and every
 * authorization rule; this module only shapes requests and whitelists the
 * target fields it prints. Grants and tokens are never part of a response.
 */
export const PAGE_APP_GATEWAY_TARGETS_COLLECTION = "app-gateway-targets";

const JWT_PATTERN = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const MAX_SET_BODY_BYTES = 8_192;

export interface PageAppGatewayTarget {
  id: string | null;
  audience: string;
  appId: string | null;
  operations: string[];
  origins: string[];
  installationId: string | null;
  organizationId: string | null;
  projectId: string | null;
  siteId: string | null;
  status: string | null;
  revision: number | null;
  grantExpiresAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  revokedAt: string | null;
}

export interface PageAppGatewayTargetListOptions extends PagesClientOptions {
  project: string;
  site: string;
}

export interface PageAppGatewayTargetSetOptions extends PageAppGatewayTargetListOptions {
  audience: string;
  appId: string;
  operations: string[];
  origins: string[];
  /** Console installation id; omitted means the CLI session's own installation. */
  installationId?: string;
}

export interface PageAppGatewayTargetRemoveOptions extends PageAppGatewayTargetListOptions {
  audience: string;
}

export interface PageAppGatewayTargetListResult {
  consoleUrl: string;
  projectRef: string;
  siteRef: string;
  success: true;
  targets: PageAppGatewayTarget[];
  total: number;
}

export interface PageAppGatewayTargetSetResult {
  action: "set";
  audience: string;
  consoleUrl: string;
  projectRef: string;
  siteRef: string;
  success: true;
  target: PageAppGatewayTarget | null;
}

export interface PageAppGatewayTargetRemoveResult {
  action: "remove";
  audience: string;
  consoleUrl: string;
  id: string | null;
  projectRef: string;
  siteRef: string;
  status: string;
  success: true;
}

export function pageAppGatewayTargetsPath(project: string, site: string): string {
  return `/api/cli/projects/${encodeURIComponent(project)}/pages/${encodeURIComponent(site)}/${PAGE_APP_GATEWAY_TARGETS_COLLECTION}`;
}

export function normalizeTargetAudience(value: string | undefined): string {
  const audience = value?.trim() ?? "";
  if (!audience) throw new CloudAuthError("PAYLOAD_INVALID", "Missing --aud.");
  if (looksLikeJwt(audience)) {
    throw new CloudAuthError("PAYLOAD_INVALID", "--aud must be an audience identifier. Do not pass a JWT.");
  }
  if (!isAudience(audience)) {
    throw new CloudAuthError(
      "PAYLOAD_INVALID",
      "--aud must be one exact audience identifier (letters, digits, and ._:@/+- only; no spaces or *; at most 200 characters).",
    );
  }
  return audience;
}

export function normalizeTargetAppId(value: string | undefined): string {
  const appId = value?.trim() ?? "";
  if (!appId) throw new CloudAuthError("PAYLOAD_INVALID", "Missing --app.");
  if (!isAppId(appId)) {
    throw new CloudAuthError("PAYLOAD_INVALID", `Invalid --app "${appId}". Use a Ravi app id such as slides.`);
  }
  return appId;
}

/** `--op` is repeatable and comma-separable; 1 to 16 exact operation ids, duplicates removed, order kept. */
export function normalizeTargetOperations(values: readonly string[] | string | undefined): string[] {
  const raw = Array.isArray(values) ? values : values ? [values] : [];
  const parts = raw
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    throw new CloudAuthError(
      "PAYLOAD_INVALID",
      "Missing --op. Pass one or more exact operation ids such as slides.list.",
    );
  }
  const operations: string[] = [];
  for (const part of parts) {
    if (!isOperationId(part)) {
      throw new CloudAuthError(
        "PAYLOAD_INVALID",
        `Invalid --op "${part}". Use an exact manifest operation id such as slides.list; no wildcards.`,
      );
    }
    if (!operations.includes(part)) operations.push(part);
  }
  if (operations.length > MAX_GRANT_OPERATIONS) {
    throw new CloudAuthError("PAYLOAD_INVALID", `Set at most ${MAX_GRANT_OPERATIONS} operations on one target.`);
  }
  return operations;
}

/** 1 to 8 https origins of this Pages site, same rules as viewer-assertion audiences. */
export function normalizeTargetOrigins(values: readonly string[] | string | undefined): string[] {
  return normalizeAssertionOrigins(values);
}

export function normalizeTargetInstallationId(value: string | undefined): string | undefined {
  const installationId = value?.trim();
  if (!installationId) return undefined;
  if (!isUuid(installationId)) {
    throw new CloudAuthError(
      "PAYLOAD_INVALID",
      "--installation must be a Console installation id (UUID). Omit it to use this installation.",
    );
  }
  return installationId.toLowerCase();
}

/**
 * This installation's Console id from `GET /api/cli/me` (`localInstallation.id`).
 * Never the locally generated `credentials.installationId`. Null when Console
 * does not report it; the set route then defaults to the session's installation.
 */
export async function resolveConsoleInstallationId(
  options: PagesClientOptions,
  deps: PagesClientDeps = {},
): Promise<string | null> {
  const auth = await createAuthenticatedPagesContext(options, deps);
  const localInstallation = objectValue(auth.me.localInstallation);
  const id = typeof localInstallation?.id === "string" ? localInstallation.id.trim() : "";
  return isUuid(id) ? id.toLowerCase() : null;
}

export async function listPageAppGatewayTargets(
  options: PageAppGatewayTargetListOptions,
  deps: PagesClientDeps = {},
): Promise<PageAppGatewayTargetListResult> {
  const project = requireText(options.project, "project");
  const site = requireText(options.site, "site");
  const auth = await createAuthenticatedPagesContext(options, deps);
  const payload = await auth.client.requestJson<unknown>(
    "GET",
    pageAppGatewayTargetsPath(project, site),
    undefined,
    auth.accessToken,
  );
  const record = objectValue(payload);
  const items = Array.isArray(record?.items) ? record.items : Array.isArray(payload) ? payload : [];
  const targets = items.map(readTarget).filter((target): target is PageAppGatewayTarget => target !== null);
  return {
    consoleUrl: auth.consoleUrl,
    projectRef: safeRef(record?.projectRef) ?? project,
    siteRef: safeRef(record?.siteRef) ?? site,
    success: true,
    targets,
    total: targets.length,
  };
}

export async function setPageAppGatewayTarget(
  options: PageAppGatewayTargetSetOptions,
  deps: PagesClientDeps = {},
): Promise<PageAppGatewayTargetSetResult> {
  const project = requireText(options.project, "project");
  const site = requireText(options.site, "site");
  const body = {
    audience: options.audience,
    ...(options.installationId ? { installationId: options.installationId } : {}),
    appId: options.appId,
    operations: options.operations,
    origins: options.origins,
  };
  if (Buffer.byteLength(JSON.stringify(body), "utf8") > MAX_SET_BODY_BYTES) {
    throw new CloudAuthError("PAYLOAD_INVALID", "The target is too large to register (8192 bytes at most).");
  }
  const auth = await createAuthenticatedPagesContext(options, deps);
  const payload = await auth.client.requestJson<unknown>(
    "PUT",
    pageAppGatewayTargetsPath(project, site),
    body,
    auth.accessToken,
  );
  const record = objectValue(payload);
  return {
    action: "set",
    audience: options.audience,
    consoleUrl: auth.consoleUrl,
    projectRef: safeRef(record?.projectRef) ?? project,
    siteRef: safeRef(record?.siteRef) ?? site,
    success: true,
    target: readTarget(objectValue(record?.target) ?? record),
  };
}

export async function removePageAppGatewayTarget(
  options: PageAppGatewayTargetRemoveOptions,
  deps: PagesClientDeps = {},
): Promise<PageAppGatewayTargetRemoveResult> {
  const project = requireText(options.project, "project");
  const site = requireText(options.site, "site");
  const auth = await createAuthenticatedPagesContext(options, deps);
  const path = `${pageAppGatewayTargetsPath(project, site)}?aud=${encodeURIComponent(options.audience)}`;
  const payload = await auth.client.requestJson<unknown>("DELETE", path, undefined, auth.accessToken);
  const record = objectValue(payload);
  return {
    action: "remove",
    audience: options.audience,
    consoleUrl: auth.consoleUrl,
    id: safeString(record?.id),
    projectRef: safeRef(record?.projectRef) ?? project,
    siteRef: safeRef(record?.siteRef) ?? site,
    status: safeString(record?.status) ?? "revoked",
    success: true,
  };
}

/** Whitelist serializer: only the public target fields, never a JWT-shaped value. */
export function readTarget(value: unknown): PageAppGatewayTarget | null {
  const record = objectValue(value);
  if (!record) return null;
  const audience = safeString(record.audience) ?? safeString(record.aud);
  if (!audience) return null;
  return {
    id: safeString(record.id),
    audience,
    appId: safeString(record.appId),
    operations: safeStringList(record.operations),
    origins: safeStringList(record.origins),
    installationId: safeString(record.installationId),
    organizationId: safeString(record.organizationId),
    projectId: safeString(record.projectId),
    siteId: safeString(record.siteId),
    status: safeString(record.status),
    revision: typeof record.revision === "number" && Number.isSafeInteger(record.revision) ? record.revision : null,
    grantExpiresAt: safeString(record.grantExpiresAt),
    createdAt: safeString(record.createdAt),
    updatedAt: safeString(record.updatedAt),
    revokedAt: safeString(record.revokedAt),
  };
}

function safeString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > 512 || looksLikeJwt(text) || /[\u0000-\u001f\u007f]/.test(text)) return null;
  return text;
}

function safeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(safeString).filter((item): item is string => item !== null);
}

function safeRef(value: unknown): string | null {
  return safeString(value);
}

function looksLikeJwt(value: string): boolean {
  return JWT_PATTERN.test(value.trim());
}

function requireText(value: string | undefined, label: string): string {
  const text = value?.trim();
  if (!text) throw new CloudAuthError("PAYLOAD_INVALID", `Missing ${label}.`);
  return text;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
