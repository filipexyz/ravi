/**
 * /help — List available slash commands
 */

import { getContact } from "../../contacts.js";
import { listCommands } from "../registry.js";
import type { SlashCommand, SlashContext } from "../registry.js";

export const helpCommand: SlashCommand = {
  name: "help",
  description: "Lista comandos disponíveis",
  permission: "all",
  handler: async (ctx: SlashContext): Promise<string> => {
    const contact = getContact(ctx.senderId);
    const isAdmin = contact?.tags.includes("admin") ?? false;
    const cmds = listCommands(isAdmin);

    if (cmds.length === 0) {
      return "Nenhum comando disponível.";
    }

    const lines = cmds.map(c => {
      const lock = c.permission === "admin" ? " 🔒" : "";
      return `/${c.name}${lock} — ${c.description}`;
    });

    return `⚡ Comandos (${cmds.length})\n\n${lines.join("\n")}`;
  },
};
