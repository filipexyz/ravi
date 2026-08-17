import { randomUUID } from "node:crypto";
import type { AgentConfig } from "../router/index.js";
import {
  MODEL_BROKER_MIN_LEASE_REMAINING_MS,
  resolveRequiredRuntimeModelBrokerSelection,
  reportRuntimeModelBrokerAttempt,
  validateRuntimeModelBrokerRouteLease,
  type RuntimeModelBrokerRouteLease,
  type RuntimeModelBrokerSelection,
} from "./model-broker.js";
import { createModelBroker } from "./model-broker-registry.js";

const MAX_PLANS = 1_024;

export interface RuntimeModelBrokerPlanIdentity {
  brokerId: string;
  runtimeId: string;
  agentId: string;
  sessionKey: string;
  turnId: string;
}

export interface RuntimeModelBrokerPlan extends RuntimeModelBrokerPlanIdentity {
  selection: RuntimeModelBrokerSelection;
  lease: RuntimeModelBrokerRouteLease;
}

export interface ClaimedRuntimeModelBrokerPlan {
  claimId: string;
  plan: RuntimeModelBrokerPlan;
}

interface PlanEntry {
  plan: RuntimeModelBrokerPlan;
  claimedAt?: number;
  claimId?: string;
}

const plans = new Map<string, PlanEntry>();
const pendingPlans = new Map<string, { profileRef: string; promise: Promise<RuntimeModelBrokerPlan> }>();

export async function planRuntimeModelBrokerRoute(input: {
  agent: Pick<AgentConfig, "id" | "defaults">;
  sessionKey: string;
  turnId: string;
  globalRequiredSetting?: string;
}): Promise<RuntimeModelBrokerPlan | undefined> {
  const selection = resolveRequiredRuntimeModelBrokerSelection(input.agent, input.globalRequiredSetting);
  if (!selection) return undefined;
  const runtimeId = process.env.RAVI_RUNTIME_ID?.trim();
  if (!runtimeId) throw new Error("The model broker requires a public RAVI_RUNTIME_ID binding.");
  const identity = {
    brokerId: selection.brokerId,
    runtimeId,
    agentId: input.agent.id,
    sessionKey: input.sessionKey,
    turnId: input.turnId,
  };
  const key = planKey(identity);
  const cached = plans.get(key);
  if (
    cached &&
    cached.plan.selection.profileRef === selection.profileRef &&
    cached.plan.lease.expiresAt >= Date.now() + MODEL_BROKER_MIN_LEASE_REMAINING_MS
  ) {
    if (cached.claimId) throw new Error("This model-broker turn already has a claimed route lease.");
    return cached.plan;
  }
  plans.delete(key);
  const inFlight = pendingPlans.get(key);
  if (inFlight) {
    if (inFlight.profileRef !== selection.profileRef) {
      throw new Error("The model-broker selection changed while route preflight was in progress.");
    }
    return inFlight.promise;
  }

  const pending = (async () => {
    const lease = validateRuntimeModelBrokerRouteLease(
      await createModelBroker(selection.brokerId).resolveRoute({
        profileRef: selection.profileRef,
        runtimeId,
        agentId: input.agent.id,
        sessionKey: input.sessionKey,
        turnId: input.turnId,
      }),
    );
    if (
      lease.brokerId !== identity.brokerId ||
      lease.runtimeId !== identity.runtimeId ||
      lease.turnId !== identity.turnId
    ) {
      throw new Error("The model broker returned a lease outside the requested runtime turn.");
    }
    const plan = { ...identity, selection, lease };
    ensureCapacity();
    plans.set(key, { plan });
    return plan;
  })();
  const pendingEntry = { profileRef: selection.profileRef, promise: pending };
  pendingPlans.set(key, pendingEntry);
  try {
    return await pending;
  } finally {
    if (pendingPlans.get(key) === pendingEntry) pendingPlans.delete(key);
  }
}

