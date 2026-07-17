import "reflect-metadata";
import { z } from "zod";
import { configStore } from "../../config-store.js";
import { nats } from "../../nats.js";
import { createRuntimeProvider, listRegisteredRuntimeProviderIds } from "../../runtime/provider-registry.js";
import { canWithCapabilities, materializeSubjectCapabilities } from "../../permissions/provider-runtime.js";
import { getAgent, mutateAgentDefaults } from "../../router/config.js";
import type { AgentConfig } from "../../router/types.js";
import { resolveTaskProfile } from "../../tasks/profiles.js";
import { resolveEffectiveAgentModel } from "../../runtime/model-preset-resolver.js";
import { resolveRuntimeTargetCredentialEligibility } from "../../runtime/target-credential-eligibility.js";
import { parseRuntimeTargetPolicy, resolveRuntimeTargetPolicy } from "../../runtime/target-policy-config.js";
import {
  collectRuntimeCapabilityNames,
  selectRuntimeTarget,
  type RuntimeTarget,
  type RuntimeTargetPolicy,
} from "../../runtime/target-policy.js";
import { fail } from "../context.js";
import { Command, CommandAccess, Group, Option, Returns } from "../decorators.js";

const RuntimeTargetSchema = z.object({
  id: z.string(),
  runtimeProvider: z.string(),
  model: z.string(),
  modelPreset: z.object({ id: z.string(), version: z.number() }).optional(),
  effort: z.string().optional(),
  thinking: z.enum(["off", "normal", "verbose"]).optional(),
  credentialRequirements: z
    .object({
      credentialIds: z.array(z.string()).optional(),
      authMethods: z.array(z.string()).optional(),
      sessionCompatibilityKey: z.string().optional(),
      requireManaged: z.boolean().optional(),
    })
    .optional(),
  requiredCapabilities: z.array(z.string()).optional(),
});

const RuntimeTargetPolicySchema = z.object({
  id: z.string(),
  strategy: z.enum(["ordered", "health-aware"]),
  targets: z.array(RuntimeTargetSchema),
  maxAttemptsPerTarget: z.number(),
  maxCredentialRecoveryAttemptsPerTarget: z.number().optional(),
  cooldownMs: z.number().optional(),
  circuitBreakerThreshold: z.number().optional(),
});

const RuntimeTargetsExplainSchema = z.object({
  agentId: z.string(),
  evaluation: z.literal("stateless_preflight"),
  enabled: z.boolean(),
  source: z.enum(["session_override", "task_profile", "agent_default", "none"]),
  provenance: z.string().nullable(),
  policyId: z.string().nullable(),
  selectedTarget: z.object({ id: z.string(), runtimeProvider: z.string(), model: z.string() }).nullable(),
  rejected: z.array(z.object({ targetId: z.string(), reason: z.string(), detail: z.string().optional() })),
});

const RuntimeTargetsShowSchema = z.object({
  agentId: z.string(),
  enabled: z.boolean(),
  policy: RuntimeTargetPolicySchema.nullable(),
  order: z.array(z.string()),
  inspectCommand: z.string(),
});

const RuntimeTargetsMutationSchema = z.object({
  action: z.enum(["set", "reorder", "clear"]),
  changed: z.boolean(),
  agentId: z.string(),
  policy: RuntimeTargetPolicySchema.nullable(),
  previousPolicyId: z.string().nullable(),
  preservedDefaultKeys: z.array(z.string()),
  inspectCommand: z.string(),
});

const RuntimeTargetsReconcileItemSchema = z.object({
  agentId: z.string(),
  action: z.enum(["set", "skip"]),
  reason: z.string().nullable(),
  currentProvider: z.string().nullable(),
  currentModel: z.string().nullable(),
  previousPolicyId: z.string().nullable(),
  proposedPolicy: RuntimeTargetPolicySchema.nullable(),
  riskFlags: z.array(z.string()),
  changed: z.boolean(),
});

const RuntimeTargetsReconcileSchema = z.object({
  action: z.literal("reconcile"),
  mode: z.enum(["dry-run", "apply"]),
  changed: z.boolean(),
  totalAgents: z.number(),
  plannedAgents: z.number(),
  changedAgents: z.number(),
  skippedAgents: z.number(),
  fallbackTargets: z.array(RuntimeTargetSchema),
  items: z.array(RuntimeTargetsReconcileItemSchema),
  inspectCommand: z.string(),
});

