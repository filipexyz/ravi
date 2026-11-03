import { z } from "zod";
import type { AdmissionGroups } from "@/server/console/fleet/sso-contract";

const secureUrl = z.string().url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
}, "OIDC requires an HTTPS URL without credentials, query or fragment.");
const originSchema = secureUrl.refine((value) => new URL(value).pathname === "/", "Console URL must be an origin.");

const configSchema = z.object({
  issuer: secureUrl,
  origin: originSchema,
  clientId: z.string().trim().min(1),
  clientSecret: z.string().min(1),
  secret: z.string().min(32),
  organizationId: z.string().uuid(),
  sessionTtlSeconds: z.coerce.number().int().min(300).max(28_800).default(3_600),
});

export type OidcConfig = z.infer<typeof configSchema> & { generation?: string; admissionGroups?: AdmissionGroups;
  networkPolicy?: { allowPrivate: boolean } };

export function getOidcBaseConfig(env: Record<string, string | undefined> = process.env) {
  const result = configSchema.omit({ issuer: true, clientId: true, clientSecret: true }).safeParse({
    origin: env.NEXT_PUBLIC_CONSOLE_URL, secret: env.RAVI_AUTH_SECRET,
    organizationId: env.RAVI_SINGLE_TENANT_ORGANIZATION_ID, sessionTtlSeconds: env.RAVI_AUTH_SESSION_TTL_SECONDS,
  });
  if (!result.success) throw new Error("OIDC installation configuration is missing or invalid.");
  return { ...result.data, origin: new URL(result.data.origin).origin };
}

export function oidcModeEnabled() {
  return process.env.RAVI_AUTH_MODE === "oidc";
}

/** Also usable on the missing-auth-settings screen; never falls back to Host. */
export function getOidcOrigin(env: Record<string, string | undefined> = process.env) {
  const origin = originSchema.safeParse(env.NEXT_PUBLIC_CONSOLE_URL);
  if (!origin.success) throw new Error("OIDC Console origin is missing or invalid.");
  return new URL(origin.data).origin;
}

export function getOidcConfig(env: Record<string, string | undefined> = process.env): OidcConfig {
  const result = configSchema.safeParse({
    issuer: env.RAVI_OIDC_ISSUER,
    origin: env.NEXT_PUBLIC_CONSOLE_URL,
    clientId: env.RAVI_OIDC_CLIENT_ID,
    clientSecret: env.RAVI_OIDC_CLIENT_SECRET,
    secret: env.RAVI_AUTH_SECRET,
    organizationId: env.RAVI_SINGLE_TENANT_ORGANIZATION_ID,
    sessionTtlSeconds: env.RAVI_AUTH_SESSION_TTL_SECONDS,
  });
  // Never print Zod input values: these include credentials.
  if (!result.success) throw new Error("OIDC installation configuration is missing or invalid.");
  return { ...result.data, origin: new URL(result.data.origin).origin };
}

export function isOidcConfigured() {
  if (!oidcModeEnabled()) return false;
  try { getOidcConfig(); return true; } catch { return false; }
}

export function oidcProvider(issuer: string) { return `oidc:${issuer}`; }
