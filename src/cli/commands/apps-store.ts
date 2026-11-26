import "reflect-metadata";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import {
  addBlock,
  buildIndex,
  renewBlocklist,
  signFile,
  verifyRepo,
  writeKeysFile,
} from "../../apps/store/index-build.js";
import {
  commitChange,
  commitRollback,
  planRollback,
  prepareLocalInstall,
  prepareOfficialInstall,
  prepareOfficialUpdate,
  searchIndex,
  setExposure,
  uninstallApp,
  verifyInstalled,
  type StorePlan,
} from "../../apps/store/install.js";
import { loadCachedSource, refreshSource } from "../../apps/store/source.js";
import { OFFICIAL_APP_SOURCE } from "../../apps/store/trust.js";
import { AppStoreError } from "../../apps/store/types.js";
import { normalizeAppId } from "../../apps/service.js";
import {
  CONTRACT_EXIT_POLICY,
  CONTRACT_EXIT_USAGE,
  contractDryRun,
  contractFail,
  errorDiagnostic,
} from "../agent-contract.js";
import { getContext, hasRuntimeInvocationContext } from "../context.js";
import { Arg, CliOnly, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function failStore(op: string, error: unknown, asJson?: boolean): never {
  if (error instanceof AppStoreError) {
    contractFail(op, error.code, error.message, {
      asJson,
      exitCode: error.exitCode === 2 ? CONTRACT_EXIT_USAGE : error.exitCode === 3 ? CONTRACT_EXIT_POLICY : 1,
      details: error.details as Record<string, unknown>,
      diagnostic: errorDiagnostic(error.message, { operation: op }),
    });
  }
  throw error;
}

/**
 * Installing, exposing and signing belong to the operator's own terminal.
 * A process launched by an agent turn or the gateway is refused, even when
 * its grants would cover the command (spec apps/store, "Who installs").
 */
function requireOperatorTerminal(op: string, asJson?: boolean): void {
  if (!hasRuntimeInvocationContext()) return;
  const message = `${op} runs only in the operator's own terminal, not from an agent turn or the gateway.`;
  contractFail(op, "APP_STORE_OPERATOR_ONLY", message, {
    asJson,
    exitCode: CONTRACT_EXIT_POLICY,
    diagnostic: errorDiagnostic(message, { operation: op }),
  });
}

function appId(op: string, value: string, asJson?: boolean): string {
  try {
    return normalizeAppId(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    contractFail(op, "USAGE_ERROR", message, {
      asJson,
      exitCode: CONTRACT_EXIT_USAGE,
      diagnostic: errorDiagnostic(message, { operation: op }),
    });
  }
}

function printPlan(plan: StorePlan): void {
  console.log(`${plan.action} ${plan.id}@${plan.version} (${plan.class}, ${plan.source})`);
  if (plan.from) console.log(`  from ${plan.from.version}`);
  console.log(`  tree ${plan.treeHash}`);
  console.log(`  context.allow: ${plan.grants.contextAllow.join(", ") || "(none)"}`);
  for (const [id, operation] of Object.entries(plan.grants.operations)) {
    console.log(`  ${operation.mutating ? "writes" : "reads "} ${id}: ${operation.runs ?? "(none)"}`);
  }
  console.log(`  visible to: ${plan.exposedTo.join(", ") || "no agent"}`);
  for (const note of plan.notes) console.log(`  note: ${note}`);
}

const searchReturnSchema = z.object({
  source: z.string(),
  indexSerial: z.number(),
  refreshedAt: z.string().nullable(),
  apps: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string(),
      publisher: z.string(),
      latest: z.string().nullable(),
      class: z.enum(["compose", "connector", "code"]).nullable(),
      installed: z.string().nullable(),
      blocked: z.boolean(),
    }),
  ),
});

const refreshReturnSchema = z.object({
  source: z.string(),
  changed: z.boolean(),
  keysSerial: z.number(),
  indexSerial: z.number(),
  blockSerial: z.number(),
  apps: z.number(),
  refreshedAt: z.string().nullable(),
});

const verifyReturnSchema = z.object({
  ok: z.boolean(),
  apps: z.array(
    z.object({
      id: z.string(),
      version: z.string(),
      source: z.enum(["official", "local"]),
      state: z.enum(["active", "quarantined"]),
      ok: z.boolean(),
      problems: z.array(z.string()),
      exposedTo: z.array(z.string()),
    }),
  ),
});