const RequiredAgentIdSchema = z.string().trim().min(1, "agent is required");
const RequiredPolicyJsonSchema = z.string().trim().min(1, "policyJson is required");
const RequiredFallbackJsonSchema = z.string().trim().min(1, "fallbackJson is required");
const RequiredOrderSchema = z.string().trim().min(1, "order is required");

const SHOW_HELP = `
USE
  Inspect the complete agent-default policy and its ordered stable target ids without executing a provider.
DO NOT USE
  Use explain when you need current eligibility, provenance, and rejection reasons.
EXAMPLES
  ravi runtime targets show --agent main --json
  ravi runtime targets explain --agent main --json
ON ERROR
  Verify the agent id with ravi agents show <id> --json.
OUTPUT
  JSON includes agentId, enabled, policy, order, and inspectCommand. Exit 0 on success, 1 on error.
SEE ALSO
  ravi runtime targets set --help
  ravi runtime targets reorder --help
  ravi runtime targets explain --help
SOURCES
  .ravi/specs/runtime/target-failover/operator-cli/SPEC.md
`;

const EXPLAIN_HELP = `
USE
  Perform a stateless preflight of policy provenance, eligibility, and redacted rejection reasons without launching a turn.
DO NOT USE
  This command does not evaluate a session's cooldown/circuit history. Use sessions trace to inspect an executed turn.
EXAMPLES
  ravi runtime targets explain --agent main --json
  ravi runtime targets explain --agent main --task-profile default --json
ON ERROR
  Correct the agent, task profile, or strict session-policy JSON reported by validation and retry.
OUTPUT
  JSON includes evaluation=stateless_preflight, source, provenance, policyId, selectedTarget, and rejected.
  For health-aware policies, configured order is only the stateless tie-breaker; live turns also use session failure history.
SEE ALSO
  ravi runtime targets show --agent main --json
  ravi sessions trace <session>
SOURCES
  .ravi/specs/runtime/target-failover/operator-cli/SPEC.md
`;

const SET_HELP = `
USE
  Replace a complete policy with strict --policy-json.
DO NOT USE
  Do not put API keys or credential values in the policy; reference managed credential IDs.
RULES HARD
  The complete document is validated before mutation. Use reorder for a lossless target-order-only change.
EXAMPLES
  ravi runtime targets set --agent main --policy-json '{"id":"main-failover","strategy":"ordered","targets":[{"id":"primary","runtimeProvider":"codex","model":"gpt-5"}],"maxAttemptsPerTarget":1}' --json
  ravi runtime targets set --agent main --policy-json '{"id":"main-failover","strategy":"health-aware","targets":[{"id":"claude-main","runtimeProvider":"claude","model":"claude-sonnet-4-5"},{"id":"codex-live","runtimeProvider":"codex","model":"gpt-5"}],"maxAttemptsPerTarget":1}' --json
ON ERROR
  Use ravi runtime targets show --agent <id> --json, then retry with the exact target ids it returns.
OUTPUT
  JSON returns the validated policy, whether it changed, preserved default keys, and an inspect command. Exit 0 on success, 1 on error.
SEE ALSO
  ravi runtime targets show --agent main --json
  ravi runtime targets reorder --help
  ravi runtime targets explain --agent main --json
SOURCES
  .ravi/specs/runtime/target-failover/operator-cli/SPEC.md
`;

const REORDER_HELP = `
USE
  Atomically reorder an existing policy by stable target ids without reconstructing its JSON.
DO NOT USE
  Use set --policy-json to create or replace the complete policy.
RULES HARD
  --order must contain every configured target id exactly once. Provider names are not target ids.
  Reorder preserves raw policy fields, target objects, and every unrelated agent default.
EXAMPLES
  ravi runtime targets show --agent main --json
  ravi runtime targets reorder --agent main --order codex-live,claude-main,pi-main --json
ON ERROR
  Copy the exact ids from show.order and retry. Invalid input changes nothing.
OUTPUT
  JSON returns the validated policy, whether it changed, preserved default keys, and an inspect command.
SEE ALSO
  ravi runtime targets set --help
  ravi runtime targets show --agent main --json
SOURCES
  .ravi/specs/runtime/target-failover/operator-cli/SPEC.md
`;

const CLEAR_HELP = `
USE
  Disable runtime target failover for one agent while preserving every unrelated default.
DO NOT USE
  This does not delete managed credentials or model presets.
EXAMPLES
  ravi runtime targets clear --agent main --json
  ravi runtime targets explain --agent main --json
ON ERROR
  Verify the agent ID with ravi agents show <id> --json.
OUTPUT
  JSON reports whether configuration changed and which unrelated defaults were preserved. Exit 0 on success, 1 on error.
SEE ALSO
  ravi runtime targets show --agent main --json
  ravi runtime targets set --help
  ravi runtime targets reorder --help
SOURCES
  .ravi/specs/runtime/target-failover/operator-cli/SPEC.md
`;

