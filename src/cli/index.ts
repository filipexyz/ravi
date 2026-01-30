#!/usr/bin/env tsx
/**
 * Ravi Bot CLI - Unified command-line interface
 *
 * Uses Commander.js + custom decorators for declarative command definition.
 */

import "reflect-metadata";
import { Command } from "commander";
import { registerCommands } from "./registry.js";

// Import command classes
import { AgentsCommands } from "./commands/agents.js";
import { ContactsCommands } from "./commands/contacts.js";
import { ServiceCommands } from "./commands/service.js";

const program = new Command();

program
  .name("ravi")
  .description("Ravi Bot CLI - Claude-powered bot management")
  .version("0.1.0");

// Register all command groups
registerCommands(program, [AgentsCommands, ContactsCommands, ServiceCommands]);

// Parse and execute
program.parse();