@Group({
  name: "apps",
  description: "Discover and validate Ravi app manifests",
  scope: "open",
})
export class AppsStoreCommands {
  @Command({ name: "search", description: "Search the official Ravi Apps index" })
  @CommandAccess({ kind: "read", resource: "apps", action: "search", risk: "low" })
  @Returns(searchReturnSchema)
  async search(
    @Arg("query", { required: false, description: "Text to match in id, name or description" }) query?: string,
    @Option({ flags: "--refresh", description: "Fetch the signed index before searching" }) refresh?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "apps search";
    try {
      const verified = (!refresh && loadCachedSource()) || (await refreshSource());
      const payload = {
        source: verified.source.id,
        indexSerial: verified.index.serial,
        refreshedAt: verified.state.refreshedAt,
        apps: searchIndex(verified, query),
      };
      if (asJson) printJson(payload);
      else if (payload.apps.length === 0) console.log("No app matches.");
      else {
        for (const app of payload.apps) {
          const installed = app.installed ? ` (installed ${app.installed})` : "";
          const blocked = app.blocked ? " [blocked]" : "";
          console.log(`- ${app.id}@${app.latest ?? "?"} :: ${app.class ?? "?"} :: ${app.name}${installed}${blocked}`);
          if (app.description) console.log(`    ${app.description}`);
        }
      }
      return payload;
    } catch (error) {
      failStore(op, error, asJson);
    }
  }

  @Command({ name: "refresh", description: "Fetch and verify the signed official index, keys and block list" })
  @CommandAccess({ kind: "mutate", resource: "apps", action: "refresh", risk: "low" })
  @Returns(refreshReturnSchema)
  async refresh(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    try {
      const verified = await refreshSource();
      const payload = {
        source: verified.source.id,
        changed: verified.changed,
        keysSerial: verified.keys.serial,
        indexSerial: verified.index.serial,
        blockSerial: verified.blocklist.serial,
        apps: Object.keys(verified.index.apps).length,
        refreshedAt: verified.state.refreshedAt,
      };
      if (asJson) printJson(payload);
      else
        console.log(
          `Index ${payload.indexSerial} verified: ${payload.apps} apps${payload.changed ? " (updated)" : ""}.`,
        );
      return payload;
    } catch (error) {
      failStore("apps refresh", error, asJson);
    }
  }

  @Command({ name: "verify", description: "Check installed store apps against their receipts and the block list" })
  @CommandAccess({ kind: "read", resource: "apps", action: "verify", risk: "low" })
  @Returns(verifyReturnSchema)
  async verify(
    @Arg("id", { required: false, description: "Installed app id. Omit to verify every store app." }) id?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "apps verify";
    try {
      const all = verifyInstalled(id ? appId(op, id, asJson) : undefined);
      // An agent sees only the store apps exposed to it, and never who else sees them.
      const caller = hasRuntimeInvocationContext() ? (getContext()?.agentId ?? null) : undefined;
      const apps =
        caller === undefined
          ? all
          : all
              .filter((app) => caller !== null && app.exposedTo.includes(caller))
              .map((app) => ({ ...app, exposedTo: [] }));
      if (id && caller !== undefined && apps.length === 0) {
        throw new AppStoreError("APP_NOT_INSTALLED", `${id} is not installed from the store.`, 1);
      }
      const payload = { ok: apps.every((app) => app.ok), apps };
      if (!payload.ok && getContext({ localOnly: true })?.suppressCliOutput !== true) process.exitCode = 1;
      if (asJson) printJson(payload);
      else if (apps.length === 0) console.log("No app was installed from the store.");
      else {
        for (const app of apps) {
          console.log(
            `- ${app.id}@${app.version} :: ${app.ok ? "ok" : "PROBLEM"} :: visible to ${app.exposedTo.join(", ") || "no agent"}`,
          );
          for (const problem of app.problems) console.log(`    ${problem}`);
        }
      }
      return payload;
    } catch (error) {
      failStore(op, error, asJson);
    }
  }