const RECONCILE_HELP = `
USE
  Build a dry-run plan, or apply it, to materialize explicit runtime target policies for agents.
DO NOT USE
  Do not use this as hidden provider discovery. Fallback targets must be supplied explicitly.
RULES HARD
  Dry-run is the default. Use --apply to mutate agent defaults.
  Existing policies are skipped unless --force is set.
  The primary target is derived from each agent's effective provider/model. Fallbacks come from --fallback-json.
EXAMPLES
  ravi runtime targets reconcile --provider claude --fallback-json '[{"runtimeProvider":"codex","model":"gpt-5.5"},{"runtimeProvider":"pi","model":"google-antigravity/gemini-2.5-flash"}]' --json
  ravi runtime targets reconcile --agent main --fallback-json '[{"id":"codex-live","runtimeProvider":"codex","model":"gpt-5.5"}]' --apply --json
ON ERROR
  Fix invalid fallback JSON or missing agent model/provider first. No configuration changes during dry-run.
OUTPUT
  JSON returns mode, affected agents, skipped agents, proposed policies, risk flags, and an inspect command.
SEE ALSO
  ravi runtime targets explain --agent main --json
  .ravi/specs/runtime/provider-controller/PRD.md
`;

export function parseRuntimeTargetPolicyJson(policyJson: string): RuntimeTargetPolicy {
  let raw: unknown;
  try {
    raw = JSON.parse(policyJson);
  } catch (error) {
    throw new Error(
      `Runtime target policy must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseRuntimeTargetPolicy(raw);
}

export function buildRuntimeTargetPolicyDefaults(
  defaults: Record<string, unknown> | null | undefined,
  policy: unknown | null,
): Record<string, unknown> | null {
  const next = { ...(defaults ?? {}) };
  if (policy) next.runtimeTargetPolicy = structuredClone(policy);
  else delete next.runtimeTargetPolicy;
  return Object.keys(next).length > 0 ? next : null;
}

export function reorderRuntimeTargetPolicy(policy: RuntimeTargetPolicy, rawOrder: string): RuntimeTargetPolicy {
  const order = rawOrder.split(",").map((entry) => entry.trim());
  if (order.length === 0 || order.some((entry) => entry.length === 0)) {
    throw new Error("--order must be a comma-separated list of non-empty stable target ids");
  }

  const duplicateIds = order.filter((id, index) => order.indexOf(id) !== index);
  if (duplicateIds.length > 0) {
    throw new Error(`--order contains duplicate target ids: ${Array.from(new Set(duplicateIds)).join(", ")}`);
  }

  const targetsById = new Map(policy.targets.map((target) => [target.id, target]));
  const unknownIds = order.filter((id) => !targetsById.has(id));
  const missingIds = policy.targets.map((target) => target.id).filter((id) => !order.includes(id));
  if (unknownIds.length > 0 || missingIds.length > 0 || order.length !== policy.targets.length) {
    const details = [
      ...(unknownIds.length > 0 ? [`unknown: ${unknownIds.join(", ")}`] : []),
      ...(missingIds.length > 0 ? [`missing: ${missingIds.join(", ")}`] : []),
    ];
    throw new Error(
      `--order must contain every configured target id exactly once${details.length > 0 ? ` (${details.join("; ")})` : ""}`,
    );
  }

  return {
    ...structuredClone(policy),
    targets: order.map((id) => structuredClone(targetsById.get(id)!)),
  };
}

export function reorderRuntimeTargetPolicyDocument(
  value: unknown,
  rawOrder: string,
): { document: Record<string, unknown>; policy: RuntimeTargetPolicy } {
  const policy = parseRuntimeTargetPolicy(value);
  const reordered = reorderRuntimeTargetPolicy(policy, rawOrder);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Configured runtime target policy must be an object");
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.targets)) {
    throw new Error("Configured runtime target policy targets must be an array");
  }
  const rawTargets = new Map(
    record.targets.map((target) => {
      if (!target || typeof target !== "object" || Array.isArray(target)) {
        throw new Error("Configured runtime target policy contains an invalid target");
      }
      return [(target as Record<string, unknown>).id, target] as const;
    }),
  );
  const document = {
    ...structuredClone(record),
    targets: reordered.targets.map((target) => structuredClone(rawTargets.get(target.id)!)),
  };
  return { document, policy: parseRuntimeTargetPolicy(document) };
}

function readConfiguredRuntimeTargetPolicy(value: unknown): RuntimeTargetPolicy | null {
  if (value === undefined || value === null) return null;
  return parseRuntimeTargetPolicy(value);
}

function emitConfigChanged(): void {
  nats.emit("ravi.config.changed", {}).catch(() => {});
}

function readPolicyId(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = (value as Record<string, unknown>).id;
  return typeof id === "string" && id.trim() ? id : null;
}

function listPreservedDefaultKeys(defaults: Record<string, unknown> | null): string[] {
  return Object.keys(defaults ?? {})
    .filter((key) => key !== "runtimeTargetPolicy")
    .sort();
}

type ReconcileItem = z.infer<typeof RuntimeTargetsReconcileItemSchema>;

function parseFallbackTargetsJson(fallbackJson: string): RuntimeTarget[] {
  let raw: unknown;
  try {
    raw = JSON.parse(fallbackJson);
  } catch (error) {
    throw new Error(`Fallback targets must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("Fallback targets must be a non-empty JSON array.");
  }
  const targets = raw.map((target, index) => {
    if (!target || typeof target !== "object" || Array.isArray(target)) {
      throw new Error(`Fallback target ${index} must be an object.`);
    }
    return {
      id: `${readFallbackProvider(target, index)}-${index + 1}`,
      ...structuredClone(target as Record<string, unknown>),
    };
  });
  return parseRuntimeTargetPolicy({
    id: "fallback-preview",
    strategy: "ordered",
    targets,
    maxAttemptsPerTarget: 1,
  }).targets;
}

function readFallbackProvider(value: unknown, index: number): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return `fallback-${index + 1}`;
  const provider = (value as Record<string, unknown>).runtimeProvider;
  return typeof provider === "string" && provider.trim() ? slugTargetId(provider) : `fallback-${index + 1}`;
}

