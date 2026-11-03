/**
 * Installation identity and desired/observed state.
 *
 * The Console stores the desired manifest (`install.yaml` parsed as JSON) and
 * the last summary an installation reported. It never stores a provider token,
 * message content, or raw logs. The installation credential is issued by a
 * single-use bootstrap token and is scoped to its own installation plus
 * `console.projects.link`.
 *
 * Contract: spec console/managed-runtime/installations.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db, schema } from "@/server/db";
import type { JsonRecord } from "@/server/db/schema";

import { cliApiError } from "./errors";
import {
  generateCliCredentials,
  getCliAccessTokenSecret,
  hashMachineFingerprint,
  hashToken,
} from "./tokens";

export const INSTALLATION_CREDENTIAL_SCOPES = [
  "console.installations.read",
  "console.installations.write",
  "console.projects.link",
] as const;

export const BOOTSTRAP_TOKEN_TTL_MS = 15 * 60 * 1000;

const NAME_MAX = 120;
const HASH_MAX = 200;
const TEXT_MAX = 120;

export type DesiredInstallation = {
  organizationId: string;
  installationId: string;
  name: string;
  version: number;
  hash: string;
  desired: JsonRecord;
};

export type InstallationCredentialResponse = {
  version: 1;
  subjectType: "installation";
  installation: {
    id: string;
    name: string;
    hostname: string | null;
    platform: string | null;
    raviVersion: string | null;
    status: string;
    installState: string;
    lastSeenAt: string;
  };
  organization: { id: string; slug: string; name: string };
  cliSession: {
    id: string;
    status: string;
    expiresAt: string;
    lastUsedAt: string | null;
  };
  scopes: string[];
  tokenType: "Bearer";
  accessToken: string;
  accessTokenExpiresAt: string;
  expiresIn: number;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  desired: DesiredInstallation;
};

export const reportedInstallationStateSchema = z
  .object({
    state: z.enum([
      "bootstrapped",
      "configured",
      "healthy",
      "blocked_human",
      "drifted",
      "degraded",
    ]),
    raviVersion: z.string().trim().max(80).optional(),
    appliedHash: z.string().trim().max(HASH_MAX).optional(),
    desiredVersion: z.number().int().positive().optional(),
    drift: z
      .array(
        z
          .object({
            resource: z.string().trim().min(1).max(60),
            key: z.string().trim().min(1).max(200),
            field: z.string().trim().min(1).max(80),
          })
          .strict(),
      )
      .max(200)
      .optional(),
    doctor: z
      .object({
        checks: z
          .array(
            z
              .object({
                id: z.string().trim().min(1).max(TEXT_MAX),
                ok: z.boolean(),
                error: z.string().trim().max(TEXT_MAX).optional(),
              })
              .strict(),
          )
          .max(200),
      })
      .strict()
      .optional(),
    gates: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(TEXT_MAX),
            state: z.enum(["satisfied", "blocked"]),
            requires: z.string().trim().max(TEXT_MAX).optional(),
          })
          .strict(),
      )
      .max(50)
      .optional(),
    instances: z.number().int().nonnegative().optional(),
    channels: z.number().int().nonnegative().optional(),
  })
  .strict();

export type ReportedInstallationState = z.infer<typeof reportedInstallationStateSchema>;

const bootstrapMetadataSchema = z
  .object({
    name: z.string().trim().max(NAME_MAX).optional(),
    hostname: z.string().trim().max(120).optional(),
    platform: z.string().trim().max(80).optional(),
    raviVersion: z.string().trim().max(80).optional(),
    machineFingerprint: z.string().trim().max(512).optional(),
  })
  .strict();

export type BootstrapInstallationMetadata = z.infer<typeof bootstrapMetadataSchema>;

export function parseBootstrapMetadata(body: unknown) {
  const parsed = bootstrapMetadataSchema.safeParse(body ?? {});
  if (!parsed.success) throw cliApiError(400, "PAYLOAD_INVALID");
  return parsed.data;
}

export function generateBootstrapToken() {
  return `ravi_bst_${randomBytes(32).toString("base64url")}`;
}

export function hashDesiredInstallation(desired: JsonRecord) {
  return `sha256:${createHash("sha256").update(canonicalDesiredJson(desired), "utf8").digest("hex")}`;
}

/** The raw string that gets hashed. Exported so the OSS side can match it exactly. */
export function canonicalDesiredJson(desired: JsonRecord) {
  return stableJson(desired);
}

