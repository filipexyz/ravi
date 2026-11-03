/**
 * Step-up runtime: issue, mint, verify-and-consume.
 *
 * Issued by the proxy when a destructive capability is invoked without
 * a step-up token. Minted by the Console UI (over HMAC) after the user
 * passes the factor challenge. Verified-and-consumed by the proxy when
 * the CLI retries the exec with `X-Ravi-Step-Up: <token>`.
 *
 * Plaintext step-up tokens live only inside a single async handler
 * scope on each side; they are never persisted. The DB row holds only
 * the SHA-256 hash, the factor chosen, and the status.
 */

import type { ConnectorsDb } from "./db";
import {
  consumeStepupChallenge,
  findStepupByTokenHash,
  insertAuditEvent,
  insertStepupChallenge,
  markStepupIssued,
  type StepupChallengeRecord,
} from "./db";
import {
  isFactorAllowedForCapability,
  type StepUpFactor,
  type StepUpProvider,
} from "./stepup/provider";

export interface StepUpRuntimeDeps {
  db: ConnectorsDb;
  provider: StepUpProvider;
  ttlSeconds: number;
}

export interface StepUpChallengeIssued {
  challengeId: string;
  verificationUrl: string;
  expiresAt: Date;
}

export class StepUpRuntimeError extends Error {
  constructor(public readonly code: StepUpRuntimeErrorCode, message: string) {
    super(message);
    this.name = "StepUpRuntimeError";
  }
}

export type StepUpRuntimeErrorCode =
  | "challenge_not_found"
  | "challenge_expired"
  | "challenge_already_consumed"
  | "factor_too_weak"
  | "verify_failed"
  | "actor_mismatch"
  | "capability_mismatch"
  | "connector_mismatch";

export async function issueChallenge(
  deps: StepUpRuntimeDeps,
  input: {
    providerConnectionId: string;
    organizationId: string;
    userId: string;
    capability: string;
    capabilityClass: "read" | "write" | "destructive";
    requestId: string;
  },
): Promise<StepUpChallengeIssued> {
  // Generate a fresh secret that becomes the step-up token. We only
  // persist its SHA-256 hash. The plaintext token is returned to the
  // Console UI by the mint endpoint after factor verification — never
  // to the proxy-initiated issue path.
  const placeholderHash = await sha256Base64(randomToken(32));
  const row = await insertStepupChallenge(deps.db, {
    providerConnectionId: input.providerConnectionId,
    organizationId: input.organizationId,
    userId: input.userId,
    capability: input.capability,
    capabilityClass: input.capabilityClass,
    tokenHash: placeholderHash, // overwritten on mint
    ttlSeconds: deps.ttlSeconds,
  });

  const providerChallenge = await deps.provider.challenge({
    userId: input.userId,
    organizationId: input.organizationId,
    connectorId: row.id,
    capability: input.capability,
    capabilityClass: input.capabilityClass,
  });

  await insertAuditEvent(deps.db, {
    organizationId: input.organizationId,
    actorType: "system",
    actorId: input.userId,
    targetType: "connector_stepup_challenge",
    targetId: row.id,
    action: "connector.stepup.issued",
    requestId: input.requestId,
    metadata: {
      capability: input.capability,
      capabilityClass: input.capabilityClass,
      provider: deps.provider.providerId,
    },
  });

  return {
    challengeId: row.id,
    verificationUrl: providerChallenge.verificationUrl,
    expiresAt: row.expiresAt,
  };
}

export interface MintTokenInput {
  challengeId: string;
  userId: string;
  organizationId: string;
  providerResponse: unknown;
  requestId: string;
}

export interface MintTokenResult {
  token: string;
  expiresAt: Date;
  factor: StepUpFactor;
}

