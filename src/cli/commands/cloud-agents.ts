/**
 * Cloud agents from the CLI: `ravi cloud key|agents|runs|schedules`. A Library
 * agent runs on Anthropic's managed agents with the organization's own key;
 * the Console owns the provider, budgets, approvals and who may do what. This
 * side calls it with the `ravi login` credentials.
 *
 * spec: cloud/agents, cli
 */

import "reflect-metadata";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

import { dbMarkCloudChatQuestionAnswered } from "../../cloud-agents/chat-db.js";
import { currentTurnPerson } from "../../cloud-agents/chat-people.js";
import type { CloudAgentsClient } from "../../cloud-agents/client.js";
import { isCloudCron, isCloudTimezone } from "../../cloud-agents/definition.js";
import { prepareCloudRunFiles } from "../../cloud-agents/run-inputs.js";
import {
  bindCloudThread,
  type CloudChatSource,
  type CloudThreadDeps,
  editCloudThreadRoot,
  openCloudThreadRoot,
  planCloudThread,
} from "../../cloud-agents/thread-binding.js";
import {
  isTerminalCloudRunStatus,
  type CloudAgent,
  type CloudRun,
  type CloudRunEvent,
  type CloudRunStartBody,
  type CloudSchedule,
} from "../../cloud-agents/types.js";
import { unattributedTurnRefusal } from "../../cloud-auth/turn-actor.js";
import {
  normalizeTurnRefusal,
  turnRefusalCopy,
  turnRefusalDetails,
  type TurnRefusal,
} from "../../cloud-auth/turn-refusal.js";
import { isOperatorOwnTurn } from "../../library/turn.js";
import { safeRelativePath } from "../../pages/read-download.js";
import {
  CONTRACT_EXIT_ERROR,
  CONTRACT_EXIT_POLICY,
  contractDryRun,
  contractFail,
  suggestSimilar,
} from "../agent-contract.js";
import {
  cloudAgentReturnSchema,
  cloudApprovalReturnSchema,
  cloudCredentialReturnSchema,
  cloudPaginationReturnSchema,
  cloudQuestionReturnSchema,
  cloudRunReturnSchema,
  cloudScheduleReturnSchema,
  formatDuration,
  formatUsd,
  pageCloudList,
  parseCloudBudget,
  parseCloudRepos,
  requireCloudAgentsSession,
  requireCloudProject,
  requirePromptText,
  usageError,
  withCloudAgentsContract,
  type OpenCloudAgentsSession,
} from "../cloud-agents-contract.js";
import { Arg, CliOnly, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";
import { getContext } from "../context.js";
import { runtimeLibraryCaller, runtimeLibrarySession } from "../library-contract.js";
import { readNonInteractiveSecret } from "../secret-input.js";

export interface CloudAgentsCommandDeps {
  openSession?: OpenCloudAgentsSession;
  /** Reads the key from redirected stdin (tests replace it). */
  readKey?: () => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
  /** Whether this call runs inside an agent's turn, and whether that turn is the operator's own. */
  inAgentRuntime?: () => boolean;
  operatorOwnTurn?: () => boolean;
  /** Whether an agent turn runs this and Ravi cannot say who asked (another agent, an unresolved speaker). */
  unattributedTurn?: () => boolean | TurnRefusal | null;
  /** Default timezone of a new schedule. */
  localTimezone?: () => string;
  /** The agent session this call runs in and the chat its turn came from; null in a terminal. */
  chatContext?: () => CloudCliChatContext | null;
  /** The turn's person (their contact and name), the run's person in a bound thread. */
  turnPerson?: () => { contactId: string | null; name: string | null };
  /** Reads a `--file` and its size (tests replace them). */
  readFile?: (path: string) => Uint8Array;
  fileSize?: (path: string) => number | null;
  /** How the run card reaches the chat (tests replace it). */
  threadDeps?: CloudThreadDeps;
}

export interface CloudCliChatContext {
  sessionName: string;
  source: CloudChatSource | null;
  /** The turn's working directory (relative `--file` paths). */
  cwd: string | null;
}

function defaultChatContext(): CloudCliChatContext | null {
  const session = runtimeLibrarySession();
  if (!session?.name) return null;
  const context = getContext();
  return {
    sessionName: session.name,
    source: context?.source ?? null,
    cwd: typeof context?.cwd === "string" && context.cwd ? context.cwd : null,
  };
}

type CloudDeliveryBody = NonNullable<CloudRunStartBody["delivery"]>;

/** Where a run or schedule delivers: this session when inside one, nowhere with `--no-deliver`. */
function deliveryFor(chat: CloudCliChatContext | null, noDeliver: boolean | undefined): CloudDeliveryBody | undefined {
  if (noDeliver) return { kind: "none" };
  if (!chat) return undefined;
  const source = chat.source;
  return {
    kind: "session",
    sessionName: chat.sessionName,
    ...(source
      ? {
          chat: {
            channel: source.channel.slice(0, 40),
            chatId: source.chatId.slice(0, 300),
            threadId: source.threadId ?? null,
            instanceId: source.instanceId ?? null,
          },
        }
      : {}),
  };
}

function formatBrl(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? `R$ ${value.toFixed(2)}` : "-";
}

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function defaultsOf(deps: CloudAgentsCommandDeps) {
  return {
    readKey: deps.readKey ?? (() => readNonInteractiveSecret({ fromStdin: true, maxBytes: 4_096 })),
    sleep: deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms))),
    inAgentRuntime: deps.inAgentRuntime ?? (() => runtimeLibraryCaller() !== null),
    operatorOwnTurn: deps.operatorOwnTurn ?? (() => isOperatorOwnTurn()),
    unattributedTurn: deps.unattributedTurn ?? (() => unattributedTurnRefusal()),
    localTimezone: deps.localTimezone ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"),
    chatContext: deps.chatContext ?? defaultChatContext,
    turnPerson: deps.turnPerson ?? currentTurnPerson,
  };
}

async function sessionFor(deps: CloudAgentsCommandDeps, project?: string, resolveProject = true) {
  return requireCloudAgentsSession({ project: project?.trim() || null, resolveProject }, deps.openSession ?? undefined);
}

/** The deployed agent a ref names: its id, Library item id, slug, `<scope>/<slug>` or name. */
export function matchCloudAgent(agents: readonly CloudAgent[], ref: string): CloudAgent | null {
  const raw = ref.trim();
  const key = raw.toLowerCase();
  const slug = key.includes("/") ? key.slice(key.lastIndexOf("/") + 1) : key;
  return (
    agents.find((agent) => agent.id === raw) ??
    agents.find((agent) => agent.library.itemId !== "" && agent.library.itemId === raw) ??
    agents.find((agent) => agent.library.slug.toLowerCase() === slug) ??
    agents.find((agent) => agent.name.toLowerCase() === key) ??
    null
  );
}

/** What the Console takes as `agent`: the Library slug (`org/x` and `clinica/x` become `x`). */
function agentArgument(ref: string, matched: CloudAgent | null): string {
  if (matched?.library.slug) return matched.library.slug;
  const raw = ref.trim();
  return raw.includes("/") ? raw.slice(raw.lastIndexOf("/") + 1) : raw;
}

async function requireDeployedAgent(
  op: string,
  client: CloudAgentsClient,
  project: string,
  ref: string,
  asJson?: boolean,
): Promise<CloudAgent> {
  const agents = await client.listAgents(project);
  const found = matchCloudAgent(agents, ref);
  if (found) return found;
  contractFail(op, "CLOUD_AGENT_NOT_FOUND", `No cloud agent '${ref.slice(0, 80)}' in project ${project}.`, {
    asJson,
    details: {
      suggestedAction: `Deploy it first: ravi cloud agents deploy ${ref.slice(0, 80)} --project ${project} --execute`,
      suggestions: suggestSimilar(
        ref,
        agents.map((agent) => agent.library.slug || agent.name),
      ),
    },
  });
}

function requireText(op: string, label: string, value: string | undefined, asJson?: boolean): string {
  const text = value?.trim() ?? "";
  if (!text) usageError(op, `${label} is required.`, asJson);
  return text;
}

function agentLine(agent: CloudAgent): string {
  const version = agent.library.version !== null ? ` v${agent.library.version}` : "";
  return `  ${agent.name.padEnd(24)} ${agent.status.padEnd(9)} ${agent.model ?? "-"}  budget ${formatUsd(agent.config.budgetUsd)}  ${agent.library.scope || "?"}/${agent.library.slug}${version}  id ${agent.id}`;
}

function runLine(run: CloudRun): string {
  return `  ${run.id}  ${run.status.padEnd(16)} ${run.agentName.padEnd(20)} ${run.trigger.padEnd(8)} ${formatUsd(run.costUsd)}  ${formatDuration(run.runningSeconds)}  ${run.actor.name ?? run.actor.id}`;
}

