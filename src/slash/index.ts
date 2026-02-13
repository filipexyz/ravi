/**
 * Slash Commands — barrel export + auto-registration
 */

export { registerCommand, handleSlashCommand, listCommands, getCommand } from "./registry.js";
export type { SlashCommand, SlashContext, SlashPermission } from "./registry.js";

// Auto-register built-in commands
import { registerCommand } from "./registry.js";
import { resetCommand } from "./commands/reset.js";
import { restartCommand } from "./commands/restart.js";
import { helpCommand } from "./commands/help.js";

registerCommand(resetCommand);
registerCommand(restartCommand);
registerCommand(helpCommand);
