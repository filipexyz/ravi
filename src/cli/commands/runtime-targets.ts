import "reflect-metadata";
import { z } from "zod";
import { configStore } from "../../config-store.js";
import { createRuntimeProvider, listRegisteredRuntimeProviderIds } from "../../runtime/provider-registry.js";
import { canWithCapabilities, materializeSubjectCapabilities } from "../../permissions/provider-runtime.js";
import { resolveRuntimeTargetPolicy } from "../../runtime/target-policy-config.js";
import { collectRuntimeCapabilityNames, selectRuntimeTarget } from "../../runtime/target-policy.js";
import { fail } from "../context.js";
import { Command, CommandAccess, Group, Option, Returns } from "../decorators.js";

const RuntimeTargetsExplainSchema = z.object({
  agentId: z.string(),
  enabled: z.boolean(),
  source: z.enum(["session_override", "task_profile", "agent_default", "none"]),
  provenance: z.string().nullable(),
  policyId: z.string().nullable(),
  selectedTarget: z.object({ id: z.string(), runtimeProvider: z.string(), model: z.string() }).nullable(),
  rejected: z.array(z.object({ targetId: z.string(), reason: z.string(), detail: z.string().optional() })),
});

@Group({
  name: "runtime.targets",
  description: "Inspect opt-in runtime target selection and failover eligibility",
  scope: "admin",
})
export class RuntimeTargetsCommands {
  @Command({ name: "explain", description: "Explain which runtime target an agent would select without executing it" })
  @CommandAccess({ kind: "read", resource: "runtime.targets", action: "explain", risk: "low" })
  @Returns(RuntimeTargetsExplainSchema)
  explain(
    @Option({ flags: "--agent <id>", description: "Agent whose defaults should be evaluated" }) agentId?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson = false,
  ) {
    if (!agentId?.trim()) fail("--agent is required. Example: ravi runtime targets explain --agent main --json");
    const agent = configStore.getConfig().agents[agentId];
    if (!agent) fail(`Agent not found: ${agentId}`);
    const resolved = resolveRuntimeTargetPolicy({ agentDefaults: agent.defaults, agentId });
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
}
