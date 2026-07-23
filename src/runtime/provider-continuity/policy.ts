import { createHash, randomUUID } from "node:crypto";
import { dbGetAgent, dbListAgents } from "../../router/router-db.js";
import { validateRuntimeModelSelector } from "../model-validation.js";
import { listRegisteredRuntimeProviderIds, validateRuntimeProviderTarget } from "../provider-registry.js";
import {
  appendProviderContinuityEvent,
  createProviderContinuityBatch,
  getProviderContinuityBatchById,
  getProviderContinuityBatchByIdempotencyKey,
  getProviderContinuityBatchByPlanHash,
  getProviderContinuityPolicy,
  listProviderContinuityPolicies,
  listProviderContinuityHealth,
  saveProviderContinuityBatch,
  writeProviderContinuityPolicy,
  ProviderContinuityStoreError,
} from "./store.js";
import {
  PROVIDER_CONTINUITY_DEFAULTS,
  PROVIDER_CONTINUITY_LIVE_BLOCK_REASON,
  PROVIDER_CONTINUITY_LIVE_GATE_ENV,
  PROVIDER_CONTINUITY_SNAPSHOT,
  PROVIDER_CONTINUITY_SPEC_VERSION,
  providerContinuityBatchSchema,
  providerContinuityContractHeader,
  providerContinuityPlanSchema,
  providerContinuityPolicyConfigSchema,
  type ProviderContinuityApplyOutcome,
  type ProviderContinuityBatch,
  type ProviderContinuityHealth,
  type ProviderContinuityPlan,
  type ProviderContinuityPolicy,
  type ProviderContinuityPolicyAction,
  type ProviderContinuityPolicyConfig,
} from "./types.js";

type ApplyItem = ReturnType<typeof providerContinuityApplyItem>;
type ContinuityAgent = NonNullable<ReturnType<typeof dbGetAgent>>;

export class ProviderContinuityPolicyError extends Error {
  constructor(
    readonly code:
      | "agent_not_found"
      | "invalid_policy"
      | "invalid_plan"
      | "expired"
      | "stale"
      | "idempotency_collision"
      | "not_found",
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ProviderContinuityPolicyError";
  }
}

