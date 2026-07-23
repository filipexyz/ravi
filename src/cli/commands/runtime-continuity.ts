import "reflect-metadata";

import { z } from "zod";
import { Arg, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";
import { fail } from "../context.js";
import {
  applyProviderContinuityPlan,
  clearProviderContinuityPolicy,
  createProviderContinuityBatchPreview,
  createProviderContinuityPolicyPreview,
  explainProviderContinuityPolicy,
  getProviderContinuityBatch,
  getProviderContinuityPolicyView,
  reorderProviderContinuityPolicy,
  setProviderContinuityPolicy,
} from "../../runtime/provider-continuity/policy.js";
import {
  getProviderContinuityDecisionReadback,
  resumeProviderContinuityJournal,
  waitProviderContinuityJournal,
  wakeProviderContinuityJournal,
} from "../../runtime/provider-continuity/coordinator.js";
import { reconcileProviderContinuityEffect } from "../../runtime/provider-continuity/effects.js";
import {
  publicProviderContinuityEffect,
  publicProviderContinuityJournal,
  readProviderContinuityTrace,
} from "../../runtime/provider-continuity/events.js";
import {
  PROVIDER_CONTINUITY_SNAPSHOT,
  PROVIDER_CONTINUITY_SPEC_VERSION,
  providerContinuityBatchReturnSchema,
  providerContinuityContractHeader,
  providerContinuityDecisionReturnSchema,
  providerContinuityEffectReturnSchema,
  providerContinuityExplainReturnSchema,
  providerContinuityMutationReturnSchema,
  providerContinuityPolicyConfigSchema,
  providerContinuityPolicyShowReturnSchema,
  providerContinuityPreviewReturnSchema,
  providerContinuityResumeReturnSchema,
  providerContinuityTargetSchema,
  providerContinuityTraceReturnSchema,
  providerContinuityWaitWakeReturnSchema,
  type ProviderContinuityPolicyConfig,
  type ProviderContinuityTarget,
} from "../../runtime/provider-continuity/types.js";

const versionSchema = z.coerce.number().int().nonnegative();
const timestampSchema = z.coerce.number().int().nonnegative();
const traceLimitSchema = z.coerce.number().int().min(1).max(500);
const reconciliationOutcomeSchema = z.enum(["succeeded", "failed"]);

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printResult(value: unknown, asJson: boolean, summary: string): void {
  if (asJson) {
    printJson(value);
    return;
  }
  console.log(summary);
}

function run<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function parseTargets(raw: string): ProviderContinuityTarget[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("--targets must be a JSON array of {provider, model} objects.");
  }
  const result = z.array(providerContinuityTargetSchema).safeParse(parsed);
  if (!result.success) {
    fail(`Invalid --targets: ${result.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  return result.data;
}

function buildPolicy(
  targets: ProviderContinuityTarget[],
  deadlineMs?: string,
  enabled = true,
): ProviderContinuityPolicyConfig {
  return providerContinuityPolicyConfigSchema.parse({
    specVersion: PROVIDER_CONTINUITY_SPEC_VERSION,
    compatibilitySnapshotId: PROVIDER_CONTINUITY_SNAPSHOT,
    strategy: "ordered",
    targets,
    deadlineMs: deadlineMs ? Number(deadlineMs) : undefined,
    enabled,
  });
}

function parseAgentIds(raw: string | undefined): string[] {
  return [
    ...new Set(
      (raw ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

@Group({
  name: "runtime.continuity",
  description: "Ordered provider and model continuity policies, journals, effects, and recovery",
  scope: "admin",
})
export class RuntimeContinuityCommands {
  @Command({
    name: "show",
    description: "Show one agent's continuity policy and target recovery state",
    helpAfter:
      "\nExamples:\n  ravi runtime continuity show main --json\n\nThis is read-only. It never enables live continuity.",
  })
  @CommandAccess({
    kind: "read",
    resource: "runtime.continuity",
    action: "show",
    risk: "low",
    resourceId: "agentId",
    requireConcreteResource: true,
    input: ["agentId"],
  })
  @Returns(providerContinuityPolicyShowReturnSchema)
  show(
    @Arg("agentId", { description: "Canonical Ravi agent id" }) agentId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    const result = run(() => getProviderContinuityPolicyView(agentId));
    printResult(
      result,
      asJson,
      result.policy ? `${agentId}: policy v${result.policy.version}` : `${agentId}: no policy`,
    );
    return result;
  }

  @Command({
    name: "explain",
    description: "Explain ordered target eligibility without starting a provider call",
    helpAfter: "\nExamples:\n  ravi runtime continuity explain main --json",
  })
  @CommandAccess({
    kind: "read",
    resource: "runtime.continuity",
    action: "explain",
    risk: "low",
    resourceId: "agentId",
    requireConcreteResource: true,
    input: ["agentId"],
  })
  @Returns(providerContinuityExplainReturnSchema)
  explain(
    @Arg("agentId", { description: "Canonical Ravi agent id" }) agentId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    const result = run(() => explainProviderContinuityPolicy(agentId));
    printResult(result, asJson, `${agentId}: ${result.decision}`);
    return result;
  }

  @Command({
    name: "preview",
    description: "Freeze and validate a single-agent policy plan without applying it",
    helpAfter:
      '\nExamples:\n  ravi runtime continuity preview main --targets \'[{"provider":"codex","model":"gpt-5"},{"provider":"claude","model":"sonnet"}]\' --json\n\nApply the returned planHash with `runtime continuity apply` before expiresAt.',
  })
  @CommandAccess({
    kind: "read",
    resource: "runtime.continuity",
    action: "preview",
    risk: "low",
    resourceId: "agentId",
    requireConcreteResource: true,
    input: ["agentId", "targets", "expectedVersion"],
    redactions: ["targets"],
  })
  @Returns(providerContinuityPreviewReturnSchema)
  preview(
    @Arg("agentId", { description: "Canonical Ravi agent id" }) agentId: string,
    @Option({ flags: "--targets <json>", description: "Ordered JSON array of {provider,model}" }) targets?: string,
    @Option({ flags: "--expected-version <n>", description: "Compare-and-set policy version (0 means absent)" })
    expectedVersion?: string,
    @Option({ flags: "--deadline-ms <n>", description: "Logical request deadline in milliseconds" })
    deadlineMs?: string,
    @Option({ flags: "--disabled", description: "Preview a disabled policy" }) disabled = false,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    if (!targets) fail("--targets is required.");
    const policy = buildPolicy(parseTargets(targets), deadlineMs, !disabled);
    const result = run(() =>
      createProviderContinuityPolicyPreview({
        agentId,
        desiredPolicy: policy,
        expectedVersion: expectedVersion === undefined ? undefined : versionSchema.parse(expectedVersion),
      }),
    );
    printResult(result, asJson, `Preview ${result.plan.planId}: ${result.plan.items[0]?.action ?? "invalid"}`);
    return result;
  }

  @Command({
    name: "apply",
    description: "Apply a frozen single-agent preview with approval and idempotency",
    helpAfter:
      "\nExamples:\n  ravi runtime continuity apply main --plan-hash <sha256> --approval-ref change-123 --idempotency-key change-123-main --json\n\nThe plan must be unexpired and every beforeVersion must still match.",
  })
  @CommandAccess({
    kind: "mutate",
    resource: "runtime.continuity",
    action: "apply",
    risk: "high",
    resourceId: "agentId",
    requireConcreteResource: true,
    input: ["agentId", "planHash", "approvalRef", "idempotencyKey"],
    requiresConfirmation: true,
  })
  @Returns(providerContinuityMutationReturnSchema)
  apply(
    @Arg("agentId", { description: "Canonical Ravi agent id frozen in the preview" }) agentId: string,
    @Option({ flags: "--plan-hash <sha256>", description: "Exact hash returned by preview" }) planHash?: string,
    @Option({ flags: "--approval-ref <ref>", description: "External approval/change reference" }) approvalRef?: string,
    @Option({ flags: "--idempotency-key <key>", description: "Stable key for this exact apply payload" })
    idempotencyKey?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    if (!planHash?.trim()) fail("--plan-hash is required.");
    if (!approvalRef?.trim()) fail("--approval-ref is required.");
    if (!idempotencyKey?.trim()) fail("--idempotency-key is required.");
    const result = run(() =>
      applyProviderContinuityPlan({
        agentId,
        planHash,
        approvalRef,
        idempotencyKey,
      }),
    );
    printResult(result, asJson, `${agentId}: ${result.outcome}`);
    return result;
  }

  @Command({
    name: "set",
    description: "Preview and apply an ordered policy in one compare-and-set operation",
    helpAfter:
      '\nExamples:\n  ravi runtime continuity set main --targets \'[{"provider":"codex","model":"gpt-5"}]\' --expected-version 0 --approval-ref change-123 --idempotency-key change-123-main --json\n\nUse preview/apply for human review; set keeps the same CAS and idempotency guarantees.',
  })
  @CommandAccess({
    kind: "mutate",
    resource: "runtime.continuity",
    action: "set",
    risk: "high",
    resourceId: "agentId",
    requireConcreteResource: true,
    input: ["agentId", "targets", "expectedVersion", "approvalRef", "idempotencyKey"],
    redactions: ["targets"],
    requiresConfirmation: true,
  })
  @Returns(providerContinuityMutationReturnSchema)
  set(
    @Arg("agentId", { description: "Canonical Ravi agent id" }) agentId: string,
    @Option({ flags: "--targets <json>", description: "Ordered JSON array of {provider,model}" }) targets?: string,
    @Option({ flags: "--expected-version <n>", description: "Required CAS version (0 means absent)" })
    expectedVersion?: string,
    @Option({ flags: "--approval-ref <ref>", description: "External approval/change reference" }) approvalRef?: string,
    @Option({ flags: "--idempotency-key <key>", description: "Stable key for this exact mutation" })
    idempotencyKey?: string,
    @Option({ flags: "--deadline-ms <n>", description: "Logical request deadline in milliseconds" })
    deadlineMs?: string,
    @Option({ flags: "--disabled", description: "Store the policy disabled" }) disabled = false,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    if (!targets) fail("--targets is required.");
    if (expectedVersion === undefined) fail("--expected-version is required.");
    if (!approvalRef?.trim()) fail("--approval-ref is required.");
    if (!idempotencyKey?.trim()) fail("--idempotency-key is required.");
    const result = run(() =>
      setProviderContinuityPolicy({
        agentId,
        desiredPolicy: buildPolicy(parseTargets(targets), deadlineMs, !disabled),
        expectedVersion: versionSchema.parse(expectedVersion),
        approvalRef,
        idempotencyKey,
      }),
    );
    printResult(result, asJson, `${agentId}: ${result.outcome}`);
    return result;
  }

  @Command({
    name: "reorder",
    description: "Move one target to another ordered index using compare-and-set",
    helpAfter:
      "\nExamples:\n  ravi runtime continuity reorder main 1 0 --expected-version 3 --approval-ref change-124 --idempotency-key change-124-main --json",
  })
  @CommandAccess({
    kind: "mutate",
    resource: "runtime.continuity",
    action: "reorder",
    risk: "high",
    resourceId: "agentId",
    requireConcreteResource: true,
    input: ["agentId", "fromIndex", "toIndex", "expectedVersion", "approvalRef", "idempotencyKey"],
    requiresConfirmation: true,
  })
  @Returns(providerContinuityMutationReturnSchema)
  reorder(
    @Arg("agentId", { description: "Canonical Ravi agent id" }) agentId: string,
    @Arg("fromIndex", { description: "Existing zero-based target index", schema: versionSchema }) fromIndex: string,
    @Arg("toIndex", { description: "Desired zero-based target index", schema: versionSchema }) toIndex: string,
    @Option({ flags: "--expected-version <n>", description: "Required current policy version" })
    expectedVersion?: string,
    @Option({ flags: "--approval-ref <ref>", description: "External approval/change reference" }) approvalRef?: string,
    @Option({ flags: "--idempotency-key <key>", description: "Stable key for this exact mutation" })
    idempotencyKey?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    if (expectedVersion === undefined) fail("--expected-version is required.");
    if (!approvalRef?.trim()) fail("--approval-ref is required.");
    if (!idempotencyKey?.trim()) fail("--idempotency-key is required.");
    const result = run(() =>
      reorderProviderContinuityPolicy({
        agentId,
        fromIndex: versionSchema.parse(fromIndex),
        toIndex: versionSchema.parse(toIndex),
        expectedVersion: versionSchema.parse(expectedVersion),
        approvalRef,
        idempotencyKey,
      }),
    );
    printResult(result, asJson, `${agentId}: ${result.outcome}`);
    return result;
  }

  @Command({
    name: "clear",
    description: "Clear one agent's policy through a versioned preview/apply mutation",
    helpAfter:
      "\nExamples:\n  ravi runtime continuity clear main --expected-version 3 --approval-ref change-125 --idempotency-key change-125-main --json\n\nIn-flight logical requests retain their frozen policy snapshot.",
  })
  @CommandAccess({
    kind: "mutate",
    resource: "runtime.continuity",
    action: "clear",
    risk: "high",
    resourceId: "agentId",
    requireConcreteResource: true,
    input: ["agentId", "expectedVersion", "approvalRef", "idempotencyKey"],
    requiresConfirmation: true,
  })
  @Returns(providerContinuityMutationReturnSchema)
  clear(
    @Arg("agentId", { description: "Canonical Ravi agent id" }) agentId: string,
    @Option({ flags: "--expected-version <n>", description: "Required current policy version" })
    expectedVersion?: string,
    @Option({ flags: "--approval-ref <ref>", description: "External approval/change reference" }) approvalRef?: string,
    @Option({ flags: "--idempotency-key <key>", description: "Stable key for this exact mutation" })
    idempotencyKey?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    if (expectedVersion === undefined) fail("--expected-version is required.");
    if (!approvalRef?.trim()) fail("--approval-ref is required.");
    if (!idempotencyKey?.trim()) fail("--idempotency-key is required.");
    const result = run(() =>
      clearProviderContinuityPolicy({
        agentId,
        expectedVersion: versionSchema.parse(expectedVersion),
        approvalRef,
        idempotencyKey,
      }),
    );
    printResult(result, asJson, `${agentId}: ${result.outcome}`);
    return result;
  }

  @Command({
    name: "batch-preview",
    description: "Freeze an immutable selected-agent or all-agent policy plan",
    helpAfter:
      '\nExamples:\n  ravi runtime continuity batch-preview --agents main,researcher --targets \'[{"provider":"codex","model":"gpt-5"}]\' --json\n  ravi runtime continuity batch-preview --all --targets \'[{"provider":"codex","model":"gpt-5"}]\' --json\n\n--agents and --all are mutually exclusive.',
  })
  @CommandAccess({
    kind: "read",
    resource: "runtime.continuity",
    action: "batch-preview",
    risk: "low",
    input: ["agents", "all", "targets"],
    redactions: ["targets"],
  })
  @Returns(providerContinuityBatchReturnSchema)
  batchPreview(
    @Option({ flags: "--agents <ids>", description: "Comma-separated exact agent ids" }) agents?: string,
    @Option({ flags: "--all", description: "Freeze all agents visible at preview time" }) all = false,
    @Option({ flags: "--targets <json>", description: "Ordered JSON array of {provider,model}" }) targets?: string,
    @Option({ flags: "--deadline-ms <n>", description: "Logical request deadline in milliseconds" })
    deadlineMs?: string,
    @Option({ flags: "--disabled", description: "Preview a disabled policy" }) disabled = false,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    const agentIds = parseAgentIds(agents);
    if (all === agentIds.length > 0) fail("Choose exactly one of --agents or --all.");
    if (!targets) fail("--targets is required.");
    const result = run(() =>
      createProviderContinuityBatchPreview({
        selector: all ? { kind: "all" } : { kind: "selected", agentIds },
        desiredPolicy: buildPolicy(parseTargets(targets), deadlineMs, !disabled),
      }),
    );
    printResult(result, asJson, `Batch ${result.batch.batchId}: ${result.batch.plan.exactAgentIds.length} agent(s)`);
    return result;
  }

  @Command({
    name: "batch-apply",
    description: "Apply an immutable batch plan atomically per agent",
    helpAfter:
      "\nExamples:\n  ravi runtime continuity batch-apply <batch-id> --plan-hash <sha256> --approval-ref change-126 --idempotency-key change-126 --json\n\nPartial success is explicit; no global compensation is attempted.",
  })
  @CommandAccess({
    kind: "mutate",
    resource: "runtime.continuity",
    action: "batch-apply",
    risk: "high",
    input: ["batchId", "planHash", "approvalRef", "idempotencyKey"],
    requiresConfirmation: true,
  })
  @Returns(providerContinuityBatchReturnSchema)
  batchApply(
    @Arg("batchId", { description: "Batch id returned by batch-preview" }) batchId: string,
    @Option({ flags: "--plan-hash <sha256>", description: "Exact immutable plan hash" }) planHash?: string,
    @Option({ flags: "--approval-ref <ref>", description: "External approval/change reference" }) approvalRef?: string,
    @Option({ flags: "--idempotency-key <key>", description: "Stable key for this exact apply payload" })
    idempotencyKey?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    if (!planHash?.trim()) fail("--plan-hash is required.");
    if (!approvalRef?.trim()) fail("--approval-ref is required.");
    if (!idempotencyKey?.trim()) fail("--idempotency-key is required.");
    const result = run(() =>
      applyProviderContinuityPlan({
        batchId,
        planHash,
        approvalRef,
        idempotencyKey,
      }),
    );
    const batchResult = { ...providerContinuityContractHeader(), batch: result.batch };
    printResult(batchResult, asJson, `Batch ${batchId}: ${result.batch.status}`);
    return batchResult;
  }

  @Command({
    name: "batch-status",
    description: "Read a batch preview or apply result",
    helpAfter: "\nExamples:\n  ravi runtime continuity batch-status <batch-id> --json",
  })
  @CommandAccess({
    kind: "read",
    resource: "runtime.continuity",
    action: "batch-status",
    risk: "low",
    input: ["batchId"],
  })
  @Returns(providerContinuityBatchReturnSchema)
  batchStatus(
    @Arg("batchId", { description: "Batch id" }) batchId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    const batch = run(() => getProviderContinuityBatch(batchId));
    const result = { ...providerContinuityContractHeader(), batch };
    printResult(result, asJson, `Batch ${batch.batchId}: ${batch.status}`);
    return result;
  }

  @Command({
    name: "decision",
    description: "Read the latest persisted decision for a logical request",
    helpAfter: "\nExamples:\n  ravi runtime continuity decision <logical-request-id> --json",
  })
  @CommandAccess({
    kind: "read",
    resource: "runtime.continuity",
    action: "decision",
    risk: "low",
    input: ["logicalRequestId"],
  })
  @Returns(providerContinuityDecisionReturnSchema)
  decision(
    @Arg("logicalRequestId", { description: "Stable logical request id" }) logicalRequestId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    const result = run(() => getProviderContinuityDecisionReadback(logicalRequestId));
    printResult(result, asJson, `${logicalRequestId}: ${result.decision?.action ?? result.journal.state}`);
    return result;
  }

  @Command({
    name: "resume",
    description: "Resume a safe non-terminal journal from its durable snapshot",
    helpAfter:
      "\nExamples:\n  ravi runtime continuity resume <logical-request-id> --json\n\nHOLD and effect-ambiguous journals remain blocked until repaired or reconciled.",
  })
  @CommandAccess({
    kind: "mutate",
    resource: "runtime.continuity",
    action: "resume",
    risk: "medium",
    input: ["logicalRequestId"],
  })
  @Returns(providerContinuityResumeReturnSchema)
  resume(
    @Arg("logicalRequestId", { description: "Stable logical request id" }) logicalRequestId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    const internal = run(() => resumeProviderContinuityJournal(logicalRequestId));
    const result = { ...internal, journal: publicProviderContinuityJournal(internal.journal) };
    printResult(result, asJson, `${logicalRequestId}: ${result.reason}`);
    return result;
  }

  @Command({
    name: "wait",
    description: "Persist a bounded recovery wait before a journal deadline",
    helpAfter: "\nExamples:\n  ravi runtime continuity wait <logical-request-id> --until <epoch-ms> --json",
  })
  @CommandAccess({
    kind: "mutate",
    resource: "runtime.continuity",
    action: "wait",
    risk: "medium",
    input: ["logicalRequestId", "until"],
  })
  @Returns(providerContinuityWaitWakeReturnSchema)
  wait(
    @Arg("logicalRequestId", { description: "Stable logical request id" }) logicalRequestId: string,
    @Option({ flags: "--until <epoch-ms>", description: "Wake time; must precede request deadline" }) until?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    if (until === undefined) fail("--until is required.");
    const internal = run(() => waitProviderContinuityJournal(logicalRequestId, timestampSchema.parse(until)));
    const result = { ...internal, journal: publicProviderContinuityJournal(internal.journal) };
    printResult(result, asJson, `${logicalRequestId}: waiting until ${result.journal.wakeAt}`);
    return result;
  }

  @Command({
    name: "wake",
    description: "Re-read and wake a due durable journal",
    helpAfter: "\nExamples:\n  ravi runtime continuity wake <logical-request-id> --json",
  })
  @CommandAccess({
    kind: "mutate",
    resource: "runtime.continuity",
    action: "wake",
    risk: "medium",
    input: ["logicalRequestId"],
  })
  @Returns(providerContinuityWaitWakeReturnSchema)
  wake(
    @Arg("logicalRequestId", { description: "Stable logical request id" }) logicalRequestId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    const internal = run(() => wakeProviderContinuityJournal(logicalRequestId));
    const result = { ...internal, journal: publicProviderContinuityJournal(internal.journal) };
    printResult(result, asJson, `${logicalRequestId}: ${result.journal.state}`);
    return result;
  }

  @Command({
    name: "reconcile",
    description: "Resolve an ambiguous effect by stable effect id and evidence",
    helpAfter:
      "\nExamples:\n  ravi runtime continuity reconcile <effect-id> --outcome succeeded --evidence-ref readback-123 --json\n\nThis never claims exactly-once; it records an explicit readback/reconciliation result.",
  })
  @CommandAccess({
    kind: "mutate",
    resource: "runtime.continuity",
    action: "reconcile",
    risk: "high",
    input: ["effectId", "outcome", "evidenceRef"],
    redactions: ["evidenceRef"],
    requiresConfirmation: true,
  })
  @Returns(providerContinuityEffectReturnSchema)
  reconcile(
    @Arg("effectId", { description: "Stable effect id" }) effectId: string,
    @Option({ flags: "--outcome <status>", description: "Readback outcome: succeeded|failed" }) outcome?: string,
    @Option({ flags: "--evidence-ref <ref>", description: "Stable, non-secret readback evidence reference" })
    evidenceRef?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    if (!outcome) fail("--outcome is required.");
    if (!evidenceRef?.trim()) fail("--evidence-ref is required.");
    const internal = run(() =>
      reconcileProviderContinuityEffect({
        effectId,
        outcome: reconciliationOutcomeSchema.parse(outcome),
        evidenceRef,
      }),
    );
    const result = {
      ...internal,
      effect: publicProviderContinuityEffect(internal.effect),
      journal: publicProviderContinuityJournal(internal.journal),
    };
    printResult(result, asJson, `${effectId}: ${result.effect.status}`);
    return result;
  }

  @Command({
    name: "trace",
    description: "Replay redacted continuity decisions with cursor pagination",
    helpAfter:
      "\nExamples:\n  ravi runtime continuity trace <logical-request-id> --limit 50 --json\n  ravi runtime continuity trace <logical-request-id> --cursor <cursor> --limit 50 --json",
  })
  @CommandAccess({
    kind: "read",
    resource: "runtime.continuity",
    action: "trace",
    risk: "low",
    input: ["logicalRequestId", "cursor", "limit"],
  })
  @Returns(providerContinuityTraceReturnSchema)
  trace(
    @Arg("logicalRequestId", { description: "Stable logical request id" }) logicalRequestId: string,
    @Option({ flags: "--cursor <cursor>", description: "Opaque cursor returned by the previous page" })
    cursor?: string,
    @Option({ flags: "--limit <n>", description: "Page size (default 50, max 500)" }) limit?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    const result = run(() =>
      readProviderContinuityTrace({
        logicalRequestId,
        cursor,
        limit: limit === undefined ? undefined : traceLimitSchema.parse(limit),
      }),
    );
    printResult(result, asJson, `${logicalRequestId}: ${result.events.length} event(s)`);
    return result;
  }
}
