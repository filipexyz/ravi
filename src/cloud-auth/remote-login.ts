import { z } from "zod";
import { CloudAuthError } from "./errors.js";
import type { CloudCredentials } from "./types.js";

export const REMOTE_LOGIN_DISCOVERY_PROTOCOL = "ravi.auth.discovery" as const;
export const REMOTE_LOGIN_DISCOVERY_SCHEMA_VERSION = 1 as const;
export const REMOTE_LOGIN_DISCOVERY_PATH = "/.well-known/ravi-auth" as const;
export const REMOTE_LOGIN_PROVIDER_PROTOCOL = "ravi.auth.post-login" as const;
export const REMOTE_LOGIN_PROVIDER_SCHEMA_VERSION = 1 as const;
export const REMOTE_LOGIN_PROVIDER_MODULES_ENV = "RAVI_REMOTE_LOGIN_PROVIDERS" as const;

const WireKindSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/)
  .max(96);
const OpaqueIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._~-]*$/)
  .max(128);
const ModuleSpecifierSchema = z
  .string()
  .regex(/^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*|file:\/\/\/[^\u0000-\u001f\u007f]+)$/);

export const RemoteLoginDiscoverySchema = z
  .object({
    protocol: z.literal(REMOTE_LOGIN_DISCOVERY_PROTOCOL),
    schemaVersion: z.literal(REMOTE_LOGIN_DISCOVERY_SCHEMA_VERSION),
    issuer: z.url(),
    authConfigEndpoint: z.url(),
    sessionEndpoints: z
      .object({
        exchange: z.url(),
        refresh: z.url(),
        logout: z.url(),
        me: z.url(),
      })
      .strict(),
    installationProvider: WireKindSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (new URL(value.authConfigEndpoint).origin !== new URL(value.issuer).origin) {
      context.addIssue({
        code: "custom",
        path: ["authConfigEndpoint"],
        message: "authConfigEndpoint must share the issuer origin",
      });
    }
    for (const [field, endpoint] of Object.entries(value.sessionEndpoints)) {
      if (new URL(endpoint).origin !== new URL(value.issuer).origin) {
        context.addIssue({
          code: "custom",
          path: ["sessionEndpoints", field],
          message: `${field} must share the issuer origin`,
        });
      }
    }
  });

export const RemoteLoginProviderModuleConfigSchema = z
  .object({
    protocol: z.literal(REMOTE_LOGIN_PROVIDER_PROTOCOL),
    schemaVersion: z.literal(REMOTE_LOGIN_PROVIDER_SCHEMA_VERSION),
    provider: WireKindSchema,
    moduleSpecifier: ModuleSpecifierSchema,
  })
  .strict();

export const RemoteLoginProviderDescriptorSchema = z
  .object({
    protocol: z.literal(REMOTE_LOGIN_PROVIDER_PROTOCOL),
    schemaVersion: z.literal(REMOTE_LOGIN_PROVIDER_SCHEMA_VERSION),
    provider: WireKindSchema,
  })
  .strict();

const BoundedOpaqueRecordSchema = z.record(z.string(), z.unknown()).superRefine((value, context) => {
  if (!isJsonRecord(value)) {
    context.addIssue({
      code: "custom",
      message: "value must contain only JSON values",
    });
    return;
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    context.addIssue({
      code: "custom",
      message: "value must be JSON serializable",
    });
    return;
  }
  if (new TextEncoder().encode(encoded).byteLength > 65_536) {
    context.addIssue({
      code: "custom",
      message: "value exceeds the supported size",
    });
  }
});

