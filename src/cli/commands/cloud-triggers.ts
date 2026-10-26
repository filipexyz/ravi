/**
 * `ravi cloud triggers list|create|update|remove|test`: Console events (Bases
 * rows and approvals, inbound mail, meetings, page comments) that become cloud
 * runs. The Console owns the router: it batches events, quotes them as
 * untrusted data in the prompt, drops events the trigger's own agent wrote and
 * applies the daily, organization and monthly caps. A trigger runs as the
 * person who created it.
 *
 * spec: cloud/agents, cli
 */

import "reflect-metadata";
import { z } from "zod";

import {
  type CloudTriggerBody,
  createCloudTrigger,
  listCloudTriggers,
  removeCloudTrigger,
  testCloudTrigger,
  updateCloudTrigger,
} from "../../cloud-agents/client-product.js";
import { CLOUD_TRIGGER_SOURCES, type CloudTrigger, type CloudTriggerSource } from "../../cloud-agents/types.js";
import { contractDryRun, contractFail } from "../agent-contract.js";
import {
  cloudPaginationReturnSchema,
  formatUsd,
  pageCloudList,
  requireCloudProject,
  requirePromptText,
  usageError,
  withCloudAgentsContract,
} from "../cloud-agents-contract.js";
import {
  agentSlugArgument,
  type CloudProductCommandDeps,
  cloudTriggerReturnSchema,
  cloudTriggerTestReturnSchema,
  listFlag,
  parseIntegerFlag,
  parseUsd,
  printJson,
  productDefaults,
  productSession,
  requireArg,
} from "../cloud-product-contract.js";
import { matchCloudAgent } from "./cloud-agents.js";
import { Arg, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";

const TRIGGERS_HELP_AFTER = `
Triggers turn Console events into cloud runs, as the person who created the
trigger: Bases rows, approvals and agent columns (--source bases), inbound mail
(mail), meetings ended or transcribed (meetings) and page comments
(pages_comments). The Console waits --batch-window seconds and starts one run
with up to 25 events, quoted as untrusted data where the prompt says {{event}}.
Rows the trigger's own agent wrote never fire it.

BRAKE
  create and update are braked (exit 3 without --execute) when the trigger ends
  up enabled: each batch of events starts a paid run later. Creating with
  --disabled, disabling with --disable, remove and test apply at once.

RESULT
  Each run's result goes to --deliver-to (a session name, or none). Inside an
  agent's turn the default is that turn's session; from a terminal, none.

EXAMPLES
  ravi cloud triggers create triage --source bases --base pedidos --events row.created --prompt "Triage this request: {{event}}" --project clinica --execute
  ravi cloud triggers test <id>
  ravi cloud triggers update <id> --disable
  ravi cloud triggers update <id> --enable --execute
`;

const triggerPayloadSchema = z.object({ success: z.literal(true), trigger: cloudTriggerReturnSchema }).strict();

function triggerLine(trigger: CloudTrigger): string {
  const filter = Object.entries(trigger.filter)
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(",") : value}`)
    .join(" ");
  const paused = trigger.pausedReason ? `  paused: ${trigger.pausedReason}` : "";
  const budget = trigger.budgetUsd === null ? "agent's" : formatUsd(trigger.budgetUsd);
  return `  ${trigger.id}  ${trigger.enabled ? "on " : "off"} ${trigger.agentName.padEnd(20)} ${trigger.source.padEnd(14)} ${filter || "-"}  today ${trigger.firedToday}/${trigger.dailyCap}  pending ${trigger.pendingEvents}  budget ${budget}${paused}`;
}

function parseSource(op: string, value: string | undefined, asJson?: boolean): CloudTriggerSource {
  const source = value?.trim() ?? "";
  if (!(CLOUD_TRIGGER_SOURCES as readonly string[]).includes(source)) {
    usageError(op, `--source must be one of ${CLOUD_TRIGGER_SOURCES.join(", ")}.`, asJson);
  }
  return source as CloudTriggerSource;
}

const TRIGGER_PROMPT_MAX_CHARS = 20_000;

/** A trigger prompt is a template: it must say where the events go. */
function parseTemplate(op: string, value: string | undefined, asJson?: boolean): string {
  const prompt = requirePromptText(op, "--prompt", value, asJson);
  if (prompt.length > TRIGGER_PROMPT_MAX_CHARS) {
    usageError(op, `--prompt is at most ${TRIGGER_PROMPT_MAX_CHARS} characters.`, asJson);
  }
  if (!prompt.includes("{{event}}")) {
    usageError(op, "--prompt must contain {{event}}: that is where the quoted events go.", asJson);
  }
  return prompt;
}

function parseDelivery(
  value: string | undefined,
  currentSession: string | null,
): CloudTriggerBody["delivery"] | undefined {
  const raw = value?.trim();
  if (raw === undefined || raw === "") {
    return currentSession ? { kind: "session", sessionName: currentSession } : undefined;
  }
  return raw.toLowerCase() === "none" ? { kind: "none" } : { kind: "session", sessionName: raw };
}

@Group({
  name: "cloud.triggers",
  description: "Console events (Bases, mail, meetings, page comments) that start cloud runs",
  scope: "open",
})
export class CloudTriggersCommands {
  constructor(private readonly deps: CloudProductCommandDeps = {}) {}

  @Command({ name: "list", description: "List the cloud triggers of a Console project" })
  @CommandAccess({ kind: "read", resource: "cloud.agents", action: "triggers.list", risk: "low" })
  @Returns(
    z
      .object({
        success: z.literal(true),
        project: z.string(),
        triggers: z.array(cloudTriggerReturnSchema),
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
    const op = "cloud triggers list";
    return withCloudAgentsContract(op, asJson, async () => {
      const session = await productSession(this.deps, project);
      const projectRef = requireCloudProject(op, session, asJson);
      const page = pageCloudList(
        op,
        await listCloudTriggers(session.client, projectRef),
        { limit, offset, command: `ravi cloud triggers list --project ${projectRef}` },
        asJson,
      );
      const triggers = page.items;
      const payload = { success: true as const, project: projectRef, triggers, pagination: page.pagination };
      if (asJson) printJson(payload);
      else if (triggers.length === 0) console.log(`No cloud triggers in ${projectRef}.`);
      else for (const trigger of triggers) console.log(triggerLine(trigger));
      return payload;
    });
  }

  @Command({
    name: "create",
    description: "Start cloud runs of an agent from Console events. Requires --execute unless --disabled.",
    helpAfter: TRIGGERS_HELP_AFTER,
  })
  @CommandAccess({
    kind: "mutate",
    resource: "cloud.agents",
    action: "triggers.create",
    risk: "high",
    requiresConfirmation: true,
  })
  @Returns(triggerPayloadSchema)
  async create(
    @Arg("agent", { description: "Library agent slug, or a cloud agent id or name" }) agentRef: string,
    @Option({ flags: "--source <source>", description: "bases, mail, meetings or pages_comments" }) source?: string,
    @Option({ flags: "--prompt <template>", description: "What each run does; {{event}} is where the events go" })
    prompt?: string,
    @Option({ flags: "--base <id>", description: "Bases: only this base" }) base?: string,
    @Option({ flags: "--view <id>", description: "Bases: only rows of this view" }) view?: string,
    @Option({ flags: "--events <event...>", description: "Only these event types (comma-separated or repeated)" })
    events?: string[],
    @Option({ flags: "--mailbox <id>", description: "Mail: only this mailbox" }) mailbox?: string,
    @Option({ flags: "--site <id>", description: "Page comments: only this site" }) site?: string,
    @Option({ flags: "--daily-cap <n>", description: "Runs per day at most (1-200, default 20)" }) dailyCap?: string,
    @Option({ flags: "--batch-window <seconds>", description: "Wait this long to batch events (0-3600, default 60)" })
    batchWindow?: string,
    @Option({ flags: "--dedupe-window <seconds>", description: "Drop repeats of an event within (default 600)" })
    dedupeWindow?: string,
    @Option({ flags: "--budget <usd>", description: "Budget per run in US dollars (default: the agent's)" })
    budget?: string,
    @Option({ flags: "--deliver-to <session>", description: "Session that gets each result, or none" })
    deliverTo?: string,
    @Option({ flags: "--disabled", description: "Create it disabled (applies at once)" }) disabled?: boolean,
    @Option({ flags: "--project <project>", description: "Console project slug (default: the cwd's project)" })
    project?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--execute", description: "Create an enabled trigger (without it, print the plan and exit 3)" })
    execute?: boolean,
  ) {
    const op = "cloud triggers create";
    const d = productDefaults(this.deps);
    const ref = requireArg(op, "<agent>", agentRef, asJson);
    const sourceValue = parseSource(op, source, asJson);
    const template = parseTemplate(op, prompt, asJson);
    const filter = {
      ...(base?.trim() ? { baseId: base.trim() } : {}),
      ...(view?.trim() ? { viewId: view.trim() } : {}),
      ...(listFlag(events)?.length ? { events: listFlag(events) } : {}),
      ...(mailbox?.trim() ? { mailboxId: mailbox.trim() } : {}),
      ...(site?.trim() ? { siteId: site.trim() } : {}),
    };
    const caps = {
      dailyCap: parseIntegerFlag(op, "--daily-cap", dailyCap, { min: 1, max: 200, asJson }),
      batchWindowSeconds: parseIntegerFlag(op, "--batch-window", batchWindow, { min: 0, max: 3600, asJson }),
      dedupeWindowSeconds: parseIntegerFlag(op, "--dedupe-window", dedupeWindow, { min: 0, max: 86_400, asJson }),
    };
    const budgetUsd = parseUsd(op, "--budget", budget, { min: 0.5, max: 200, asJson });
    const delivery = parseDelivery(deliverTo, d.currentSessionName());
    const enabled = disabled !== true;
    return withCloudAgentsContract(
      op,
      asJson,
      async () => {
        const session = await productSession(this.deps, project);
        const projectRef = requireCloudProject(op, session, asJson);
        const deployed = matchCloudAgent(await session.client.listAgents(projectRef), ref);
        const agent = agentSlugArgument(ref, deployed);
        if (enabled && execute !== true) {
          contractDryRun(
            op,
            {
              agent,
              project: projectRef,
              source: sourceValue,
              filter,
              promptChars: template.length,
              dailyCap: caps.dailyCap ?? 20,
              batchWindowSeconds: caps.batchWindowSeconds ?? 60,
              budgetUsd: budgetUsd ?? deployed?.config.budgetUsd ?? null,
              delivery: delivery ?? null,
              enabled,
              effect: "each batch of matching events starts a paid cloud run later, as you",
            },
            { asJson },
          );
        }
        const trigger = await createCloudTrigger(session.client, {
          project: projectRef,
          agent,
          source: sourceValue,
          filter,
          prompt: template,
          enabled,
          ...Object.fromEntries(Object.entries(caps).filter(([, value]) => value !== undefined)),
          ...(budgetUsd !== undefined ? { budgetUsd } : {}),
          ...(delivery !== undefined ? { delivery } : {}),
        });
        const payload = { success: true as const, trigger };
        if (asJson) printJson(payload);
        else
          console.log(
            `✓ Trigger ${trigger.id}: ${trigger.source} → ${trigger.agentName} ${trigger.enabled ? "enabled" : "disabled"}. Try it: ravi cloud triggers test ${trigger.id}`,
          );
        return payload;
      },
      { notFoundCode: "CLOUD_AGENT_NOT_FOUND" },
    );
  }

  @Command({
    name: "update",
    description: "Change a cloud trigger. Requires --execute when it stays or becomes enabled.",
    helpAfter: TRIGGERS_HELP_AFTER,
  })
  @CommandAccess({
    kind: "mutate",
    resource: "cloud.agents",
    action: "triggers.update",
    risk: "high",
    requiresConfirmation: true,
  })
  @Returns(triggerPayloadSchema)
  async update(
    @Arg("id", { description: "Trigger id" }) triggerId: string,
    @Option({ flags: "--prompt <template>", description: "What each run does; {{event}} is where the events go" })
    prompt?: string,
    @Option({ flags: "--events <event...>", description: "Only these event types" }) events?: string[],
    @Option({ flags: "--daily-cap <n>", description: "Runs per day at most (1-200)" }) dailyCap?: string,
    @Option({ flags: "--batch-window <seconds>", description: "Wait this long to batch events (0-3600)" })
    batchWindow?: string,
    @Option({ flags: "--dedupe-window <seconds>", description: "Drop repeats of an event within" })
    dedupeWindow?: string,
    @Option({ flags: "--budget <usd>", description: "Budget per run in US dollars, or none for the agent's" })
    budget?: string,
    @Option({ flags: "--deliver-to <session>", description: "Session that gets each result, or none" })
    deliverTo?: string,
    @Option({ flags: "--enable", description: "Enable it" }) enable?: boolean,
    @Option({ flags: "--disable", description: "Disable it (applies at once)" }) disable?: boolean,
    @Option({ flags: "--project <project>", description: "Console project slug (default: the cwd's project)" })
    project?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Apply a change that leaves the trigger enabled (without it, print the plan and exit 3)",
    })
    execute?: boolean,
  ) {
    const op = "cloud triggers update";
    const id = requireArg(op, "<id>", triggerId, asJson);
    if (enable && disable) usageError(op, "Pass --enable or --disable, not both.", asJson);
    const body: CloudTriggerBody = {};
    if (prompt !== undefined) body.prompt = parseTemplate(op, prompt, asJson);
    const eventList = listFlag(events);
    if (eventList !== undefined) body.filter = { events: eventList };
    const daily = parseIntegerFlag(op, "--daily-cap", dailyCap, { min: 1, max: 200, asJson });
    if (daily !== undefined) body.dailyCap = daily;
    const batch = parseIntegerFlag(op, "--batch-window", batchWindow, { min: 0, max: 3600, asJson });
    if (batch !== undefined) body.batchWindowSeconds = batch;
    const dedupe = parseIntegerFlag(op, "--dedupe-window", dedupeWindow, { min: 0, max: 86_400, asJson });
    if (dedupe !== undefined) body.dedupeWindowSeconds = dedupe;
    const budgetUsd = parseUsd(op, "--budget", budget, { min: 0.5, max: 200, allowNone: true, asJson });
    if (budgetUsd !== undefined) body.budgetUsd = budgetUsd;
    if (deliverTo !== undefined) body.delivery = parseDelivery(deliverTo, null) ?? { kind: "none" };
    if (enable) body.enabled = true;
    if (disable) body.enabled = false;
    if (Object.keys(body).length === 0) {
      usageError(
        op,
        "Nothing to change.",
        asJson,
        "Pass --prompt, --events, --daily-cap, --batch-window, --dedupe-window, --budget, --deliver-to, --enable or --disable",
      );
    }
    return withCloudAgentsContract(
      op,
      asJson,
      async () => {
        const session = await productSession(this.deps, project);
        const projectRef = requireCloudProject(op, session, asJson);
        const current = (await listCloudTriggers(session.client, projectRef)).find((trigger) => trigger.id === id);
        if (!current) {
          contractFail(op, "CLOUD_TRIGGER_NOT_FOUND", `No cloud trigger ${id.slice(0, 80)} in ${projectRef}.`, {
            asJson,
            details: { suggestedAction: `List them with: ravi cloud triggers list --project ${projectRef}` },
          });
        }
        if (body.filter) body.filter = { ...current.filter, ...body.filter };
        const enabledAfter = body.enabled ?? current.enabled;
        if (enabledAfter && execute !== true) {
          contractDryRun(
            op,
            {
              trigger: current.id,
              agent: current.agentName,
              project: projectRef,
              source: current.source,
              changes: Object.keys(body),
              dailyCap: body.dailyCap ?? current.dailyCap,
              budgetUsd: body.budgetUsd === undefined ? current.budgetUsd : body.budgetUsd,
              enabled: enabledAfter,
              effect: "the trigger keeps starting paid cloud runs from events, as its creator",
            },
            { asJson },
          );
        }
        const trigger = await updateCloudTrigger(session.client, current.id, body);
        const payload = { success: true as const, trigger };
        if (asJson) printJson(payload);
        else console.log(`✓ Updated trigger ${trigger.id} (${trigger.enabled ? "enabled" : "disabled"})`);
        return payload;
      },
      { notFoundCode: "CLOUD_TRIGGER_NOT_FOUND" },
    );
  }

  @Command({ name: "remove", description: "Delete a cloud trigger (applies at once)" })
  @CommandAccess({ kind: "mutate", resource: "cloud.agents", action: "triggers.remove", risk: "medium" })
  @Returns(z.object({ success: z.literal(true), id: z.string(), removed: z.literal(true) }).strict())
  async remove(
    @Arg("id", { description: "Trigger id" }) triggerId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "cloud triggers remove";
    const id = requireArg(op, "<id>", triggerId, asJson);
    return withCloudAgentsContract(
      op,
      asJson,
      async () => {
        const session = await productSession(this.deps, undefined, false);
        await removeCloudTrigger(session.client, id);
        const payload = { success: true as const, id, removed: true as const };
        if (asJson) printJson(payload);
        else console.log(`✓ Removed trigger ${id}`);
        return payload;
      },
      { notFoundCode: "CLOUD_TRIGGER_NOT_FOUND" },
    );
  }

  @Command({ name: "test", description: "Show the prompt a trigger would send now (no run starts)" })
  @CommandAccess({ kind: "read", resource: "cloud.agents", action: "triggers.test", risk: "low" })
  @Returns(z.object({ success: z.literal(true), id: z.string(), test: cloudTriggerTestReturnSchema }).strict())
  async test(
    @Arg("id", { description: "Trigger id" }) triggerId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "cloud triggers test";
    const id = requireArg(op, "<id>", triggerId, asJson);
    return withCloudAgentsContract(
      op,
      asJson,
      async () => {
        const session = await productSession(this.deps, undefined, false);
        const test = await testCloudTrigger(session.client, id);
        const payload = { success: true as const, id, test };
        if (asJson) {
          printJson(payload);
        } else {
          const events = test.sample
            ? "no pending event, prompt built from a sample event"
            : `${test.eventCount} pending event(s)`;
          console.log(
            `Trigger ${id}: ${events}${test.blockedBy ? `, would not run now: ${test.blockedBy}` : ""}. No run was started.`,
          );
          if (test.prompt) console.log(`\n${test.prompt}`);
        }
        return payload;
      },
      { notFoundCode: "CLOUD_TRIGGER_NOT_FOUND" },
    );
  }
}
