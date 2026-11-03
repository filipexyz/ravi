import { eq } from "drizzle-orm";

import { isHostedOrProductionRuntime } from "@/lib/auth/config";
import { ConsoleApiError } from "@/server/console/api-error";
import { db, schema } from "@/server/db";
import {
  fetchWorkosUserManagementMetadata,
  type WorkosUserManagementMetadataResult,
} from "@/server/workos/user-management";

export const WORKOS_PLATFORM_OPERATOR_METADATA_KEY = "ravi_platform_operator";
export const PLATFORM_OPERATOR_DEV_ALLOWLIST_ENV = "RAVI_PLATFORM_OPERATOR_DEV_ALLOWLIST";

export type PlatformOperatorSource = "workos_metadata" | "env_allowlist";
export type PlatformOperatorMetadataSource = "user_management_api" | "session" | "unavailable";
export type PlatformOperatorMirrorAction = "upsert" | "revoke" | "preserve";

export type PlatformOperatorGrant = {
  granted: boolean;
  source: PlatformOperatorSource | null;
  preserveExisting?: boolean;
};

export type PlatformOperatorIdentity = {
  email: string;
  provider?: string;
  providerUserId?: string;
  rawProfile: Record<string, unknown>;
};

export type PlatformOperatorSyncIdentity = PlatformOperatorIdentity & {
  provider: string;
  providerUserId: string;
};

export type PlatformOperatorUser = {
  id: string;
  primaryEmail: string;
};

export function platformOperatorFromWorkosMetadata(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  const value = (metadata as Record<string, unknown>)[WORKOS_PLATFORM_OPERATOR_METADATA_KEY];
  if (value === true) return true;
  if (typeof value === "number" && value === 1) return true;
  if (typeof value === "string" && value.trim().toLowerCase() === "true") return true;
  return false;
}

export function workosMetadataFromRawProfile(rawProfile: Record<string, unknown>): unknown {
  if (rawProfile.metadata && typeof rawProfile.metadata === "object" && !Array.isArray(rawProfile.metadata)) {
    return rawProfile.metadata;
  }

  const userProfile = rawProfile.userProfile;
  if (userProfile && typeof userProfile === "object" && !Array.isArray(userProfile)) {
    const nested = (userProfile as Record<string, unknown>).metadata;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) return nested;
  }

  return undefined;
}

export function parsePlatformOperatorDevAllowlist(value: string | undefined): {
  emails: string[];
  userIds: string[];
} {
  const emails: string[] = [];
  const userIds: string[] = [];

  for (const part of (value ?? "").split(",")) {
    const token = part.trim().toLowerCase();
    if (!token) continue;
    if (token.includes("@")) emails.push(token);
    else userIds.push(token);
  }

  return { emails, userIds };
}

export function isPlatformOperatorDevAllowlistEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (isHostedOrProductionRuntime()) return false;
  return Boolean(env[PLATFORM_OPERATOR_DEV_ALLOWLIST_ENV]?.trim());
}

export function matchesPlatformOperatorDevAllowlist(
  user: PlatformOperatorUser,
  allowlist = parsePlatformOperatorDevAllowlist(process.env[PLATFORM_OPERATOR_DEV_ALLOWLIST_ENV]),
): boolean {
  const email = user.primaryEmail.trim().toLowerCase();
  const userId = user.id.trim().toLowerCase();
  return allowlist.emails.includes(email) || allowlist.userIds.includes(userId);
}

export function sessionProfileHasOperatorMetadataKey(rawProfile: Record<string, unknown>): boolean {
  const metadata = workosMetadataFromRawProfile(rawProfile);
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  return WORKOS_PLATFORM_OPERATOR_METADATA_KEY in metadata;
}

export function mergeWorkosUserManagementMetadata(
  rawProfile: Record<string, unknown>,
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = {
    ...rawProfile,
    metadata,
    workosMetadataSource: "user_management_api",
  };

  const userProfile = rawProfile.userProfile;
  if (userProfile && typeof userProfile === "object" && !Array.isArray(userProfile)) {
    next.userProfile = {
      ...(userProfile as Record<string, unknown>),
      metadata,
    };
  }

  return next;
}

