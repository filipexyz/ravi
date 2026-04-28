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
import { emitCliAuditEvent, runWithCliAudit } from "./audit.js";
import { configureCliLogging } from "./logging.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf-8"));

configureCliLogging();

const program = new Command();

program.name("ravi").description("Ravi Bot CLI - Claude-powered bot management").version(pkg.version);

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
        await spawnDirectTui(session);
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
program.parse();

async function spawnDirectTui(session: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  const { existsSync } = await import("node:fs");
  const projectRoot = join(__dirname, "../..");
  const tuiPath = existsSync(join(projectRoot, "src/tui/index.tsx"))
    ? join(projectRoot, "src/tui/index.tsx")
    : join(projectRoot, "dist/tui/index.tsx");

  await new Promise<void>((resolve, reject) => {
    const child = spawn("bun", [tuiPath, session], {
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if ((code ?? 0) !== 0) {
        reject(new Error(`TUI exited with code ${code ?? 0}`));
        return;
      }
      resolve();
    });
  });
}