function printRun(run: CloudRun): void {
  console.log(`Run ${run.id}: ${run.status}`);
  console.log(`  Agent:   ${run.agentName} (${run.agentId})`);
  console.log(`  Trigger: ${run.trigger}, by ${run.actor.name ?? run.actor.id}`);
  console.log(
    `  Cost:    ${formatUsd(run.costUsd)} of ${formatUsd(run.budgetUsd)}, ${formatDuration(run.runningSeconds)}`,
  );
  console.log(
    `  Tokens:  in ${run.tokens.input}, out ${run.tokens.output}, cache read ${run.tokens.cacheRead}, cache write ${run.tokens.cacheWrite}`,
  );
  if (typeof run.costBrl === "number" || typeof run.chargedBrl === "number") {
    const charged = typeof run.chargedBrl === "number" ? `, charged ${formatBrl(run.chargedBrl)} in credits` : "";
    console.log(`  In BRL:  ${formatBrl(run.costBrl)}${charged}`);
  }
  if (run.delivery)
    console.log(`  Delivery: ${deliveryLine(run.delivery)}${run.deliveredAt ? `, delivered ${run.deliveredAt}` : ""}`);
  if (run.threadKey) console.log(`  Thread:  ${run.threadKey}`);
  if (run.outcome) {
    console.log(
      `  Outcome: ${run.outcome.lastResult ?? "not evaluated yet"} after ${run.outcome.iterations} of ${run.outcome.maxIterations} iterations`,
    );
    if (run.outcome.feedback) console.log(`    ${run.outcome.feedback.slice(0, 300)}`);
  }
  for (const file of run.files ?? []) console.log(`  Input:   ${file.name} (${file.size} bytes)`);
  if (run.error) console.log(`  Error:   ${run.error.code} ${run.error.message}`);
  for (const question of run.questions ?? []) printQuestion(run, question);
  for (const approval of run.approvals) {
    console.log(
      `  Approval ${approval.id}: ${approval.status} ${approval.server ? `${approval.server}/` : ""}${approval.tool}`,
    );
    if (approval.status === "pending") {
      console.log(`    Approve: ravi cloud runs approve ${run.id} ${approval.id} --execute`);
      console.log(`    Deny:    ravi cloud runs deny ${run.id} ${approval.id}`);
    }
  }
  for (const output of run.outputs) console.log(`  Output:  ${output.name} (${output.size} bytes)`);
  if (run.url) console.log(`  Console: ${run.url}`);
  if (run.result) console.log(`\n${run.result}`);
}

function deliveryLine(delivery: NonNullable<CloudRun["delivery"]>): string {
  if (delivery.kind === "session") return `session ${delivery.sessionName ?? "-"}`;
  if (delivery.kind === "page_room") return `page chat room ${delivery.roomId ?? "-"}`;
  return "none";
}

function printQuestion(run: CloudRun, question: NonNullable<CloudRun["questions"]>[number]): void {
  console.log(`  Question ${question.id}: ${question.status} ${question.question.replace(/\s+/g, " ").slice(0, 200)}`);
  for (const [index, option] of question.options.entries()) console.log(`    ${index + 1}. ${option.slice(0, 120)}`);
  if (question.status === "pending") {
    console.log(`    Answer:  ravi cloud runs answer ${run.id} ${question.id} "<answer>" --execute`);
  } else if (question.answer) {
    console.log(`    Answered: ${question.answer.replace(/\s+/g, " ").slice(0, 200)}`);
  }
}

function scheduleLine(schedule: CloudSchedule): string {
  return `  ${schedule.id}  ${schedule.enabled ? "on " : "off"} ${schedule.agentName.padEnd(20)} ${schedule.cron} (${schedule.timezone})  next ${schedule.nextRunAt ?? "-"}  budget ${formatUsd(schedule.budgetUsd)}${schedule.prompt === null ? "  HEARTBEAT.md" : ""}`;
}

function eventLine(event: CloudRunEvent): string {
  const at = event.at ? `${event.at.slice(11, 19)} ` : "";
  switch (event.type) {
    case "message":
      return `${at}${event.role ?? "agent"}: ${event.text ?? ""}`;
    case "tool_call":
      return `${at}→ ${event.tool ?? "tool"}${event.text ? ` ${event.text}` : ""}`;
    case "tool_result":
      return `${at}← ${event.tool ?? "tool"}${event.text ? ` ${event.text}` : ""}`;
    case "status":
      return `${at}status: ${event.status ?? event.text ?? ""}`;
    case "approval":
      return `${at}approval: ${event.text ?? event.tool ?? ""}`;
    case "error":
      return `${at}error: ${event.text ?? ""}`;
    default:
      return `${at}${event.type}: ${event.text ?? ""}`;
  }
}

// ---------------------------------------------------------------------------
// ravi cloud key

const KEY_SET_HELP_AFTER = `
MUTATE (BRAKED) — sends the organization's Anthropic API key to the Console,
which checks it with Anthropic and stores it encrypted. The key never comes
back: only its last characters (keyHint). Every cloud run of the organization
spends on this key. Only owners and admins set it.

RULES
  • The key is read from redirected stdin only; never pass it as an argument.
  • Without --execute it prints the plan and exits 3; stdin is not read.
  • Agents do not set the key (CLOUD_AGENT_CANNOT_SET_KEY, exit 3).

EXAMPLES
  ravi cloud key set --stdin --execute < ~/secrets/anthropic-key
  ravi cloud key set --stdin --monthly-alert 100 --execute < ~/secrets/anthropic-key
`;

@Group({
  name: "cloud.key",
  description: "The organization's Anthropic API key for cloud agents (kept in the Console)",
  scope: "open",
})
export class CloudKeyCommands {
  constructor(private readonly deps: CloudAgentsCommandDeps = {}) {}

  @Command({
    name: "status",
    description: "Show whether the organization has a cloud agents key, and this month's cost",
  })
  @CommandAccess({ kind: "read", resource: "cloud.agents", action: "key.status", risk: "low" })
  @Returns(z.object({ success: z.literal(true), credential: cloudCredentialReturnSchema }).strict())
  async status(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    return withCloudAgentsContract("cloud key status", asJson, async () => {
      const session = await sessionFor(this.deps, undefined, false);
      const credential = await session.client.getCredential();
      const payload = { success: true as const, credential };
      if (asJson) {
        printJson(payload);
      } else if (!credential.configured) {
        console.log("No Anthropic key for cloud agents. An owner or admin sets it:");
        console.log("  ravi cloud key set --stdin --execute < <file-with-the-key>");
      } else {
        console.log(
          `Anthropic key …${credential.keyHint ?? "????"}: ${credential.status}${credential.verifiedAt ? `, verified ${credential.verifiedAt}` : ""}`,
        );
        console.log(
          `This month: ${formatUsd(credential.monthCostUsd)}${credential.monthlyAlertUsd !== null ? ` (alert at ${formatUsd(credential.monthlyAlertUsd)})` : ""}`,
        );
      }
      return payload;
    });
  }

  @Command({
    name: "set",
    description: "Set or replace the organization's Anthropic API key from stdin. Requires --execute.",
    helpAfter: KEY_SET_HELP_AFTER,
  })
  @CliOnly()
  @CommandAccess({
    kind: "mutate",
    resource: "cloud.agents",
    action: "key.set",
    risk: "high",
    requiresConfirmation: true,
  })
  @Returns(z.object({ success: z.literal(true), credential: cloudCredentialReturnSchema }).strict())
  async set(
    @Option({ flags: "--stdin", description: "Read the key from redirected stdin (the only way to pass it)" })
    stdin?: boolean,
    @Option({ flags: "--monthly-alert <usd>", description: "Alert owners and admins when a month's cost passes this" })
    monthlyAlert?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--execute", description: "Send the key (without it, print the plan and exit 3)" })
    execute?: boolean,
  ) {
    const op = "cloud key set";
    const d = defaultsOf(this.deps);
    if (d.inAgentRuntime()) {
      contractFail(op, "CLOUD_AGENT_CANNOT_SET_KEY", "Agents do not set the organization's cloud agents key.", {
        asJson,
        exitCode: CONTRACT_EXIT_POLICY,
        details: { suggestedAction: "Ask an owner or admin to run: ravi cloud key set --stdin --execute < <key-file>" },
      });
    }
    if (stdin !== true) {
      usageError(
        op,
        "The key is read from stdin only: pass --stdin and redirect the key file.",
        asJson,
        "ravi cloud key set --stdin --execute < <key-file>",
      );
    }
    let monthlyAlertUsd: number | undefined;
    if (monthlyAlert !== undefined) {
      monthlyAlertUsd = Number(String(monthlyAlert).trim().replace(/^\$/, ""));
      if (!Number.isFinite(monthlyAlertUsd) || monthlyAlertUsd <= 0 || monthlyAlertUsd > 1_000_000) {
        usageError(op, "--monthly-alert must be a positive number of US dollars.", asJson);
      }
    }
    return withCloudAgentsContract(op, asJson, async () => {
      const session = await sessionFor(this.deps, undefined, false);
      const current = await session.client.getCredential();
      if (execute !== true) {
        contractDryRun(
          op,
          {
            provider: "anthropic",
            keyFrom: "stdin",
            replaces: current.configured,
            currentKeyHint: current.keyHint,
            monthlyAlertUsd: monthlyAlertUsd ?? null,
            effect:
              "the Console checks the key with Anthropic, stores it encrypted and uses it for every cloud run of the organization",
          },
          { asJson },
        );
      }
      const apiKey = (await d.readKey()).trim();
      if (!apiKey || /\s/.test(apiKey)) usageError(op, "stdin did not hold one API key.", asJson);
      const credential = await session.client.setCredential({
        provider: "anthropic",
        apiKey,
        ...(monthlyAlertUsd !== undefined ? { monthlyAlertUsd } : {}),
      });
      const payload = { success: true as const, credential };
      if (asJson) printJson(payload);
      else console.log(`✓ Anthropic key …${credential.keyHint ?? "????"} set (${credential.status})`);
      return payload;
    });
  }