function slugTargetId(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "target"
  );
}

function uniqueTargetId(base: string, used: Set<string>): string {
  let id = slugTargetId(base);
  let suffix = 2;
  while (used.has(id)) {
    id = `${slugTargetId(base)}-${suffix}`;
    suffix += 1;
  }
  used.add(id);
  return id;
}

function buildReconcilePolicy(input: {
  agentId: string;
  agent: AgentConfig;
  fallbackTargets: RuntimeTarget[];
  policyPrefix: string;
}): {
  policy: RuntimeTargetPolicy | null;
  currentProvider: string | null;
  currentModel: string | null;
  reason: string | null;
} {
  const effective = resolveEffectiveAgentModel(input.agent);
  if (effective.error) {
    return {
      policy: null,
      currentProvider: effective.effectiveProvider || null,
      currentModel: effective.effectiveModel,
      reason: `model_selection_error:${effective.error}`,
    };
  }
  if (!effective.effectiveModel) {
    return {
      policy: null,
      currentProvider: effective.effectiveProvider || null,
      currentModel: null,
      reason: "missing_effective_model",
    };
  }
  const usedIds = new Set<string>();
  const primary: RuntimeTarget = {
    id: uniqueTargetId(`${effective.effectiveProvider}-primary`, usedIds),
    runtimeProvider: effective.effectiveProvider,
    model: effective.effectiveModel,
    ...(effective.modelPresetId && effective.modelPresetVersion
      ? { modelPreset: { id: effective.modelPresetId, version: effective.modelPresetVersion } }
      : {}),
  };
  const targets = [primary];
  for (const fallback of input.fallbackTargets) {
    if (fallback.runtimeProvider === primary.runtimeProvider && fallback.model === primary.model) continue;
    targets.push({
      ...structuredClone(fallback),
      id: uniqueTargetId(fallback.id, usedIds),
    });
  }
  if (targets.length < 2) {
    return {
      policy: null,
      currentProvider: effective.effectiveProvider,
      currentModel: effective.effectiveModel,
      reason: "no_distinct_fallback_targets",
    };
  }
  return {
    currentProvider: effective.effectiveProvider,
    currentModel: effective.effectiveModel,
    reason: null,
    policy: {
      id: `${slugTargetId(input.policyPrefix)}-${slugTargetId(input.agentId)}`,
      strategy: "ordered",
      targets,
      maxAttemptsPerTarget: 1,
      maxCredentialRecoveryAttemptsPerTarget: 1,
      cooldownMs: 30_000,
      circuitBreakerThreshold: 3,
    },
  };
}

