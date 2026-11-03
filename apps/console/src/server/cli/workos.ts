import { createRemoteJWKSet, decodeJwt, decodeProtectedHeader, jwtVerify, type JWTPayload } from "jose";

import type { ConsoleIdentity } from "@/server/console/workspace";
import {
  inspectWorkosRoleClaims,
  workosOrganizationAccessDiagnostics,
  workosOrganizationRoleDeniedMessage,
  type WorkosOrganizationAccessDiagnostics,
} from "@/server/console/workos-role";

import { getCliWorkosValidationConfig } from "./config";
import { CliApiError, cliApiError } from "./errors";

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export type WorkosUserProfile = {
  id: string;
  email: string;
  name: string | null;
  profilePictureUrl: string | null;
  rawProfile: Record<string, unknown>;
};

export type WorkosCliIdentityResult = {
  identity: ConsoleIdentity;
  providerOrganizationId: string | null;
  organizationRoleMapped: boolean;
  diagnostics: WorkosOrganizationAccessDiagnostics;
};

export async function validateWorkosCliToken(workosAccessToken: string): Promise<WorkosCliIdentityResult> {
  const config = getCliWorkosValidationConfig();
  if (!config) {
    throw cliApiError(
      503,
      "SERVER_UNAVAILABLE",
      "CLI WorkOS exchange is not configured.",
    );
  }

  let payload: JWTPayload;
  try {
    const verified = await jwtVerify(workosAccessToken, jwksFor(config.jwksUrl), {
      issuer: issuerVariants(config.issuer),
    });
    payload = verified.payload;
  } catch (error) {
    logWorkosValidationFailure(error, workosAccessToken, config);
    throw cliApiError(401, "AUTH_REQUIRED", "WorkOS CLI token is invalid.");
  }

  const userProfile = await resolveWorkosUserProfile(payload);

  try {
    const result = workosIdentityFromPayload(payload, userProfile, { allowUnmappedOrganizationRole: true });
    if (result.providerOrganizationId && !result.organizationRoleMapped) {
      logWorkosUnmappedOrganizationRole(result.diagnostics);
    }
    return result;
  } catch (error) {
    if (error instanceof CliApiError) {
      logWorkosIdentityMappingFailure(
        error,
        workosOrganizationAccessDiagnostics({
          payload: payload as Record<string, unknown>,
          userProfile,
        }),
      );
    }
    throw error;
  }
}

export function workosIdentityFromPayload(payload: JWTPayload): WorkosCliIdentityResult;
export function workosIdentityFromPayload(
  payload: JWTPayload,
  userProfile: WorkosUserProfile | null,
): WorkosCliIdentityResult;
export function workosIdentityFromPayload(
  payload: JWTPayload,
  userProfile: WorkosUserProfile | null | undefined,
  options: { allowUnmappedOrganizationRole?: boolean },
): WorkosCliIdentityResult;
export function workosIdentityFromPayload(
  payload: JWTPayload,
  userProfile?: WorkosUserProfile | null,
  options?: { allowUnmappedOrganizationRole?: boolean },
): WorkosCliIdentityResult {
  const inspection = inspectWorkosRoleClaims(payload as Record<string, unknown>);
  const diagnostics = workosOrganizationAccessDiagnostics({
    payload: payload as Record<string, unknown>,
    userProfile,
  });
  const providerUserId = claim(payload, "sub") ?? userProfile?.id ?? null;
  const email =
    claim(payload, "email") ??
    claim(payload, "user_email") ??
    claim(payload, "preferred_username") ??
    userProfile?.email ??
    null;
  const providerOrganizationId = claim(payload, "org_id") ?? claim(payload, "organization_id");
  const providerMembershipId = claim(payload, "membership_id") ?? claim(payload, "organization_membership_id");
  const mappedRole = inspection.mappedRole;

  if (!providerUserId || !email) {
    throw cliApiError(401, "AUTH_REQUIRED", "WorkOS CLI token is missing identity claims.");
  }

  if (providerOrganizationId && !mappedRole && !options?.allowUnmappedOrganizationRole) {
    throw cliApiError(403, "ORG_ACCESS_DENIED", workosOrganizationRoleDeniedMessage(inspection));
  }

  const resolvedRole = mappedRole ?? "viewer";
  const name = claim(payload, "name") ?? userProfile?.name ?? email;
  const organizationSlug = providerOrganizationId
    ? `workos-${providerOrganizationId.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(-24)}`
    : "cli-organization-required";

  return {
    providerOrganizationId,
    organizationRoleMapped: Boolean(mappedRole),
    diagnostics,
    identity: {
      provider: "workos",
      providerUserId,
      providerOrganizationId: providerOrganizationId ?? undefined,
      providerMembershipId: providerMembershipId ?? undefined,
      email,
      name,
      avatarUrl: claim(payload, "picture") ?? userProfile?.profilePictureUrl ?? null,
      organizationName: providerOrganizationId
        ? claim(payload, "org_name") ?? `WorkOS ${providerOrganizationId.slice(-6)}`
        : "CLI organization required",
      organizationSlug,
      role: resolvedRole,
      rawProfile: safeWorkosProfile(payload, userProfile, inspection.slugs[0] ?? null),
    },
  };
}

