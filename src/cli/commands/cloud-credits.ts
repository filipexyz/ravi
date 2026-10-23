/**
 * `ravi cloud credits show|topup`: Ravi credits in BRL. In credits mode the
 * organization's runs go through Ravi's gateway key and each run is charged at
 * the provider's list price converted at the rate shown on its entry (no
 * markup). A top-up is a Pix charge; the credit posts when the payment clears.
 *
 * spec: cloud/agents, cli
 */

import "reflect-metadata";
import { z } from "zod";

import { getCloudCredits, topupCloudCredits } from "../../cloud-agents/client-product.js";
import type { CloudCreditEntry } from "../../cloud-agents/types.js";
import { contractDryRun } from "../agent-contract.js";
import { formatUsd, usageError, withCloudAgentsContract } from "../cloud-agents-contract.js";
import {
  type CloudProductCommandDeps,
  cloudCreditEntryReturnSchema,
  cloudCreditsReturnSchema,
  formatBrl,
  parseBrl,
  printJson,
  productSession,
} from "../cloud-product-contract.js";
import { Arg, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";

const CLOUD_TOPUP_MIN_BRL = 20;
const CLOUD_TOPUP_MAX_BRL = 5_000;

const TOPUP_HELP_AFTER = `
MUTATE (BRAKED) — creates a Pix charge for Ravi credits (R$ ${CLOUD_TOPUP_MIN_BRL} to R$ ${CLOUD_TOPUP_MAX_BRL}). The
credit posts to the organization's balance when the payment clears. Only owners
and admins add credits. Credits pay for runs only in credits mode
(ravi cloud settings set --billing-mode credits --execute).

EXAMPLES
  ravi cloud credits topup 100                # plan (exit 3)
  ravi cloud credits topup 100 --execute      # prints the Pix link and copy-paste code
`;

function entryLine(entry: CloudCreditEntry): string {
  const what = entry.kind === "run" && entry.runId ? `run ${entry.runId}` : entry.kind;
  const usd = entry.usd !== null ? ` (${formatUsd(entry.usd)} at ${entry.fxRate ?? "?"})` : "";
  return `  ${(entry.createdAt ?? "").slice(0, 10).padEnd(10)} ${formatBrl(entry.amountBrl).padStart(12)} ${entry.status.padEnd(7)} ${what}${usd}`;
}

function printPix(entry: CloudCreditEntry): void {
  if (entry.paymentUrl) console.log(`  Pay with Pix: ${entry.paymentUrl}`);
  if (entry.pixCopyPaste) console.log(`  Pix copy-paste code: ${entry.pixCopyPaste}`);
}

@Group({
  name: "cloud.credits",
  description: "Ravi credits in BRL for cloud runs (balance, ledger, Pix top-ups)",
  scope: "open",
})
export class CloudCreditsCommands {
  constructor(private readonly deps: CloudProductCommandDeps = {}) {}

  @Command({ name: "show", description: "Show the credits balance, this month's spend and the latest entries" })
  @CommandAccess({ kind: "read", resource: "cloud.agents", action: "credits.show", risk: "low" })
  @Returns(z.object({ success: z.literal(true), credits: cloudCreditsReturnSchema }).strict())
  async show(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    return withCloudAgentsContract("cloud credits show", asJson, async () => {
      const session = await productSession(this.deps, undefined, false);
      const credits = await getCloudCredits(session.client);
      const payload = { success: true as const, credits };
      if (asJson) {
        printJson(payload);
      } else {
        console.log(
          `Billing mode: ${credits.mode === "credits" ? "Ravi credits" : "the organization's own key (credits not used)"}`,
        );
        console.log(`Balance: ${formatBrl(credits.balanceBrl)}  This month: ${formatBrl(credits.monthSpentBrl)}`);
        console.log(`Rate: ${credits.fxRate ? `US$ 1 = R$ ${credits.fxRate}` : "not set"}`);
        for (const entry of credits.entries.slice(0, 20)) console.log(entryLine(entry));
        for (const entry of credits.entries.filter((item) => item.kind === "topup" && item.status === "pending")) {
          console.log(`Pending top-up ${entry.id} (${formatBrl(entry.amountBrl)}):`);
          printPix(entry);
        }
      }
      return payload;
    });
  }

  @Command({
    name: "topup",
    description: "Add Ravi credits with a Pix charge (prints the link and code). Requires --execute.",
    helpAfter: TOPUP_HELP_AFTER,
  })
  @CommandAccess({
    kind: "mutate",
    resource: "cloud.agents",
    action: "credits.topup",
    risk: "high",
    requiresConfirmation: true,
  })
  @Returns(
    z
      .object({
        success: z.literal(true),
        entry: cloudCreditEntryReturnSchema,
        credits: cloudCreditsReturnSchema.nullable(),
      })
      .strict(),
  )
  async topup(
    @Arg("amount", { description: `Amount in reais (${CLOUD_TOPUP_MIN_BRL} to ${CLOUD_TOPUP_MAX_BRL})` })
    amount: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--execute", description: "Create the Pix charge (without it, print the plan and exit 3)" })
    execute?: boolean,
  ) {
    const op = "cloud credits topup";
    const amountBrl = parseBrl(op, "<amount>", amount, asJson);
    if (amountBrl < CLOUD_TOPUP_MIN_BRL || amountBrl > CLOUD_TOPUP_MAX_BRL) {
      usageError(op, `<amount> must be from R$ ${CLOUD_TOPUP_MIN_BRL} to R$ ${CLOUD_TOPUP_MAX_BRL}.`, asJson);
    }
    return withCloudAgentsContract(op, asJson, async () => {
      const session = await productSession(this.deps, undefined, false);
      if (execute !== true) {
        const current = await getCloudCredits(session.client);
        contractDryRun(
          op,
          {
            amountBrl,
            balanceBrl: current.balanceBrl,
            mode: current.mode,
            effect: "creates a Pix charge for the organization; the credit posts when the payment clears",
          },
          { asJson },
        );
      }
      const result = await topupCloudCredits(session.client, amountBrl);
      const payload = { success: true as const, entry: result.entry, credits: result.credits };
      if (asJson) {
        printJson(payload);
      } else {
        console.log(
          `✓ Pix charge ${result.entry.id} for ${formatBrl(result.entry.amountBrl)} (${result.entry.status})`,
        );
        printPix(result.entry);
        console.log("  The credit posts when the payment clears: ravi cloud credits show");
      }
      return payload;
    });
  }
}
