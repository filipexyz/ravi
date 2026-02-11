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

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf-8"));

const program = new Command();

program
  .name("ravi")
  .description("Ravi Bot CLI - Claude-powered bot management")
  .version(pkg.version);

// Register all command groups (auto-discovered from barrel)
registerCommands(program, Object.values(allCommands));

// Parse and execute
program.parse();
