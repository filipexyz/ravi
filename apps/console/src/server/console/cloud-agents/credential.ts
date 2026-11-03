// The organization's own Anthropic key (D5): verified before it is stored,
// encrypted at rest, never echoed (only the last four characters), revoked by
// wiping the secret. Every provider call goes through `withOrganizationProvider`,
// which marks the key invalid when the provider rejects it.

import { randomUUID } from "node:crypto";

import { and, eq, gte, ne, sql } from "drizzle-orm";
import { z } from "zod";

import { db, schema } from "@/server/db";

import { assertAdminRole, assertCloudAgentsEnabled, type CloudContext, type ResolvedCloudDeps } from "./access";
import { CloudAgentsError, cloudError } from "./errors";
import { recordCloudAudit } from "./records";
import { type CloudAgentProvider, CloudProviderError } from "./providers/types";
import type { CloudCredential } from "./types";

const PROVIDER = "anthropic";
const API_KEY_PATTERN = /^sk-ant-[A-Za-z0-9_-]{20,300}$/;

const setCredentialSchema = z
  .object({
    provider: z.literal(PROVIDER).optional(),
    apiKey: z.string().trim().min(1).max(400),
    monthlyAlertUsd: z.number().int().min(1).max(1_000_000).nullable().optional(),
  })
  .strict();

type CredentialRow = typeof schema.cloudAgentCredentials.$inferSelect;

export async function getCloudCredential(ctx: CloudContext): Promise<CloudCredential> {
  const deps = await assertCloudAgentsEnabled(ctx);
  const row = await currentCredential(ctx.workspace.organization.id);
  return serializeCredential(row, await monthCostUsd(ctx.workspace.organization.id, deps.now()));
}

export async function setCloudCredential(ctx: CloudContext, body: unknown): Promise<CloudCredential> {
  const deps = await assertCloudAgentsEnabled(ctx);
  assertAdminRole(ctx.workspace);
  const parsed = setCredentialSchema.safeParse(body);
  if (!parsed.success) throw cloudError("validation_failed", "Send { provider: \"anthropic\", apiKey, monthlyAlertUsd? }.");
  const apiKey = parsed.data.apiKey;
  if (!API_KEY_PATTERN.test(apiKey)) {
    throw cloudError("validation_failed", "That does not look like an Anthropic API key (sk-ant-...).");
  }

  try {
    await deps.providerFactory({ provider: PROVIDER, apiKey, limits: deps.providerLimits }).verifyKey();
  } catch (error) {
    if (error instanceof CloudProviderError && error.kind === "auth") {
      throw new CloudAgentsError("cloud_credential_invalid", "Anthropic rejected this key. Nothing was stored.", undefined, 400);
    }
    throw providerFailure(error);
  }

  const organizationId = ctx.workspace.organization.id;
  const now = deps.now();
  const keyHint = apiKey.slice(-4);
  const saved = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(schema.cloudAgentCredentials)
      .where(and(eq(schema.cloudAgentCredentials.organizationId, organizationId), ne(schema.cloudAgentCredentials.status, "revoked")))
      .for("update")
      .limit(1);
    // The same key keeps its row; a different key is a new credential (new id), so
    // deployments made with the old key are recreated on their next deploy.
    const sameKey =
      existing?.secretEncrypted != null &&
      deps.codec.decrypt(existing.secretEncrypted, { organizationId, purpose: "credential", recordId: existing.id }) === apiKey;
    const monthlyAlertUsd = parsed.data.monthlyAlertUsd === undefined ? (existing?.monthlyAlertUsd ?? null) : parsed.data.monthlyAlertUsd;
    if (existing && !sameKey) {
      await tx
        .update(schema.cloudAgentCredentials)
        .set({ status: "revoked", secretEncrypted: null, updatedByUserId: ctx.workspace.user.id, updatedAt: now })
        .where(eq(schema.cloudAgentCredentials.id, existing.id));
    }
    const id = existing && sameKey ? existing.id : randomUUID();
    const secretEncrypted = deps.codec.encrypt(apiKey, { organizationId, purpose: "credential", recordId: id });
    if (existing && sameKey) {
      const [row] = await tx
        .update(schema.cloudAgentCredentials)
        .set({
          secretEncrypted,
          keyHint,
          status: "active",
          verifiedAt: now,
          lastError: null,
          monthlyAlertUsd,
          updatedByUserId: ctx.workspace.user.id,
          updatedAt: now,
        })
        .where(eq(schema.cloudAgentCredentials.id, existing.id))
        .returning();
      return row!;
    }
    const [row] = await tx
      .insert(schema.cloudAgentCredentials)
      .values({
        id,
        organizationId,
        provider: PROVIDER,
        secretEncrypted,
        keyHint,
        status: "active",
        verifiedAt: now,
        monthlyAlertUsd,
        alertedMonth: existing?.alertedMonth ?? null,
        createdByUserId: ctx.workspace.user.id,
        updatedByUserId: ctx.workspace.user.id,
      })
      .returning();
    return row!;
  });
  await recordCloudAudit({
    organizationId,
    projectId: null,
    actorType: ctx.surface === "cli" ? "cli" : "user",
    actorId: ctx.workspace.user.id,
    action: "cloud_agents.credential.set",
    targetType: "cloud_agent_credential",
    targetId: saved.id,
    requestId: ctx.requestId,
    after: { provider: PROVIDER, keyHint, monthlyAlertUsd: saved.monthlyAlertUsd },
  });
  return serializeCredential(saved, await monthCostUsd(organizationId, now));
}

