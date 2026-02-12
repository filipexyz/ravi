/**
 * Slash Command Registry
 *
 * Handles registration, parsing, permission checking, and execution
 * of slash commands intercepted at the gateway layer.
 */

import type { ChannelPlugin } from "../channels/types.js";
import type { RouterConfig } from "../router/types.js";
import { getContact } from "../contacts.js";
import { logger } from "../utils/logger.js";

const log = logger.child("slash");

// ============================================================================
// Types
// ============================================================================

export type SlashPermission = "all" | "admin";

export interface SlashCommand {
  name: string;
  description: string;
  permission: SlashPermission;
  handler: (ctx: SlashContext) => Promise<string | null>;
}

export interface SlashContext {
  senderId: string;
  senderName?: string;
  chatId: string;
  isGroup: boolean;
  args: string[];
  mentions?: string[];
  plugin: ChannelPlugin;
  accountId: string;
  routerConfig: RouterConfig;
}

interface HandleInput {
  text: string;
  senderId: string;
  senderName?: string;
  chatId: string;
  isGroup: boolean;
  mentions?: string[];
  plugin: ChannelPlugin;
  accountId: string;
  routerConfig: RouterConfig;
}

// ============================================================================
// Registry
// ============================================================================

const commands = new Map<string, SlashCommand>();

export function registerCommand(cmd: SlashCommand): void {
  commands.set(cmd.name.toLowerCase(), cmd);
  log.debug("Registered slash command", { name: cmd.name, permission: cmd.permission });
}

export function getCommand(name: string): SlashCommand | undefined {
  return commands.get(name.toLowerCase());
}

export function listCommands(isAdmin: boolean): SlashCommand[] {
  const all = Array.from(commands.values());
  if (isAdmin) return all;
  return all.filter(c => c.permission === "all");
}

// ============================================================================
// Parser
// ============================================================================

export function parseSlashCommand(text: string): { name: string; args: string[] } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;

  const parts = trimmed.slice(1).split(/\s+/);
  const name = parts[0]?.toLowerCase();
  if (!name) return null;

  return { name, args: parts.slice(1) };
}

// ============================================================================
// Handler
// ============================================================================

/**
 * Attempt to handle a slash command.
 * Returns true if the command was handled (intercepted), false if it should
 * fall through to normal message processing.
 */
export async function handleSlashCommand(input: HandleInput): Promise<boolean> {
  const parsed = parseSlashCommand(input.text);
  if (!parsed) return false;

  const cmd = getCommand(parsed.name);
  if (!cmd) return false; // Unknown command → fall through

  // Permission check
  if (cmd.permission === "admin") {
    const contact = getContact(input.senderId);
    const isAdmin = contact?.tags.includes("admin") ?? false;
    if (!isAdmin) {
      log.info("Slash command denied (no admin tag)", {
        command: parsed.name,
        senderId: input.senderId,
      });
      return false; // No permission → fall through as normal message
    }
  }

  log.info("Executing slash command", {
    command: parsed.name,
    senderId: input.senderId,
    args: parsed.args,
  });

  try {
    const response = await cmd.handler({
      senderId: input.senderId,
      senderName: input.senderName,
      chatId: input.chatId,
      isGroup: input.isGroup,
      args: parsed.args,
      mentions: input.mentions,
      plugin: input.plugin,
      accountId: input.accountId,
      routerConfig: input.routerConfig,
    });

    // Send response if handler returned text
    if (response) {
      await input.plugin.outbound.send(input.accountId, input.chatId, {
        text: response,
      });
    }
  } catch (err) {
    log.error("Slash command error", { command: parsed.name, error: err });
    await input.plugin.outbound.send(input.accountId, input.chatId, {
      text: `⚠️ Error executing /${parsed.name}`,
    });
  }

  return true;
}
