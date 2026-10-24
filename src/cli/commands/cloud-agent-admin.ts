/**
 * `ravi cloud agents approve|cap|memory-reset`: owner and admin decisions on a
 * deployed cloud agent. `approve` approves the capability manifest the
 * compiler derived (an agent with writes auto, open network, secrets, external
 * MCP servers, an installation placement or the Ravi provider, and every
 * catalog install, waits for it); `cap` sets the monthly cap that pauses the
 * agent; `memory-reset` archives the agent's memory stores. The Console checks
 * the role. Same `cloud.agents` group as the deploy and run commands.
 *
 * spec: cloud/agents, cli
 */

import "reflect-metadata";
import { z } from "zod";

import {
  approveCloudAgent,
  getCloudProductAgent,
  getCloudProductAgentDetail,
  resetCloudAgentMemory,
  setCloudAgentCap,
} from "../../cloud-agents/client-product.js";
import type { CloudAgent } from "../../cloud-agents/types.js";
import { contractDryRun } from "../agent-contract.js";
import { formatUsd, requireCloudProject, withCloudAgentsContract } from "../cloud-agents-contract.js";
import {
  type CloudProductCommandDeps,
  cloudProductAgentReturnSchema,
  parseUsd,
  printJson,
  productSession,
  requireArg,
  requireProjectAgent,
} from "../cloud-product-contract.js";
import { Arg, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";

const APPROVE_HELP_AFTER = `
MUTATE (BRAKED) — approves the agent's current capability manifest (what it can
do: model, writes, network and hosts, MCP servers, Ravi tool families, secrets,
repositories, memory, placement, provider, Office skills, web filters,
ask_human, workflows). Runs of an agent awaiting approval are refused with
CLOUD_AGENT_AWAITING_APPROVAL. Deploying a version whose manifest changes asks
again. Only owners and admins approve.

EXAMPLES
  ravi cloud agents approve triage --project clinica             # plan with the manifest (exit 3)
  ravi cloud agents approve triage --project clinica --execute
`;

const CAP_HELP_AFTER = `
Sets the agent's monthly cap in US dollars (an admin override of the
definition's cloud.monthlyCapUsd); none removes the override. When the month's
cost of its runs crosses the cap, the agent pauses: its schedules and triggers
skip and new runs are refused until the 1st (UTC) or until the cap is raised.

BRAKE
  Raising or removing the cap is braked (exit 3 without --execute); lowering it
  applies at once.

EXAMPLES
  ravi cloud agents cap triage 20 --project clinica
  ravi cloud agents cap triage 100 --project clinica --execute
  ravi cloud agents cap triage none --project clinica --execute
`;

const MEMORY_RESET_HELP_AFTER = `
MUTATE (BRAKED) — archives the agent's memory stores (cloud.memory "agent":
one store; "person": one per person). Later runs start with empty memory;
an archived store is never mounted again. Only owners and admins reset memory.

EXAMPLES
  ravi cloud agents memory-reset triage --project clinica             # plan with the store count (exit 3)
  ravi cloud agents memory-reset triage --project clinica --execute
`;

const agentPayloadSchema = z.object({ success: z.literal(true), agent: cloudProductAgentReturnSchema }).strict();

function manifestLines(agent: CloudAgent): string[] {
  const value = agent.manifest?.value;
  if (!value) return ["  (no manifest yet: deploy the agent again)"];
  return Object.entries(value).map(([key, entry]) => `  ${key}: ${JSON.stringify(entry)}`);
}

@Group({
  name: "cloud.agents",
  description: "Library agents deployed to run in the cloud (Anthropic managed agents)",
  scope: "open",
})
export class CloudAgentAdminCommands {
  constructor(private readonly deps: CloudProductCommandDeps = {}) {}

  @Command({
    name: "approve",
    description: "Approve a cloud agent's capability manifest (owner or admin). Requires --execute.",
    helpAfter: APPROVE_HELP_AFTER,
  })
  @CommandAccess({
    kind: "mutate",
    resource: "cloud.agents",
    action: "agents.approve",
    risk: "high",
    requiresConfirmation: true,
  })
  @Returns(agentPayloadSchema)
  async approve(
    @Arg("agent", { description: "Cloud agent id, Library slug or name" }) agentRef: string,
    @Option({ flags: "--project <project>", description: "Console project slug (default: the cwd's project)" })
    project?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--execute", description: "Approve (without it, print the plan and exit 3)" }) execute?: boolean,
  ) {
    const op = "cloud agents approve";
    const ref = requireArg(op, "<agent>", agentRef, asJson);
    return withCloudAgentsContract(
      op,
      asJson,
      async () => {
        const session = await productSession(this.deps, project);
        const projectRef = requireCloudProject(op, session, asJson);
        const matched = await requireProjectAgent(op, session.client, projectRef, ref, asJson);
        const current = await getCloudProductAgent(session.client, matched.id);
        if (execute !== true) {
          contractDryRun(
            op,
            {
              agent: { id: current.id, name: current.name, status: current.status },
              project: projectRef,
              manifestHash: current.manifest?.hash ?? null,
              alreadyApproved: current.manifest?.approved === true,
              manifest: current.manifest?.value ?? null,
              catalogEntryId: current.catalogEntryId ?? null,
              effect: "the agent's runs may use every capability in this manifest, as the person each run acts for",
            },
            { asJson },
          );
        }
        const agent = await approveCloudAgent(session.client, current.id);
        const payload = { success: true as const, agent };
        if (asJson) {
          printJson(payload);
        } else {
          console.log(`✓ Approved ${agent.name} (${agent.status}), manifest ${agent.manifest?.hash ?? "?"}`);
          for (const line of manifestLines(agent)) console.log(line);
        }
        return payload;
      },
      { notFoundCode: "CLOUD_AGENT_NOT_FOUND" },
    );
  }

  @Command({
    name: "cap",
    description: "Set a cloud agent's monthly cap in US$ (or none). Requires --execute when raising it.",
    helpAfter: CAP_HELP_AFTER,
  })
  @CommandAccess({
    kind: "mutate",
    resource: "cloud.agents",
    action: "agents.cap",
    risk: "high",
    requiresConfirmation: true,
  })
  @Returns(agentPayloadSchema)
  async cap(
    @Arg("agent", { description: "Cloud agent id, Library slug or name" }) agentRef: string,
    @Arg("usd", { description: "Monthly cap in US dollars, or none" }) usd: string,
    @Option({ flags: "--project <project>", description: "Console project slug (default: the cwd's project)" })
    project?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--execute", description: "Raise or remove the cap (without it, print the plan and exit 3)" })
    execute?: boolean,
  ) {
    const op = "cloud agents cap";
    const ref = requireArg(op, "<agent>", agentRef, asJson);
    const next = parseUsd(op, "<usd>", requireArg(op, "<usd>", usd, asJson), {
      min: 0.01,
      max: 100_000,
      allowNone: true,
      asJson,
    }) as number | null;
    return withCloudAgentsContract(
      op,
      asJson,
      async () => {
        const session = await productSession(this.deps, project);
        const projectRef = requireCloudProject(op, session, asJson);
        const matched = await requireProjectAgent(op, session.client, projectRef, ref, asJson);
        const current = await getCloudProductAgent(session.client, matched.id);
        const currentCap = current.cap?.monthlyCapUsd ?? null;
        const raises = currentCap !== null && (next === null || next > currentCap);
        if (raises && execute !== true) {
          contractDryRun(
            op,
            {
              agent: { id: current.id, name: current.name },
              project: projectRef,
              monthlyCapUsd: { from: currentCap, to: next },
              monthSpentUsd: current.cap?.monthSpentUsd ?? 0,
              paused: current.cap?.pausedAt !== null && current.cap?.pausedAt !== undefined,
              effect: "the agent may spend more this month; a paused agent resumes when its spend is under the cap",
            },
            { asJson },
          );
        }
        const agent = await setCloudAgentCap(session.client, current.id, next);
        const payload = { success: true as const, agent };
        if (asJson) {
          printJson(payload);
        } else {
          const capNow = agent.cap?.monthlyCapUsd ?? null;
          console.log(
            `✓ ${agent.name}: monthly cap ${capNow === null ? "none" : formatUsd(capNow)}, spent ${formatUsd(agent.cap?.monthSpentUsd ?? 0)}${agent.cap?.pausedAt ? " (paused)" : ""}`,
          );
        }
        return payload;
      },
      { notFoundCode: "CLOUD_AGENT_NOT_FOUND" },
    );
  }

  @Command({
    name: "memory-reset",
    description: "Archive a cloud agent's memory stores (its runs start with empty memory). Requires --execute.",
    helpAfter: MEMORY_RESET_HELP_AFTER,
  })
  @CommandAccess({
    kind: "mutate",
    resource: "cloud.agents",
    action: "agents.memory_reset",
    risk: "high",
    requiresConfirmation: true,
  })
  @Returns(
    z.object({ success: z.literal(true), agentId: z.string(), name: z.string(), archivedStores: z.number() }).strict(),
  )
  async memoryReset(
    @Arg("agent", { description: "Cloud agent id, Library slug or name" }) agentRef: string,
    @Option({ flags: "--project <project>", description: "Console project slug (default: the cwd's project)" })
    project?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--execute", description: "Archive the stores (without it, print the plan and exit 3)" })
    execute?: boolean,
  ) {
    const op = "cloud agents memory-reset";
    const ref = requireArg(op, "<agent>", agentRef, asJson);
    return withCloudAgentsContract(
      op,
      asJson,
      async () => {
        const session = await productSession(this.deps, project);
        const projectRef = requireCloudProject(op, session, asJson);
        const matched = await requireProjectAgent(op, session.client, projectRef, ref, asJson);
        const { agent: current, memory } = await getCloudProductAgentDetail(session.client, matched.id);
        if (execute !== true) {
          contractDryRun(
            op,
            {
              agent: { id: current.id, name: current.name },
              project: projectRef,
              memory: current.config.memory ?? null,
              stores: memory?.storeCount ?? null,
              effect:
                current.config.memory === "person"
                  ? "archives every person's memory store of this agent; later runs start with empty memory"
                  : "archives the agent's memory store; later runs start with empty memory",
            },
            { asJson },
          );
        }
        const result = await resetCloudAgentMemory(session.client, current.id);
        const payload = {
          success: true as const,
          agentId: result.agentId,
          name: current.name,
          archivedStores: result.archivedStores ?? memory?.storeCount ?? 0,
        };
        if (asJson) printJson(payload);
        else console.log(`✓ Archived ${payload.archivedStores} memory store(s) of ${current.name}`);
        return payload;
      },
      { notFoundCode: "CLOUD_AGENT_NOT_FOUND" },
    );
  }
}
