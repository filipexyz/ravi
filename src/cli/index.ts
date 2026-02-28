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
import { runSetup } from "./commands/setup.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf-8"));

const program = new Command();

program.name("ravi").description("Ravi Bot CLI - Claude-powered bot management").version(pkg.version);

// Register all command groups (auto-discovered from barrel)
registerCommands(program, Object.values(allCommands));

// Top-level commands (not via decorator groups)
program
  .command("setup")
  .description("Wizard interativo de configuração")
  .action(async () => {
    await runSetup();
  });

// TUI - full-screen terminal interface
program
  .command("tui")
  .description("Open the terminal UI (connects via NATS)")
  .argument("[session]", "Session name to connect to", "main")
  .action(async (session: string) => {
    // Dynamic import to avoid loading OpenTUI for non-TUI commands
    const { spawn } = await import("node:child_process");
    const { existsSync } = await import("node:fs");
    // __dirname points to dist/bundle/ when running from built CLI,
    // so resolve from package.json location instead
    const projectRoot = join(__dirname, "../..");
    const tuiPath = existsSync(join(projectRoot, "src/tui/index.tsx"))
      ? join(projectRoot, "src/tui/index.tsx")
      : join(projectRoot, "dist/tui/index.tsx");
    const child = spawn("bun", [tuiPath, session], {
      stdio: "inherit",
      env: process.env,
    });
    child.on("exit", (code) => process.exit(code ?? 0));
  });

// Parse and execute
program.parse();
