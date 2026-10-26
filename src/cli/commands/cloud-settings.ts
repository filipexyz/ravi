/**
 * `ravi cloud settings show|set`: the organization's cloud agents settings —
 * billing mode (the organization's own key, or Ravi credits), the monthly cap
 * that pauses runs, and the daily cap of runs started by event triggers.
 * Owners and admins change them; the Console enforces it.
 *
 * spec: cloud/agents, cli
 */

import "reflect-metadata";
import { z } from "zod";

import { getCloudSettings, updateCloudSettings } from "../../cloud-agents/client-product.js";
import type { CloudOrgSettings, CloudOrgSettingsBody } from "../../cloud-agents/types.js";
import { contractDryRun } from "../agent-contract.js";
import { formatUsd, usageError, withCloudAgentsContract } from "../cloud-agents-contract.js";
import {
  type CloudProductCommandDeps,
  cloudSettingsReturnSchema,
  parseIntegerFlag,
  parseUsd,
  printJson,
  productSession,
  refuseInAgentRuntime,
} from "../cloud-product-contract.js";
import { Command, CommandAccess, Group, Option, Returns } from "../decorators.js";

const SETTINGS_SET_HELP_AFTER = `
BRAKE
  A change that can raise spending is braked (exit 3 without --execute):
  switching the billing mode (it changes who pays and redeploys the agents),
  raising or removing the monthly cap, raising the daily event-run cap.
  Lowering a cap applies at once.

  The monthly cap counts the cost of runs started this calendar month (UTC).
  When it is crossed, runs pause until the 1st or until an admin raises it;
  running runs keep their own budget.

EXAMPLES
  ravi cloud settings set --monthly-cap 50                  # lower: applies at once
  ravi cloud settings set --monthly-cap 500 --execute
  ravi cloud settings set --billing-mode credits --execute
`;

/** The settings a change would let spend more than before. */
function spendExpansions(current: CloudOrgSettings, body: CloudOrgSettingsBody): string[] {
  const expansions: string[] = [];
  if (body.billingMode !== undefined && body.billingMode !== current.billingMode) expansions.push("billingMode");
  if (body.monthlyCapUsd !== undefined && current.monthlyCapUsd !== null) {
    if (body.monthlyCapUsd === null || body.monthlyCapUsd > current.monthlyCapUsd) expansions.push("monthlyCapUsd");
  }
  if (body.dailyEventRunsCap !== undefined && body.dailyEventRunsCap > current.dailyEventRunsCap) {
    expansions.push("dailyEventRunsCap");
  }
  return expansions;
}

function printSettings(settings: CloudOrgSettings): void {
  console.log(
    `Billing mode: ${settings.billingMode === "credits" ? "Ravi credits" : "the organization's own key"}${settings.gatewayAvailable ? "" : " (credits not available on this Console)"}`,
  );
  console.log(
    `Monthly cap: ${settings.monthlyCapUsd === null ? "none" : formatUsd(settings.monthlyCapUsd)}, spent ${formatUsd(settings.monthSpentUsd)} this month`,
  );
  if (settings.pausedAt) console.log(`Paused since ${settings.pausedAt}: ${settings.pausedReason ?? "monthly cap"}`);
  console.log(`Event runs per day: at most ${settings.dailyEventRunsCap}`);
  console.log(
    `Provider webhook: ${settings.webhook.configured ? `configured${settings.webhook.lastEventAt ? `, last event ${settings.webhook.lastEventAt}` : ""}` : "not configured (ravi cloud webhook show)"}`,
  );
}

@Group({
  name: "cloud.settings",
  description: "The organization's cloud agents settings: billing mode and caps",
  scope: "open",
})
export class CloudSettingsCommands {
  constructor(private readonly deps: CloudProductCommandDeps = {}) {}