  @Command({ name: "remove", description: "Remove the organization's cloud agents key (runs stop starting)" })
  @CommandAccess({ kind: "mutate", resource: "cloud.agents", action: "key.remove", risk: "medium" })
  @Returns(z.object({ success: z.literal(true), credential: cloudCredentialReturnSchema }).strict())
  async remove(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    return withCloudAgentsContract("cloud key remove", asJson, async () => {
      const session = await sessionFor(this.deps, undefined, false);
      const credential = await session.client.removeCredential();
      const payload = { success: true as const, credential };
      if (asJson) printJson(payload);
      else console.log("✓ Removed the organization's Anthropic key. New cloud runs will not start until one is set.");
      return payload;
    });
  }
}

// ---------------------------------------------------------------------------
// ravi cloud agents

const AGENTS_DEPLOY_HELP_AFTER = `
MUTATE (BRAKED) — deploys a Library agent definition (published with
'ravi agents publish') to the cloud provider for one Console project: the
Console compiles AGENTS.md, agent.json (with its optional "cloud" block) and
the agent's Library skills, and creates the provider's agent and environment.
Deploying the same version again changes nothing.

EXAMPLES
  ravi cloud agents deploy triage --project clinica                 # plan (exit 3)
  ravi cloud agents deploy triage --project clinica --execute
  ravi cloud agents deploy triage --version 3 --project clinica --execute
`;

const agentPayloadSchema = z.object({ success: z.literal(true), agent: cloudAgentReturnSchema }).strict();

@Group({
  name: "cloud.agents",
  description: "Library agents deployed to run in the cloud (Anthropic managed agents)",
  scope: "open",
})
export class CloudAgentsCommands {
  constructor(private readonly deps: CloudAgentsCommandDeps = {}) {}

  @Command({ name: "list", description: "List the cloud agents of a Console project" })
  @CommandAccess({ kind: "read", resource: "cloud.agents", action: "agents.list", risk: "low" })
  @Returns(
    z
      .object({
        success: z.literal(true),
        project: z.string(),
        agents: z.array(cloudAgentReturnSchema),
        pagination: cloudPaginationReturnSchema,
      })
      .strict(),
  )
  async list(
    @Option({ flags: "--project <project>", description: "Console project slug (default: the cwd's project)" })
    project?: string,
    @Option({ flags: "--limit <n>", description: "Page size (1-200, default 50)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Skip this many (default 0)" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "cloud agents list";
    return withCloudAgentsContract(op, asJson, async () => {
      const session = await sessionFor(this.deps, project);
      const projectRef = requireCloudProject(op, session, asJson);
      const page = pageCloudList(
        op,
        await session.client.listAgents(projectRef),
        { limit, offset, command: `ravi cloud agents list --project ${projectRef}` },
        asJson,
      );
      const agents = page.items;
      const payload = { success: true as const, project: projectRef, agents, pagination: page.pagination };
      if (asJson) {
        printJson(payload);
      } else if (agents.length === 0) {
        console.log(`No cloud agents in ${projectRef}. Deploy a Library agent with:`);
        console.log(`  ravi cloud agents deploy <agent> --project ${projectRef} --execute`);
      } else {
        for (const agent of agents) console.log(agentLine(agent));
      }
      return payload;
    });
  }

  @Command({ name: "show", description: "Show one cloud agent (id, Library slug or name)" })
  @CommandAccess({ kind: "read", resource: "cloud.agents", action: "agents.show", risk: "low" })
  @Returns(agentPayloadSchema)
  async show(
    @Arg("agent", { description: "Cloud agent id, Library slug or name" }) agentRef: string,
    @Option({ flags: "--project <project>", description: "Console project slug (default: the cwd's project)" })
    project?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "cloud agents show";
    const ref = requireText(op, "<agent>", agentRef, asJson);
    return withCloudAgentsContract(
      op,
      asJson,
      async () => {
        const session = await sessionFor(this.deps, project);
        const projectRef = requireCloudProject(op, session, asJson);
        const matched = await requireDeployedAgent(op, session.client, projectRef, ref, asJson);
        const agent = await session.client.getAgent(matched.id);
        const payload = { success: true as const, agent };
        if (asJson) {
          printJson(payload);
        } else {
          console.log(agentLine(agent));
          console.log(
            `  networking ${agent.config.networking}, web search ${agent.config.webSearch ? "on" : "off"}, writes ${agent.config.writes}, Ravi MCP ${agent.config.raviMcp ? "on" : "off"}`,
          );
          if (agent.config.mcpServers.length > 0) console.log(`  MCP servers: ${agent.config.mcpServers.join(", ")}`);
          if (agent.config.repositories.length > 0)
            console.log(`  Repositories: ${agent.config.repositories.join(", ")}`);
          if (agent.config.schedule)
            console.log(`  Schedule: ${agent.config.schedule.cron} (${agent.config.schedule.timezone})`);
          if (agent.lastError) console.log(`  Last error: ${agent.lastError}`);
        }
        return payload;
      },
      { notFoundCode: "CLOUD_AGENT_NOT_FOUND" },
    );
  }

  @Command({
    name: "deploy",
    description: "Deploy a Library agent to the cloud for a project. Requires --execute.",
    helpAfter: AGENTS_DEPLOY_HELP_AFTER,
  })
  @CommandAccess({
    kind: "mutate",
    resource: "cloud.agents",
    action: "agents.deploy",
    risk: "high",
    requiresConfirmation: true,
  })
  @Returns(agentPayloadSchema.extend({ changed: z.boolean(), warnings: z.array(z.string()) }).strict())
  async deploy(
    @Arg("agent", { description: "Library agent slug or item id" }) agentRef: string,
    @Option({ flags: "--version <n>", description: "Library version (default: the latest published)" })
    version?: string,
    @Option({ flags: "--project <project>", description: "Console project slug (default: the cwd's project)" })
    project?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--execute", description: "Deploy (without it, print the plan and exit 3)" }) execute?: boolean,
  ) {
    const op = "cloud agents deploy";
    const ref = requireText(op, "<agent>", agentRef, asJson);
    let versionNumber: number | undefined;
    if (version !== undefined) {
      versionNumber = Number(version);
      if (!Number.isInteger(versionNumber) || versionNumber < 1)
        usageError(op, "--version must be a positive integer.", asJson);
    }
    return withCloudAgentsContract(
      op,
      asJson,
      async () => {
        const session = await sessionFor(this.deps, project);
        const projectRef = requireCloudProject(op, session, asJson);
        const current = matchCloudAgent(await session.client.listAgents(projectRef), ref);
        const agent = agentArgument(ref, current);
        if (execute !== true) {
          contractDryRun(
            op,
            {
              agent,
              project: projectRef,
              version: versionNumber ?? "latest",
              deployed: current ? { id: current.id, version: current.library.version, status: current.status } : null,
              effect:
                "the Console compiles the Library agent and creates or updates its provider agent and environment",
            },
            { asJson },
          );
        }
        const result = await session.client.deployAgent({
          project: projectRef,
          agent,
          ...(versionNumber !== undefined ? { version: versionNumber } : {}),
        });
        const payload = {
          success: true as const,
          agent: result.agent,
          changed: result.changed,
          warnings: result.warnings,
        };
        if (asJson) {
          printJson(payload);
        } else {
          console.log(
            !result.changed
              ? `= ${result.agent.name} already runs this version (${result.agent.status})`
              : `✓ Deployed ${result.agent.name} v${result.agent.library.version ?? "?"} (${result.agent.status})`,
          );
          for (const warning of result.warnings) console.log(`  ! ${warning}`);
          console.log(
            `  Run it: ravi cloud runs start ${result.agent.library.slug || agent} "<prompt>" --project ${projectRef} --execute`,
          );
        }
        return payload;
      },
      { notFoundCode: "CLOUD_AGENT_NOT_FOUND" },
    );
  }

  @Command({ name: "archive", description: "Archive a cloud agent (no new runs; past runs stay readable)" })
  @CommandAccess({ kind: "mutate", resource: "cloud.agents", action: "agents.archive", risk: "medium" })
  @Returns(
    z
      .object({
        success: z.literal(true),
        id: z.string(),
        archived: z.literal(true),
        agent: cloudAgentReturnSchema.nullable(),
      })
      .strict(),
  )
  async archive(
    @Arg("agent", { description: "Cloud agent id, Library slug or name" }) agentRef: string,
    @Option({ flags: "--project <project>", description: "Console project slug (default: the cwd's project)" })
    project?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "cloud agents archive";
    const ref = requireText(op, "<agent>", agentRef, asJson);
    return withCloudAgentsContract(
      op,
      asJson,
      async () => {
        const session = await sessionFor(this.deps, project);
        const projectRef = requireCloudProject(op, session, asJson);
        const matched = await requireDeployedAgent(op, session.client, projectRef, ref, asJson);
        const agent = await session.client.archiveAgent(matched.id);
        const payload = { success: true as const, id: matched.id, archived: true as const, agent };
        if (asJson) printJson(payload);
        else console.log(`✓ Archived ${matched.name} (${matched.id})`);
        return payload;
      },
      { notFoundCode: "CLOUD_AGENT_NOT_FOUND" },
    );
  }
}

// ---------------------------------------------------------------------------
// ravi cloud runs

const RUNS_START_HELP_AFTER = `
MUTATE (BRAKED: SPENDS MONEY) — starts a cloud run of a Library agent with the
organization's Anthropic key. The run acts as you: its Ravi tools are the
Console's, with your access, and every write outside its container waits for
a person's approval (unless the agent was deployed with writes: auto). It stops
at its budget (default the agent's, US$ 5 unless agent.json says otherwise).
An agent never deployed in the project is deployed first.

INSIDE A CONVERSATION
  Started from an agent's session, the run reports back to it: its result
  (with the cost), the approvals it waits on and the questions it asks come to
  this conversation. Only the run's person approves or answers: on Slack with
  private Approve/Deny buttons, elsewhere by replying "aprovar <código>" or
  "negar <código>". --no-deliver keeps the result in the Console only.
  --bind-thread (a Slack thread or a WhatsApp group) also makes the
  conversation the run's: a run card shows its status, and the run's person
  talks to the run there (on WhatsApp, starting with @run or replying to the card).

EXAMPLES
  ravi cloud runs start triage "Summarize yesterday's open tickets" --project clinica            # plan (exit 3)
  ravi cloud runs start triage "Summarize yesterday's open tickets" --project clinica --execute
  ravi cloud runs start dev-helper "Fix the flaky test" --repo acme/api@dev --budget 10 --execute
  ravi cloud runs start analyst "Compare the two quotes" --file quote-a.pdf --file quote-b.pdf --execute
  ravi cloud runs start writer "Draft the release notes" --outcome "Covers every merged PR" --max-iterations 3 --execute

NEXT
  ravi cloud runs follow <run>        # live events until it ends
  ravi cloud runs approve <run> <approval> --execute
  ravi cloud runs answer <run> <question> "<answer>" --execute
`;

const runPayloadSchema = z.object({ success: z.literal(true), run: cloudRunReturnSchema }).strict();

const startPayloadSchema = z
  .object({
    success: z.literal(true),
    run: cloudRunReturnSchema,
    /** The conversation bound to the run (`--bind-thread`). */
    thread: z
      .object({ threadKey: z.string(), channel: z.enum(["slack", "whatsapp"]), cardMessageId: z.string().nullable() })
      .strict()
      .optional(),
  })
  .strict();

const OUTCOME_RUBRIC_MAX = 8_000;
const ROWS_VIEW_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function parseOutcome(
  op: string,
  rubric: string | undefined,
  maxIterations: string | undefined,
  asJson?: boolean,
): CloudRunStartBody["outcome"] | undefined {
  if (rubric === undefined) {
    if (maxIterations !== undefined) usageError(op, "--max-iterations goes with --outcome.", asJson);
    return undefined;
  }
  const text = rubric.trim();
  if (!text || text.length > OUTCOME_RUBRIC_MAX) {
    usageError(op, `--outcome takes a rubric of 1-${OUTCOME_RUBRIC_MAX} characters.`, asJson);
  }
  if (maxIterations === undefined) return { rubric: text };
  const iterations = Number(maxIterations);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 5) {
    usageError(op, "--max-iterations must be an integer from 1 to 5.", asJson);
  }
  return { rubric: text, maxIterations: iterations };
}

function parseRows(
  op: string,
  viewId: string | undefined,
  limit: string | undefined,
  asJson?: boolean,
): CloudRunStartBody["rows"] | undefined {
  if (viewId === undefined) {
    if (limit !== undefined) usageError(op, "--rows-limit goes with --rows-view.", asJson);
    return undefined;
  }
  const id = viewId.trim();
  if (!ROWS_VIEW_PATTERN.test(id)) usageError(op, "--rows-view takes a Base view id.", asJson);
  if (limit === undefined) return { viewId: id };
  const rows = Number(limit);
  if (!Number.isInteger(rows) || rows < 1 || rows > 500) {
    usageError(op, "--rows-limit must be an integer from 1 to 500.", asJson);
  }
  return { viewId: id, limit: rows };
}

@Group({
  name: "cloud.runs",
  description: "Cloud runs of Library agents: start, follow, approve, stop",
  scope: "open",
})
export class CloudRunsCommands {
  constructor(private readonly deps: CloudAgentsCommandDeps = {}) {}