function collectReconcileRiskFlags(agentId: string, policy: RuntimeTargetPolicy): string[] {
  const flags: string[] = [];
  const registeredProviders = new Set(listRegisteredRuntimeProviderIds());
  const capabilities = materializeSubjectCapabilities("agent", agentId, { includeRoles: true });
  const credentialEligibility = resolveRuntimeTargetCredentialEligibility(policy, { agentId });
  for (const target of policy.targets) {
    if (!registeredProviders.has(target.runtimeProvider)) flags.push(`provider_unregistered:${target.id}`);
    if (!canWithCapabilities(capabilities, "use", "runtime.target", target.id)) {
      flags.push(`permission_denied:${target.id}`);
    }
    const credential = credentialEligibility.get(target.id);
    if (credential && !credential.eligible) {
      flags.push(`credential_unavailable:${target.id}:${credential.detail ?? "unknown"}`);
    }
  }
  return flags;
}

function findBlockingReconcileRisk(flags: string[]): string | null {
  if (flags.some((flag) => flag.startsWith("provider_unregistered:"))) {
    return "unsafe_policy:provider_unregistered";
  }
  if (flags.some((flag) => flag.startsWith("permission_denied:"))) {
    return "unsafe_policy:permission_denied";
  }
  return null;
}

@Group({
  name: "runtime.targets",
  description: "Inspect opt-in runtime target selection and failover eligibility",
  scope: "admin",
})
export class RuntimeTargetsCommands {
  @Command({
    name: "show",
    description: "Show the complete configured runtime target policy and order for one agent",
    helpAfter: SHOW_HELP,
  })
  @CommandAccess({ kind: "read", resource: "runtime.targets", action: "show", risk: "low" })
  @Returns(RuntimeTargetsShowSchema)
  show(
    @Option({
      flags: "--agent <id>",
      description: "Agent whose configured policy should be shown",
      schema: RequiredAgentIdSchema,
    })
    agentId?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (!agentId?.trim()) fail("--agent is required. Example: ravi runtime targets show --agent main --json");
    const agent = getAgent(agentId);
    if (!agent) fail(`Agent not found: ${agentId}`);

    let policy: RuntimeTargetPolicy | null;
    try {
      policy = readConfiguredRuntimeTargetPolicy(agent.defaults?.runtimeTargetPolicy);
    } catch (error) {
      fail(`Configured runtime target policy is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
    const payload = {
      agentId,
      enabled: Boolean(policy),
      policy,
      order: policy?.targets.map((target) => target.id) ?? [],
      inspectCommand: `ravi runtime targets explain --agent ${agentId} --json`,
    };
    if (asJson) console.log(JSON.stringify(payload, null, 2));
    else if (!policy) console.log(`No runtime target policy is configured for agent '${agentId}'.`);
    else console.log(`${policy.id}: ${payload.order.join(" -> ")}`);
    return payload;
  }

  @Command({
    name: "explain",
    description: "Explain which runtime target an agent would select without executing it",
    helpAfter: EXPLAIN_HELP,
  })
  @CommandAccess({ kind: "read", resource: "runtime.targets", action: "explain", risk: "low" })
  @Returns(RuntimeTargetsExplainSchema)
  explain(
    @Option({
      flags: "--agent <id>",
      description: "Agent whose defaults should be evaluated",
      schema: RequiredAgentIdSchema,
    })
    agentId?: string,
    @Option({
      flags: "--task-profile <id>",
      description: "Optional task profile whose policy and credential scope apply",
    })
    taskProfileId?: string,
    @Option({
      flags: "--session-policy-json <json>",
      description: "Optional session override policy to evaluate first",
    })
    sessionPolicyJson?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (!agentId?.trim()) fail("--agent is required. Example: ravi runtime targets explain --agent main --json");
    const agent = configStore.getConfig().agents[agentId];
    if (!agent) fail(`Agent not found: ${agentId}`);
    const taskProfile = taskProfileId?.trim() ? resolveTaskProfile(taskProfileId) : null;
    let sessionOverride: RuntimeTargetPolicy | undefined;
    if (sessionPolicyJson?.trim()) {
      try {
        sessionOverride = parseRuntimeTargetPolicyJson(sessionPolicyJson);
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
    }
    const resolved = resolveRuntimeTargetPolicy({
      ...(sessionOverride ? { sessionOverride } : {}),
      ...(taskProfile?.runtimeTargetPolicy ? { taskProfilePolicy: taskProfile.runtimeTargetPolicy } : {}),
      ...(taskProfile ? { taskProfileId: taskProfile.id } : {}),
      agentDefaults: agent.defaults,
      agentId,
    });
    const registeredProviders = new Set(listRegisteredRuntimeProviderIds());
    const capabilities = materializeSubjectCapabilities("agent", agentId, { includeRoles: true });
    const selection = resolved.policy
      ? selectRuntimeTarget(
          resolved.policy,
          {
            logicalTurnId: "preview",
            attempts: [],
            sideEffectBoundaryCrossed: false,
            terminal: false,
          },
          {
            now: Date.now(),
            registeredProviders,
            availableCapabilities: new Map(
              resolved.policy.targets
                .filter((target) => registeredProviders.has(target.runtimeProvider))
                .map((target) => [
                  target.runtimeProvider,
                  collectRuntimeCapabilityNames(createRuntimeProvider(target.runtimeProvider).getCapabilities()),
                ]),
            ),
            permittedTargetIds: new Set(
              resolved.policy.targets
                .filter((target) => canWithCapabilities(capabilities, "use", "runtime.target", target.id))
                .map((target) => target.id),
            ),
            credentialEligibility: resolveRuntimeTargetCredentialEligibility(resolved.policy, {
              agentId,
              ...(taskProfile ? { taskProfileId: taskProfile.id } : {}),
            }),
          },
        )
      : null;
    const payload = {
      agentId,
      evaluation: "stateless_preflight" as const,
      enabled: Boolean(resolved.policy),
      source: resolved.source,
      provenance: resolved.provenance,
      policyId: resolved.policy?.id ?? null,
      selectedTarget:
        selection?.status === "selected"
          ? {
              id: selection.target.id,
              runtimeProvider: selection.target.runtimeProvider,
              model: selection.target.model,
            }
          : null,
      rejected: selection?.rejected ?? [],
    };
    if (asJson) console.log(JSON.stringify(payload, null, 2));
    else if (!payload.enabled) console.log(`No runtime target policy is enabled for agent '${agentId}'.`);
    else console.log(`${payload.policyId}: ${payload.selectedTarget?.id ?? "exhausted"}`);
    return payload;
  }

  @Command({
    name: "set",
    description: "Validate and set an agent runtime target policy while preserving unrelated defaults",
    helpAfter: SET_HELP,
  })
  @CommandAccess({ kind: "mutate", resource: "runtime.targets", action: "set", risk: "medium" })
  @Returns(RuntimeTargetsMutationSchema)
  set(
    @Option({
      flags: "--agent <id>",
      description: "Agent whose opt-in runtime target policy should change",
      schema: RequiredAgentIdSchema,
    })
    agentId?: string,
    @Option({
      flags: "--policy-json <json>",
      description: "Complete runtime target policy as strict JSON",
      schema: RequiredPolicyJsonSchema,
    })
    policyJson?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (!agentId?.trim())
      fail("--agent is required. Example: ravi runtime targets set --agent main --policy-json '<json>'");
    if (!policyJson?.trim()) fail("--policy-json is required. Use ravi runtime targets set --help for an example.");
    if (!getAgent(agentId)) fail(`Agent not found: ${agentId}`);

    let policy: RuntimeTargetPolicy;
    try {
      policy = parseRuntimeTargetPolicyJson(policyJson);
    } catch (error) {
      fail(`${error instanceof Error ? error.message : String(error)}. No configuration was changed.`);
    }

    let previousPolicyId: string | null = null;
    const mutation = mutateAgentDefaults(agentId, (defaults) => {
      previousPolicyId = readPolicyId(defaults?.runtimeTargetPolicy);
      return buildRuntimeTargetPolicyDefaults(defaults, policy);
    });
    if (mutation.changed) {
      configStore.refresh();
      emitConfigChanged();
    }
    const payload = {
      action: "set" as const,
      changed: mutation.changed,
      agentId,
      policy,
      previousPolicyId,
      preservedDefaultKeys: listPreservedDefaultKeys(mutation.defaults),
      inspectCommand: `ravi runtime targets show --agent ${agentId} --json`,
    };
    if (asJson) console.log(JSON.stringify(payload, null, 2));
    else
      console.log(
        `${mutation.changed ? "Set" : "Unchanged"} runtime target policy '${policy.id}' for agent '${agentId}'.`,
      );
    return payload;
  }

  @Command({
    name: "reorder",
    description: "Atomically reorder an existing runtime target policy by stable target ids",
    helpAfter: REORDER_HELP,
  })
  @CommandAccess({ kind: "mutate", resource: "runtime.targets", action: "reorder", risk: "medium" })
  @Returns(RuntimeTargetsMutationSchema)
  reorder(
    @Option({
      flags: "--agent <id>",
      description: "Agent whose existing runtime target policy should be reordered",
      schema: RequiredAgentIdSchema,
    })
    agentId?: string,
    @Option({
      flags: "--order <target-ids>",
      description: "Comma-separated exact permutation of stable ids from runtime targets show",
      schema: RequiredOrderSchema,
    })
    orderRaw?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (!agentId?.trim())
      fail("--agent is required. Example: ravi runtime targets reorder --agent main --order a,b,c --json");
    if (!orderRaw?.trim()) fail("--order is required and must contain every configured target id exactly once.");
    if (!getAgent(agentId)) fail(`Agent not found: ${agentId}`);

    let policy: RuntimeTargetPolicy | null = null;
    let previousPolicyId: string | null = null;
    let mutation: ReturnType<typeof mutateAgentDefaults>;
    try {
      mutation = mutateAgentDefaults(agentId, (defaults) => {
        const configured = defaults?.runtimeTargetPolicy;
        if (configured === undefined || configured === null) {
          fail(
            `No runtime target policy is configured for agent '${agentId}'. Create one with set --policy-json before using reorder.`,
          );
        }
        previousPolicyId = readPolicyId(configured);
        const reordered = reorderRuntimeTargetPolicyDocument(configured, orderRaw);
        policy = reordered.policy;
        return buildRuntimeTargetPolicyDefaults(defaults, reordered.document);
      });
    } catch (error) {
      fail(`${error instanceof Error ? error.message : String(error)}. No configuration was changed.`);
    }
    if (!policy) fail("Reorder failed before producing a validated policy. No configuration was changed.");
    if (mutation.changed) {
      configStore.refresh();
      emitConfigChanged();
    }
    const payload = {
      action: "reorder" as const,
      changed: mutation.changed,
      agentId,
      policy,
      previousPolicyId,
      preservedDefaultKeys: listPreservedDefaultKeys(mutation.defaults),
      inspectCommand: `ravi runtime targets show --agent ${agentId} --json`,
    };
    if (asJson) console.log(JSON.stringify(payload, null, 2));
    else console.log(`${mutation.changed ? "Reordered" : "Unchanged"} runtime target policy for agent '${agentId}'.`);
    return payload;
  }

  @Command({
    name: "clear",
    description: "Disable an agent runtime target policy while preserving unrelated defaults",
    helpAfter: CLEAR_HELP,
  })
  @CommandAccess({ kind: "mutate", resource: "runtime.targets", action: "clear", risk: "medium" })
  @Returns(RuntimeTargetsMutationSchema)
  clear(
    @Option({
      flags: "--agent <id>",
      description: "Agent whose runtime target policy should be removed",
      schema: RequiredAgentIdSchema,
    })
    agentId?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (!agentId?.trim()) fail("--agent is required. Example: ravi runtime targets clear --agent main --json");
    if (!getAgent(agentId)) fail(`Agent not found: ${agentId}`);

    let previousPolicyId: string | null = null;
    const mutation = mutateAgentDefaults(agentId, (defaults) => {
      previousPolicyId = readPolicyId(defaults?.runtimeTargetPolicy);
      return buildRuntimeTargetPolicyDefaults(defaults, null);
    });
    if (mutation.changed) {
      configStore.refresh();
      emitConfigChanged();
    }
    const payload = {
      action: "clear" as const,
      changed: mutation.changed,
      agentId,
      policy: null,
      previousPolicyId,
      preservedDefaultKeys: listPreservedDefaultKeys(mutation.defaults),
      inspectCommand: `ravi runtime targets show --agent ${agentId} --json`,
    };
    if (asJson) console.log(JSON.stringify(payload, null, 2));
    else console.log(`${mutation.changed ? "Cleared" : "No"} runtime target policy for agent '${agentId}'.`);
    return payload;
  }

  @Command({
    name: "reconcile",
    description:
      "Plan or apply explicit fleet runtime target policies from current agent provider plus supplied fallbacks",
    helpAfter: RECONCILE_HELP,
  })
  @CommandAccess({ kind: "mutate", resource: "runtime.targets", action: "reconcile", risk: "medium" })
  @Returns(RuntimeTargetsReconcileSchema)
  reconcile(
    @Option({
      flags: "--fallback-json <json>",
      description: "JSON array of explicit fallback runtime target objects",
      schema: RequiredFallbackJsonSchema,
    })
    fallbackJson?: string,
    @Option({
      flags: "--agent <id>",
      description: "Optional single agent to reconcile",
    })
    agentId?: string,
    @Option({
      flags: "--provider <id>",
      description: "Only reconcile agents whose effective provider matches this provider",
    })
    providerFilter?: string,
    @Option({
      flags: "--policy-prefix <prefix>",
      description: "Prefix for generated policy ids (default: controller)",
    })
    policyPrefix = "controller",
    @Option({
      flags: "--force",
      description: "Replace an existing agent-default runtime target policy",
    })
    force?: boolean,
    @Option({
      flags: "--apply",
      description: "Apply the generated plan. Without this flag the command is dry-run only.",
    })
    apply?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (!fallbackJson?.trim()) {
      fail(
        '--fallback-json is required. Example: ravi runtime targets reconcile --fallback-json \'[{"runtimeProvider":"codex","model":"gpt-5"}]\' --json',
      );
    }
    let fallbackTargets: RuntimeTarget[];
    try {
      fallbackTargets = parseFallbackTargetsJson(fallbackJson);
    } catch (error) {
      fail(`${error instanceof Error ? error.message : String(error)}. No configuration was changed.`);
    }

    const config = configStore.getConfig();
    const provider = providerFilter?.trim();
    const selectedAgents = Object.values(config.agents)
      .filter((agent) => !agentId?.trim() || agent.id === agentId.trim())
      .sort((left, right) => left.id.localeCompare(right.id));
    if (agentId?.trim() && selectedAgents.length === 0) fail(`Agent not found: ${agentId.trim()}`);

    const items: ReconcileItem[] = selectedAgents.map((agent) => {
      const previousPolicyId = readPolicyId(agent.defaults?.runtimeTargetPolicy);
      const built = buildReconcilePolicy({
        agentId: agent.id,
        agent,
        fallbackTargets,
        policyPrefix,
      });
      if (provider && built.currentProvider !== provider) {
        return {
          agentId: agent.id,
          action: "skip",
          reason: `provider_filter:${built.currentProvider ?? "unknown"}`,
          currentProvider: built.currentProvider,
          currentModel: built.currentModel,
          previousPolicyId,
          proposedPolicy: null,
          riskFlags: [],
          changed: false,
        };
      }
      if (previousPolicyId && !force) {
        return {
          agentId: agent.id,
          action: "skip",
          reason: "existing_policy",
          currentProvider: built.currentProvider,
          currentModel: built.currentModel,
          previousPolicyId,
          proposedPolicy: null,
          riskFlags: [],
          changed: false,
        };
      }
      if (!built.policy) {
        return {
          agentId: agent.id,
          action: "skip",
          reason: built.reason,
          currentProvider: built.currentProvider,
          currentModel: built.currentModel,
          previousPolicyId,
          proposedPolicy: null,
          riskFlags: [],
          changed: false,
        };
      }
      return {
        agentId: agent.id,
        action: "set",
        reason: null,
        currentProvider: built.currentProvider,
        currentModel: built.currentModel,
        previousPolicyId,
        proposedPolicy: built.policy,
        riskFlags: collectReconcileRiskFlags(agent.id, built.policy),
        changed: false,
      };
    });

    let changedAgents = 0;
    if (apply) {
      for (const item of items) {
        if (item.action !== "set" || !item.proposedPolicy) continue;
        const blockingRisk = findBlockingReconcileRisk(item.riskFlags);
        if (blockingRisk) {
          item.action = "skip";
          item.reason = blockingRisk;
          continue;
        }
        const mutation = mutateAgentDefaults(item.agentId, (defaults) =>
          buildRuntimeTargetPolicyDefaults(defaults, item.proposedPolicy),
        );
        item.changed = mutation.changed;
        if (mutation.changed) changedAgents += 1;
      }
      if (changedAgents > 0) {
        configStore.refresh();
        emitConfigChanged();
      }
    }

    const plannedAgents = items.filter((item) => item.action === "set").length;
    const payload = {
      action: "reconcile" as const,
      mode: apply ? ("apply" as const) : ("dry-run" as const),
      changed: changedAgents > 0,
      totalAgents: selectedAgents.length,
      plannedAgents,
      changedAgents,
      skippedAgents: items.length - plannedAgents,
      fallbackTargets,
      items,
      inspectCommand: "ravi runtime targets explain --agent <agent-id> --json",
    };
    if (asJson) console.log(JSON.stringify(payload, null, 2));
    else {
      console.log(
        `${apply ? "Applied" : "Planned"} runtime target reconciliation: ${plannedAgents} planned, ${payload.skippedAgents} skipped, ${changedAgents} changed.`,
      );
    }
    return payload;
  }
}