export const RemoteInstallationCredentialSchema = z
  .object({
    provider: WireKindSchema,
    credentialId: OpaqueIdSchema,
    material: BoundedOpaqueRecordSchema,
    publicMetadata: BoundedOpaqueRecordSchema.optional(),
    expiresAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

export type RemoteLoginDiscovery = z.infer<typeof RemoteLoginDiscoverySchema>;
export type RemoteLoginProviderModuleConfig = z.infer<typeof RemoteLoginProviderModuleConfigSchema>;
export type RemoteInstallationCredential = z.infer<typeof RemoteInstallationCredentialSchema>;

export interface RemoteLoginInstallationMetadata {
  readonly clientInstallationId: string;
  readonly name: string;
  readonly hostname: string;
  readonly platform: string;
  readonly raviVersion?: string;
}

export interface RemoteLoginProviderContext {
  readonly endpointUrl: string;
  readonly discovery: RemoteLoginDiscovery;
  readonly humanCredentials: CloudCredentials;
  readonly installation: RemoteLoginInstallationMetadata;
  readonly previousCredential?: RemoteInstallationCredential;
}

export interface RemoteLoginProvider {
  readonly descriptor: z.infer<typeof RemoteLoginProviderDescriptorSchema>;
  reconcileInstallation(
    context: RemoteLoginProviderContext,
  ): Promise<RemoteInstallationCredential> | RemoteInstallationCredential;
}

export interface RemoteLoginProviderModule {
  readonly remoteLoginProvider: RemoteLoginProvider;
}

export type RemoteLoginProviderImporter = (moduleSpecifier: string) => Promise<unknown>;
export type RemoteLoginFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class RemoteLoginContractError extends Error {
  constructor(
    readonly reason:
      | "invalid_discovery"
      | "issuer_mismatch"
      | "invalid_provider_configuration"
      | "module_load_failed"
      | "invalid_module_export"
      | "provider_mismatch"
      | "duplicate_provider"
      | "provider_not_configured"
      | "invalid_provider_result",
  ) {
    super(reason);
    this.name = "RemoteLoginContractError";
  }
}

export async function discoverRemoteLoginEndpoint(
  endpointUrl: string,
  fetchImpl: RemoteLoginFetch = globalThis.fetch,
): Promise<RemoteLoginDiscovery> {
  const endpoint = normalizeRemoteLoginEndpoint(endpointUrl);
  let response: Response;
  try {
    response = await fetchImpl(`${endpoint}${REMOTE_LOGIN_DISCOVERY_PATH}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "error",
    });
  } catch (error) {
    throw new CloudAuthError("SERVER_UNAVAILABLE", "Remote login discovery failed.", { cause: error });
  }
  if (!response.ok) {
    throw new CloudAuthError("SERVER_UNAVAILABLE", "Remote login discovery is unavailable.", {
      status: response.status,
    });
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new CloudAuthError("PAYLOAD_INVALID", "Remote login discovery returned invalid JSON.", { cause: error });
  }
  const parsed = RemoteLoginDiscoverySchema.safeParse(payload);
  if (!parsed.success) {
    throw new RemoteLoginContractError("invalid_discovery");
  }
  if (normalizeRemoteLoginEndpoint(parsed.data.issuer) !== endpoint) {
    throw new RemoteLoginContractError("issuer_mismatch");
  }
  return parsed.data;
}

export function normalizeRemoteLoginEndpoint(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new CloudAuthError("PAYLOAD_INVALID", "Remote login endpoint is invalid.");
  }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback(parsed.hostname))) {
    throw new CloudAuthError(
      "PAYLOAD_INVALID",
      "Remote login endpoints require HTTPS; loopback HTTP is allowed for local development.",
    );
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new CloudAuthError(
      "PAYLOAD_INVALID",
      "Remote login endpoint must not contain credentials, query, or fragment.",
    );
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/+$/, "");
}

export function parseRemoteLoginProviderModuleConfigs(value: string | undefined): RemoteLoginProviderModuleConfig[] {
  if (!value?.trim()) return [];
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new RemoteLoginContractError("invalid_provider_configuration");
  }
  const parsed = z.array(RemoteLoginProviderModuleConfigSchema).safeParse(decoded);
  if (!parsed.success) {
    throw new RemoteLoginContractError("invalid_provider_configuration");
  }
  const providers = new Set<string>();
  for (const config of parsed.data) {
    if (providers.has(config.provider)) {
      throw new RemoteLoginContractError("duplicate_provider");
    }
    providers.add(config.provider);
  }
  return parsed.data;
}

export async function loadRemoteLoginProvider(
  provider: string,
  configs: readonly RemoteLoginProviderModuleConfig[],
  importer: RemoteLoginProviderImporter = (moduleSpecifier) => import(moduleSpecifier),
): Promise<RemoteLoginProvider> {
  const config = configs.find((candidate) => candidate.provider === provider);
  if (!config) throw new RemoteLoginContractError("provider_not_configured");
  let moduleValue: unknown;
  try {
    moduleValue = await importer(config.moduleSpecifier);
  } catch {
    throw new RemoteLoginContractError("module_load_failed");
  }
  const record = objectValue(moduleValue);
  const candidate = objectValue(record?.remoteLoginProvider) as unknown as RemoteLoginProvider | null;
  if (!candidate || typeof candidate.reconcileInstallation !== "function") {
    throw new RemoteLoginContractError("invalid_module_export");
  }
  const descriptor = RemoteLoginProviderDescriptorSchema.safeParse(candidate.descriptor);
  if (!descriptor.success) {
    throw new RemoteLoginContractError("invalid_module_export");
  }
  if (descriptor.data.provider !== provider) {
    throw new RemoteLoginContractError("provider_mismatch");
  }
  return candidate;
}

export async function reconcileRemoteInstallation(
  provider: RemoteLoginProvider,
  context: RemoteLoginProviderContext,
): Promise<RemoteInstallationCredential> {
  let result: unknown;
  try {
    result = await provider.reconcileInstallation(context);
  } catch (error) {
    if (error instanceof CloudAuthError || error instanceof RemoteLoginContractError) throw error;
    throw new CloudAuthError("SERVER_UNAVAILABLE", "Remote installation reconciliation failed.", { cause: error });
  }
  const parsed = RemoteInstallationCredentialSchema.safeParse(result);
  if (!parsed.success || parsed.data.provider !== provider.descriptor.provider) {
    throw new RemoteLoginContractError("invalid_provider_result");
  }
  return parsed.data;
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

function objectValue(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isJsonRecord(value: Record<string, unknown>): boolean {
  const stack: unknown[] = [value];
  const seen = new WeakSet<object>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean" ||
      (typeof current === "number" && Number.isFinite(current))
    ) {
      continue;
    }
    if (typeof current !== "object") return false;
    if (seen.has(current)) return false;
    seen.add(current);
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) return false;
    stack.push(...Object.values(current));
  }
  return true;
}