function requireAgent(agentId: string) {
  const normalized = agentId.trim();
  const agent = dbGetAgent(normalized);
  if (!agent) {
    throw new ProviderContinuityPolicyError("agent_not_found", `Agent not found: ${normalized}.`, {
      agentId: normalized,
    });
  }
  return agent;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

export function providerContinuityStableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function policyConfig(policy: ProviderContinuityPolicy): ProviderContinuityPolicyConfig {
  return providerContinuityPolicyConfigSchema.parse({
    specVersion: policy.specVersion,
    compatibilitySnapshotId: policy.compatibilitySnapshotId,
    strategy: policy.strategy,
    targets: policy.targets,
    deadlineMs: policy.deadlineMs,
    enabled: policy.enabled,
  });
}

export function validateProviderContinuityPolicy(input: unknown): ProviderContinuityPolicyConfig {
  const parsed = providerContinuityPolicyConfigSchema.safeParse(input);
  if (!parsed.success) {
    throw new ProviderContinuityPolicyError(
      "invalid_policy",
      `Invalid provider continuity policy: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "policy"}: ${issue.message}`)
        .join("; ")}`,
    );
  }

  const registered = new Set(listRegisteredRuntimeProviderIds());
  const seen = new Set<string>();
  const errors: string[] = [];
  for (const [index, target] of parsed.data.targets.entries()) {
    const key = `${target.provider}\u0000${target.model}`;
    if (seen.has(key)) {
      errors.push(`targets[${index}] duplicates ${target.provider}/${target.model}`);
    }
    seen.add(key);
    if (!registered.has(target.provider)) {
      errors.push(`targets[${index}] references unregistered provider '${target.provider}'`);
      continue;
    }
    const modelValidation = validateRuntimeModelSelector(target.provider, target.model);
    if (!modelValidation.ok) {
      errors.push(`targets[${index}]: ${modelValidation.error ?? "invalid model selector"}`);
    }
  }
  if (errors.length > 0) {
    throw new ProviderContinuityPolicyError(
      "invalid_policy",
      `Invalid provider continuity policy: ${errors.join("; ")}`,
      {
        errors,
      },
    );
  }
  return parsed.data;
}

function policiesEqual(
  current: ProviderContinuityPolicy | null,
  desired: ProviderContinuityPolicyConfig | null,
): boolean {
  if (!current || !desired) return current === null && desired === null;
  return providerContinuityStableJson(policyConfig(current)) === providerContinuityStableJson(desired);
}

function actionFor(
  current: ProviderContinuityPolicy | null,
  desired: ProviderContinuityPolicyConfig | null,
): ProviderContinuityPolicyAction {
  if (!desired) return current ? "clear" : "no_op";
  if (!current) return "create";
  return policiesEqual(current, desired) ? "no_op" : "update";
}

function buildPlan(input: {
  selector: ProviderContinuityPlan["selector"];
  exactAgentIds: string[];
  desiredPolicy: ProviderContinuityPolicyConfig | null;
  expectedVersions?: Map<string, number>;
  preloadedAgents?: Map<string, ContinuityAgent>;
  preloadedPolicies?: Map<string, ProviderContinuityPolicy>;
  now?: number;
  ttlMs?: number;
}): ProviderContinuityPlan {
  const now = input.now ?? Date.now();
  const desiredPolicy = input.desiredPolicy ? validateProviderContinuityPolicy(input.desiredPolicy) : null;
  const items = input.exactAgentIds.map((agentId) => {
    const errors: string[] = [];
    let current: ProviderContinuityPolicy | null = null;
    let agent: ContinuityAgent | null = null;
    try {
      if (input.preloadedAgents) {
        agent = input.preloadedAgents.get(agentId) ?? null;
        if (!agent) {
          throw new ProviderContinuityPolicyError("agent_not_found", `Agent not found: ${agentId}.`, { agentId });
        }
        current = input.preloadedPolicies?.get(agentId) ?? null;
      } else {
        agent = requireAgent(agentId);
        current = getProviderContinuityPolicy(agentId);
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    if (agent && desiredPolicy) {
      for (const [index, target] of desiredPolicy.targets.entries()) {
        const compatibility = validateRuntimeProviderTarget(target, {
          requiresMcpServers: agent.specMode === true,
          requiresRemoteSpawn: Boolean(agent.remote),
          toolAccessMode: "unrestricted",
        });
        errors.push(...compatibility.errors.map((error) => `targets[${index}]: ${error}`));
      }
    }
    const beforeVersion = current?.version ?? 0;
    const expected = input.expectedVersions?.get(agentId);
    if (expected !== undefined && expected !== beforeVersion) {
      errors.push(`stale expected version ${expected}; current version is ${beforeVersion}`);
    }
    return {
      agentId,
      beforeVersion,
      action: actionFor(current, desiredPolicy),
      valid: errors.length === 0,
      errors,
    };
  });
  const planId = `pcp_${randomUUID().replaceAll("-", "")}`;
  const planWithoutHash = {
    planId,
    selector: input.selector,
    exactAgentIds: input.exactAgentIds,
    desiredPolicy,
    items,
    expiresAt: now + (input.ttlMs ?? PROVIDER_CONTINUITY_DEFAULTS.batchPlanTtlMs),
    createdAt: now,
    compatibilitySnapshotId: PROVIDER_CONTINUITY_SNAPSHOT,
  };
  const planHash = sha256(providerContinuityStableJson(planWithoutHash));
  return providerContinuityPlanSchema.parse({ ...planWithoutHash, planHash });
}

function createPreviewBatch(plan: ProviderContinuityPlan): ProviderContinuityBatch {
  const batch = providerContinuityBatchSchema.parse({
    batchId: `pcb_${randomUUID().replaceAll("-", "")}`,
    plan,
    status: "preview",
    approvalRef: null,
    idempotencyKey: null,
    requestFingerprint: null,
    outcomes: [],
    createdAt: plan.createdAt,
    appliedAt: null,
    compatibilitySnapshotId: PROVIDER_CONTINUITY_SNAPSHOT,
  });
  createProviderContinuityBatch(batch);
  appendProviderContinuityEvent({
    logicalRequestId: null,
    agentId: plan.selector.kind === "single" ? (plan.exactAgentIds[0] ?? null) : null,
    type: "continuity.policy.previewed",
    payload: {
      batchId: batch.batchId,
      planId: plan.planId,
      planHash: plan.planHash,
      selector: plan.selector,
      exactAgentIds: plan.exactAgentIds,
      actions: plan.items.map((item) => ({
        agentId: item.agentId,
        beforeVersion: item.beforeVersion,
        action: item.action,
        valid: item.valid,
      })),
    },
    createdAt: plan.createdAt,
    specVersion: PROVIDER_CONTINUITY_SPEC_VERSION,
    compatibilitySnapshotId: PROVIDER_CONTINUITY_SNAPSHOT,
  });
  return batch;
}

export function createProviderContinuityPolicyPreview(input: {
  agentId: string;
  desiredPolicy: ProviderContinuityPolicyConfig | null;
  expectedVersion?: number;
  now?: number;
  ttlMs?: number;
}) {
  const agentId = input.agentId.trim();
  const agent = requireAgent(agentId);
  const current = getProviderContinuityPolicy(agentId);
  const expectedVersions =
    input.expectedVersion === undefined ? undefined : new Map<string, number>([[agentId, input.expectedVersion]]);
  const plan = buildPlan({
    selector: { kind: "single", agentIds: [agentId] },
    exactAgentIds: [agentId],
    desiredPolicy: input.desiredPolicy,
    expectedVersions,
    preloadedAgents: new Map([[agentId, agent]]),
    preloadedPolicies: current ? new Map([[agentId, current]]) : new Map(),
    now: input.now,
    ttlMs: input.ttlMs,
  });
  createPreviewBatch(plan);
  return { ...providerContinuityContractHeader(), plan };
}

export function createProviderContinuityBatchPreview(input: {
  selector: { kind: "selected"; agentIds: string[] } | { kind: "all" };
  desiredPolicy: ProviderContinuityPolicyConfig | null;
  now?: number;
  ttlMs?: number;
}) {
  const agents = dbListAgents();
  const preloadedAgents = new Map(agents.map((agent) => [agent.id, agent]));
  const preloadedPolicies = new Map(listProviderContinuityPolicies().map((policy) => [policy.agentId, policy]));
  const exactAgentIds =
    input.selector.kind === "all"
      ? agents.map((agent) => agent.id).sort()
      : [...new Set(input.selector.agentIds.map((id) => id.trim()).filter(Boolean))];
  if (exactAgentIds.length === 0) {
    throw new ProviderContinuityPolicyError("invalid_plan", "Batch selector resolved to zero agents.");
  }
  const selector: ProviderContinuityPlan["selector"] =
    input.selector.kind === "all"
      ? { kind: "all", agentIds: exactAgentIds }
      : { kind: "selected", agentIds: exactAgentIds };
  const plan = buildPlan({
    selector,
    exactAgentIds,
    desiredPolicy: input.desiredPolicy,
    preloadedAgents,
    preloadedPolicies,
    now: input.now,
    ttlMs: input.ttlMs,
  });
  const batch = createPreviewBatch(plan);
  return { ...providerContinuityContractHeader(), batch };
}

export function getProviderContinuityBatch(batchId: string): ProviderContinuityBatch {
  const batch = getProviderContinuityBatchById(batchId);
  if (!batch) {
    throw new ProviderContinuityPolicyError("not_found", `Provider continuity batch not found: ${batchId}.`);
  }
  return batch;
}

function assertPlanIntegrity(batch: ProviderContinuityBatch, planHash: string): void {
  if (batch.plan.planHash !== planHash) {
    throw new ProviderContinuityPolicyError("invalid_plan", "Plan hash does not match the frozen preview.");
  }
  if (batch.compatibilitySnapshotId !== PROVIDER_CONTINUITY_SNAPSHOT) {
    throw new ProviderContinuityPolicyError("invalid_plan", "Batch compatibility snapshot does not match runtime.");
  }
  const { planHash: _storedHash, ...withoutHash } = batch.plan;
  const recomputed = sha256(providerContinuityStableJson(withoutHash));
  if (recomputed !== batch.plan.planHash) {
    throw new ProviderContinuityPolicyError("invalid_plan", "Frozen preview content does not match its plan hash.");
  }
}

function providerContinuityApplyItem(
  agentId: string,
  outcome: ProviderContinuityApplyOutcome,
  beforeVersion: number,
  afterVersion: number,
  message: string,
) {
  return { agentId, outcome, beforeVersion, afterVersion, message } as const;
}

function applyOnePlanItem(
  item: ProviderContinuityPlan["items"][number],
  desiredPolicy: ProviderContinuityPolicyConfig | null,
): ApplyItem {
  if (!item.valid) {
    return providerContinuityApplyItem(
      item.agentId,
      "invalid",
      item.beforeVersion,
      item.beforeVersion,
      item.errors.join("; ") || "Preview item is invalid.",
    );
  }
  const current = getProviderContinuityPolicy(item.agentId);
  const currentVersion = current?.version ?? 0;
  if (currentVersion !== item.beforeVersion) {
    return providerContinuityApplyItem(
      item.agentId,
      "stale",
      item.beforeVersion,
      currentVersion,
      `Current version ${currentVersion} no longer matches frozen version ${item.beforeVersion}.`,
    );
  }
  try {
    const result = writeProviderContinuityPolicy({
      agentId: item.agentId,
      expectedVersion: item.beforeVersion,
      policy: desiredPolicy,
    });
    return providerContinuityApplyItem(
      item.agentId,
      result.changed ? "applied" : "no_op",
      item.beforeVersion,
      result.after?.version ?? 0,
      result.changed ? `Applied ${item.action}.` : "Policy already matches the frozen plan.",
    );
  } catch (error) {
    if (error instanceof ProviderContinuityStoreError && error.code === "stale") {
      const afterVersion = getProviderContinuityPolicy(item.agentId)?.version ?? 0;
      return providerContinuityApplyItem(item.agentId, "stale", item.beforeVersion, afterVersion, error.message);
    }
    const temporary =
      error instanceof Error && /(locked|busy|temporar|timeout)/i.test(error.message)
        ? "temporary_failure"
        : "permanent_failure";
    return providerContinuityApplyItem(
      item.agentId,
      temporary,
      item.beforeVersion,
      getProviderContinuityPolicy(item.agentId)?.version ?? item.beforeVersion,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function aggregateBatchStatus(outcomes: ApplyItem[]): ProviderContinuityBatch["status"] {
  if (outcomes.length === 0) return "failed";
  const successful = outcomes.filter((item) => item.outcome === "applied" || item.outcome === "no_op").length;
  if (successful === outcomes.length) return "success";
  if (successful > 0) return "partial_success";
  if (outcomes.every((item) => item.outcome === "stale")) return "stale";
  return "failed";
}

interface ApplyPlanBaseInput {
  planHash: string;
  approvalRef: string;
  idempotencyKey: string;
  now?: number;
  requestFingerprintOverride?: string;
}

export function applyProviderContinuityPlan(input: ApplyPlanBaseInput & { agentId: string; batchId?: never }): {
  specVersion: typeof PROVIDER_CONTINUITY_SPEC_VERSION;
  compatibilitySnapshotId: typeof PROVIDER_CONTINUITY_SNAPSHOT;
  changed: boolean;
  outcome: ProviderContinuityApplyOutcome;
  policy: ProviderContinuityPolicy | null;
  plan: ProviderContinuityPlan | null;
};
export function applyProviderContinuityPlan(input: ApplyPlanBaseInput & { batchId: string; agentId?: never }): {
  batch: ProviderContinuityBatch;
};
export function applyProviderContinuityPlan(input: ApplyPlanBaseInput & { agentId?: string; batchId?: string }):
  | {
      specVersion: typeof PROVIDER_CONTINUITY_SPEC_VERSION;
      compatibilitySnapshotId: typeof PROVIDER_CONTINUITY_SNAPSHOT;
      changed: boolean;
      outcome: ProviderContinuityApplyOutcome;
      policy: ProviderContinuityPolicy | null;
      plan: ProviderContinuityPlan | null;
    }
  | { batch: ProviderContinuityBatch } {
  const now = input.now ?? Date.now();
  const planHash = input.planHash.trim();
  const approvalRef = input.approvalRef.trim();
  const idempotencyKey = input.idempotencyKey.trim();
  if (!planHash || !approvalRef || !idempotencyKey) {
    throw new ProviderContinuityPolicyError(
      "invalid_plan",
      "planHash, approvalRef, and idempotencyKey are all required.",
    );
  }

  const batch = input.batchId
    ? getProviderContinuityBatchById(input.batchId)
    : getProviderContinuityBatchByPlanHash(planHash);
  if (!batch) {
    throw new ProviderContinuityPolicyError("not_found", "Frozen provider continuity preview not found.");
  }
  if (input.agentId) {
    const exact = batch.plan.exactAgentIds;
    if (batch.plan.selector.kind !== "single" || exact.length !== 1 || exact[0] !== input.agentId.trim()) {
      throw new ProviderContinuityPolicyError("invalid_plan", "Preview does not belong to the requested agent.");
    }
  }
  assertPlanIntegrity(batch, planHash);

  const requestFingerprint =
    input.requestFingerprintOverride ??
    sha256(
      providerContinuityStableJson({
        batchId: batch.batchId,
        planHash,
        approvalRef,
        idempotencyKey,
      }),
    );
  const replay = getProviderContinuityBatchByIdempotencyKey(idempotencyKey);
  if (replay) {
    if (replay.requestFingerprint !== requestFingerprint) {
      throw new ProviderContinuityPolicyError(
        "idempotency_collision",
        `Idempotency key '${idempotencyKey}' was reused with a different payload.`,
      );
    }
    if (input.agentId) {
      const item = replay.outcomes[0];
      if (!item) {
        throw new ProviderContinuityPolicyError("invalid_plan", "Stored idempotent result is incomplete.");
      }
      return {
        ...providerContinuityContractHeader(),
        changed: item.outcome === "applied",
        outcome: item.outcome,
        policy: getProviderContinuityPolicy(input.agentId),
        plan: replay.plan,
      };
    }
    return { batch: replay };
  }
  if (batch.status !== "preview") {
    throw new ProviderContinuityPolicyError(
      "invalid_plan",
      `Frozen preview '${batch.batchId}' was already applied with a different idempotency key.`,
    );
  }
  if (batch.plan.expiresAt <= now) {
    throw new ProviderContinuityPolicyError("expired", `Preview expired at ${batch.plan.expiresAt}.`);
  }
  if (!batch.plan.items.every((item) => item.valid)) {
    throw new ProviderContinuityPolicyError(
      "invalid_plan",
      "Preview contains invalid agent items; zero writes performed.",
    );
  }

  const outcomes = batch.plan.items.map((item) => applyOnePlanItem(item, batch.plan.desiredPolicy));
  const applied = providerContinuityBatchSchema.parse({
    ...batch,
    status: aggregateBatchStatus(outcomes),
    approvalRef,
    idempotencyKey,
    requestFingerprint,
    outcomes,
    appliedAt: now,
  });
  saveProviderContinuityBatch(applied);
  appendProviderContinuityEvent({
    logicalRequestId: null,
    agentId: input.agentId?.trim() ?? null,
    type: "continuity.policy.applied",
    payload: {
      batchId: applied.batchId,
      planId: applied.plan.planId,
      planHash: applied.plan.planHash,
      approvalRefFingerprint: sha256(approvalRef),
      idempotencyKeyFingerprint: sha256(idempotencyKey),
      status: applied.status,
      outcomes: applied.outcomes,
    },
    createdAt: now,
    specVersion: PROVIDER_CONTINUITY_SPEC_VERSION,
    compatibilitySnapshotId: PROVIDER_CONTINUITY_SNAPSHOT,
  });

  if (input.agentId) {
    const item = outcomes[0];
    if (!item) {
      throw new ProviderContinuityPolicyError("invalid_plan", "Single-agent apply produced no outcome.");
    }
    return {
      ...providerContinuityContractHeader(),
      changed: item.outcome === "applied",
      outcome: item.outcome,
      policy: getProviderContinuityPolicy(input.agentId),
      plan: applied.plan,
    };
  }
  return { batch: applied };
}

export function setProviderContinuityPolicy(input: {
  agentId: string;
  desiredPolicy: ProviderContinuityPolicyConfig;
  expectedVersion: number;
  approvalRef: string;
  idempotencyKey: string;
  now?: number;
}) {
  const desiredPolicy = validateProviderContinuityPolicy(input.desiredPolicy);
  const requestFingerprint = directMutationFingerprint({
    operation: "set",
    agentId: input.agentId,
    desiredPolicy,
    expectedVersion: input.expectedVersion,
    approvalRef: input.approvalRef,
    idempotencyKey: input.idempotencyKey,
  });
  const replay = replayDirectMutation(input.idempotencyKey, requestFingerprint, input.agentId);
  if (replay) return replay;
  return applyDirectPolicyMutation({
    agentId: input.agentId,
    desiredPolicy,
    expectedVersion: input.expectedVersion,
    approvalRef: input.approvalRef,
    idempotencyKey: input.idempotencyKey,
    requestFingerprint,
    now: input.now,
  });
}

function applyDirectPolicyMutation(input: {
  agentId: string;
  desiredPolicy: ProviderContinuityPolicyConfig | null;
  expectedVersion: number;
  approvalRef: string;
  idempotencyKey: string;
  requestFingerprint: string;
  now?: number;
}) {
  const preview = createProviderContinuityPolicyPreview({
    agentId: input.agentId,
    desiredPolicy: input.desiredPolicy,
    expectedVersion: input.expectedVersion,
    now: input.now,
  });
  return applyProviderContinuityPlan({
    agentId: input.agentId,
    planHash: preview.plan.planHash,
    approvalRef: input.approvalRef,
    idempotencyKey: input.idempotencyKey,
    now: input.now,
    requestFingerprintOverride: input.requestFingerprint,
  });
}

function directMutationFingerprint(input: {
  operation: string;
  agentId: string;
  desiredPolicy: ProviderContinuityPolicyConfig | null;
  expectedVersion: number;
  approvalRef: string;
  idempotencyKey: string;
  detail?: Record<string, unknown>;
}): string {
  return sha256(providerContinuityStableJson(input));
}

function replayDirectMutation(
  idempotencyKey: string,
  requestFingerprint: string,
  agentId: string,
): {
  specVersion: typeof PROVIDER_CONTINUITY_SPEC_VERSION;
  compatibilitySnapshotId: typeof PROVIDER_CONTINUITY_SNAPSHOT;
  changed: boolean;
  outcome: ProviderContinuityApplyOutcome;
  policy: ProviderContinuityPolicy | null;
  plan: ProviderContinuityPlan | null;
} | null {
  const replay = getProviderContinuityBatchByIdempotencyKey(idempotencyKey);
  if (!replay) return null;
  if (replay.requestFingerprint !== requestFingerprint) {
    throw new ProviderContinuityPolicyError(
      "idempotency_collision",
      `Idempotency key '${idempotencyKey}' was reused with a different payload.`,
    );
  }
  const item = replay.outcomes.find((candidate) => candidate.agentId === agentId);
  if (!item) {
    throw new ProviderContinuityPolicyError("invalid_plan", "Stored idempotent result is incomplete.");
  }
  return {
    ...providerContinuityContractHeader(),
    changed: item.outcome === "applied",
    outcome: item.outcome,
    policy: getProviderContinuityPolicy(agentId),
    plan: replay.plan,
  };
}

export function reorderProviderContinuityPolicy(input: {
  agentId: string;
  fromIndex: number;
  toIndex: number;
  expectedVersion: number;
  approvalRef: string;
  idempotencyKey: string;
  now?: number;
}) {
  const requestFingerprint = directMutationFingerprint({
    operation: "reorder",
    agentId: input.agentId,
    desiredPolicy: null,
    expectedVersion: input.expectedVersion,
    approvalRef: input.approvalRef,
    idempotencyKey: input.idempotencyKey,
    detail: { fromIndex: input.fromIndex, toIndex: input.toIndex },
  });
  const replay = replayDirectMutation(input.idempotencyKey, requestFingerprint, input.agentId);
  if (replay) return replay;
  const current = getProviderContinuityPolicy(input.agentId);
  if (!current) {
    throw new ProviderContinuityPolicyError("not_found", `No provider continuity policy for ${input.agentId}.`);
  }
  if (current.version !== input.expectedVersion) {
    throw new ProviderContinuityPolicyError(
      "stale",
      `Policy version for ${input.agentId} is ${current.version}, expected ${input.expectedVersion}.`,
    );
  }
  if (
    input.fromIndex < 0 ||
    input.toIndex < 0 ||
    input.fromIndex >= current.targets.length ||
    input.toIndex >= current.targets.length
  ) {
    throw new ProviderContinuityPolicyError(
      "invalid_policy",
      `Reorder indices must be between 0 and ${current.targets.length - 1}.`,
    );
  }
  const targets = [...current.targets];
  const [moved] = targets.splice(input.fromIndex, 1);
  if (!moved) {
    throw new ProviderContinuityPolicyError("invalid_policy", `Target index ${input.fromIndex} does not exist.`);
  }
  targets.splice(input.toIndex, 0, moved);
  return applyDirectPolicyMutation({
    agentId: input.agentId,
    desiredPolicy: { ...policyConfig(current), targets },
    expectedVersion: input.expectedVersion,
    approvalRef: input.approvalRef,
    idempotencyKey: input.idempotencyKey,
    requestFingerprint,
    now: input.now,
  });
}

export function clearProviderContinuityPolicy(input: {
  agentId: string;
  expectedVersion: number;
  approvalRef: string;
  idempotencyKey: string;
  now?: number;
}) {
  const requestFingerprint = directMutationFingerprint({
    operation: "clear",
    agentId: input.agentId,
    desiredPolicy: null,
    expectedVersion: input.expectedVersion,
    approvalRef: input.approvalRef,
    idempotencyKey: input.idempotencyKey,
  });
  const replay = replayDirectMutation(input.idempotencyKey, requestFingerprint, input.agentId);
  if (replay) return replay;
  return applyDirectPolicyMutation({
    agentId: input.agentId,
    desiredPolicy: null,
    expectedVersion: input.expectedVersion,
    approvalRef: input.approvalRef,
    idempotencyKey: input.idempotencyKey,
    requestFingerprint,
    now: input.now,
  });
}

export function isProviderContinuityLiveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[PROVIDER_CONTINUITY_LIVE_GATE_ENV] === "1";
}

export function getProviderContinuityPolicyView(agentId: string) {
  requireAgent(agentId);
  const policy = getProviderContinuityPolicy(agentId);
  const enabled = isProviderContinuityLiveEnabled();
  return {
    ...providerContinuityContractHeader(),
    policy,
    health: listProviderContinuityHealth(agentId),
    liveActivation: {
      enabled,
      gate: PROVIDER_CONTINUITY_LIVE_GATE_ENV,
      reason: enabled ? null : PROVIDER_CONTINUITY_LIVE_BLOCK_REASON,
    },
  };
}

function healthForTarget(
  health: ProviderContinuityHealth[],
  target: ProviderContinuityPolicy["targets"][number],
): ProviderContinuityHealth | null {
  return health.find((item) => item.provider === target.provider && item.model === target.model) ?? null;
}

function rejectionReasonsForHealth(health: ProviderContinuityHealth | null, index: number, now: number): string[] {
  if (!health) return [];
  if (health.state === "open") {
    if (health.probeEligibleAt !== null && now >= health.probeEligibleAt && index === 0) {
      if (health.probeLeaseId && (health.probeLeaseExpiresAt ?? 0) > now) return ["half_open_probe_lease_busy"];
      return [];
    }
    return ["circuit_open"];
  }
  if (health.state === "half_open") {
    if (health.probeLeaseId && (health.probeLeaseExpiresAt ?? 0) > now) return ["half_open_probe_lease_busy"];
    return [];
  }
  if (
    index === 0 &&
    health.stableSince !== null &&
    health.probationSuccesses >= PROVIDER_CONTINUITY_DEFAULTS.probationSuccessesToClose &&
    now - health.stableSince < PROVIDER_CONTINUITY_DEFAULTS.failbackDwellMs
  ) {
    return ["failback_dwell_not_elapsed"];
  }
  return [];
}

export function explainProviderContinuityPolicy(agentId: string, now = Date.now()) {
  requireAgent(agentId);
  const policy = getProviderContinuityPolicy(agentId);
  if (!policy) {
    return {
      ...providerContinuityContractHeader(),
      agentId,
      policyVersion: 0,
      enabled: false,
      orderedTargets: [],
      selectedTargetIndex: null,
      decision: "No continuity policy; existing runtime provider selection remains unchanged.",
    };
  }
  const health = listProviderContinuityHealth(agentId);
  const orderedTargets = policy.targets.map((target, index) => {
    const recovery = healthForTarget(health, target);
    const rejectionReasons = rejectionReasonsForHealth(recovery, index, now);
    return {
      index,
      target,
      eligible: policy.enabled && rejectionReasons.length === 0,
      recovery,
      rejectionReasons: policy.enabled ? rejectionReasons : ["policy_disabled"],
    };
  });
  const selectedTargetIndex = orderedTargets.find((item) => item.eligible)?.index ?? null;
  return {
    ...providerContinuityContractHeader(),
    agentId,
    policyVersion: policy.version,
    enabled: policy.enabled,
    orderedTargets,
    selectedTargetIndex,
    decision:
      selectedTargetIndex === null
        ? "No eligible target; a logical request would stop explicitly."
        : `Select configured target index ${selectedTargetIndex}; order is never rearranged.`,
  };
}