  @Command({ name: "install", description: "Install an app from the official index, or from a folder with --from" })
  @CommandAccess({ kind: "mutate", resource: "apps", action: "install", risk: "high", requiresConfirmation: true })
  @CliOnly()
  async install(
    @Arg("id", { required: false, description: "App id in the index (omit with --from)" }) id?: string,
    @Option({ flags: "--version <version>", description: "Exact version (default: newest installable)" })
    version?: string,
    @Option({ flags: "--from <dir>", description: "Install a local app folder instead of the index" }) from?: string,
    @Option({ flags: "--allow-code", description: "With --from: accept an app that runs commands other than ravi" })
    allowCode?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--execute", description: "Install; default is a dry-run that shows the plan (exit 3)" })
    execute?: boolean,
  ) {
    const op = "apps install";
    requireOperatorTerminal(op, asJson);
    if (!id && !from) {
      contractFail(op, "USAGE_ERROR", "Give an app id, or --from <dir>.", {
        asJson,
        exitCode: CONTRACT_EXIT_USAGE,
        diagnostic: errorDiagnostic("Give an app id, or --from <dir>.", { operation: op }),
      });
    }
    try {
      const prepared = from
        ? prepareLocalInstall(resolve(from), { allowCode })
        : await prepareOfficialInstall(appId(op, id!, asJson), { version, persist: execute === true });
      if (from && id && prepared.plan.id !== appId(op, id, asJson)) {
        throw new AppStoreError("APP_PACKAGE_INVALID", `The folder holds app ${prepared.plan.id}, not ${id}.`, 2);
      }
      if (!execute) {
        if (!asJson) printPlan(prepared.plan);
        contractDryRun(op, { ...prepared.plan }, { asJson });
      }
      const receipt = commitChange(prepared);
      const payload = { installed: true, plan: prepared.plan, receipt };
      if (asJson) printJson(payload);
      else {
        console.log(`Installed ${receipt.id}@${receipt.version}. No agent sees it yet.`);
        console.log(`Next: ravi apps allow ${receipt.id} --agent <agent> --execute`);
      }
      return payload;
    } catch (error) {
      failStore(op, error, asJson);
    }
  }

  @Command({ name: "update", description: "Update an installed official app to the newest version" })
  @CommandAccess({ kind: "mutate", resource: "apps", action: "update", risk: "high", requiresConfirmation: true })
  @CliOnly()
  async update(
    @Arg("id", { description: "Installed app id" }) id: string,
    @Option({ flags: "--version <version>", description: "Exact version (default: newest installable)" })
    version?: string,
    @Option({ flags: "--now", description: "Skip the 24-hour wait after a version is published" }) now?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--execute", description: "Update; default is a dry-run that shows the plan (exit 3)" })
    execute?: boolean,
  ) {
    const op = "apps update";
    requireOperatorTerminal(op, asJson);
    try {
      const prepared = await prepareOfficialUpdate(appId(op, id, asJson), {
        version,
        skipCooldown: now,
        persist: execute === true,
      });
      if ("upToDate" in prepared) {
        const payload = { updated: false, id: prepared.id, version: prepared.version };
        if (asJson) printJson(payload);
        else console.log(`${prepared.id}@${prepared.version} is up to date.`);
        return payload;
      }
      if (!execute) {
        if (!asJson) printPlan(prepared.plan);
        contractDryRun(op, { ...prepared.plan }, { asJson });
      }
      const receipt = commitChange(prepared);
      const payload = { updated: true, plan: prepared.plan, receipt };
      if (asJson) printJson(payload);
      else console.log(`Updated ${receipt.id} to ${receipt.version}.`);
      return payload;
    } catch (error) {
      failStore(op, error, asJson);
    }
  }