/**
 * Creates the installation record and its bootstrap token. The plaintext
 * token is returned once and never stored.
 */
export async function createManagedInstallation(input: {
  organizationId: string;
  createdByUserId: string;
  name: string;
  desired: JsonRecord;
  requestId: string;
  now?: Date;
}): Promise<{
  installation: typeof schema.localInstallations.$inferSelect;
  token: string;
  tokenExpiresAt: Date;
}> {
  const now = input.now ?? new Date();
  const name = input.name.trim().slice(0, NAME_MAX);
  if (!name) throw cliApiError(400, "PAYLOAD_INVALID");

  const desiredHash = hashDesiredInstallation(input.desired);
  const token = generateBootstrapToken();
  const tokenExpiresAt = new Date(now.getTime() + BOOTSTRAP_TOKEN_TTL_MS);

  return db.transaction(async (tx) => {
    const [installation] = await tx
      .insert(schema.localInstallations)
      .values({
        organizationId: input.organizationId,
        userId: null,
        subjectType: "installation",
        name,
        status: "active",
        installState: "requested",
        desiredJson: input.desired,
        desiredVersion: 1,
        desiredHash,
        firstSeenAt: now,
        lastSeenAt: now,
      })
      .returning();
    if (!installation) throw new Error("Failed to create installation.");

    await tx.insert(schema.installationBootstrapTokens).values({
      organizationId: input.organizationId,
      installationId: installation.id,
      tokenHash: hashToken(token),
      createdByUserId: input.createdByUserId,
      expiresAt: tokenExpiresAt,
    });

    await tx.insert(schema.auditEvents).values({
      organizationId: input.organizationId,
      actorType: "user",
      actorId: input.createdByUserId,
      targetType: "local_installation",
      targetId: installation.id,
      action: "local_installation.created",
      requestId: input.requestId,
      metadataJson: {
        desiredHash,
        desiredVersion: 1,
        source: "console.managed-installation",
      },
    });

    return { installation, token, tokenExpiresAt };
  });
}

/**
 * Exchanges a single-use bootstrap token for an installation credential.
 * Idempotent only in the sense that a consumed token is refused: the caller
 * must not retry with the same token.
 */