export function readRuntimeModelBrokerPlan(
  identity: RuntimeModelBrokerPlanIdentity | undefined,
): RuntimeModelBrokerPlan | undefined {
  if (!identity) return undefined;
  const key = planKey(identity);
  const entry = plans.get(key);
  if (!entry || entry.plan.lease.expiresAt < Date.now() + MODEL_BROKER_MIN_LEASE_REMAINING_MS) {
    plans.delete(key);
    return undefined;
  }
  return entry.plan;
}

export function claimRuntimeModelBrokerPlan(
  identity: RuntimeModelBrokerPlanIdentity | undefined,
): ClaimedRuntimeModelBrokerPlan | undefined {
  if (!identity) return undefined;
  const key = planKey(identity);
  const entry = plans.get(key);
  if (!entry || entry.plan.lease.expiresAt < Date.now() + MODEL_BROKER_MIN_LEASE_REMAINING_MS) {
    plans.delete(key);
    return undefined;
  }
  if (entry.claimId) throw new Error("This model-broker route lease was already claimed.");
  const claimId = `mbclaim_${randomUUID()}`;
  entry.claimId = claimId;
  entry.claimedAt = Date.now();
  return { claimId, plan: entry.plan };
}

export function clearRuntimeModelBrokerPlan(claim: ClaimedRuntimeModelBrokerPlan): void {
  const key = planKey(claim.plan);
  const entry = plans.get(key);
  if (entry?.claimId === claim.claimId) plans.delete(key);
}

/**
 * Releases a claimed turn only after the broker authoritatively permits another
 * credential attempt. Terminal retained outcomes stay claimed until lease expiry,
 * preserving the duplicate-delivery fence for that logical turn.
 */
export function releaseRuntimeModelBrokerPlanForAdvance(
  input: RuntimeModelBrokerPlanIdentity & { leaseId: string; attemptId: string },
): boolean {
  const key = planKey(input);
  const entry = plans.get(key);
  if (!entry) return false;
  if (!entry.claimId) throw new Error("Cannot advance an unclaimed model-broker route plan.");
  if (entry.plan.lease.leaseId !== input.leaseId || entry.plan.lease.attemptId !== input.attemptId) {
    throw new Error("Cannot advance a different model-broker route attempt.");
  }
  plans.delete(key);
  return true;
}

export async function abandonClaimedRuntimeModelBrokerPlan(
  claim: ClaimedRuntimeModelBrokerPlan,
  failureKind: string,
): Promise<void> {
  try {
    await reportRuntimeModelBrokerAttempt(createModelBroker(claim.plan.brokerId), {
      attemptId: claim.plan.lease.attemptId,
      turnId: claim.plan.lease.turnId,
      leaseId: claim.plan.lease.leaseId,
      runtimeId: claim.plan.lease.runtimeId,
      sessionKey: claim.plan.sessionKey,
      outcome: "abandoned",
      effectState: "none",
      failureKind,
    });
  } finally {
    clearRuntimeModelBrokerPlan(claim);
  }
}

export function buildRuntimeModelBrokerPlanIdentity(input: {
  selection: RuntimeModelBrokerSelection;
  runtimeId: string;
  agentId: string;
  sessionKey: string;
  turnId: string;
}): RuntimeModelBrokerPlanIdentity {
  return {
    brokerId: input.selection.brokerId,
    runtimeId: input.runtimeId,
    agentId: input.agentId,
    sessionKey: input.sessionKey,
    turnId: input.turnId,
  };
}

export function resetRuntimeModelBrokerPlansForTests(): void {
  plans.clear();
  pendingPlans.clear();
}

function ensureCapacity(now = Date.now()): void {
  for (const [key, entry] of plans) {
    if (entry.plan.lease.expiresAt < now + MODEL_BROKER_MIN_LEASE_REMAINING_MS) plans.delete(key);
  }
  if (plans.size >= MAX_PLANS) throw new Error("The in-memory model-broker plan cache is full.");
}

function planKey(identity: RuntimeModelBrokerPlanIdentity): string {
  return [identity.brokerId, identity.runtimeId, identity.agentId, identity.sessionKey, identity.turnId].join("\u0000");
}