  @Command({ name: "rollback", description: "Go back to the previous installed version of a store app" })
  @CommandAccess({ kind: "mutate", resource: "apps", action: "rollback", risk: "medium", requiresConfirmation: true })
  @CliOnly()
  async rollback(
    @Arg("id", { description: "Installed app id" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--execute", description: "Roll back; default is a dry-run that shows the plan (exit 3)" })
    execute?: boolean,
  ) {
    const op = "apps rollback";
    requireOperatorTerminal(op, asJson);
    try {
      const plan = planRollback(appId(op, id, asJson));
      if (!execute) {
        if (!asJson) printPlan(plan);
        contractDryRun(op, { ...plan }, { asJson });
      }
      const receipt = commitRollback(plan);
      const payload = { rolledBack: true, plan, receipt };
      if (asJson) printJson(payload);
      else console.log(`${receipt.id} is back on ${receipt.version}.`);
      return payload;
    } catch (error) {
      failStore(op, error, asJson);
    }
  }

  @Command({ name: "uninstall", description: "Remove a store app (kept in the store's trash)" })
  @CommandAccess({ kind: "mutate", resource: "apps", action: "uninstall", risk: "medium" })
  @CliOnly()
  async uninstall(
    @Arg("id", { description: "Installed app id" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "apps uninstall";
    requireOperatorTerminal(op, asJson);
    try {
      const result = uninstallApp(appId(op, id, asJson));
      const payload = { uninstalled: true, ...result };
      if (asJson) printJson(payload);
      else console.log(`Uninstalled ${result.id}@${result.version}; its files are in ${result.trash}.`);
      return payload;
    } catch (error) {
      failStore(op, error, asJson);
    }
  }

  @Command({ name: "allow", description: "Let one agent see and run a store app" })
  @CommandAccess({ kind: "mutate", resource: "apps", action: "allow", risk: "high", requiresConfirmation: true })
  @CliOnly()
  async allow(
    @Arg("id", { description: "Installed app id" }) id: string,
    @Option({ flags: "--agent <agent>", description: "Agent id" }) agent?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--execute", description: "Allow; default is a dry-run that shows the plan (exit 3)" })
    execute?: boolean,
  ) {
    const op = "apps allow";
    requireOperatorTerminal(op, asJson);
    if (!agent) {
      contractFail(op, "USAGE_ERROR", "--agent is required.", {
        asJson,
        exitCode: CONTRACT_EXIT_USAGE,
        diagnostic: errorDiagnostic("--agent is required.", { operation: op }),
      });
    }
    try {
      const normalized = appId(op, id, asJson);
      if (!execute) {
        contractDryRun(
          op,
          {
            id: normalized,
            agent,
            note: "The agent still needs its own grants for what the app runs (for example execute:group:pages).",
          },
          { asJson },
        );
      }
      const { receipt, changed } = setExposure(normalized, agent, true);
      const payload = { id: receipt.id, agent, changed, exposedTo: receipt.exposedTo };
      if (asJson) printJson(payload);
      else console.log(`${receipt.id} is visible to ${receipt.exposedTo.join(", ")}.`);
      return payload;
    } catch (error) {
      failStore(op, error, asJson);
    }
  }

  @Command({ name: "revoke", description: "Hide a store app from one agent" })
  @CommandAccess({ kind: "mutate", resource: "apps", action: "revoke", risk: "low" })
  @CliOnly()
  async revoke(
    @Arg("id", { description: "Installed app id" }) id: string,
    @Option({ flags: "--agent <agent>", description: "Agent id" }) agent?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "apps revoke";
    requireOperatorTerminal(op, asJson);
    if (!agent) {
      contractFail(op, "USAGE_ERROR", "--agent is required.", {
        asJson,
        exitCode: CONTRACT_EXIT_USAGE,
        diagnostic: errorDiagnostic("--agent is required.", { operation: op }),
      });
    }
    try {
      const { receipt, changed } = setExposure(appId(op, id, asJson), agent, false);
      const payload = { id: receipt.id, agent, changed, exposedTo: receipt.exposedTo };
      if (asJson) printJson(payload);
      else console.log(`${receipt.id} is visible to ${receipt.exposedTo.join(", ") || "no agent"}.`);
      return payload;
    } catch (error) {
      failStore(op, error, asJson);
    }
  }
}

function readKey(op: string, path: string | undefined, asJson?: boolean): string {
  if (!path) {
    contractFail(op, "USAGE_ERROR", "--key <path> is required.", {
      asJson,
      exitCode: CONTRACT_EXIT_USAGE,
      diagnostic: errorDiagnostic("--key <path> is required.", { operation: op }),
    });
  }
  return readFileSync(resolve(path.replace(/^~(?=\/|$)/, process.env.HOME ?? "~")), "utf8");
}

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

@Group({
  name: "apps.index",
  description: "Build and sign a Ravi Apps index repository (maintainers)",
  scope: "open",
})
export class AppsIndexCommands {
  @Command({ name: "build", description: "Build bundles and an unsigned index.json from apps/<id>/ folders" })
  @CommandAccess({ kind: "mutate", resource: "apps.index", action: "build", risk: "low" })
  @CliOnly()
  async build(
    @Arg("dir", { required: false, description: "Index repository folder (default: current folder)" }) dir?: string,
    @Option({ flags: "--publisher <name>", description: "Publisher name for new apps (default: ravi)" })
    publisher?: string,
    @Option({ flags: "--expires-days <n>", description: "Days until the index expires (default: 30)" })
    expiresDays?: string,
    @Option({ flags: "--check", description: "Validate and print the result without writing" }) check?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "apps index build";
    requireOperatorTerminal(op, asJson);
    try {
      const result = buildIndex({
        repoDir: resolve(dir ?? "."),
        publisher,
        expiresDays: expiresDays ? Number(expiresDays) : undefined,
        dryRun: check === true,
      });
      if (asJson) printJson(result);
      else {
        for (const entry of result.added)
          console.log(`+ ${entry.id}@${entry.version} (${entry.class}) ${entry.treeHash}`);
        for (const entry of result.unchanged) console.log(`= ${entry.id}@${entry.version}`);
        console.log(
          result.written
            ? `index.json serial ${result.index.serial} written; sign it with ravi apps index sign index.json --key <publish key>.`
            : "Check passed; nothing was written.",
        );
      }
      return result;
    } catch (error) {
      failStore(op, error, asJson);
    }
  }

  @Command({ name: "sign", description: "Sign keys.json, index.json or blocklist.json with an Ed25519 key file" })
  @CommandAccess({ kind: "mutate", resource: "apps.index", action: "sign", risk: "medium" })
  @CliOnly()
  async sign(
    @Arg("file", { description: "File to sign; writes <file>.sig" }) file: string,
    @Option({ flags: "--key <path>", description: "Ed25519 private key (PKCS#8 PEM)" }) key?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "apps index sign";
    requireOperatorTerminal(op, asJson);
    try {
      const result = signFile(resolve(file), readKey(op, key, asJson));
      const payload = { file: resolve(file), signature: `${resolve(file)}.sig`, publicKey: result.publicKey };
      if (asJson) printJson(payload);
      else console.log(`Signed ${payload.file} with ${payload.publicKey}.`);
      return payload;
    } catch (error) {
      failStore(op, error, asJson);
    }
  }

  @Command({ name: "keys", description: "Write keys.json naming the publication and block keys" })
  @CommandAccess({ kind: "mutate", resource: "apps.index", action: "keys", risk: "medium" })
  @CliOnly()
  async keys(
    @Arg("dir", { required: false, description: "Index repository folder (default: current folder)" }) dir?: string,
    @Option({ flags: "--publish <keys>", description: "Publication public keys, comma-separated" }) publish?: string,
    @Option({ flags: "--block <keys>", description: "Block-list public keys, comma-separated" }) block?: string,
    @Option({ flags: "--expires-days <n>", description: "Days until keys.json expires (default: 365)" })
    expiresDays?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "apps index keys";
    requireOperatorTerminal(op, asJson);
    try {
      const keys = writeKeysFile({
        repoDir: resolve(dir ?? "."),
        publish: list(publish),
        block: list(block),
        expiresDays: expiresDays ? Number(expiresDays) : undefined,
      });
      if (asJson) printJson(keys);
      else console.log(`keys.json serial ${keys.serial} written; sign it with the root key.`);
      return keys;
    } catch (error) {
      failStore(op, error, asJson);
    }
  }

  @Command({ name: "block", description: "Add an app version to blocklist.json, or renew it without --id" })
  @CommandAccess({ kind: "mutate", resource: "apps.index", action: "block", risk: "medium" })
  @CliOnly()
  async block(
    @Arg("dir", { required: false, description: "Index repository folder (default: current folder)" }) dir?: string,
    @Option({ flags: "--id <id>", description: "App id to block; omit to only renew the list" }) id?: string,
    @Option({ flags: "--version <version>", description: "Version to block (default: every version)" })
    version?: string,
    @Option({ flags: "--reason <text>", description: "Why it is blocked (shown to operators)" }) reason?: string,
    @Option({ flags: "--expires-days <n>", description: "Days until the list expires (default: 30)" })
    expiresDays?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "apps index block";
    requireOperatorTerminal(op, asJson);
    try {
      const options = {
        repoDir: resolve(dir ?? "."),
        expiresDays: expiresDays ? Number(expiresDays) : undefined,
      };
      const blocklist = id
        ? addBlock({ ...options, id: appId(op, id, asJson), version, reason: reason ?? "" })
        : renewBlocklist(options);
      if (asJson) printJson(blocklist);
      else console.log(`blocklist.json serial ${blocklist.serial} written; sign it with the block key.`);
      return blocklist;
    } catch (error) {
      failStore(op, error, asJson);
    }
  }

  @Command({ name: "verify", description: "Verify a source folder the way a Ravi client would" })
  @CommandAccess({ kind: "read", resource: "apps.index", action: "verify", risk: "low" })
  @CliOnly()
  async verify(
    @Arg("dir", { required: false, description: "Index repository folder (default: current folder)" }) dir?: string,
    @Option({ flags: "--root <keys>", description: "Root public keys, comma-separated (default: the ones in Ravi)" })
    root?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const rootKeys = root ? list(root) : [...OFFICIAL_APP_SOURCE.rootKeys];
    const report = verifyRepo(resolve(dir ?? "."), rootKeys);
    if (!report.ok) {
      if (!asJson) for (const problem of report.problems) console.log(`- ${problem}`);
      contractFail("apps index verify", "APP_INDEX_INVALID", report.problems.join("; "), {
        asJson,
        details: { problems: report.problems },
        diagnostic: errorDiagnostic("The index folder does not verify.", { operation: "apps index verify" }),
      });
    }
    if (asJson) printJson(report);
    else console.log(`OK: ${report.apps} apps, index serial ${report.indexSerial}.`);
    return report;
  }
}