  @Command({
    name: "start",
    description: "Start a paid cloud run of a Library agent. Requires --execute.",
    helpAfter: RUNS_START_HELP_AFTER,
  })
  @CommandAccess({
    kind: "mutate",
    resource: "cloud.agents",
    action: "runs.start",
    risk: "high",
    requiresConfirmation: true,
  })
  @Returns(startPayloadSchema)
  async start(
    @Arg("agent", { description: "Library agent slug, or a cloud agent id or name" }) agentRef: string,
    @Arg("prompt", { description: "What the agent should do" }) prompt: string,
    @Option({ flags: "--budget <usd>", description: "Budget for this run in US dollars (0.5-200)" }) budget?: string,
    @Option({ flags: "--repo <repo...>", description: "Mount a GitHub repository: owner/name[@branch], repeatable" })
    repos?: string[],
    @Option({ flags: "--project <project>", description: "Console project slug (default: the cwd's project)" })
    project?: string,
    @Option({ flags: "--idempotency-key <key>", description: "Same key, same run: a retry never starts a second run" })
    idempotencyKey?: string,
    @Option({
      flags: "--file <path...>",
      description: "A file the run reads at /mnt/session/inputs/<name>, repeatable (10 files, 3 MB in all)",
    })
    files?: string[],
    @Option({ flags: "--outcome <rubric>", description: "What the result must satisfy; the run revises until it does" })
    outcome?: string,
    @Option({ flags: "--max-iterations <n>", description: "Revisions for --outcome (1-5, default 1)" })
    maxIterations?: string,
    @Option({ flags: "--rows-view <id>", description: "Work through the rows of this Base view (needs a budget)" })
    rowsView?: string,
    @Option({ flags: "--rows-limit <n>", description: "How many rows of --rows-view (1-500)" }) rowsLimit?: string,
    @Option({
      flags: "--bind-thread",
      description: "Make this Slack thread or WhatsApp group the run's conversation (run card, replies go to the run)",
    })
    bindThread?: boolean,
    @Option({ flags: "--no-deliver", description: "Do not bring the result back to this conversation" })
    noDeliver?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--execute", description: "Start the run (without it, print the plan and exit 3)" })
    execute?: boolean,
  ) {
    const op = "cloud runs start";
    const d = defaultsOf(this.deps);
    const ref = requireText(op, "<agent>", agentRef, asJson);
    const text = requirePromptText(op, "<prompt>", prompt, asJson);
    const budgetUsd = parseCloudBudget(op, budget, asJson);
    const repositories = parseCloudRepos(op, repos, asJson);
    const key = idempotencyKey?.trim();
    if (key !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(key)) {
      usageError(op, "--idempotency-key must be 8-128 characters of letters, digits, '.', '_', ':' and '-'.", asJson);
    }
    const outcomeBody = parseOutcome(op, outcome, maxIterations, asJson);
    const rows = parseRows(op, rowsView, rowsLimit, asJson);
    const chat = d.chatContext();
    const delivery = deliveryFor(chat, noDeliver);
    let plan: ReturnType<typeof planCloudThread> | null = null;
    if (bindThread) {
      if (noDeliver) usageError(op, "--bind-thread brings the run to this conversation; drop --no-deliver.", asJson);
      plan = planCloudThread(chat?.source);
      if ("error" in plan) usageError(op, plan.error, asJson);
    }
    const threadPlan = plan && !("error" in plan) ? plan : null;
    const inputs =
      files && files.length > 0
        ? prepareCloudRunFiles(files, {
            cwd: chat?.cwd ?? process.cwd(),
            insideCwdOnly: d.inAgentRuntime() && !d.operatorOwnTurn(),
            ...(this.deps.readFile ? { readFile: this.deps.readFile } : {}),
            ...(this.deps.fileSize ? { fileSize: this.deps.fileSize } : {}),
          })
        : null;
    if (typeof inputs === "string") usageError(op, inputs, asJson);
    return withCloudAgentsContract(
      op,
      asJson,
      async () => {
        const session = await sessionFor(this.deps, project);
        const projectRef = requireCloudProject(op, session, asJson);
        const deployed = matchCloudAgent(await session.client.listAgents(projectRef), ref);
        const agent = agentArgument(ref, deployed);
        if (execute !== true) {
          contractDryRun(
            op,
            {
              agent,
              project: projectRef,
              deployed: deployed !== null,
              budgetUsd: budgetUsd ?? deployed?.config.budgetUsd ?? null,
              repositories: (repositories ?? []).map((entry) => entry.repo),
              promptChars: text.length,
              files: inputs?.summary ?? [],
              outcome: outcomeBody
                ? { rubricChars: outcomeBody.rubric.length, maxIterations: outcomeBody.maxIterations ?? 1 }
                : null,
              rows: rows ?? null,
              delivery: delivery
                ? { kind: delivery.kind, ...(delivery.sessionName ? { sessionName: delivery.sessionName } : {}) }
                : null,
              thread: threadPlan
                ? { channel: threadPlan.channel, threadKey: threadPlan.threadKey ?? "a new thread on the run card" }
                : null,
              effect: `start a paid cloud run of ${agent} with the organization's Anthropic key${deployed ? "" : " (deploys the latest Library version first)"}`,
            },
            { asJson },
          );
        }
        const person = threadPlan ? d.turnPerson() : null;
        const card = {
          runId: "",
          agentName: deployed?.name ?? agent,
          prompt: text,
          status: "starting",
          personName: person?.name ?? null,
        };
        let threadKey = threadPlan?.threadKey ?? null;
        let rootCard: string | null = null;
        if (threadPlan?.channel === "slack" && !threadKey) {
          try {
            const root = await openCloudThreadRoot(threadPlan, card, this.deps.threadDeps);
            threadKey = root.threadKey;
            rootCard = root.cardMessageId;
          } catch (error) {
            contractFail(
              op,
              "CLOUD_THREAD_CARD_FAILED",
              `Could not post the run card in this chat: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`,
              {
                asJson,
                details: { suggestedAction: "Start it without --bind-thread, or from inside a Slack thread." },
              },
            );
          }
        }
        let run: CloudRun;
        try {
          run = await session.client.startRun({
            project: projectRef,
            agent,
            prompt: text,
            trigger: d.inAgentRuntime() ? "agent" : "manual",
            ...(budgetUsd !== undefined ? { budgetUsd } : {}),
            ...(repositories ? { repositories } : {}),
            ...(key ? { idempotencyKey: key } : {}),
            ...(delivery ? { delivery } : {}),
            ...(threadKey ? { threadKey } : {}),
            ...(inputs ? { files: inputs.files } : {}),
            ...(outcomeBody ? { outcome: outcomeBody } : {}),
            ...(rows ? { rows } : {}),
          });
        } catch (error) {
          if (threadPlan?.channel === "slack" && rootCard) {
            await editCloudThreadRoot(
              threadPlan,
              rootCard,
              { ...card, status: "failed", summary: "A run não começou." },
              this.deps.threadDeps,
            ).catch(() => {});
          }
          throw error;
        }
        const thread =
          threadPlan && threadKey
            ? await bindCloudThread(
                {
                  plan: threadPlan,
                  threadKey,
                  cardMessageId: rootCard,
                  runId: run.id,
                  status: run.status,
                  agentName: run.agentName,
                  prompt: text,
                  sessionName: chat?.sessionName ?? null,
                  actorUserId: run.actor.id,
                  actorContactId: person?.contactId ?? null,
                  personName: person?.name ?? run.actor.name,
                },
                this.deps.threadDeps,
              )
            : null;
        const payload = {
          success: true as const,
          run,
          ...(thread
            ? { thread: { threadKey: thread.threadKey, channel: thread.channel, cardMessageId: thread.cardMessageId } }
            : {}),
        };
        if (asJson) {
          printJson(payload);
        } else {
          console.log(
            `✓ Started cloud run ${run.id} of ${run.agentName} (${run.status}), budget ${formatUsd(run.budgetUsd)}`,
          );
          if (delivery?.kind === "session")
            console.log(`  Reports back to this conversation (${delivery.sessionName}).`);
          if (thread) {
            console.log(
              `  Bound to this ${thread.channel === "slack" ? "Slack thread" : "WhatsApp group"}: ${thread.actorName ?? "the run's person"} talks to the run here${thread.channel === "whatsapp" ? " (start with @run or reply to the card)" : ""}.`,
            );
          }
          console.log(`  Follow: ravi cloud runs follow ${run.id}`);
          if (run.url) console.log(`  Console: ${run.url}`);
        }
        return payload;
      },
      { notFoundCode: "CLOUD_AGENT_NOT_FOUND" },
    );
  }

