import "reflect-metadata";
import { Command } from "commander";
import { ContextCommands } from "../commands/context.js";
import { registerCommands } from "../registry.js";

const program = new Command();
registerCommands(program, [ContextCommands]);
await program.parseAsync();
