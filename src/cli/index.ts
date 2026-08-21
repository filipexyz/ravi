#!/usr/bin/env tsx
/**
 * Ravi Bot CLI - Unified command-line interface
 *
 * Uses Commander.js + custom decorators for declarative command definition.
 *
 * For programmatic access to CLI tools (without running the CLI),
 * import from "./cli/exports.js" instead.
 */

// MUST be first import - loads ~/.ravi/.env before other modules initialize
import "./env.js";

import "reflect-metadata";
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { registerCommands } from "./registry.js";
import * as allCommands from "./commands/index.js";
import {
  ContractError,
  contractFailureOutcome,
  installRootUsageContract,
  installUsageContract,
  renderContractError,
  unexpectedErrorToContractError,
} from "./agent-contract.js";
import { runDoctor } from "./commands/doctor.js";
import { runSetup } from "./commands/setup.js";
import { maybeRunManagedRuntimeRebindFromEnv } from "../managed-runtime-rebind.js";
import { runUpdate, type RaviUpdateOptions } from "./commands/update.js";
import { runCloudAuthRootCommand, runLogin, runLogout, runWhoami } from "./commands/cloud-auth.js";
import { emitCliAuditEvent, runWithCliAudit, wasContractErrorAudited } from "./audit.js";
import { configureCliLogging } from "./logging.js";
import { spawnDirectTui } from "./tui-launcher.js";
import { maybeRunAppAliasRoute } from "../apps/router.js";
import { buildRootOperationalHelp } from "../runtime/runtime-operational-context.js";
import { CliTerminationRequest, terminateCliProcess, writeProcessStdout } from "./process-output.js";
import { getContext } from "./context.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf-8"));
const projectRoot = join(__dirname, "../..");

configureCliLogging();

const program = new Command();

function isRootVersionRequest(args: string[]): boolean {
  return args.length === 1 && (args[0] === "--version" || args[0] === "-V");
}

program
  .name("ravi")
  .description("Ravi Bot CLI - Claude-powered bot management")
  .addHelpText(
    "after",
    `\nRoot options:\n  ravi --version    Print Ravi CLI version\n${buildRootOperationalHelp(
      process.env,
      getContext({ touch: false, readOnly: true })?.context ?? null,
    )}`,
  );

program.showSuggestionAfterError();

// Register all command groups (auto-discovered from barrel)
registerCommands(program, Object.values(allCommands) as Array<new () => object>);

// Manual v2 contract, installed per migrated domain group: commander usage
// errors (unknown flag, missing required argument) exit 2 with the error
// envelope instead of plain text with exit 1. Unlisted groups keep commander's
// default behavior until they are migrated.
const AGENT_CONTRACT_DOMAINS = [
  "agents",
  "artifacts",
  "audio",
  "bridges",
  "calendars",
  "channels",
  "chats",
  "cloud",
  "commands",
  "connectors",
  "contacts",
  "context",
  "costs",
  "credentials",
  "crm",
  "cron",
  "devin",
  "feedback",
  "gmail",
  "heartbeat",
  "hooks",
  "image",
  "inbox",
  "insights",
  "instances",
  "mail",
  "media",
  "meetings",
  "metrics",
  "observers",
  "pages",
  "projects",
  "prox",
  "react",
  "routes",
  "rules",
  "runtime",
  "self",
  "sessions",
  "settings",
  "skill-gates",
  "skills",
  "slack",
  "specs",
  "stickers",
  "sync",
  "tag-rules",
  "tags",
  "tasks",
  "threads",
  "transcribe",
  "triggers",
  "video",
  "watch",
  "whatsapp",
  "work-objects",
  "workflows",
  "yt",
];
for (const domain of AGENT_CONTRACT_DOMAINS) installUsageContract(program, domain);

// Top-level commands (not via decorator groups)
program
  .command("doctor")
  .description("Inspect critical Ravi runtime, substrate, and contract health")
  .option("--json", "Print raw JSON result")
  .option("--full", "Print full informational findings and evidence")
  .option("--strict", "Exit non-zero on warnings")
  .option("--domain <domain>", "Run one doctor domain")
  .action(async (options: { json?: boolean; full?: boolean; strict?: boolean; domain?: string }) => {
    await runWithCliAudit(
      {
        group: "_root",
        name: "doctor",
        tool: "root_doctor",
        input: options,
        closeLazyConnection: true,
      },
      () =>
        runDoctor({
          json: options.json,
          full: options.full,
          strict: options.strict,
          domain: options.domain,
          setExitCode: true,
        }),
    );
  });

program
  .command("setup")
  .description("Wizard interativo de configuração")
  .action(async () => {
    await runWithCliAudit(
      {
        group: "_root",
        name: "setup",
        tool: "root_setup",
        closeLazyConnection: true,
      },
      () => runSetup(),
    );
  });

program
  .command("update")
  .description("Update Ravi CLI to an exact release or configured npm channel")
  .option("--version <version>", "Install one exact Ravi release")
  .option("--expected-integrity <sri>", "Require the npm sha512 SRI for an exact release")
  .option("--next", "Switch to dev builds (npm @next tag)")
  .option("--stable", "Switch to stable releases (npm @latest tag)")
  .option("--no-restart", "Do not restart managed Ravi processes after updating")
  .option("--json", "Print a machine-readable result")
  .action(async (options: RaviUpdateOptions) => {
    await runWithCliAudit(
      {
        group: "_root",
        name: "update",
        tool: "root_update",
        input: { ...options },
        closeLazyConnection: true,
      },
      () => runUpdate(options),
    );
  });