  @Command({ name: "show", description: "Show the billing mode, caps, pause state and webhook status" })
  @CommandAccess({ kind: "read", resource: "cloud.agents", action: "settings.show", risk: "low" })
  @Returns(z.object({ success: z.literal(true), settings: cloudSettingsReturnSchema }).strict())
  async show(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    return withCloudAgentsContract("cloud settings show", asJson, async () => {
      const session = await productSession(this.deps, undefined, false);
      const settings = await getCloudSettings(session.client);
      const payload = { success: true as const, settings };
      if (asJson) printJson(payload);
      else printSettings(settings);
      return payload;
    });
  }

  @Command({
    name: "set",
    description: "Change the billing mode or caps. Requires --execute when it can raise spending.",
    helpAfter: SETTINGS_SET_HELP_AFTER,
  })
  @CommandAccess({
    kind: "mutate",
    resource: "cloud.agents",
    action: "settings.set",
    risk: "high",
    requiresConfirmation: true,
  })
  @Returns(
    z.object({ success: z.literal(true), settings: cloudSettingsReturnSchema, changes: z.array(z.string()) }).strict(),
  )
  async set(
    @Option({ flags: "--billing-mode <mode>", description: "byok (the organization's key) or credits (Ravi credits)" })
    billingMode?: string,
    @Option({ flags: "--monthly-cap <usd>", description: "Monthly cap in US dollars for the organization, or none" })
    monthlyCap?: string,
    @Option({ flags: "--daily-event-runs <n>", description: "Runs event triggers may start per day (1-1000)" })
    dailyEventRuns?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--execute", description: "Apply a change that can raise spending (without it, exit 3)" })
    execute?: boolean,
  ) {
    const op = "cloud settings set";
    const body: CloudOrgSettingsBody = {};
    if (billingMode !== undefined) {
      const mode = billingMode.trim().toLowerCase();
      if (mode !== "byok" && mode !== "credits") usageError(op, "--billing-mode must be byok or credits.", asJson);
      body.billingMode = mode;
    }
    const cap = parseUsd(op, "--monthly-cap", monthlyCap, { min: 0.01, max: 100_000, allowNone: true, asJson });
    if (cap !== undefined) body.monthlyCapUsd = cap;
    const daily = parseIntegerFlag(op, "--daily-event-runs", dailyEventRuns, { min: 1, max: 1_000, asJson });
    if (daily !== undefined) body.dailyEventRunsCap = daily;
    if (Object.keys(body).length === 0) {
      usageError(op, "Nothing to change.", asJson, "Pass --billing-mode, --monthly-cap or --daily-event-runs");
    }
    return withCloudAgentsContract(op, asJson, async () => {
      const session = await productSession(this.deps, undefined, false);
      const current = await getCloudSettings(session.client);
      const expansions = spendExpansions(current, body);
      if (expansions.length > 0) {
        refuseInAgentRuntime(op, this.deps, {
          code: "CLOUD_AGENT_CANNOT_RAISE_SPENDING",
          message: "Agents do not change cloud settings in a way that can raise spending; lowering a cap is fine.",
          suggestedAction:
            "Ask an owner or admin to run: ravi cloud settings set ... --execute (or change it in the Console)",
          asJson,
        });
      }
      if (expansions.length > 0 && execute !== true) {
        contractDryRun(
          op,
          {
            changes: body,
            raisesSpending: expansions,
            current: {
              billingMode: current.billingMode,
              monthlyCapUsd: current.monthlyCapUsd,
              dailyEventRunsCap: current.dailyEventRunsCap,
            },
            effect:
              body.billingMode !== undefined && body.billingMode !== current.billingMode
                ? "switches who pays for every cloud run of the organization and redeploys its agents"
                : "lets the organization's cloud runs spend more",
          },
          { asJson },
        );
      }
      const settings = await updateCloudSettings(session.client, body);
      const payload = { success: true as const, settings, changes: Object.keys(body) };
      if (asJson) {
        printJson(payload);
      } else {
        console.log("✓ Updated the cloud agents settings");
        printSettings(settings);
      }
      return payload;
    });
  }
}
