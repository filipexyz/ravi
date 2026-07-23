import { randomUUID } from "node:crypto";
import { executeWrite } from "../../db/write-retry.js";
import { getDb } from "../../router/router-db.js";
import { ensureProviderContinuityTables, getProviderContinuityHealth, saveProviderContinuityHealth } from "./store.js";
import {
  PROVIDER_CONTINUITY_DEFAULTS,
  providerContinuityHealthSchema,
  type ProviderContinuityFailureEvidence,
  type ProviderContinuityHealth,
  type ProviderContinuityTarget,
} from "./types.js";

const DEFAULT_OPEN_WAIT_MS = 30_000;
const PROBE_LEASE_MS = 60_000;

export function defaultProviderContinuityHealth(input: {
  agentId: string;
  target: ProviderContinuityTarget;
  now?: number;
}): ProviderContinuityHealth {
  const now = input.now ?? Date.now();
  return providerContinuityHealthSchema.parse({
    agentId: input.agentId,
    provider: input.target.provider,
    model: input.target.model,
    state: "closed",
    consecutiveQualifiedFailures: 0,
    probationSuccesses: 0,
    openedAt: null,
    probeEligibleAt: null,
    probeLeaseId: null,
    probeLeaseExpiresAt: null,
    stableSince: null,
    lastFailureAt: null,
    lastSuccessAt: null,
    updatedAt: now,
  });
}

export function readProviderContinuityHealth(input: {
  agentId: string;
  target: ProviderContinuityTarget;
  now?: number;
}): ProviderContinuityHealth {
  return (
    getProviderContinuityHealth(input.agentId, input.target.provider, input.target.model) ??
    defaultProviderContinuityHealth(input)
  );
}

export function recordProviderContinuityTargetFailure(input: {
  agentId: string;
  target: ProviderContinuityTarget;
  evidence: ProviderContinuityFailureEvidence;
  now?: number;
}): ProviderContinuityHealth {
  const now = input.now ?? Date.now();
  const current = readProviderContinuityHealth({ agentId: input.agentId, target: input.target, now });
  if (!input.evidence.qualifiedForCircuit) {
    return saveProviderContinuityHealth({
      ...current,
      lastFailureAt: now,
      updatedAt: now,
    });
  }

  const failures =
    current.state === "half_open"
      ? PROVIDER_CONTINUITY_DEFAULTS.qualifiedFailuresToOpen
      : current.consecutiveQualifiedFailures + 1;
  const opens = current.state === "half_open" || failures >= PROVIDER_CONTINUITY_DEFAULTS.qualifiedFailuresToOpen;
  const waitMs = Math.max(DEFAULT_OPEN_WAIT_MS, input.evidence.retryAfterMs ?? 0);
  return saveProviderContinuityHealth({
    ...current,
    state: opens ? "open" : current.state,
    consecutiveQualifiedFailures: failures,
    probationSuccesses: opens ? 0 : current.probationSuccesses,
    openedAt: opens ? now : current.openedAt,
    probeEligibleAt: opens ? now + waitMs : current.probeEligibleAt,
    probeLeaseId: null,
    probeLeaseExpiresAt: null,
    stableSince: opens ? null : current.stableSince,
    lastFailureAt: now,
    updatedAt: now,
  });
}

export function recordProviderContinuityTargetSuccess(input: {
  agentId: string;
  target: ProviderContinuityTarget;
  probe?: boolean;
  leaseId?: string | null;
  now?: number;
}): ProviderContinuityHealth {
  const now = input.now ?? Date.now();
  const current = readProviderContinuityHealth({ agentId: input.agentId, target: input.target, now });
  const probeSuccess = input.probe === true || current.state === "half_open";
  if (!probeSuccess) {
    return saveProviderContinuityHealth({
      ...current,
      consecutiveQualifiedFailures: 0,
      probationSuccesses: 0,
      openedAt: null,
      probeEligibleAt: null,
      stableSince: null,
      lastSuccessAt: now,
      updatedAt: now,
    });
  }
  if (current.state !== "half_open" || !input.leaseId || input.leaseId !== current.probeLeaseId) {
    throw new Error(`Probe lease mismatch for ${input.agentId}/${input.target.provider}/${input.target.model}.`);
  }
  const probationSuccesses = current.probationSuccesses + 1;
  const closes = probationSuccesses >= PROVIDER_CONTINUITY_DEFAULTS.probationSuccessesToClose;
  return saveProviderContinuityHealth({
    ...current,
    state: closes ? "closed" : "half_open",
    consecutiveQualifiedFailures: 0,
    probationSuccesses,
    probeLeaseId: null,
    probeLeaseExpiresAt: null,
    stableSince: closes ? now : null,
    lastSuccessAt: now,
    updatedAt: now,
  });
}

export interface ProviderContinuityTargetEligibility {
  eligible: boolean;
  probe: boolean;
  rejectionReasons: string[];
  waitUntil: number | null;
  health: ProviderContinuityHealth;
}

