import { and, eq, gt, lte } from "drizzle-orm";
import { randomBytes, randomInt } from "node:crypto";

import type { ConsoleAuthState } from "@/lib/auth/session";
import { consoleBrowserOrigin } from "@/lib/auth/console-origin";
import { hasActiveBrowserSession, hasActiveMember, lockMemberIssuance } from "@/lib/auth/member-issuance";
import { getConsoleWorkspace } from "@/server/console/workspace";
import { db, schema } from "@/server/db";

import { DEFAULT_CLI_SCOPES } from "./config";
import { cliApiError } from "./errors";
import { hashToken } from "./tokens";

export const CLI_DEVICE_AUTH_EXPIRES_IN_SECONDS = 10 * 60;
export const CLI_DEVICE_AUTH_INTERVAL_SECONDS = 2;

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type CliDeviceAuthorizationResponse = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
};

export type CliDeviceAuthorizationView = {
  status: "pending" | "approved" | "consumed" | "expired" | "denied" | "invalid";
  expiresAt: string | null;
};

export async function createCliDeviceAuthorization(input: {
  requestUrl: string;
  clientId?: string | null;
  userAgent?: string | null;
}): Promise<CliDeviceAuthorizationResponse> {
  const origin = consoleBrowserOrigin(input.requestUrl);
  const now = new Date();
  const expiresAt = addSeconds(now, CLI_DEVICE_AUTH_EXPIRES_IN_SECONDS);
  const deviceCode = `ravi_cd_${randomBytes(48).toString("base64url")}`;
  const userCode = generateUserCode();
  const verificationUri = new URL("/cli/authorize", origin).toString();
  const verificationUriComplete = new URL(`/cli/authorize?user_code=${encodeURIComponent(userCode)}`, origin).toString();

  await db.insert(schema.cliDeviceAuthorizations).values({
    deviceCodeHash: hashToken(`cli-device:${deviceCode}`),
    userCodeHash: hashToken(`cli-user:${normalizeUserCode(userCode)}`),
    scopesJson: [...DEFAULT_CLI_SCOPES],
    metadataJson: {
      clientId: cleanText(input.clientId, 120),
      source: "console_device_authorization",
      userAgent: cleanText(input.userAgent, 180),
    },
    expiresAt,
  });

  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete,
    expiresIn: CLI_DEVICE_AUTH_EXPIRES_IN_SECONDS,
    interval: CLI_DEVICE_AUTH_INTERVAL_SECONDS,
  };
}

export async function getCliDeviceAuthorizationView(userCode: string | null): Promise<CliDeviceAuthorizationView> {
  const normalized = normalizeUserCode(userCode);
  if (!normalized) return { status: "invalid", expiresAt: null };

  const row = await findDeviceAuthorizationByUserCode(normalized);
  if (!row) return { status: "invalid", expiresAt: null };

  const now = new Date();
  if ((row.status === "pending" || row.status === "approved") && row.expiresAt <= now) {
    await expireDeviceAuthorization(row.id, now);
    return { status: "expired", expiresAt: row.expiresAt.toISOString() };
  }

  return { status: row.status, expiresAt: row.expiresAt.toISOString() };
}

