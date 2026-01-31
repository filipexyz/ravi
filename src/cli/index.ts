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

// Import command classes
import { AgentsCommands } from "./commands/agents.js";
import { ChannelsCommands } from "./commands/channels.js";
import { ContactsCommands } from "./commands/contacts.js";
import { ServiceCommands } from "./commands/service.js";
import { DaemonCommands } from "./commands/daemon.js";
import { ToolsCommands } from "./commands/tools.js";
import { RoutesCommands } from "./commands/routes.js";
import { SettingsCommands } from "./commands/settings.js";
import { CrossCommands } from "./commands/cross.js";
import { MatrixCommands } from "./commands/matrix.js";

const program = new Command();

program
  .name("ravi")
  .description("Ravi Bot CLI - Claude-powered bot management")
  .version("0.1.0");

// Register all command groups
registerCommands(program, [
  AgentsCommands,
  ChannelsCommands,
  ContactsCommands,
  ServiceCommands,
  DaemonCommands,
  ToolsCommands,
  RoutesCommands,
  SettingsCommands,
  CrossCommands,
  MatrixCommands,
]);

// Parse and execute
program.parse();