  @Command({ name: "list", description: "List cloud runs of a Console project" })
  @CommandAccess({ kind: "read", resource: "cloud.agents", action: "runs.list", risk: "low" })
  @Returns(
    z
      .object({
        success: z.literal(true),
        project: z.string(),
        runs: z.array(cloudRunReturnSchema),
        cursor: z.string().nullable(),
      })
      .strict(),
  )
  async list(
    @Option({ flags: "--agent <agent>", description: "Only this cloud agent" }) agent?: string,
    @Option({ flags: "--status <status>", description: "Only this status (running, waiting_approval, completed, ...)" })
    status?: string,
    @Option({ flags: "--cursor <cursor>", description: "Next page (the cursor of the previous page)" }) cursor?: string,
    @Option({ flags: "--limit <n>", description: "Page size (1-100, default 25)" }) limit?: string,
    @Option({ flags: "--project <project>", description: "Console project slug (default: the cwd's project)" })
    project?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "cloud runs list";
    let pageSize: number | undefined;
    if (limit !== undefined) {
      pageSize = Number(limit);
      if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
        usageError(op, "--limit must be an integer from 1 to 100.", asJson);
      }
    }
    return withCloudAgentsContract(op, asJson, async () => {
      const session = await sessionFor(this.deps, project);
      const projectRef = requireCloudProject(op, session, asJson);
      // The Console filters by cloud agent id: a slug or name is resolved here.
      const agentId = agent?.trim()
        ? (await requireDeployedAgent(op, session.client, projectRef, agent.trim(), asJson)).id
        : undefined;
      const page = await session.client.listRuns({
        project: projectRef,
        ...(agentId ? { agent: agentId } : {}),
        ...(pageSize !== undefined ? { limit: pageSize } : {}),
        ...(status?.trim() ? { status: status.trim() } : {}),
        ...(cursor?.trim() ? { cursor: cursor.trim() } : {}),
      });
      const payload = { success: true as const, project: projectRef, runs: page.runs, cursor: page.cursor };
      if (asJson) {
        printJson(payload);
      } else if (page.runs.length === 0) {
        console.log(`No cloud runs in ${projectRef}.`);
      } else {
        for (const run of page.runs) console.log(runLine(run));
        if (page.cursor) console.log(`\nMore: ravi cloud runs list --project ${projectRef} --cursor ${page.cursor}`);
      }
      return payload;
    });
  }

  @Command({ name: "show", description: "Show a cloud run: status, cost, approvals, outputs and result" })
  @CommandAccess({ kind: "read", resource: "cloud.agents", action: "runs.show", risk: "low" })
  @Returns(runPayloadSchema)
  async show(
    @Arg("run", { description: "Run id" }) runId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "cloud runs show";
    const id = requireText(op, "<run>", runId, asJson);
    return withCloudAgentsContract(
      op,
      asJson,
      async () => {
        const session = await sessionFor(this.deps, undefined, false);
        const run = await session.client.getRun(id);
        const payload = { success: true as const, run };
        if (asJson) printJson(payload);
        else printRun(run);
        return payload;
      },
      { notFoundCode: "CLOUD_RUN_NOT_FOUND" },
    );
  }