export async function mintToken(
  deps: StepUpRuntimeDeps,
  input: MintTokenInput,
): Promise<MintTokenResult> {
  const result = await deps.provider.verify({
    challengeId: input.challengeId,
    providerResponse: input.providerResponse,
  });
  if (!result.verified || !result.factor) {
    throw new StepUpRuntimeError("verify_failed", result.rejectionReason ?? "factor verification failed");
  }

  // Look up the row to confirm it exists and matches the actor. We
  // identify the row by id rather than hash here because the previous
  // placeholder hash is replaced atomically.
  const existing = await findStepupById(deps.db, input.challengeId);
  if (!existing) throw new StepUpRuntimeError("challenge_not_found", "Challenge missing");
  if (existing.userId !== input.userId || existing.organizationId !== input.organizationId) {
    throw new StepUpRuntimeError("actor_mismatch", "Challenge owned by a different actor");
  }
  if (existing.status !== "issued") {
    throw new StepUpRuntimeError("challenge_already_consumed", "Challenge no longer issuable");
  }
  if (existing.expiresAt.getTime() < Date.now()) {
    throw new StepUpRuntimeError("challenge_expired", "Challenge expired");
  }
  if (!isFactorAllowedForCapability(result.factor, existing.capability, existing.capabilityClass as "read" | "write" | "destructive")) {
    throw new StepUpRuntimeError("factor_too_weak", "Factor not allowed for capability");
  }

  const token = randomToken(32);
  const tokenHash = await sha256Base64(token);
  await deps.db.sql`
    update connector_stepup_challenges
    set token_hash = ${tokenHash}, factor = ${result.factor}, updated_at = now()
    where id = ${input.challengeId}
  `;
  void markStepupIssued; // already set inside the same update above

  await insertAuditEvent(deps.db, {
    organizationId: input.organizationId,
    actorType: "user",
    actorId: input.userId,
    targetType: "connector_stepup_challenge",
    targetId: input.challengeId,
    action: "connector.stepup.minted",
    requestId: input.requestId,
    metadata: { factor: result.factor },
  });

  return { token, expiresAt: existing.expiresAt, factor: result.factor };
}

export interface VerifyAndConsumeInput {
  token: string;
  userId: string;
  organizationId: string;
  providerConnectionId: string;
  capability: string;
  capabilityClass: "read" | "write" | "destructive";
  requestId: string;
}

export async function verifyAndConsumeToken(
  deps: StepUpRuntimeDeps,
  input: VerifyAndConsumeInput,
): Promise<StepupChallengeRecord> {
  const tokenHash = await sha256Base64(input.token);
  const row = await findStepupByTokenHash(deps.db, tokenHash);
  if (!row) throw new StepUpRuntimeError("challenge_not_found", "No matching challenge");
  if (row.userId !== input.userId || row.organizationId !== input.organizationId) {
    throw new StepUpRuntimeError("actor_mismatch", "Challenge owned by a different actor");
  }
  if (row.providerConnectionId !== input.providerConnectionId) {
    throw new StepUpRuntimeError("connector_mismatch", "Challenge issued for a different connector");
  }
  if (row.capability !== input.capability) {
    throw new StepUpRuntimeError("capability_mismatch", "Challenge issued for a different capability");
  }
  if (row.status !== "issued") {
    throw new StepUpRuntimeError("challenge_already_consumed", "Challenge already used");
  }
  if (row.expiresAt.getTime() < Date.now()) {
    throw new StepUpRuntimeError("challenge_expired", "Challenge expired");
  }
  if (row.factor && !isFactorAllowedForCapability(row.factor, input.capability, input.capabilityClass)) {
    throw new StepUpRuntimeError("factor_too_weak", "Factor recorded on challenge no longer satisfies policy");
  }

  const consumed = await consumeStepupChallenge(deps.db, row.id);
  if (!consumed) throw new StepUpRuntimeError("challenge_already_consumed", "Challenge raced to consumption");

  await insertAuditEvent(deps.db, {
    organizationId: input.organizationId,
    actorType: "cli",
    actorId: input.userId,
    targetType: "connector_stepup_challenge",
    targetId: row.id,
    action: "connector.stepup.consumed",
    requestId: input.requestId,
    metadata: { capability: input.capability, factor: row.factor },
  });

  return consumed;
}

async function findStepupById(db: ConnectorsDb, id: string): Promise<StepupChallengeRecord | null> {
  const rows = await db.sql<StepupChallengeRecord[]>`
    select
      id, provider_connection_id as "providerConnectionId",
      organization_id as "organizationId", user_id as "userId",
      capability, capability_class as "capabilityClass",
      factor, status, token_hash as "tokenHash",
      expires_at as "expiresAt", consumed_at as "consumedAt"
    from connector_stepup_challenges
    where id = ${id}
    limit 1
  `;
  return rows[0] ?? null;
}

function randomToken(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += 1) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Base64(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input) as BufferSource,
  );
  const bytes = new Uint8Array(digest);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += 1) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}