export async function bootstrapInstallation(input: {
  token: string;
  metadata: BootstrapInstallationMetadata;
  requestId: string;
  userAgent?: string | null;
  now?: Date;
}): Promise<InstallationCredentialResponse> {
  const now = input.now ?? new Date();
  const tokenHash = hashToken(input.token);
  const machineFingerprintHash = input.metadata.machineFingerprint
    ? hashMachineFingerprint(input.metadata.machineFingerprint)
    : null;
  const secret = getCliAccessTokenSecret();
  if (!secret) throw cliApiError(503, "SERVER_UNAVAILABLE", "CLI token issuer is not configured.");

  const sessionId = randomUUID();
  const result = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        token: schema.installationBootstrapTokens,
        installation: schema.localInstallations,
        organization: schema.organizations,
      })
      .from(schema.installationBootstrapTokens)
      .innerJoin(
        schema.localInstallations,
        eq(schema.installationBootstrapTokens.installationId, schema.localInstallations.id),
      )
      .innerJoin(
        schema.organizations,
        eq(schema.installationBootstrapTokens.organizationId, schema.organizations.id),
      )
      .where(eq(schema.installationBootstrapTokens.tokenHash, tokenHash))
      .limit(1)
      .for("update");

    if (!row) throw cliApiError(401, "BOOTSTRAP_TOKEN_INVALID");
    if (row.token.revokedAt) throw cliApiError(401, "BOOTSTRAP_TOKEN_REVOKED");
    if (row.token.usedAt) throw cliApiError(409, "BOOTSTRAP_TOKEN_USED");
    if (row.token.expiresAt <= now) throw cliApiError(401, "BOOTSTRAP_TOKEN_EXPIRED");
    if (row.installation.status !== "active") throw cliApiError(403, "INSTALLATION_REVOKED");
    if (row.installation.installState === "decommissioned" || row.organization.status !== "active") {
      throw cliApiError(403, "INSTALLATION_REVOKED");
    }

    if (machineFingerprintHash) {
      const burned = await tx
        .select({ id: schema.localInstallations.id })
        .from(schema.localInstallations)
        .where(
          and(
            eq(schema.localInstallations.organizationId, row.installation.organizationId),
            eq(schema.localInstallations.machineFingerprintHash, machineFingerprintHash),
            eq(schema.localInstallations.status, "decommissioned"),
          ),
        )
        .limit(1);
      if (burned.length > 0) throw cliApiError(403, "INSTALLATION_REVOKED");
    }

    const [consumed] = await tx
      .update(schema.installationBootstrapTokens)
      .set({ usedAt: now, updatedAt: now })
      .where(
        and(
          eq(schema.installationBootstrapTokens.id, row.token.id),
          eq(schema.installationBootstrapTokens.tokenHash, tokenHash),
        ),
      )
      .returning({ id: schema.installationBootstrapTokens.id });
    if (!consumed) throw cliApiError(409, "BOOTSTRAP_TOKEN_USED");

    const name = input.metadata.name ?? row.installation.name;
    const [installation] = await tx
      .update(schema.localInstallations)
      .set({
        name: name.slice(0, NAME_MAX),
        hostname: input.metadata.hostname ?? null,
        platform: input.metadata.platform ?? null,
        raviVersion: input.metadata.raviVersion ?? null,
        machineFingerprintHash: machineFingerprintHash ?? row.installation.machineFingerprintHash,
        subjectType: "installation",
        userId: null,
        status: "active",
        installState: "bootstrapped",
        installStateReason: null,
        lastSeenAt: now,
        updatedAt: now,
      })
      .where(eq(schema.localInstallations.id, row.installation.id))
      .returning();
    if (!installation) throw new Error("Failed to bootstrap installation.");

    const credentials = await generateCliCredentials({
      secret,
      sessionId,
      localInstallationId: installation.id,
      organizationId: installation.organizationId,
      userId: null,
      subjectType: "installation",
      scopes: [...INSTALLATION_CREDENTIAL_SCOPES],
      now,
    });

    const [session] = await tx
      .insert(schema.cliSessions)
      .values({
        id: sessionId,
        localInstallationId: installation.id,
        organizationId: installation.organizationId,
        userId: null,
        subjectType: "installation",
        refreshTokenHash: credentials.refreshTokenHash,
        accessTokenJti: credentials.accessTokenJti,
        scopesJson: [...INSTALLATION_CREDENTIAL_SCOPES],
        status: "active",
        expiresAt: credentials.refreshTokenExpiresAt,
        lastUsedAt: now,
      })
      .returning();
    if (!session) throw new Error("Failed to create installation session.");

    await tx.insert(schema.auditEvents).values([
      {
        organizationId: installation.organizationId,
        actorType: "cli",
        actorId: installation.id,
        targetType: "local_installation",
        targetId: installation.id,
        action: "local_installation.bootstrapped",
        requestId: input.requestId,
        metadataJson: {
          bootstrapTokenId: row.token.id,
          localInstallationId: installation.id,
          machineFingerprint: Boolean(machineFingerprintHash),
          userAgent: input.userAgent?.slice(0, 180) ?? null,
        },
      },
      {
        organizationId: installation.organizationId,
        actorType: "cli",
        actorId: installation.id,
        targetType: "cli_session",
        targetId: session.id,
        action: "cli_session.created",
        requestId: input.requestId,
        metadataJson: {
          localInstallationId: installation.id,
          scopes: [...INSTALLATION_CREDENTIAL_SCOPES],
          source: "installation-bootstrap",
        },
      },
    ]);

    return { installation, organization: row.organization, session, credentials };
  });

  return installationCredentialResponse({
    installation: result.installation,
    organization: result.organization,
    cliSession: result.session,
    credentials: result.credentials,
    now,
  });
}

/** Shared by bootstrap and refresh so both return exactly one credential shape. */
export function installationCredentialResponse(input: {
  installation: typeof schema.localInstallations.$inferSelect;
  organization: typeof schema.organizations.$inferSelect;
  cliSession: typeof schema.cliSessions.$inferSelect;
  credentials: Awaited<ReturnType<typeof generateCliCredentials>>;
  now: Date;
}): InstallationCredentialResponse {
  return {
    version: 1,
    subjectType: "installation",
    installation: installationSummary(input.installation),
    organization: {
      id: input.organization.id,
      slug: input.organization.slug,
      name: input.organization.name,
    },
    cliSession: {
      id: input.cliSession.id,
      status: input.cliSession.status,
      expiresAt: input.cliSession.expiresAt.toISOString(),
      lastUsedAt: input.cliSession.lastUsedAt?.toISOString() ?? null,
    },
    scopes: input.cliSession.scopesJson,
    tokenType: "Bearer",
    accessToken: input.credentials.accessToken,
    accessTokenExpiresAt: input.credentials.accessTokenExpiresAt.toISOString(),
    expiresIn: Math.max(
      0,
      Math.round((input.credentials.accessTokenExpiresAt.getTime() - input.now.getTime()) / 1000),
    ),
    refreshToken: input.credentials.refreshToken,
    refreshTokenExpiresAt: input.credentials.refreshTokenExpiresAt.toISOString(),
    desired: desiredInstallation(input.installation),
  };
}