  @Command({ name: "follow", description: "Print a cloud run's events until it ends (--json: NDJSON)" })
  @CliOnly()
  @CommandAccess({ kind: "read", resource: "cloud.agents", action: "runs.follow", risk: "low" })
  async follow(
    @Arg("run", { description: "Run id" }) runId: string,
    @Option({ flags: "--interval <seconds>", description: "Seconds between polls (1-60, default 3)" })
    interval?: string,
    @Option({ flags: "--json", description: "Print one JSON event per line (NDJSON)" }) asJson?: boolean,
  ) {
    const op = "cloud runs follow";
    const d = defaultsOf(this.deps);
    const id = requireText(op, "<run>", runId, asJson);
    const seconds = interval === undefined ? 3 : Number(interval);
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 60) {
      usageError(op, "--interval must be a number of seconds from 1 to 60.", asJson);
    }
    return withCloudAgentsContract(
      op,
      asJson,
      async () => {
        const session = await sessionFor(this.deps, undefined, false);
        let cursor: string | null = null;
        let events = 0;
        let lastStatus: string | null = null;
        const printed = new Set<string>();
        const drain = async () => {
          const page = await session.client.listEvents(id, cursor);
          for (const event of page.events) {
            events += 1;
            console.log(asJson ? JSON.stringify(event) : eventLine(event));
          }
          cursor = page.cursor ?? cursor;
        };
        for (;;) {
          await drain();
          const run = await session.client.getRun(id);
          if (!asJson && run.status !== lastStatus) {
            console.log(`— ${run.status} (${formatUsd(run.costUsd)}, ${formatDuration(run.runningSeconds)})`);
          }
          lastStatus = run.status;
          if (!asJson) {
            for (const approval of run.approvals) {
              if (approval.status !== "pending" || printed.has(approval.id)) continue;
              printed.add(approval.id);
              console.log(
                `  Waiting for approval ${approval.id}: ${approval.server ? `${approval.server}/` : ""}${approval.tool}`,
              );
              console.log(`    Approve: ravi cloud runs approve ${run.id} ${approval.id} --execute`);
              console.log(`    Deny:    ravi cloud runs deny ${run.id} ${approval.id}`);
            }
            for (const question of run.questions ?? []) {
              if (question.status !== "pending" || printed.has(question.id)) continue;
              printed.add(question.id);
              printQuestion(run, question);
            }
          }
          if (isTerminalCloudRunStatus(run.status)) {
            await drain();
            if (asJson) {
              console.log(JSON.stringify({ type: "run", run }));
            } else if (run.result) {
              console.log(`\n${run.result}`);
            }
            return { success: true as const, runId: run.id, status: run.status, events };
          }
          await d.sleep(seconds * 1_000);
        }
      },
      { notFoundCode: "CLOUD_RUN_NOT_FOUND" },
    );
  }

  @Command({ name: "stop", description: "Stop a cloud run now (applies at once)" })
  @CommandAccess({ kind: "mutate", resource: "cloud.agents", action: "runs.stop", risk: "medium" })
  @Returns(runPayloadSchema)
  async stop(
    @Arg("run", { description: "Run id" }) runId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "cloud runs stop";
    const id = requireText(op, "<run>", runId, asJson);
    return withCloudAgentsContract(
      op,
      asJson,
      async () => {
        const session = await sessionFor(this.deps, undefined, false);
        const run = (await session.client.stopRun(id)) ?? (await session.client.getRun(id));
        const payload = { success: true as const, run };
        if (asJson) printJson(payload);
        else console.log(`✓ Stopped ${run.id} (${run.status}, ${formatUsd(run.costUsd)})`);
        return payload;
      },
      { notFoundCode: "CLOUD_RUN_NOT_FOUND" },
    );
  }

  @Command({ name: "reply", description: "Send a follow-up message to a cloud run. Requires --execute." })
  @CommandAccess({
    kind: "mutate",
    resource: "cloud.agents",
    action: "runs.reply",
    risk: "high",
    requiresConfirmation: true,
  })
  @Returns(runPayloadSchema)
  async reply(
    @Arg("run", { description: "Run id" }) runId: string,
    @Arg("text", { description: "The message" }) text: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--execute", description: "Send it (without it, print the plan and exit 3)" }) execute?: boolean,
  ) {
    const op = "cloud runs reply";
    const id = requireText(op, "<run>", runId, asJson);
    const message = requirePromptText(op, "<text>", text, asJson);
    return withCloudAgentsContract(
      op,
      asJson,
      async () => {
        const session = await sessionFor(this.deps, undefined, false);
        const current = await session.client.getRun(id);
        if (execute !== true) {
          contractDryRun(
            op,
            {
              run: current.id,
              status: current.status,
              costUsd: current.costUsd,
              budgetUsd: current.budgetUsd,
              textChars: message.length,
              effect: "the run continues with this message and spends more of its budget",
            },
            { asJson },
          );
        }
        const run = (await session.client.sendMessage(id, message)) ?? (await session.client.getRun(id));
        const payload = { success: true as const, run };
        if (asJson) printJson(payload);
        else console.log(`✓ Sent to ${run.id} (${run.status}). Follow: ravi cloud runs follow ${run.id}`);
        return payload;
      },
      { notFoundCode: "CLOUD_RUN_NOT_FOUND" },
    );
  }

  @Command({
    name: "approve",
    description: "Approve a write a cloud run is waiting on (only the run's person can). Requires --execute.",
  })
  @CommandAccess({
    kind: "mutate",
    resource: "cloud.agents",
    action: "runs.approve",
    risk: "high",
    requiresConfirmation: true,
  })
  @Returns(
    z.object({ success: z.literal(true), run: cloudRunReturnSchema, approval: cloudApprovalReturnSchema }).strict(),
  )
  async approve(
    @Arg("run", { description: "Run id" }) runId: string,
    @Arg("approval", { description: "Approval id (ravi cloud runs show <run>)" }) approvalId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--execute", description: "Approve (without it, print the plan and exit 3)" }) execute?: boolean,
  ) {
    const op = "cloud runs approve";
    const id = requireText(op, "<run>", runId, asJson);
    const approvalRef = requireText(op, "<approval>", approvalId, asJson);
    // Only the run's person approves: in a person's turn this call acts as them
    // (their `ravi link`), and the Console refuses anyone else.
    this.refuseUnattributedTurn(op, asJson);
    return withCloudAgentsContract(
      op,
      asJson,
      () => this.decide(op, id, approvalRef, "approve", undefined, execute === true, asJson),
      { notFoundCode: "CLOUD_RUN_NOT_FOUND" },
    );
  }

  @Command({ name: "deny", description: "Deny a write a cloud run is waiting on (applies at once)" })
  @CommandAccess({ kind: "mutate", resource: "cloud.agents", action: "runs.deny", risk: "low" })
  @Returns(
    z.object({ success: z.literal(true), run: cloudRunReturnSchema, approval: cloudApprovalReturnSchema }).strict(),
  )
  async deny(
    @Arg("run", { description: "Run id" }) runId: string,
    @Arg("approval", { description: "Approval id (ravi cloud runs show <run>)" }) approvalId: string,
    @Option({ flags: "--reason <text>", description: "Why (the agent reads it)" }) reason?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "cloud runs deny";
    const id = requireText(op, "<run>", runId, asJson);
    const approvalRef = requireText(op, "<approval>", approvalId, asJson);
    return withCloudAgentsContract(
      op,
      asJson,
      () => this.decide(op, id, approvalRef, "deny", reason?.trim() || undefined, true, asJson),
      { notFoundCode: "CLOUD_RUN_NOT_FOUND" },
    );
  }

  /**
   * A turn Ravi cannot attribute sends no person to the Console, so the call
   * would go out as the operator and decide the operator's runs. It stops here
   * instead (as Bases does), before any Console call.
   */
  private refuseUnattributedTurn(op: string, asJson?: boolean) {
    const refusal = normalizeTurnRefusal(defaultsOf(this.deps).unattributedTurn());
    if (!refusal) return;
    const copy = turnRefusalCopy(refusal.reason, "cloud-runs");
    contractFail(op, "ACTOR_UNKNOWN", copy.message, {
      asJson,
      exitCode: CONTRACT_EXIT_POLICY,
      details: {
        ...turnRefusalDetails(refusal.reason),
        suggestedAction:
          refusal.reason.kind === "unknown"
            ? "Ask the run's person to answer from their own chat or the Console, or the operator to run it in the terminal."
            : copy.suggestedAction,
      },
    });
  }

  private async decide(
    op: string,
    runId: string,
    approvalId: string,
    decision: "approve" | "deny",
    reason: string | undefined,
    execute: boolean,
    asJson?: boolean,
  ) {
    const session = await sessionFor(this.deps, undefined, false);
    const current = await session.client.getRun(runId);
    const approval = current.approvals.find((entry) => entry.id === approvalId);
    if (!approval) {
      contractFail(op, "CLOUD_APPROVAL_NOT_FOUND", `Run ${current.id} has no approval ${approvalId.slice(0, 80)}.`, {
        asJson,
        details: {
          suggestedAction: `Read the run's approvals with: ravi cloud runs show ${current.id} --json`,
          suggestions: suggestSimilar(
            approvalId,
            current.approvals.map((entry) => entry.id),
          ),
        },
      });
    }
    if (approval.status !== "pending") {
      contractFail(op, "CLOUD_APPROVAL_NOT_PENDING", `Approval ${approval.id} is already ${approval.status}.`, {
        asJson,
        exitCode: CONTRACT_EXIT_ERROR,
        details: { suggestedAction: `Read the run with: ravi cloud runs show ${current.id}` },
      });
    }
    if (!execute) {
      contractDryRun(
        op,
        {
          run: current.id,
          approval: approval.id,
          tool: approval.tool,
          server: approval.server,
          inputPreview: approval.inputPreview ? approval.inputPreview.slice(0, 200) : null,
          person: current.actor.name ?? current.actor.id,
          effect: `the cloud run performs this write as ${current.actor.name ?? "its person"}; only the run's person can approve it`,
        },
        { asJson },
      );
    }
    const decided = await session.client.decideApproval(current.id, approval.id, {
      decision,
      ...(reason ? { reason } : {}),
    });
    const run = decided.run ?? (await session.client.getRun(current.id));
    const after = decided.approval ??
      run.approvals.find((entry) => entry.id === approval.id) ?? {
        ...approval,
        status: decision === "approve" ? "approved" : "denied",
      };
    const payload = { success: true as const, run, approval: after };
    if (asJson) printJson(payload);
    else
      console.log(`✓ ${decision === "approve" ? "Approved" : "Denied"} ${approval.tool} on ${run.id} (${run.status})`);
    return payload;
  }

  @Command({
    name: "answer",
    description: "Answer a question a cloud run asked its person (only that person can). Requires --execute.",
  })
  @CommandAccess({
    kind: "mutate",
    resource: "cloud.agents",
    action: "runs.answer",
    risk: "high",
    requiresConfirmation: true,
  })
  @Returns(
    z.object({ success: z.literal(true), run: cloudRunReturnSchema, question: cloudQuestionReturnSchema }).strict(),
  )
  async answer(
    @Arg("run", { description: "Run id" }) runId: string,
    @Arg("question", { description: "Question id (ravi cloud runs show <run>)" }) questionId: string,
    @Arg("text", { description: "The answer, in the person's words" }) text: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--execute", description: "Send the answer (without it, print the plan and exit 3)" })
    execute?: boolean,
  ) {
    const op = "cloud runs answer";
    const id = requireText(op, "<run>", runId, asJson);
    const questionRef = requireText(op, "<question>", questionId, asJson);
    const answerText = requireText(op, "<text>", text, asJson);
    if (answerText.length > 4_000) usageError(op, "<text> takes at most 4000 characters.", asJson);
    this.refuseUnattributedTurn(op, asJson);
    return withCloudAgentsContract(
      op,
      asJson,
      async () => {
        const session = await sessionFor(this.deps, undefined, false);
        const current = await session.client.getRun(id);
        const questions = current.questions ?? [];
        const question = questions.find((entry) => entry.id === questionRef);
        if (!question) {
          contractFail(
            op,
            "CLOUD_QUESTION_NOT_FOUND",
            `Run ${current.id} has no question ${questionRef.slice(0, 80)}.`,
            {
              asJson,
              details: {
                suggestedAction: `Read the run's questions with: ravi cloud runs show ${current.id} --json`,
                suggestions: suggestSimilar(
                  questionRef,
                  questions.map((entry) => entry.id),
                ),
              },
            },
          );
        }
        if (question.status !== "pending") {
          contractFail(op, "CLOUD_QUESTION_NOT_PENDING", `Question ${question.id} is already ${question.status}.`, {
            asJson,
            exitCode: CONTRACT_EXIT_ERROR,
            details: { suggestedAction: `Read the run with: ravi cloud runs show ${current.id}` },
          });
        }
        if (execute !== true) {
          contractDryRun(
            op,
            {
              run: current.id,
              question: question.id,
              asked: question.question.slice(0, 200),
              answerChars: answerText.length,
              person: current.actor.name ?? current.actor.id,
              effect: `the run continues with this answer, as ${current.actor.name ?? "its person"}; only the run's person can answer`,
            },
            { asJson },
          );
        }
        const run =
          (await session.client.answerQuestion(current.id, question.id, answerText)) ??
          (await session.client.getRun(current.id));
        try {
          dbMarkCloudChatQuestionAnswered(question.id);
        } catch {
          // The local note only keeps a bound thread from answering it again.
        }
        const after = (run.questions ?? []).find((entry) => entry.id === question.id) ?? {
          ...question,
          status: "answered" as const,
          answer: answerText,
        };
        const payload = { success: true as const, run, question: after };
        if (asJson) printJson(payload);
        else console.log(`✓ Answered ${question.id} on ${run.id} (${run.status})`);
        return payload;
      },
      { notFoundCode: "CLOUD_RUN_NOT_FOUND" },
    );
  }

  @Command({ name: "outputs", description: "List a cloud run's output files, or download them with --download <dir>" })
  @CommandAccess({ kind: "mutate", resource: "cloud.agents", action: "runs.outputs", risk: "low" })
  @Returns(
    z
      .object({
        success: z.literal(true),
        runId: z.string(),
        outputs: z.array(z.object({ id: z.string(), name: z.string(), size: z.number() }).strict()),
        directory: z.string().nullable(),
        downloaded: z.array(
          z.object({ id: z.string(), name: z.string(), path: z.string(), bytes: z.number() }).strict(),
        ),
      })
      .strict(),
  )
  async outputs(
    @Arg("run", { description: "Run id" }) runId: string,
    @Option({ flags: "--download <dir>", description: "Write every output file into this folder" }) download?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "cloud runs outputs";
    const id = requireText(op, "<run>", runId, asJson);
    return withCloudAgentsContract(
      op,
      asJson,
      async () => {
        const session = await sessionFor(this.deps, undefined, false);
        const run = await session.client.getRun(id);
        const downloaded: Array<{ id: string; name: string; path: string; bytes: number }> = [];
        let directory: string | null = null;
        if (download?.trim()) {
          directory = resolve(download.trim());
          const folder = directory;
          const targets = run.outputs.map((output) => {
            let relative: string;
            try {
              relative = safeRelativePath(output.name);
            } catch {
              contractFail(op, "CLOUD_OUTPUT_NAME_CONFLICT", `Output ${output.id} has an unsafe file name.`, {
                asJson,
                details: { suggestedAction: `Download it in the Console: ravi cloud runs show ${run.id}` },
              });
            }
            return { output, relative, key: relative.toLowerCase(), path: join(folder, relative) };
          });
          // Two outputs on one path (also when only the case differs), or a file where another needs a folder.
          const clash = targets.find(
            (target, index) =>
              targets.findIndex((other) => other.key === target.key) !== index ||
              targets.some((other) => other.key.startsWith(`${target.key}/`)),
          );
          if (clash) {
            contractFail(
              op,
              "CLOUD_OUTPUT_NAME_CONFLICT",
              `Two outputs of run ${run.id} would be written to ${clash.relative.slice(0, 200)}.`,
              {
                asJson,
                details: { suggestedAction: `Download them one by one in the Console: ravi cloud runs show ${run.id}` },
              },
            );
          }
          const existing = targets.find((target) => existsSync(target.path));
          if (existing) {
            contractFail(op, "CLOUD_OUTPUT_EXISTS", `${existing.relative.slice(0, 200)} already exists in ${folder}.`, {
              asJson,
              details: { suggestedAction: "Download into an empty folder: --download <new-dir>" },
            });
          }
          for (const target of targets) {
            const file = await session.client.downloadOutput(run.id, target.output.id);
            try {
              mkdirSync(dirname(target.path), { recursive: true });
              // `wx`: never replace a file, also one that appeared since the check above.
              writeFileSync(target.path, file.bytes, { flag: "wx" });
            } catch (error) {
              const code = (error as NodeJS.ErrnoException).code;
              if (code !== "EEXIST" && code !== "ENOTDIR" && code !== "EISDIR") throw error;
              contractFail(
                op,
                "CLOUD_OUTPUT_EXISTS",
                `${target.relative.slice(0, 200)} cannot be written in ${folder}: something is already there.`,
                {
                  asJson,
                  details: {
                    suggestedAction: "Download into an empty folder: --download <new-dir>",
                    written: downloaded.map((entry) => entry.path),
                  },
                },
              );
            }
            downloaded.push({
              id: target.output.id,
              name: target.output.name,
              path: target.path,
              bytes: file.bytes.byteLength,
            });
          }
        }
        const payload = { success: true as const, runId: run.id, outputs: run.outputs, directory, downloaded };
        if (asJson) {
          printJson(payload);
        } else if (run.outputs.length === 0) {
          console.log(`Run ${run.id} has no output files.`);
        } else if (directory) {
          for (const file of downloaded) console.log(`✓ ${file.path} (${file.bytes} bytes)`);
        } else {
          for (const output of run.outputs) console.log(`  ${output.name} (${output.size} bytes)  id ${output.id}`);
          console.log(`\nDownload: ravi cloud runs outputs ${run.id} --download <dir>`);
        }
        return payload;
      },
      { notFoundCode: "CLOUD_RUN_NOT_FOUND" },
    );
  }
}

