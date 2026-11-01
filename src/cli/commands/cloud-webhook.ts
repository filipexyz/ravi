/**
 * `ravi cloud webhook show|set|remove`: the provider webhook that makes the
 * Console sync a run as soon as the provider reports a change. `show` prints
 * the organization's endpoint URL to register in the provider console; `set`
 * stores the `whsec_` signing secret the provider console shows (stdin only,
 * never returned). Only owners and admins change it.
 *
 * spec: cloud/agents, cli
 */

import "reflect-metadata";
import { z } from "zod";

import { getCloudWebhook, removeCloudWebhook, setCloudWebhook } from "../../cloud-agents/client-product.js";
import { contractDryRun } from "../agent-contract.js";
import { usageError, withCloudAgentsContract } from "../cloud-agents-contract.js";
import {
  type CloudProductCommandDeps,
  cloudWebhookReturnSchema,
  printJson,
  productDefaults,
  productSession,
  refuseInAgentRuntime,
} from "../cloud-product-contract.js";
import { CliOnly, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";

const WEBHOOK_SET_HELP_AFTER = `
MUTATE (BRAKED) — stores the provider's webhook signing secret (whsec_...) in
the Console, encrypted. The Console then verifies every delivery to the URL
'ravi cloud webhook show' prints and syncs the run at once, instead of waiting
for its periodic pass. The secret never comes back.

STEPS
  1. ravi cloud webhook show                       # copy the URL
  2. Register that URL for session events in the provider console; copy its signing secret.
  3. ravi cloud webhook set --stdin --execute < <file-with-the-secret>

RULES
  • The secret is read from redirected stdin only; never pass it as an argument.
  • Without --execute it prints the plan and exits 3; stdin is not read.
  • Agents do not set it (CLOUD_AGENT_CANNOT_SET_SECRET, exit 3).
`;

const webhookPayloadSchema = z.object({ success: z.literal(true), webhook: cloudWebhookReturnSchema }).strict();

@Group({
  name: "cloud.webhook",
  description: "The provider webhook that syncs cloud runs at once (endpoint URL and signing secret)",
  scope: "open",
})
export class CloudWebhookCommands {
  constructor(private readonly deps: CloudProductCommandDeps = {}) {}

  @Command({ name: "show", description: "Show the webhook URL to register and whether a signing secret is set" })
  @CommandAccess({ kind: "read", resource: "cloud.agents", action: "webhook.show", risk: "low" })
  @Returns(webhookPayloadSchema)
  async show(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    return withCloudAgentsContract("cloud webhook show", asJson, async () => {
      const session = await productSession(this.deps, undefined, false);
      const webhook = await getCloudWebhook(session.client);
      const payload = { success: true as const, webhook };
      if (asJson) {
        printJson(payload);
      } else {
        console.log(`Webhook URL: ${webhook.url ?? "(not available; ask an owner or admin)"}`);
        console.log(
          webhook.configured
            ? `Signing secret: set${webhook.lastEventAt ? `, last event ${webhook.lastEventAt}` : ", no event yet"}`
            : "Signing secret: not set. An owner or admin runs: ravi cloud webhook set --stdin --execute < <file>",
        );
      }
      return payload;
    });
  }

  @Command({
    name: "set",
    description: "Store the provider's webhook signing secret from stdin. Requires --execute.",
    helpAfter: WEBHOOK_SET_HELP_AFTER,
  })
  @CliOnly()
  @CommandAccess({
    kind: "mutate",
    resource: "cloud.agents",
    action: "webhook.set",
    risk: "high",
    requiresConfirmation: true,
  })
  @Returns(webhookPayloadSchema)
  async set(
    @Option({ flags: "--stdin", description: "Read the secret from redirected stdin (the only way to pass it)" })
    stdin?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--execute", description: "Send the secret (without it, print the plan and exit 3)" })
    execute?: boolean,
  ) {
    const op = "cloud webhook set";
    const d = productDefaults(this.deps);
    refuseInAgentRuntime(op, this.deps, {
      code: "CLOUD_AGENT_CANNOT_SET_SECRET",
      message: "Agents do not set the webhook signing secret.",
      suggestedAction: "Ask an owner or admin to run: ravi cloud webhook set --stdin --execute < <file>",
      asJson,
    });
    if (stdin !== true) {
      usageError(
        op,
        "The secret is read from stdin only: pass --stdin and redirect the file that holds it.",
        asJson,
        "ravi cloud webhook set --stdin --execute < <file>",
      );
    }
    return withCloudAgentsContract(op, asJson, async () => {
      const session = await productSession(this.deps, undefined, false);
      const current = await getCloudWebhook(session.client);
      if (execute !== true) {
        contractDryRun(
          op,
          {
            secretFrom: "stdin",
            replaces: current.configured,
            url: current.url,
            effect: "the Console verifies provider deliveries with this secret and syncs runs as they change",
          },
          { asJson },
        );
      }
      const secret = (await d.readSecret()).trim();
      if (!secret || /\s/.test(secret)) usageError(op, "stdin did not hold one signing secret.", asJson);
      const webhook = await setCloudWebhook(session.client, secret);
      const payload = { success: true as const, webhook };
      if (asJson) printJson(payload);
      else
        console.log(`✓ Webhook signing secret set. Deliveries to ${webhook.url ?? "the webhook URL"} now sync runs.`);
      return payload;
    });
  }

  @Command({ name: "remove", description: "Remove the webhook signing secret (runs sync on the periodic pass)" })
  @CommandAccess({ kind: "mutate", resource: "cloud.agents", action: "webhook.remove", risk: "medium" })
  @Returns(webhookPayloadSchema)
  async remove(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    return withCloudAgentsContract("cloud webhook remove", asJson, async () => {
      const session = await productSession(this.deps, undefined, false);
      const webhook = await removeCloudWebhook(session.client);
      const payload = { success: true as const, webhook };
      if (asJson) printJson(payload);
      else console.log("✓ Removed the webhook signing secret. Runs sync on the Console's periodic pass.");
      return payload;
    });
  }
}
