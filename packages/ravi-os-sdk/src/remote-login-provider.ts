import { z } from "zod";

export const REMOTE_LOGIN_DISCOVERY_PROTOCOL = "ravi.auth.discovery" as const;
export const REMOTE_LOGIN_DISCOVERY_SCHEMA_VERSION = 1 as const;
export const REMOTE_LOGIN_PROVIDER_PROTOCOL = "ravi.auth.post-login" as const;
export const REMOTE_LOGIN_PROVIDER_SCHEMA_VERSION = 1 as const;

const WireKindSchema = z.string().regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/).max(96);
const OpaqueIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._~-]*$/).max(128);
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
    const issuerOrigin = new URL(value.issuer).origin;
    if (new URL(value.authConfigEndpoint).origin !== issuerOrigin) {
      context.addIssue({
        code: "custom",
        path: ["authConfigEndpoint"],
        message: "authConfigEndpoint must share the issuer origin",
      });
    }
    for (const [field, endpoint] of Object.entries(value.sessionEndpoints)) {
      if (new URL(endpoint).origin !== issuerOrigin) {
        context.addIssue({
          code: "custom",
          path: ["sessionEndpoints", field],
          message: `${field} must share the issuer origin`,
        });
      }
    }
  });

export const RemoteLoginProviderDescriptorSchema = z
  .object({
    protocol: z.literal(REMOTE_LOGIN_PROVIDER_PROTOCOL),
    schemaVersion: z.literal(REMOTE_LOGIN_PROVIDER_SCHEMA_VERSION),
    provider: WireKindSchema,
  })
  .strict();

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
export type RemoteInstallationCredential = z.infer<typeof RemoteInstallationCredentialSchema>;

export interface RemoteLoginHumanCredentials {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessTokenExpiresAt: string | null;
  readonly refreshTokenExpiresAt?: string | null;
  readonly scopes: readonly string[];
}

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
  readonly humanCredentials: RemoteLoginHumanCredentials;
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