export async function applyWorkosUserManagementMetadataToIdentity<T extends PlatformOperatorSyncIdentity>(
  identity: T,
  options: {
    fetchMetadata?: (
      workosUserId: string,
    ) => Promise<WorkosUserManagementMetadataResult>;
  } = {},
): Promise<{
  identity: T;
  metadataSource: PlatformOperatorMetadataSource;
  workosMetadataResolved: boolean;
}> {
  if (identity.provider !== "workos") {
    return { identity, metadataSource: "unavailable", workosMetadataResolved: true };
  }

  const fetchMetadata = options.fetchMetadata ?? fetchWorkosUserManagementMetadata;
  const apiResult = await fetchMetadata(identity.providerUserId);
  if (apiResult.ok) {
    return {
      identity: {
        ...identity,
        rawProfile: mergeWorkosUserManagementMetadata(identity.rawProfile, apiResult.metadata),
      },
      metadataSource: "user_management_api",
      workosMetadataResolved: true,
    };
  }

  if (sessionProfileHasOperatorMetadataKey(identity.rawProfile)) {
    return { identity, metadataSource: "session", workosMetadataResolved: true };
  }

  return { identity, metadataSource: "unavailable", workosMetadataResolved: false };
}

export function resolvePlatformOperatorGrant(input: {
  identity: PlatformOperatorIdentity;
  user: PlatformOperatorUser;
  env?: NodeJS.ProcessEnv;
  workosMetadataResolved?: boolean;
}): PlatformOperatorGrant {
  // OIDC authenticates people; installation membership never grants central ops.
  if (input.identity.provider?.startsWith("oidc:")) return { granted: false, source: null };
  const env = input.env ?? process.env;
  if (platformOperatorFromWorkosMetadata(workosMetadataFromRawProfile(input.identity.rawProfile))) {
    return { granted: true, source: "workos_metadata" };
  }

  if (
    isPlatformOperatorDevAllowlistEnabled(env) &&
    matchesPlatformOperatorDevAllowlist(
      input.user,
      parsePlatformOperatorDevAllowlist(env[PLATFORM_OPERATOR_DEV_ALLOWLIST_ENV]),
    )
  ) {
    return { granted: true, source: "env_allowlist" };
  }

  if (input.workosMetadataResolved === false) {
    return { granted: false, source: null, preserveExisting: true };
  }

  return { granted: false, source: null };
}

export function platformOperatorMirrorAction(grant: PlatformOperatorGrant): PlatformOperatorMirrorAction {
  if (grant.granted && grant.source) return "upsert";
  if (grant.preserveExisting) return "preserve";
  return "revoke";
}

export async function syncPlatformOperatorMirror(input: {
  identity: PlatformOperatorIdentity;
  user: PlatformOperatorUser;
  workosMetadataResolved?: boolean;
}): Promise<PlatformOperatorGrant> {
  const grant = resolvePlatformOperatorGrant(input);
  const [existing] = await db
    .select({ userId: schema.platformOperators.userId, source: schema.platformOperators.source })
    .from(schema.platformOperators)
    .where(eq(schema.platformOperators.userId, input.user.id))
    .limit(1);

  if (grant.granted && grant.source) {
    const now = new Date();
    await db
      .insert(schema.platformOperators)
      .values({
        userId: input.user.id,
        source: grant.source,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.platformOperators.userId,
        set: {
          source: grant.source,
          updatedAt: now,
        },
      });

    if (!existing || existing.source !== grant.source) {
      await writePlatformOperatorAudit({
        action: existing ? "platform_operator.updated" : "platform_operator.granted",
        source: grant.source,
        userId: input.user.id,
      });
    }

    return grant;
  }

  if (platformOperatorMirrorAction(grant) === "preserve") {
    return grant;
  }

  if (existing) {
    await db.delete(schema.platformOperators).where(eq(schema.platformOperators.userId, input.user.id));
    await writePlatformOperatorAudit({
      action: "platform_operator.revoked",
      source: existing.source,
      userId: input.user.id,
    });
  }

  return grant;
}

export async function isPlatformOperator(user: Pick<PlatformOperatorUser, "id">): Promise<boolean> {
  const [row] = await db
    .select({ userId: schema.platformOperators.userId })
    .from(schema.platformOperators)
    .where(eq(schema.platformOperators.userId, user.id))
    .limit(1);
  return Boolean(row);
}

export async function assertPlatformOperator(user: Pick<PlatformOperatorUser, "id">): Promise<void> {
  if (await isPlatformOperator(user)) return;
  throw new ConsoleApiError(403, { error: "forbidden" });
}

export function isConsoleManageBugsPath(segments: string[]): boolean {
  const [area, resource] = segments;
  return (area === "manage" || area === "admin") && resource === "bugs";
}

export function platformOperatorPageOutcome(isOperator: boolean): "ok" | "not_found" {
  return isOperator ? "ok" : "not_found";
}

async function writePlatformOperatorAudit(input: {
  action: string;
  source: string;
  userId: string;
}) {
  await db.insert(schema.auditEvents).values({
    organizationId: null,
    actorType: "system",
    actorId: input.userId,
    targetType: "user",
    targetId: input.userId,
    action: input.action,
    metadataJson: {
      source: input.source,
    },
  });
}