/** Updates only the monthly alert amount (owners and admins). */
export async function setCloudMonthlyAlert(ctx: CloudContext, monthlyAlertUsd: number | null): Promise<CloudCredential> {
  const deps = await assertCloudAgentsEnabled(ctx);
  assertAdminRole(ctx.workspace);
  if (monthlyAlertUsd !== null && (!Number.isInteger(monthlyAlertUsd) || monthlyAlertUsd < 1 || monthlyAlertUsd > 1_000_000)) {
    throw cloudError("validation_failed", "monthlyAlertUsd is a whole number of US$ from 1, or null.");
  }
  const row = await currentCredential(ctx.workspace.organization.id);
  if (!row) throw cloudError("cloud_credential_missing", "Set the organization's Anthropic API key first.");
  const [saved] = await db
    .update(schema.cloudAgentCredentials)
    .set({ monthlyAlertUsd, updatedByUserId: ctx.workspace.user.id, updatedAt: deps.now() })
    .where(eq(schema.cloudAgentCredentials.id, row.id))
    .returning();
  return serializeCredential(saved ?? row, await monthCostUsd(ctx.workspace.organization.id, deps.now()));
}

export async function removeCloudCredential(ctx: CloudContext): Promise<CloudCredential> {
  const deps = await assertCloudAgentsEnabled(ctx);
  assertAdminRole(ctx.workspace);
  const organizationId = ctx.workspace.organization.id;
  const now = deps.now();
  const revoked = await db
    .update(schema.cloudAgentCredentials)
    .set({ status: "revoked", secretEncrypted: null, updatedByUserId: ctx.workspace.user.id, updatedAt: now })
    .where(and(eq(schema.cloudAgentCredentials.organizationId, organizationId), ne(schema.cloudAgentCredentials.status, "revoked")))
    .returning({ id: schema.cloudAgentCredentials.id, keyHint: schema.cloudAgentCredentials.keyHint });
  for (const row of revoked) {
    await recordCloudAudit({
      organizationId,
      projectId: null,
      actorType: ctx.surface === "cli" ? "cli" : "user",
      actorId: ctx.workspace.user.id,
      action: "cloud_agents.credential.removed",
      targetType: "cloud_agent_credential",
      targetId: row.id,
      requestId: ctx.requestId,
      before: { provider: PROVIDER, keyHint: row.keyHint },
    });
  }
  return serializeCredential(null, await monthCostUsd(organizationId, now));
}

/**
 * Runs `use` with the organization's provider. A rejected key marks the
 * credential `invalid` and becomes `cloud_credential_invalid`; any other
 * provider failure becomes `provider_error` with the provider's message.
 */
export async function withOrganizationProvider<T>(
  organizationId: string,
  deps: ResolvedCloudDeps,
  use: (provider: CloudAgentProvider) => Promise<T>,
): Promise<T> {
  const provider = await organizationProvider(organizationId, deps);
  return callProvider(organizationId, deps, () => use(provider.provider), provider.credentialId);
}