export function inspectProviderContinuityTargetEligibility(input: {
  agentId: string;
  target: ProviderContinuityTarget;
  targetIndex: number;
  safeNewRequest: boolean;
  deadlineAt: number;
  now?: number;
}): ProviderContinuityTargetEligibility {
  const now = input.now ?? Date.now();
  const health = readProviderContinuityHealth({ agentId: input.agentId, target: input.target, now });
  if (now >= input.deadlineAt) {
    return {
      eligible: false,
      probe: false,
      rejectionReasons: ["deadline_expired"],
      waitUntil: null,
      health,
    };
  }

  if (health.state === "open") {
    const probeEligibleAt = health.probeEligibleAt ?? Number.POSITIVE_INFINITY;
    if (now < probeEligibleAt) {
      return {
        eligible: false,
        probe: false,
        rejectionReasons: ["circuit_open"],
        waitUntil: probeEligibleAt < input.deadlineAt ? probeEligibleAt : null,
        health,
      };
    }
    if (!input.safeNewRequest) {
      return {
        eligible: false,
        probe: false,
        rejectionReasons: ["probe_requires_safe_new_request"],
        waitUntil: null,
        health,
      };
    }
    if (health.probeLeaseId && (health.probeLeaseExpiresAt ?? 0) > now) {
      return {
        eligible: false,
        probe: false,
        rejectionReasons: ["half_open_probe_lease_busy"],
        waitUntil: Math.min(health.probeLeaseExpiresAt ?? input.deadlineAt, input.deadlineAt),
        health,
      };
    }
    return { eligible: true, probe: true, rejectionReasons: [], waitUntil: null, health };
  }

  if (health.state === "half_open") {
    if (!input.safeNewRequest) {
      return {
        eligible: false,
        probe: false,
        rejectionReasons: ["probe_requires_safe_new_request"],
        waitUntil: null,
        health,
      };
    }
    if (health.probeLeaseId && (health.probeLeaseExpiresAt ?? 0) > now) {
      return {
        eligible: false,
        probe: false,
        rejectionReasons: ["half_open_probe_lease_busy"],
        waitUntil: Math.min(health.probeLeaseExpiresAt ?? input.deadlineAt, input.deadlineAt),
        health,
      };
    }
    return { eligible: true, probe: true, rejectionReasons: [], waitUntil: null, health };
  }

  if (
    input.targetIndex === 0 &&
    health.stableSince !== null &&
    health.probationSuccesses >= PROVIDER_CONTINUITY_DEFAULTS.probationSuccessesToClose &&
    now - health.stableSince < PROVIDER_CONTINUITY_DEFAULTS.failbackDwellMs
  ) {
    return {
      eligible: false,
      probe: false,
      rejectionReasons: ["failback_dwell_not_elapsed"],
      waitUntil: health.stableSince + PROVIDER_CONTINUITY_DEFAULTS.failbackDwellMs,
      health,
    };
  }
  return { eligible: true, probe: false, rejectionReasons: [], waitUntil: null, health };
}

interface HealthJsonRow {
  health_json: string;
}

export function acquireProviderContinuityProbeLease(input: {
  agentId: string;
  target: ProviderContinuityTarget;
  deadlineAt: number;
  now?: number;
  leaseMs?: number;
}): { acquired: boolean; leaseId: string | null; health: ProviderContinuityHealth; reason: string | null } {
  const now = input.now ?? Date.now();
  const db = getDb();
  ensureProviderContinuityTables(db);
  return executeWrite(
    db,
    (tx) => {
      const row = tx
        .prepare(
          `SELECT health_json FROM runtime_provider_continuity_target_health
           WHERE agent_id = ? AND provider = ? AND model = ?`,
        )
        .get(input.agentId, input.target.provider, input.target.model) as HealthJsonRow | undefined;
      const current = row
        ? providerContinuityHealthSchema.parse(JSON.parse(row.health_json))
        : defaultProviderContinuityHealth({ agentId: input.agentId, target: input.target, now });
      if (current.state !== "open" && current.state !== "half_open") {
        return { acquired: false, leaseId: null, health: current, reason: "circuit_not_probeable" };
      }
      if ((current.probeEligibleAt ?? now) > now) {
        return { acquired: false, leaseId: null, health: current, reason: "probe_wait_not_elapsed" };
      }
      if (current.probeLeaseId && (current.probeLeaseExpiresAt ?? 0) > now) {
        return { acquired: false, leaseId: null, health: current, reason: "half_open_probe_lease_busy" };
      }
      const leaseId = `pcl_${randomUUID().replaceAll("-", "")}`;
      const leaseExpiresAt = Math.min(input.deadlineAt, now + Math.max(1_000, input.leaseMs ?? PROBE_LEASE_MS));
      if (leaseExpiresAt <= now) {
        return { acquired: false, leaseId: null, health: current, reason: "deadline_expired" };
      }
      const health = providerContinuityHealthSchema.parse({
        ...current,
        state: "half_open",
        probeLeaseId: leaseId,
        probeLeaseExpiresAt: leaseExpiresAt,
        updatedAt: now,
      });
      tx.prepare(
        `INSERT INTO runtime_provider_continuity_target_health
           (agent_id, provider, model, health_json, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(agent_id, provider, model) DO UPDATE SET
           health_json = excluded.health_json,
           updated_at = excluded.updated_at`,
      ).run(input.agentId, input.target.provider, input.target.model, JSON.stringify(health), now);
      return { acquired: true, leaseId, health, reason: null };
    },
    { label: "provider-continuity-probe-lease" },
  );
}

export function releaseProviderContinuityProbeLease(input: {
  agentId: string;
  target: ProviderContinuityTarget;
  leaseId: string;
  now?: number;
}): ProviderContinuityHealth {
  const now = input.now ?? Date.now();
  const current = readProviderContinuityHealth({ agentId: input.agentId, target: input.target, now });
  if (current.probeLeaseId !== input.leaseId) return current;
  return saveProviderContinuityHealth({
    ...current,
    probeLeaseId: null,
    probeLeaseExpiresAt: null,
    updatedAt: now,
  });
}