// ---------------------------------------------------------------------------
// ravi cloud schedules

const SCHEDULES_HELP_AFTER = `
Schedules start cloud runs on a cron, as the person who scheduled them, with
the schedule's prompt (default: the agent's HEARTBEAT.md) and budget. Added or
updated from an agent's session, each run reports back to that conversation
(its result with the cost, approvals and questions); --no-deliver keeps the
results in the Console only.

BRAKE
  add and update are braked (exit 3 without --execute) when the schedule ends
  up enabled: each tick spends money. Adding with --disabled, disabling with
  --disable and remove apply at once.

EXAMPLES
  ravi cloud schedules add triage --cron "0 9 * * 1-5" --timezone America/Sao_Paulo --project clinica --execute
  ravi cloud schedules update <id> --disable
  ravi cloud schedules update <id> --enable --execute
  ravi cloud schedules remove <id>
`;

const schedulePayloadSchema = z.object({ success: z.literal(true), schedule: cloudScheduleReturnSchema }).strict();

@Group({
  name: "cloud.schedules",
  description: "Schedules that start cloud runs on a cron",
  scope: "open",
})
export class CloudSchedulesCommands {
  constructor(private readonly deps: CloudAgentsCommandDeps = {}) {}

  @Command({ name: "list", description: "List the cloud schedules of a Console project" })
  @CommandAccess({ kind: "read", resource: "cloud.agents", action: "schedules.list", risk: "low" })
  @Returns(
    z
      .object({
        success: z.literal(true),
        project: z.string(),
        schedules: z.array(cloudScheduleReturnSchema),
        pagination: cloudPaginationReturnSchema,
      })
      .strict(),
  )
  async list(
    @Option({ flags: "--project <project>", description: "Console project slug (default: the cwd's project)" })
    project?: string,
    @Option({ flags: "--limit <n>", description: "Page size (1-200, default 50)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Skip this many (default 0)" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "cloud schedules list";
    return withCloudAgentsContract(op, asJson, async () => {
      const session = await sessionFor(this.deps, project);
      const projectRef = requireCloudProject(op, session, asJson);
      const page = pageCloudList(
        op,
        await session.client.listSchedules(projectRef),
        { limit, offset, command: `ravi cloud schedules list --project ${projectRef}` },
        asJson,
      );
      const schedules = page.items;
      const payload = { success: true as const, project: projectRef, schedules, pagination: page.pagination };
      if (asJson) {
        printJson(payload);
      } else if (schedules.length === 0) {
        console.log(`No cloud schedules in ${projectRef}.`);
      } else {
        for (const schedule of schedules) console.log(scheduleLine(schedule));
      }
      return payload;
    });
  }

  @Command({
    name: "add",
    description: "Schedule cloud runs of an agent on a cron. Requires --execute unless --disabled.",
    helpAfter: SCHEDULES_HELP_AFTER,
  })
  @CommandAccess({
    kind: "mutate",
    resource: "cloud.agents",
    action: "schedules.add",
    risk: "high",
    requiresConfirmation: true,
  })
  @Returns(schedulePayloadSchema)
  async add(
    @Arg("agent", { description: "Library agent slug, or a cloud agent id or name" }) agentRef: string,
    @Option({ flags: "--cron <expr>", description: 'Five cron fields, such as "0 9 * * 1-5"' }) cron?: string,
    @Option({ flags: "--timezone <tz>", description: "IANA time zone (default: this machine's)" }) timezone?: string,
    @Option({ flags: "--prompt <text>", description: "What each run does (default: the agent's HEARTBEAT.md)" })
    prompt?: string,
    @Option({ flags: "--budget <usd>", description: "Budget per run in US dollars (default: the agent's)" })
    budget?: string,
    @Option({ flags: "--disabled", description: "Create it disabled (applies at once)" }) disabled?: boolean,
    @Option({ flags: "--project <project>", description: "Console project slug (default: the cwd's project)" })
    project?: string,
    @Option({ flags: "--no-deliver", description: "Do not bring each run's result back to this conversation" })
    noDeliver?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--execute", description: "Create an enabled schedule (without it, print the plan and exit 3)" })
    execute?: boolean,
  ) {
    const op = "cloud schedules add";
    const d = defaultsOf(this.deps);
    const delivery = deliveryFor(d.chatContext(), noDeliver);
    const ref = requireText(op, "<agent>", agentRef, asJson);
    const cronExpr = requireText(op, "--cron", cron, asJson);
    if (!isCloudCron(cronExpr)) usageError(op, "--cron must have five fields (minute hour day month weekday).", asJson);
    const tz = timezone?.trim() || d.localTimezone();
    if (!isCloudTimezone(tz)) usageError(op, "--timezone must be an IANA time zone such as America/Sao_Paulo.", asJson);
    const promptText = prompt === undefined ? null : requirePromptText(op, "--prompt", prompt, asJson);
    const budgetUsd = parseCloudBudget(op, budget, asJson);
    const enabled = disabled !== true;
    return withCloudAgentsContract(
      op,
      asJson,
      async () => {
        const session = await sessionFor(this.deps, project);
        const projectRef = requireCloudProject(op, session, asJson);
        const deployed = matchCloudAgent(await session.client.listAgents(projectRef), ref);
        const agent = agentArgument(ref, deployed);
        if (enabled && execute !== true) {
          contractDryRun(
            op,
            {
              agent,
              project: projectRef,
              cron: cronExpr,
              timezone: tz,
              budgetUsd: budgetUsd ?? deployed?.config.budgetUsd ?? null,
              promptSource: promptText === null ? "HEARTBEAT.md" : "custom",
              promptChars: promptText?.length ?? null,
              enabled,
              delivery: delivery
                ? { kind: delivery.kind, ...(delivery.sessionName ? { sessionName: delivery.sessionName } : {}) }
                : null,
              effect: "start a paid cloud run on every tick, as you",
            },
            { asJson },
          );
        }
        const schedule = await session.client.createSchedule({
          project: projectRef,
          agent,
          cron: cronExpr,
          timezone: tz,
          enabled,
          ...(promptText !== null ? { prompt: promptText } : {}),
          ...(budgetUsd !== undefined ? { budgetUsd } : {}),
          ...(delivery ? { delivery } : {}),
        });
        const payload = { success: true as const, schedule };
        if (asJson) printJson(payload);
        else
          console.log(
            `✓ Scheduled ${schedule.agentName}: ${schedule.cron} (${schedule.timezone}) ${schedule.enabled ? "enabled" : "disabled"}, id ${schedule.id}`,
          );
        return payload;
      },
      { notFoundCode: "CLOUD_AGENT_NOT_FOUND" },
    );
  }

  @Command({
    name: "update",
    description: "Change a cloud schedule. Requires --execute when it stays or becomes enabled.",
    helpAfter: SCHEDULES_HELP_AFTER,
  })
  @CommandAccess({
    kind: "mutate",
    resource: "cloud.agents",
    action: "schedules.update",
    risk: "high",
    requiresConfirmation: true,
  })
  @Returns(schedulePayloadSchema)
  async update(
    @Arg("id", { description: "Schedule id" }) scheduleId: string,
    @Option({ flags: "--cron <expr>", description: "Five cron fields" }) cron?: string,
    @Option({ flags: "--timezone <tz>", description: "IANA time zone" }) timezone?: string,
    @Option({ flags: "--prompt <text>", description: "What each run does" }) prompt?: string,
    @Option({ flags: "--heartbeat", description: "Use the agent's HEARTBEAT.md as the prompt again" })
    heartbeat?: boolean,
    @Option({ flags: "--budget <usd>", description: "Budget per run in US dollars" }) budget?: string,
    @Option({ flags: "--enable", description: "Enable it" }) enable?: boolean,
    @Option({ flags: "--disable", description: "Disable it (applies at once)" }) disable?: boolean,
    @Option({ flags: "--project <project>", description: "Console project slug (default: the cwd's project)" })
    project?: string,
    @Option({ flags: "--no-deliver", description: "Stop bringing each run's result back to a conversation" })
    noDeliver?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Apply a change that leaves the schedule enabled (without it, print the plan and exit 3)",
    })
    execute?: boolean,
  ) {
    const op = "cloud schedules update";
    const d = defaultsOf(this.deps);
    const id = requireText(op, "<id>", scheduleId, asJson);
    if (enable && disable) usageError(op, "Pass --enable or --disable, not both.", asJson);
    if (prompt !== undefined && heartbeat) usageError(op, "Pass --prompt or --heartbeat, not both.", asJson);
    const body: {
      cron?: string;
      timezone?: string;
      prompt?: string | null;
      budgetUsd?: number;
      enabled?: boolean;
      delivery?: CloudDeliveryBody;
    } = {};
    if (cron !== undefined) {
      if (!isCloudCron(cron)) usageError(op, "--cron must have five fields (minute hour day month weekday).", asJson);
      body.cron = cron.trim();
    }
    if (timezone !== undefined) {
      if (!isCloudTimezone(timezone.trim())) usageError(op, "--timezone must be an IANA time zone.", asJson);
      body.timezone = timezone.trim();
    }
    if (prompt !== undefined) body.prompt = requirePromptText(op, "--prompt", prompt, asJson);
    if (heartbeat) body.prompt = null;
    const budgetUsd = parseCloudBudget(op, budget, asJson);
    if (budgetUsd !== undefined) body.budgetUsd = budgetUsd;
    if (enable) body.enabled = true;
    if (disable) body.enabled = false;
    if (noDeliver) body.delivery = { kind: "none" };
    if (Object.keys(body).length === 0) {
      usageError(
        op,
        "Nothing to change.",
        asJson,
        "Pass --cron, --timezone, --prompt, --heartbeat, --budget, --enable, --disable or --no-deliver",
      );
    }
    // A change made from an agent's session also points the runs' results at it.
    const sessionDelivery = noDeliver ? undefined : deliveryFor(d.chatContext(), false);
    if (sessionDelivery) body.delivery = sessionDelivery;
    return withCloudAgentsContract(
      op,
      asJson,
      async () => {
        const session = await sessionFor(this.deps, project);
        const projectRef = requireCloudProject(op, session, asJson);
        const current = (await session.client.listSchedules(projectRef)).find((schedule) => schedule.id === id);
        if (!current) {
          contractFail(op, "CLOUD_SCHEDULE_NOT_FOUND", `No cloud schedule ${id.slice(0, 80)} in ${projectRef}.`, {
            asJson,
            details: { suggestedAction: `List them with: ravi cloud schedules list --project ${projectRef}` },
          });
        }
        const enabledAfter = body.enabled ?? current.enabled;
        if (enabledAfter && execute !== true) {
          contractDryRun(
            op,
            {
              schedule: current.id,
              agent: current.agentName,
              project: projectRef,
              changes: Object.keys(body),
              cron: body.cron ?? current.cron,
              timezone: body.timezone ?? current.timezone,
              budgetUsd: body.budgetUsd ?? current.budgetUsd,
              enabled: enabledAfter,
              delivery: body.delivery
                ? {
                    kind: body.delivery.kind,
                    ...(body.delivery.sessionName ? { sessionName: body.delivery.sessionName } : {}),
                  }
                : null,
              effect: "the schedule keeps starting paid cloud runs, as you",
            },
            { asJson },
          );
        }
        const schedule = await session.client.updateSchedule(current.id, body);
        const payload = { success: true as const, schedule };
        if (asJson) printJson(payload);
        else
          console.log(
            `✓ Updated ${schedule.id}: ${schedule.cron} (${schedule.timezone}) ${schedule.enabled ? "enabled" : "disabled"}`,
          );
        return payload;
      },
      { notFoundCode: "CLOUD_SCHEDULE_NOT_FOUND" },
    );
  }

  @Command({ name: "remove", description: "Delete a cloud schedule (applies at once)" })
  @CommandAccess({ kind: "mutate", resource: "cloud.agents", action: "schedules.remove", risk: "medium" })
  @Returns(z.object({ success: z.literal(true), id: z.string(), removed: z.literal(true) }).strict())
  async remove(
    @Arg("id", { description: "Schedule id" }) scheduleId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "cloud schedules remove";
    const id = requireText(op, "<id>", scheduleId, asJson);
    return withCloudAgentsContract(
      op,
      asJson,
      async () => {
        const session = await sessionFor(this.deps, undefined, false);
        await session.client.deleteSchedule(id);
        const payload = { success: true as const, id, removed: true as const };
        if (asJson) printJson(payload);
        else console.log(`✓ Removed schedule ${id}`);
        return payload;
      },
      { notFoundCode: "CLOUD_SCHEDULE_NOT_FOUND" },
    );
  }
}
