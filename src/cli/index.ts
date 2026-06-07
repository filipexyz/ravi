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
import { runDoctor } from "./commands/doctor.js";
import { runSetup } from "./commands/setup.js";
import { runUpdate } from "./commands/update.js";
import { runCloudAuthRootCommand, runLogin, runLogout, runWhoami } from "./commands/cloud-auth.js";
import { emitCliAuditEvent, runWithCliAudit } from "./audit.js";
import { configureCliLogging } from "./logging.js";
import { spawnDirectTui } from "./tui-launcher.js";
import { maybeRunAppAliasRoute } from "../apps/router.js";
import { buildRootOperationalHelp } from "../runtime/runtime-operational-context.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf-8"));
const projectRoot = join(__dirname, "../..");

configureCliLogging();

const program = new Command();

function isRootVersionRequest(args: string[]): boolean {
  return args.length === 1 && (args[0] === "--version" || args[0] === "-V");
}

if (isRootVersionRequest(process.argv.slice(2))) {
  console.log(pkg.version);
  process.exit(0);
}

program
  .name("ravi")
  .description("Ravi Bot CLI - Claude-powered bot management")
  .addHelpText("after", `\nRoot options:\n  ravi --version    Print Ravi CLI version\n${buildRootOperationalHelp()}`);

program.showSuggestionAfterError();

// Register all command groups (auto-discovered from barrel)
registerCommands(program, Object.values(allCommands) as Array<new () => object>);

// Top-level commands (not via decorator groups)
program
  .command("doctor")
  .description("Inspect critical Ravi runtime, substrate, and contract health")
  .option("--json", "Print raw JSON result")
  .action(async (options: { json?: boolean }) => {
    await runWithCliAudit(
      {
        group: "_root",
        name: "doctor",
        tool: "root_doctor",
        input: options,
        closeLazyConnection: true,
      },
      () => runDoctor({ json: options.json }),
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
  .description("Update Ravi CLI to the configured npm channel")
  .option("--next", "Switch to dev builds (npm @next tag)")
  .option("--stable", "Switch to stable releases (npm @latest tag)")
  .action(async (options: { next?: boolean; stable?: boolean }) => {
    await runWithCliAudit(
      {
        group: "_root",
        name: "update",
        tool: "root_update",
        input: options,
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

// Parse and execute
maybeSuggestKnownRootCommand(process.argv.slice(2), program);

const handledByAppAlias = await maybeRunAppAliasRoute(process.argv.slice(2), {
  staticRootCommands: rootCommandNames(program),
});
if (handledByAppAlias) process.exit(process.exitCode ?? 0);

program.parse();

function maybeSuggestKnownRootCommand(args: string[], command: Command): void {
  const requested = args[0];
  if (!requested || requested.startsWith("-")) return;

  const known = rootCommandNames(command);
  if (known.has(requested)) return;

  const suggestion = resolveKnownRootCommandSuggestion(requested, known);
  if (!suggestion) return;

  const suggestedArgs = [suggestion, ...args.slice(1)];
  console.error(`Unknown command: ravi ${requested}`);
  console.error(`Did you mean: ravi ${suggestedArgs.join(" ")}?`);
  process.exit(1);
}

function resolveKnownRootCommandSuggestion(requested: string, known: Set<string>): string | undefined {
  const explicit: Record<string, string> = {
    task: "tasks",
  };
  const explicitSuggestion = explicit[requested];
  if (explicitSuggestion && known.has(explicitSuggestion)) return explicitSuggestion;

  const plural = `${requested}s`;
  if (known.has(plural)) return plural;
  return undefined;
}

function rootCommandNames(command: Command): Set<string> {
  const names = new Set<string>();
  for (const subcommand of command.commands) {
    names.add(subcommand.name());
    for (const alias of subcommand.aliases()) names.add(alias);
  }
  return names;
}