export async function approveCliDeviceAuthorization(input: {
  auth: ConsoleAuthState;
  organizationRef?: string | null;
  requestId: string;
  userCode: string;
}) {
  const normalized = normalizeUserCode(input.userCode);
  if (!normalized) {
    throw cliApiError(400, "PAYLOAD_INVALID", "Device code is missing.");
  }

  const row = await findDeviceAuthorizationByUserCode(normalized);
  if (!row) {
    throw cliApiError(404, "AUTH_EXPIRED", "This Ravi CLI login code is invalid or expired.");
  }

  const now = new Date();
  if (row.expiresAt <= now) {
    await expireDeviceAuthorization(row.id, now);
    throw cliApiError(401, "AUTH_EXPIRED", "This Ravi CLI login code expired.");
  }

  const workspace = await getConsoleWorkspace(input.auth, {
    organizationRef: input.organizationRef,
  });

  return db.transaction(async tx => {
    await lockMemberIssuance(tx, workspace.organization.id);
    const [current] = await tx.select().from(schema.cliDeviceAuthorizations)
      .where(eq(schema.cliDeviceAuthorizations.id, row.id)).limit(1).for("update");
    const admittedAt = new Date();
    if (!current || current.expiresAt <= admittedAt) throw cliApiError(401, "AUTH_EXPIRED");
    if (!await hasActiveMember(tx, workspace.organization.id, workspace.user.id) ||
      (input.auth.mode === "oidc" && !await hasActiveBrowserSession(tx, workspace.organization.id, workspace.user.id, input.auth.oidc?.sessionId))) {
      throw cliApiError(403, "ORG_ACCESS_DENIED");
    }
    if (current.status === "approved" && current.userId === workspace.user.id && current.organizationId === workspace.organization.id) {
      if (current.expiresAt <= new Date()) throw cliApiError(401, "AUTH_EXPIRED");
      return { ok: true as const };
    }
    if (current.status !== "pending") throw cliApiError(401, "AUTH_EXPIRED", "This Ravi CLI login code is no longer pending.");
    const [updated] = await tx.update(schema.cliDeviceAuthorizations).set({
      status: "approved", userId: workspace.user.id, organizationId: workspace.organization.id,
      membershipId: workspace.membership.id, approvedAt: admittedAt, updatedAt: admittedAt,
    }).where(and(eq(schema.cliDeviceAuthorizations.id, row.id), eq(schema.cliDeviceAuthorizations.status, "pending"),
      gt(schema.cliDeviceAuthorizations.expiresAt, new Date()))).returning();
    if (!updated) throw cliApiError(401, "AUTH_EXPIRED");
    await tx.insert(schema.auditEvents).values({
      organizationId: workspace.organization.id,
      actorType: workspace.mode === "anonymous" ? "anonymous" : "user", actorId: workspace.user.id,
      targetType: "cli_device_authorization", targetId: row.id, action: "cli_device_authorization.approved",
      requestId: input.requestId, metadataJson: { source: "cli-auth", localFlow: "console_device_authorization" },
    });
    // A row/write/audit wait may have crossed either source deadline. Throwing
    // here rolls back approval and its success audit in the same transaction.
    if (input.auth.mode === "oidc" && !await hasActiveBrowserSession(tx, workspace.organization.id, workspace.user.id, input.auth.oidc?.sessionId))
      throw cliApiError(403, "ORG_ACCESS_DENIED");
    if (current.expiresAt <= new Date()) throw cliApiError(401, "AUTH_EXPIRED");
    return { ok: true as const };
  });
}