program
  .command("login")
  .description("Link this local Ravi CLI to a Console-compatible endpoint")
  .option("--console <url>", "Console base URL", "https://console.ravi.bot")
  .option("--json", "Print raw JSON result")
  .option("--no-open", "Do not open a browser")
  .option("--no-poll", "Do not poll the exchange endpoint when auth is pending")
  .option("--timeout-seconds <seconds>", "Maximum login polling time", "300")
  .option("--interval-seconds <seconds>", "Login polling interval")
  .action(
    async (options: {
      console?: string;
      json?: boolean;
      open?: boolean;
      poll?: boolean;
      timeoutSeconds?: string;
      intervalSeconds?: string;
    }) => {
      await runWithCliAudit(
        {
          group: "_root",
          name: "login",
          tool: "root_login",
          input: options,
          closeLazyConnection: true,
        },
        () => runCloudAuthRootCommand(options.json, () => runLogin(options)),
      );
    },
  );

program
  .command("whoami")
  .description("Show the linked Ravi Cloud CLI identity")
  .option("--console <url>", "Console base URL")
  .option("--json", "Print raw JSON result")
  .action(async (options: { console?: string; json?: boolean }) => {
    await runWithCliAudit(
      {
        group: "_root",
        name: "whoami",
        tool: "root_whoami",
        input: options,
        closeLazyConnection: true,
      },
      () => runCloudAuthRootCommand(options.json, () => runWhoami(options)),
    );
  });

program
  .command("logout")
  .description("Remove local Ravi Cloud CLI credentials and revoke them in Console when possible")
  .option("--console <url>", "Console base URL")
  .option("--json", "Print raw JSON result")
  .action(async (options: { console?: string; json?: boolean }) => {
    await runWithCliAudit(
      {
        group: "_root",
        name: "logout",
        tool: "root_logout",
        input: options,
        closeLazyConnection: true,
      },
      () => runCloudAuthRootCommand(options.json, () => runLogout(options)),
    );
  });

// TUI - full-screen terminal interface
program
  .command("tui")
  .description("Open the terminal UI for a session")
  .argument("[session]", "Session name or key", "main")
  .action(async (session: string) => {
    await runWithCliAudit(
      {
        group: "_root",
        name: "tui",
        tool: "root_tui",
        input: { session },
        closeLazyConnection: true,
      },
      async () => {
        await spawnDirectTui(session, projectRoot);
      },
    );
  });

program
  .command("stream")
  .description("Run the Ravi JSONL stdio stream server")
  .option("--scope <scope>", "Stream scope preset", "events")
  .option("--topic <pattern...>", "Override topic patterns")
  .option("--heartbeat-ms <ms>", "Heartbeat interval in milliseconds", "5000")
  .action(async (options: { scope: string; topic?: string[]; heartbeatMs: string }) => {
    await emitCliAuditEvent({
      group: "_root",
      name: "stream",
      tool: "root_stream",
      input: options,
      status: "started",
      closeLazyConnection: false,
    });
    await runWithCliAudit(
      {
        group: "_root",
        name: "stream",
        tool: "root_stream",
        input: options,
        closeLazyConnection: false,
      },
      async () => {
        const { runCliStreamServer } = await import("../stream/server.js");
        await runCliStreamServer({
          scope: options.scope,
          topicPatterns: options.topic,
          heartbeatMs: Number.parseInt(options.heartbeatMs, 10) || 5000,
        });
      },
    );
  });

// Parse and execute. Root parser failures use the same exit-2 contract as
// migrated domain nodes, including unknown command suggestions.
installRootUsageContract(program);

void bootstrapCli().catch(async (error: unknown) => {
  if (error instanceof CliTerminationRequest) {
    return terminateCliProcess(error.exitCode);
  }
  if (error instanceof ContractError) {
    // Contract helpers render once and throw. Audit the semantic outcome before
    // preserving the process taxonomy (1 failure · 2 usage · 3 blocked).
    if (!wasContractErrorAudited(error) && !isSelfReadOperation(error.op)) {
      const [group = "cli", ...operationParts] = error.op.trim().split(/\s+/);
      await emitCliAuditEvent({
        group,
        name: operationParts.join("_") || "root",
        tool: error.op.replace(/\s+/g, "_"),
        outcome: contractFailureOutcome(error),
        exitCode: error.exitCode,
        errorCode: error.code,
        status: "completed",
        closeLazyConnection: true,
      });
    }
    return terminateCliProcess(error.exitCode);
  }
  const contractError = unexpectedErrorToContractError("cli bootstrap");
  renderContractError(contractError, process.argv.includes("--json"));
  await emitCliAuditEvent({
    group: "cli",
    name: "bootstrap",
    tool: "cli_bootstrap",
    outcome: contractFailureOutcome(contractError),
    exitCode: contractError.exitCode,
    errorCode: contractError.code,
    status: "completed",
    closeLazyConnection: true,
  });
  return terminateCliProcess(contractError.exitCode);
});

async function bootstrapCli(): Promise<void> {
  if (isRootVersionRequest(process.argv.slice(2))) {
    await writeProcessStdout(`${pkg.version}\n`);
    return terminateCliProcess(0);
  }

  if (await maybeRunManagedRuntimeRebindFromEnv()) return;

  const handledByAppAlias = await maybeRunAppAliasRoute(process.argv.slice(2), {
    staticRootCommands: rootCommandNames(program),
  });
  if (handledByAppAlias) {
    return terminateCliProcess(process.exitCode ?? 0);
  }

  await program.parseAsync();
}

function isSelfReadOperation(operation: string): boolean {
  return /^self (whoami|context|chat|route|recent|permissions|knowledge|explain)$/.test(operation.trim());
}

function rootCommandNames(command: Command): Set<string> {
  const names = new Set<string>();
  for (const subcommand of command.commands) {
    names.add(subcommand.name());
    for (const alias of subcommand.aliases()) names.add(alias);
  }
  return names;
}