export async function organizationProvider(organizationId: string, deps: ResolvedCloudDeps) {
  const row = await currentCredential(organizationId);
  if (!row?.secretEncrypted) {
    throw cloudError("cloud_credential_missing", "Set the organization's Anthropic API key first (Console settings, or `ravi cloud key set`).");
  }
  if (row.status === "invalid") {
    throw cloudError("cloud_credential_invalid", "Anthropic rejected the organization's API key. An owner or admin sets a new one.");
  }
  const apiKey = deps.codec.decrypt(row.secretEncrypted, { organizationId, purpose: "credential", recordId: row.id });
  return { provider: deps.providerFactory({ provider: PROVIDER, apiKey, limits: deps.providerLimits }), credentialId: row.id };
}

/** Maps a provider failure on an organization's key (see `withOrganizationProvider`). */
export async function callProvider<T>(organizationId: string, deps: ResolvedCloudDeps, run: () => Promise<T>, credentialId?: string): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof CloudProviderError && error.kind === "auth") {
      await markCredentialInvalid(organizationId, error.message, deps.now(), credentialId);
      throw cloudError("cloud_credential_invalid", "Anthropic rejected the organization's API key. An owner or admin sets a new one.");
    }
    throw providerFailure(error);
  }
}

export function providerFailure(error: unknown) {
  if (error instanceof CloudAgentsError) return error;
  if (error instanceof CloudProviderError && error.kind === "permission") {
    return cloudError(
      "provider_error",
      `Anthropic: this key has no access to Claude Managed Agents (beta managed-agents-2026-04-01) or to the resource it asked for: ${error.message}`,
      { kind: error.kind, status: error.status },
    );
  }
  if (error instanceof CloudProviderError) {
    return cloudError("provider_error", `Anthropic: ${error.message}`, { kind: error.kind, status: error.status });
  }
  return cloudError("provider_error", error instanceof Error ? error.message.slice(0, 300) : "The provider call failed.");
}

async function markCredentialInvalid(organizationId: string, message: string, now: Date, credentialId?: string) {
  await db
    .update(schema.cloudAgentCredentials)
    .set({ status: "invalid", lastError: message.slice(0, 500), updatedAt: now })
    .where(
      and(
        eq(schema.cloudAgentCredentials.organizationId, organizationId),
        credentialId ? eq(schema.cloudAgentCredentials.id, credentialId) : ne(schema.cloudAgentCredentials.status, "revoked"),
        eq(schema.cloudAgentCredentials.status, "active"),
      ),
    );
}

export async function currentCredential(organizationId: string): Promise<CredentialRow | null> {
  const [row] = await db
    .select()
    .from(schema.cloudAgentCredentials)
    .where(
      and(
        eq(schema.cloudAgentCredentials.organizationId, organizationId),
        eq(schema.cloudAgentCredentials.provider, PROVIDER),
        ne(schema.cloudAgentCredentials.status, "revoked"),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** This calendar month's (UTC) list cost of the organization's cloud runs, in US$. */
export async function monthCostUsd(organizationId: string, now: Date) {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [row] = await db
    .select({ micros: sql<string>`coalesce(sum(${schema.cloudAgentRuns.costUsdMicros}), 0)` })
    .from(schema.cloudAgentRuns)
    .where(and(eq(schema.cloudAgentRuns.organizationId, organizationId), gte(schema.cloudAgentRuns.startedAt, monthStart)));
  return Math.round(Number(row?.micros ?? 0) / 10_000) / 100;
}

function serializeCredential(row: CredentialRow | null, monthCost: number): CloudCredential {
  const configured = Boolean(row?.secretEncrypted);
  return {
    provider: PROVIDER,
    configured,
    keyHint: configured ? (row?.keyHint ?? null) : null,
    status: !row || !configured ? "missing" : row.status === "invalid" ? "invalid" : "active",
    verifiedAt: configured ? (row?.verifiedAt?.toISOString() ?? null) : null,
    monthlyAlertUsd: row?.monthlyAlertUsd ?? null,
    monthCostUsd: monthCost,
  };
}
