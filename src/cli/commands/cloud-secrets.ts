/**
 * `ravi cloud secrets list|set|remove`: secrets a cloud run uses outside its
 * container. The Console stores each value encrypted and adds it to a run's
 * vault for the hosts it is bound to, so the value is substituted at egress
 * and never reaches the sandbox. The value goes up once, from stdin, and never
 * comes back (only its last characters).
 *
 * spec: cloud/agents, cli
 */

import "reflect-metadata";
import { z } from "zod";

import { listCloudSecrets, removeCloudSecret, setCloudSecret } from "../../cloud-agents/client-product.js";
import { CLOUD_SECRET_NAME_PATTERN } from "../../cloud-agents/definition.js";
import type { CloudSecret } from "../../cloud-agents/types.js";
import { contractDryRun, contractFail } from "../agent-contract.js";
import {
  cloudPaginationReturnSchema,
  pageCloudList,
  usageError,
  withCloudAgentsContract,
} from "../cloud-agents-contract.js";
import {
  type CloudProductCommandDeps,
  cloudSecretReturnSchema,
  listFlag,
  printJson,
  productDefaults,
  productSession,
  refuseInAgentRuntime,
  requireArg,
} from "../cloud-product-contract.js";
import { Arg, CliOnly, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";

const MAX_HOSTS = 10;
const HOST_PATTERN = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
/** The Console stores values of 1 to 8192 characters. */
const MAX_SECRET_CHARS = 8_192;

const SECRETS_SET_HELP_AFTER = `
MUTATE (BRAKED) — sends a secret value to the Console, which stores it
encrypted. At run start every secret an agent names in its cloud block
("secrets": ["STRIPE_API_KEY"]) is added to the run's vault, bound to its
hosts: the value is substituted when a request leaves for one of those hosts
and is never visible inside the sandbox. Only owners and admins set secrets.

RULES
  • The value is read from redirected stdin only; never pass it as an argument.
  • Without --execute it prints the plan and exits 3; stdin is not read.
  • Without --project the secret is organization-wide; with it, only that project's runs get it.
  • Agents do not set secrets (CLOUD_AGENT_CANNOT_SET_SECRET, exit 3).

EXAMPLES
  ravi cloud secrets set STRIPE_API_KEY --host api.stripe.com --stdin --execute < ~/secrets/stripe
  ravi cloud secrets set CRM_TOKEN --host api.crm.example --project clinica --stdin --execute < ~/secrets/crm
`;

const secretsListSchema = z
  .object({
    success: z.literal(true),
    project: z.string().nullable(),
    secrets: z.array(cloudSecretReturnSchema),
    pagination: cloudPaginationReturnSchema,
  })
  .strict();

function secretLine(secret: CloudSecret): string {
  const scope = secret.projectId ? `project ${secret.projectId}` : "organization";
  return `  ${secret.name.padEnd(28)} …${secret.valueHint ?? "????"}  ${scope}  hosts ${secret.allowedHosts.join(", ") || "-"}  id ${secret.id}`;
}

@Group({
  name: "cloud.secrets",
  description: "Secrets cloud runs use at egress, bound to hosts (values stay in the Console)",
  scope: "open",
})
export class CloudSecretsCommands {
  constructor(private readonly deps: CloudProductCommandDeps = {}) {}

  @Command({ name: "list", description: "List the organization's (or a project's) cloud secrets: names and hints" })
  @CommandAccess({ kind: "read", resource: "cloud.agents", action: "secrets.list", risk: "low" })
  @Returns(secretsListSchema)
  async list(
    @Option({ flags: "--project <project>", description: "Only this Console project's secrets" }) project?: string,
    @Option({ flags: "--limit <n>", description: "Page size (1-200, default 50)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Skip this many (default 0)" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "cloud secrets list";
    return withCloudAgentsContract(op, asJson, async () => {
      const session = await productSession(this.deps, project, false);
      const projectRef = project?.trim() || null;
      const page = pageCloudList(
        op,
        await listCloudSecrets(session.client, projectRef),
        { limit, offset, command: `ravi cloud secrets list${projectRef ? ` --project ${projectRef}` : ""}` },
        asJson,
      );
      const secrets = page.items;
      const payload = { success: true as const, project: projectRef, secrets, pagination: page.pagination };
      if (asJson) {
        printJson(payload);
      } else if (secrets.length === 0) {
        console.log("No cloud secrets. An owner or admin adds one with:");
        console.log("  ravi cloud secrets set <NAME> --host <host> --stdin --execute < <file-with-the-value>");
      } else {
        for (const secret of secrets) console.log(secretLine(secret));
      }
      return payload;
    });
  }

  @Command({
    name: "set",
    description: "Set or replace a cloud secret from stdin, bound to its hosts. Requires --execute.",
    helpAfter: SECRETS_SET_HELP_AFTER,
  })
  @CliOnly()
  @CommandAccess({
    kind: "mutate",
    resource: "cloud.agents",
    action: "secrets.set",
    risk: "high",
    requiresConfirmation: true,
  })
  @Returns(z.object({ success: z.literal(true), secret: cloudSecretReturnSchema }).strict())
  async set(
    @Arg("name", { description: "Secret name, such as STRIPE_API_KEY (A-Z, 0-9 and _)" }) nameArg: string,
    @Option({ flags: "--host <host...>", description: "Host the value may go to (repeatable, 1-10)" })
    hosts?: string[],
    @Option({
      flags: "--project <project>",
      description: "Bind it to one Console project (default: organization-wide)",
    })
    project?: string,
    @Option({ flags: "--stdin", description: "Read the value from redirected stdin (the only way to pass it)" })
    stdin?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--execute", description: "Send the value (without it, print the plan and exit 3)" })
    execute?: boolean,
  ) {
    const op = "cloud secrets set";
    const d = productDefaults(this.deps);
    refuseInAgentRuntime(op, this.deps, {
      code: "CLOUD_AGENT_CANNOT_SET_SECRET",
      message: "Agents do not set cloud secrets.",
      suggestedAction:
        "Ask an owner or admin to run: ravi cloud secrets set <NAME> --host <host> --stdin --execute < <file>",
      asJson,
    });
    const name = requireArg(op, "<name>", nameArg, asJson);
    if (!CLOUD_SECRET_NAME_PATTERN.test(name)) {
      usageError(op, "<name> is 2-64 characters of A-Z, 0-9 and _, starting with a letter.", asJson);
    }
    const allowedHosts = (listFlag(hosts) ?? []).map((host) => host.toLowerCase());
    if (allowedHosts.length === 0 || allowedHosts.length > MAX_HOSTS) {
      usageError(op, `Pass 1 to ${MAX_HOSTS} --host values: the hosts this secret may be sent to.`, asJson);
    }
    const badHost = allowedHosts.find((host) => !HOST_PATTERN.test(host));
    if (badHost)
      usageError(op, `--host takes a bare hostname (such as api.stripe.com), not '${badHost.slice(0, 80)}'.`, asJson);
    if (stdin !== true) {
      usageError(
        op,
        "The value is read from stdin only: pass --stdin and redirect the file that holds it.",
        asJson,
        `ravi cloud secrets set ${name} --host ${allowedHosts[0]} --stdin --execute < <file>`,
      );
    }
    const projectRef = project?.trim() || null;
    return withCloudAgentsContract(op, asJson, async () => {
      const session = await productSession(this.deps, undefined, false);
      const current = (await listCloudSecrets(session.client, projectRef)).find(
        (secret) => secret.name === name && (projectRef ? secret.projectId !== null : secret.projectId === null),
      );
      if (execute !== true) {
        contractDryRun(
          op,
          {
            name,
            scope: projectRef ? { project: projectRef } : "organization",
            allowedHosts,
            valueFrom: "stdin",
            replaces: current !== undefined,
            currentValueHint: current?.valueHint ?? null,
            effect:
              "the Console stores the value encrypted and substitutes it at egress, for these hosts only, in every run whose agent names this secret",
          },
          { asJson },
        );
      }
      const value = (await d.readSecret()).replace(/\r?\n$/, "");
      if (!value.trim()) usageError(op, "stdin held no value.", asJson);
      if (value.length > MAX_SECRET_CHARS) {
        usageError(op, `The value is longer than ${MAX_SECRET_CHARS} characters.`, asJson);
      }
      const secret = await setCloudSecret(session.client, {
        ...(projectRef ? { project: projectRef } : {}),
        name,
        value,
        allowedHosts,
      });
      const payload = { success: true as const, secret };
      if (asJson) printJson(payload);
      else
        console.log(`✓ Secret ${secret.name} …${secret.valueHint ?? "????"} set for ${secret.allowedHosts.join(", ")}`);
      return payload;
    });
  }

  @Command({ name: "remove", description: "Remove a cloud secret (runs that name it stop starting)" })
  @CommandAccess({ kind: "mutate", resource: "cloud.agents", action: "secrets.remove", risk: "medium" })
  @Returns(z.object({ success: z.literal(true), id: z.string(), name: z.string(), removed: z.literal(true) }).strict())
  async remove(
    @Arg("secret", { description: "Secret name or id" }) secretRef: string,
    @Option({
      flags: "--project <project>",
      description: "The project the secret is bound to (default: organization-wide)",
    })
    project?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "cloud secrets remove";
    const ref = requireArg(op, "<secret>", secretRef, asJson);
    const projectRef = project?.trim() || null;
    return withCloudAgentsContract(
      op,
      asJson,
      async () => {
        const session = await productSession(this.deps, undefined, false);
        const secrets = await listCloudSecrets(session.client, projectRef);
        const scoped = secrets.filter((secret) => (projectRef ? secret.projectId !== null : secret.projectId === null));
        const secret = secrets.find((entry) => entry.id === ref) ?? scoped.find((entry) => entry.name === ref);
        if (!secret) {
          contractFail(op, "CLOUD_SECRET_NOT_FOUND", `No cloud secret '${ref.slice(0, 80)}'.`, {
            asJson,
            details: {
              suggestedAction: `List them with: ravi cloud secrets list${projectRef ? ` --project ${projectRef}` : ""}`,
            },
          });
        }
        await removeCloudSecret(session.client, secret.id);
        const payload = { success: true as const, id: secret.id, name: secret.name, removed: true as const };
        if (asJson) printJson(payload);
        else
          console.log(
            `✓ Removed secret ${secret.name}. Runs of agents that name it stop starting until it is set again.`,
          );
        return payload;
      },
      { notFoundCode: "CLOUD_SECRET_NOT_FOUND" },
    );
  }
}
