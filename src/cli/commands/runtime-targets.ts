import "reflect-metadata";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { configStore } from "../../config-store.js";
import { nats } from "../../nats.js";
import { createRuntimeProvider, listRegisteredRuntimeProviderIds } from "../../runtime/provider-registry.js";
import { canWithCapabilities, materializeSubjectCapabilities } from "../../permissions/provider-runtime.js";
import { getAgent, updateAgent } from "../../router/config.js";
import { resolveTaskProfile } from "../../tasks/profiles.js";
import { resolveRuntimeTargetCredentialEligibility } from "../../runtime/target-credential-eligibility.js";
import { parseRuntimeTargetPolicy, resolveRuntimeTargetPolicy } from "../../runtime/target-policy-config.js";
import {
  collectRuntimeCapabilityNames,
  selectRuntimeTarget,
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
  action: z.enum(["set", "clear"]),
  changed: z.boolean(),
  agentId: z.string(),
  policy: RuntimeTargetPolicySchema.nullable(),
  previousPolicyId: z.string().nullable(),
  preservedDefaultKeys: z.array(z.string()),
  inspectCommand: z.string(),
});

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
  ravi runtime targets explain --help
SOURCES
  .ravi/specs/runtime/target-failover/operator-cli/SPEC.md
`;

const EXPLAIN_HELP = `
USE
  Preview the effective policy, provenance, selected target, and redacted rejection reasons without launching a turn.
DO NOT USE
  Use show to inspect the complete configured agent-default policy or sessions trace to inspect an executed turn.
EXAMPLES
  ravi runtime targets explain --agent main --json
  ravi runtime targets explain --agent main --task-profile default --json
ON ERROR
  Correct the agent, task profile, or strict session-policy JSON reported by validation and retry.
OUTPUT
  JSON includes enabled, source, provenance, policyId, selectedTarget, and rejected. Exit 0 on success, 1 on error.
SEE ALSO
  ravi runtime targets show --agent main --json
  ravi sessions trace <session>
SOURCES
  .ravi/specs/runtime/target-failover/operator-cli/SPEC.md
`;

const SET_HELP = `
USE
  Replace a complete policy with --policy-json, or atomically reorder an existing policy with --order.
DO NOT USE
  Do not put API keys or credential values in the policy; reference managed credential IDs.
RULES HARD
  Supply exactly one of --policy-json or --order. --order uses stable target ids and must include every id exactly once.
  Reorder preserves target objects, policy metadata, provider/model defaults, and every unrelated agent default.
EXAMPLES
  ravi runtime targets set --agent main --policy-json '{"id":"main-failover","strategy":"ordered","targets":[{"id":"primary","runtimeProvider":"codex","model":"gpt-5"}],"maxAttemptsPerTarget":1}' --json
  ravi runtime targets set --agent main --order codex-live,claude-main,pi-main --json
ON ERROR
  Use ravi runtime targets show --agent <id> --json, then retry with the exact target ids it returns.
OUTPUT
  JSON returns the validated policy, whether it changed, preserved default keys, and an inspect command. Exit 0 on success, 1 on error.
SEE ALSO
  ravi runtime targets show --agent main --json
  ravi runtime targets explain --agent main --json
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
SOURCES
  .ravi/specs/runtime/target-failover/operator-cli/SPEC.md
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
  policy: RuntimeTargetPolicy | null,
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

  return parseRuntimeTargetPolicy({
    ...structuredClone(policy),
    targets: order.map((id) => structuredClone(targetsById.get(id)!)),
  });
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
    @Option({ flags: "--agent <id>", description: "Agent whose configured policy should be shown" }) agentId?: string,
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
    @Option({ flags: "--agent <id>", description: "Agent whose defaults should be evaluated" }) agentId?: string,
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
    @Option({ flags: "--agent <id>", description: "Agent whose opt-in runtime target policy should change" })
    agentId?: string,
    @Option({ flags: "--policy-json <json>", description: "Complete runtime target policy as strict JSON" })
    policyJson?: string,
    @Option({
      flags: "--order <target-ids>",
      description: "Comma-separated exact permutation of stable ids from runtime targets show",
    })
    orderRaw?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (!agentId?.trim())
      fail("--agent is required. Example: ravi runtime targets set --agent main --policy-json '<json>'");
    const hasPolicyJson = Boolean(policyJson?.trim());
    const hasOrder = Boolean(orderRaw?.trim());
    if (hasPolicyJson === hasOrder) {
      fail("Provide exactly one of --policy-json or --order. Use ravi runtime targets set --help for examples.");
    }
    const agent = getAgent(agentId);
    if (!agent) fail(`Agent not found: ${agentId}`);

    let policy: RuntimeTargetPolicy;
    try {
      if (hasPolicyJson) {
        policy = parseRuntimeTargetPolicyJson(policyJson!);
      } else {
        const configured = readConfiguredRuntimeTargetPolicy(agent.defaults?.runtimeTargetPolicy);
        if (!configured) {
          fail(
            `No runtime target policy is configured for agent '${agentId}'. Create one with --policy-json before using --order.`,
          );
        }
        policy = reorderRuntimeTargetPolicy(configured, orderRaw!);
      }
    } catch (error) {
      fail(`${error instanceof Error ? error.message : String(error)}. No configuration was changed.`);
    }

    const previousPolicyId = readPolicyId(agent.defaults?.runtimeTargetPolicy);
    const nextDefaults = buildRuntimeTargetPolicyDefaults(agent.defaults, policy);
    const changed = !isDeepStrictEqual(agent.defaults ?? null, nextDefaults);
    if (changed) {
      updateAgent(agentId, { defaults: nextDefaults });
      configStore.refresh();
      emitConfigChanged();
    }
    const payload = {
      action: "set" as const,
      changed,
      agentId,
      policy,
      previousPolicyId,
      preservedDefaultKeys: listPreservedDefaultKeys(nextDefaults),
      inspectCommand: `ravi runtime targets show --agent ${agentId} --json`,
    };
    if (asJson) console.log(JSON.stringify(payload, null, 2));
    else console.log(`${changed ? "Set" : "Unchanged"} runtime target policy '${policy.id}' for agent '${agentId}'.`);
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
    @Option({ flags: "--agent <id>", description: "Agent whose runtime target policy should be removed" })
    agentId?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (!agentId?.trim()) fail("--agent is required. Example: ravi runtime targets clear --agent main --json");
    const agent = getAgent(agentId);
    if (!agent) fail(`Agent not found: ${agentId}`);

    const previousPolicyId = readPolicyId(agent.defaults?.runtimeTargetPolicy);
    const nextDefaults = buildRuntimeTargetPolicyDefaults(agent.defaults, null);
    const changed = !isDeepStrictEqual(agent.defaults ?? null, nextDefaults);
    if (changed) {
      updateAgent(agentId, { defaults: nextDefaults });
      configStore.refresh();
      emitConfigChanged();
    }
    const payload = {
      action: "clear" as const,
      changed,
      agentId,
      policy: null,
      previousPolicyId,
      preservedDefaultKeys: listPreservedDefaultKeys(nextDefaults),
      inspectCommand: `ravi runtime targets show --agent ${agentId} --json`,
    };
    if (asJson) console.log(JSON.stringify(payload, null, 2));
    else console.log(`${changed ? "Cleared" : "No"} runtime target policy for agent '${agentId}'.`);
    return payload;
  }
}