export function desiredInstallation(
  installation: typeof schema.localInstallations.$inferSelect,
): DesiredInstallation {
  return {
    organizationId: installation.organizationId,
    installationId: installation.id,
    name: installation.name,
    version: installation.desiredVersion,
    hash: installation.desiredHash ?? hashDesiredInstallation(installation.desiredJson),
    desired: installation.desiredJson,
  };
}

export async function getInstallationDesired(input: {
  installation: typeof schema.localInstallations.$inferSelect;
  installationId: string;
  requestId: string;
}): Promise<DesiredInstallation> {
  if (input.installation.id !== input.installationId) {
    throw cliApiError(403, "INSTALLATION_MISMATCH");
  }
  return desiredInstallation(input.installation);
}

export async function reportInstallationState(input: {
  installation: typeof schema.localInstallations.$inferSelect;
  installationId: string;
  reported: ReportedInstallationState;
  requestId: string;
  now?: Date;
}): Promise<{
  installation: ReturnType<typeof installationSummary>;
  drift: boolean;
  desired: DesiredInstallation;
}> {
  if (input.installation.id !== input.installationId) {
    throw cliApiError(403, "INSTALLATION_MISMATCH");
  }
  const now = input.now ?? new Date();
  const { installation } = input;
  const desiredHash = installation.desiredHash ?? hashDesiredInstallation(installation.desiredJson);
  const appliedHash = input.reported.appliedHash ?? installation.appliedHash;
  const drift = Boolean(appliedHash && desiredHash && appliedHash !== desiredHash);
  const state = drift && input.reported.state === "healthy" ? "drifted" : input.reported.state;

  const [updated] = await db
    .update(schema.localInstallations)
    .set({
      appliedHash: appliedHash ?? null,
      installState: state,
      installStateReason: drift ? "applied_hash_differs_from_desired" : null,
      lastSeenAt: now,
      observedJson: input.reported,
      raviVersion: input.reported.raviVersion ?? installation.raviVersion,
      stateReportedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.localInstallations.id, installation.id),
        eq(schema.localInstallations.status, "active"),
      ),
    )
    .returning();
  if (!updated) throw cliApiError(403, "INSTALLATION_REVOKED");

  await db.insert(schema.auditEvents).values({
    organizationId: installation.organizationId,
    actorType: "cli",
    actorId: installation.id,
    targetType: "local_installation",
    targetId: installation.id,
    action: "local_installation.state_reported",
    requestId: input.requestId,
    metadataJson: {
      appliedHash: appliedHash ?? null,
      desiredHash,
      drift,
      localInstallationId: installation.id,
      state,
    },
  });

  return { installation: installationSummary(updated), drift, desired: desiredInstallation(updated) };
}

export function installationSummary(
  installation: typeof schema.localInstallations.$inferSelect,
) {
  return {
    id: installation.id,
    name: installation.name,
    hostname: installation.hostname,
    platform: installation.platform,
    raviVersion: installation.raviVersion,
    status: installation.status,
    installState: installation.installState,
    lastSeenAt: installation.lastSeenAt.toISOString(),
  };
}

/**
 * Stable JSON for hashing: object keys sorted by Unicode code point, arrays
 * keep their order, no whitespace.
 *
 * The comparator is code-point based on purpose. `localeCompare` follows the
 * host locale/ICU, so the same manifest could hash differently in two
 * environments and leave the installation in permanent drift. The fixed vector
 * in installations.test.ts is the contract the OSS reconciler copies.
 */
function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => compareCodePoints(a, b))
        .map(([key, item]) => [key, sortJson(item)]),
    );
  }
  return value;
}

function compareCodePoints(a: string, b: string) {
  const left = Array.from(a);
  const right = Array.from(b);
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftCode = left[index]?.codePointAt(0) ?? 0;
    const rightCode = right[index]?.codePointAt(0) ?? 0;
    if (leftCode !== rightCode) return leftCode - rightCode;
  }
  return left.length - right.length;
}