export async function resolveApprovedCliDeviceAuthorizationForExchange(input: {
  deviceCode: string;
  requestId: string;
}) {
  const deviceCodeHash = hashToken(`cli-device:${input.deviceCode}`);
  const now = new Date();
  const [row] = await db
    .select({
      authorization: schema.cliDeviceAuthorizations,
      user: schema.users,
      organization: schema.organizations,
      membership: schema.organizationMemberships,
    })
    .from(schema.cliDeviceAuthorizations)
    .leftJoin(schema.users, eq(schema.cliDeviceAuthorizations.userId, schema.users.id))
    .leftJoin(schema.organizations, eq(schema.cliDeviceAuthorizations.organizationId, schema.organizations.id))
    .leftJoin(schema.organizationMemberships, eq(schema.cliDeviceAuthorizations.membershipId, schema.organizationMemberships.id))
    .where(eq(schema.cliDeviceAuthorizations.deviceCodeHash, deviceCodeHash))
    .limit(1);

  if (!row) {
    throw cliApiError(401, "AUTH_EXPIRED", "This Ravi CLI login code is invalid or expired.");
  }

  if ((row.authorization.status === "pending" || row.authorization.status === "approved") && row.authorization.expiresAt <= now) {
    await expireDeviceAuthorization(row.authorization.id, now);
    throw cliApiError(401, "AUTH_EXPIRED", "This Ravi CLI login code expired.");
  }

  if (row.authorization.status === "pending") {
    await db
      .update(schema.cliDeviceAuthorizations)
      .set({ lastPolledAt: now, updatedAt: now })
      .where(eq(schema.cliDeviceAuthorizations.id, row.authorization.id));
    throw cliApiError(409, "AUTH_PENDING");
  }

  if (
    row.authorization.status !== "approved" ||
    !row.user ||
    !row.organization ||
    !row.membership
  ) {
    throw cliApiError(401, "AUTH_EXPIRED", "This Ravi CLI login code was already used.");
  }

  if (
    row.user.status !== "active" ||
    row.organization.status !== "active" ||
    row.membership.status !== "active"
  ) {
    throw cliApiError(
      403,
      "ORG_ACCESS_DENIED",
      "This CLI login cannot be completed because the Console user, organization, or membership is not active. Re-run `ravi login` and approve at /cli/authorize?user_code=…, or ask an organization owner to restore a Console-compatible role.",
    );
  }

  return {
    authorization: row.authorization,
    user: row.user,
    organization: row.organization,
    membership: row.membership,
    scopes: row.authorization.scopesJson.length ? row.authorization.scopesJson : [...DEFAULT_CLI_SCOPES],
  };
}

export async function consumeCliDeviceAuthorization(input: {
  tx: DbTransaction;
  authorizationId: string;
}) {
  // Fleet is already held. Acquire the source row BEFORE reading the clock;
  // an UPDATE predicate bound before its row wait would still use stale time.
  const [source] = await input.tx.select().from(schema.cliDeviceAuthorizations)
    .where(eq(schema.cliDeviceAuthorizations.id, input.authorizationId)).limit(1).for("update");
  const now = new Date();
  if (!source || source.status !== "approved" || source.expiresAt <= now) throw cliApiError(401, "AUTH_EXPIRED");
  const [updated] = await input.tx
    .update(schema.cliDeviceAuthorizations)
    .set({
      status: "consumed",
      consumedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.cliDeviceAuthorizations.id, input.authorizationId),
        eq(schema.cliDeviceAuthorizations.status, "approved"),
        gt(schema.cliDeviceAuthorizations.expiresAt, now),
      ),
    )
    .returning({ id: schema.cliDeviceAuthorizations.id });

  if (!updated) {
    throw cliApiError(401, "AUTH_EXPIRED", "This Ravi CLI login code was already used.");
  }
  return { admittedAt: now, expiresAt: source.expiresAt };
}

function findDeviceAuthorizationByUserCode(userCode: string) {
  return db.query.cliDeviceAuthorizations.findFirst({
    where: eq(
      schema.cliDeviceAuthorizations.userCodeHash,
      hashToken(`cli-user:${userCode}`),
    ),
  });
}

async function expireDeviceAuthorization(id: string, now: Date) {
  await db
    .update(schema.cliDeviceAuthorizations)
    .set({ status: "expired", updatedAt: now })
    .where(
      and(
        eq(schema.cliDeviceAuthorizations.id, id),
        lte(schema.cliDeviceAuthorizations.expiresAt, now),
      ),
    );
}

function generateUserCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let value = "";
  for (let index = 0; index < 8; index += 1) {
    value += alphabet[randomInt(alphabet.length)];
  }
  return `${value.slice(0, 4)}-${value.slice(4)}`;
}

export function normalizeUserCode(value: string | null | undefined) {
  const normalized = value?.replace(/[^a-z0-9]/gi, "").toUpperCase() ?? "";
  return normalized.length === 8 ? normalized : null;
}

function addSeconds(date: Date, seconds: number) {
  return new Date(date.getTime() + seconds * 1000);
}

function cleanText(value: string | null | undefined, maxLength: number) {
  const cleaned = value?.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return cleaned ? cleaned.slice(0, maxLength) : null;
}