function jwksFor(url: string) {
  const cached = jwksCache.get(url);
  if (cached) return cached;

  const jwks = createRemoteJWKSet(new URL(url));
  jwksCache.set(url, jwks);
  return jwks;
}

function issuerVariants(issuer: string | string[]) {
  const issuers = Array.isArray(issuer) ? issuer : [issuer];
  return [...new Set(issuers.flatMap((value) => (value.endsWith("/") ? [value, value.slice(0, -1)] : [value, `${value}/`])))];
}

function logWorkosValidationFailure(
  error: unknown,
  token: string,
  config: NonNullable<ReturnType<typeof getCliWorkosValidationConfig>>,
) {
  let claims: JWTPayload | null = null;
  let header: ReturnType<typeof decodeProtectedHeader> | null = null;
  try {
    claims = decodeJwt(token);
    header = decodeProtectedHeader(token);
  } catch {
    // Keep the log safe and useful even when the provider token is opaque or malformed.
  }

  console.error("WorkOS CLI token validation failed", {
    errorName: error instanceof Error ? error.name : "unknown",
    errorMessage: error instanceof Error ? error.message : String(error),
    allowedIssuers: issuerVariants(config.issuer),
    jwksHost: safeHost(config.jwksUrl),
    tokenIssuer: typeof claims?.iss === "string" ? claims.iss : null,
    tokenAudience: Array.isArray(claims?.aud) ? claims.aud : typeof claims?.aud === "string" ? claims.aud : null,
    tokenKid: typeof header?.kid === "string" ? header.kid : null,
    ...workosOrganizationAccessDiagnostics({
      payload: (claims ?? {}) as Record<string, unknown>,
    }),
  });
}

function logWorkosIdentityMappingFailure(
  error: CliApiError,
  diagnostics: WorkosOrganizationAccessDiagnostics,
) {
  console.error("WorkOS CLI identity mapping failed", {
    errorCode: error.code,
    ...diagnostics,
  });
}

export function logWorkosUnmappedOrganizationRole(diagnostics: WorkosOrganizationAccessDiagnostics) {
  console.error("WorkOS CLI organization role was missing or unmapped", diagnostics);
}

async function resolveWorkosUserProfile(payload: JWTPayload): Promise<WorkosUserProfile | null> {
  if (claim(payload, "email") ?? claim(payload, "user_email") ?? claim(payload, "preferred_username")) {
    return null;
  }

  const userId = claim(payload, "sub");
  if (!userId) return null;

  const apiKey = process.env.WORKOS_API_KEY?.trim();
  if (!apiKey) {
    console.error("WorkOS CLI user profile lookup skipped", {
      reason: "missing_api_key",
      hasSubject: true,
    });
    return null;
  }

  let response: Response;
  try {
    response = await fetch(`https://api.workos.com/user_management/users/${encodeURIComponent(userId)}`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
    });
  } catch (error) {
    console.error("WorkOS CLI user profile lookup failed", {
      reason: "request_failed",
      errorName: error instanceof Error ? error.name : "unknown",
      errorMessage: error instanceof Error ? error.message : String(error),
      userId,
    });
    return null;
  }

  if (!response.ok) {
    console.error("WorkOS CLI user profile lookup failed", {
      reason: "bad_status",
      status: response.status,
      userId,
    });
    return null;
  }

  const data = await response.json().catch(() => null);
  const rawProfile = record(data);
  const email = stringValue(rawProfile.email);
  if (!email) {
    console.error("WorkOS CLI user profile lookup returned no email", {
      userId,
      hasProfile: Boolean(rawProfile),
    });
    return null;
  }

  const firstName = stringValue(rawProfile.first_name) ?? stringValue(rawProfile.firstName);
  const lastName = stringValue(rawProfile.last_name) ?? stringValue(rawProfile.lastName);
  const fullName = [firstName, lastName].filter(Boolean).join(" ") || null;

  return {
    id: stringValue(rawProfile.id) ?? userId,
    email,
    name: fullName,
    profilePictureUrl:
      stringValue(rawProfile.profile_picture_url) ?? stringValue(rawProfile.profilePictureUrl),
    rawProfile,
  };
}

function safeHost(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return "invalid-url";
  }
}

function claim(payload: JWTPayload, key: string) {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function safeWorkosProfile(
  payload: JWTPayload,
  userProfile?: WorkosUserProfile | null,
  mappedRoleSlug?: string | null,
) {
  return {
    provider: "workos",
    subject: claim(payload, "sub"),
    email: claim(payload, "email") ?? claim(payload, "user_email") ?? claim(payload, "preferred_username"),
    organizationId: claim(payload, "org_id") ?? claim(payload, "organization_id"),
    membershipId: claim(payload, "membership_id") ?? claim(payload, "organization_membership_id"),
    role: mappedRoleSlug ?? claim(payload, "role") ?? claim(payload, "organization_role"),
    issuer: claim(payload, "iss"),
    audience: Array.isArray(payload.aud) ? payload.aud.filter((item): item is string => typeof item === "string") : claim(payload, "aud"),
    userProfile: userProfile
      ? {
          id: userProfile.id,
          email: userProfile.email,
          name: userProfile.name,
          profilePictureUrl: userProfile.profilePictureUrl,
          metadata: userProfile.rawProfile.metadata,
        }
      : null,
    metadata: userProfile?.rawProfile.metadata,
  };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
