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
import { registerCommands } from "./registry.js";
import * as allCommands from "./commands/index.js";

const program = new Command();

program
  .name("ravi")
  .description("Ravi Bot CLI - Claude-powered bot management")
  .version("0.1.0");

// Register all command groups (auto-discovered from barrel)
registerCommands(program, Object.values(allCommands));

// Parse and execute
program.parse();
