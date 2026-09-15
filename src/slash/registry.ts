/**
 * Slash Command Registry
 *
 * Handles registration, parsing, permission checking, and execution
 * of slash commands intercepted at the gateway layer.
 */

import { randomUUID } from "node:crypto";
import type { RouterConfig } from "../router/types.js";
import { getContact } from "../contacts.js";
import {
  NATIVE_CHANNEL_DRIVER_PROTOCOL,
  NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION,
  NativeInboundChannelActionRequestSchema,
  type NativeInboundChannelActionRequest,
  type NativeInboundChannelActionResult,
} from "../channels/native/driver.js";
import { configuredNativeInboundActionNames, requestNativeInboundChannelAction } from "../channels/inbound-actions.js";
import { getNats } from "../nats.js";
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
  /** Channel type identifier (e.g. "whatsapp-baileys") */
  channelType: string;
  accountId: string;
  routerConfig: RouterConfig;
  /** Send a message to the chat */
  send: (accountId: string, chatId: string, text: string) => Promise<void>;
}

interface HandleInput {
  text: string;
  messageId: string;
  senderId: string;
  senderName?: string;
  chatId: string;
  isGroup: boolean;
  mentions?: string[];
  channelType: string;
  accountId: string;
  routerConfig: RouterConfig;
  send: (accountId: string, chatId: string, text: string) => Promise<void>;
}

export interface HandleSlashCommandOptions {
  nativeInboundActions?: ReadonlySet<string>;
  requestNativeInboundAction?: (
    request: NativeInboundChannelActionRequest,
  ) => Promise<NativeInboundChannelActionResult | null>;
}

// ============================================================================
// Registry
// ============================================================================

const commands = new Map<string, SlashCommand>();
let configuredActionSource: string | undefined;
let configuredActions = new Set<string>();

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
  return all.filter((c) => c.permission === "all");
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
export async function handleSlashCommand(
  input: HandleInput,
  options: HandleSlashCommandOptions = {},
): Promise<boolean> {
  const parsed = parseSlashCommand(input.text);
  if (!parsed) return false;

  const cmd = getCommand(parsed.name);
  if (!cmd) {
    if (!(options.nativeInboundActions ?? nativeInboundActions()).has(parsed.name)) return false;
    const request = NativeInboundChannelActionRequestSchema.parse({
      protocol: NATIVE_CHANNEL_DRIVER_PROTOCOL,
      schemaVersion: NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION,
      requestId: `channel-action-${randomUUID()}`,
      action: parsed.name,
      hasArguments: parsed.args.length > 0,
      identity: {
        channelKind: input.channelType,
        accountId: input.accountId,
        conversationId: input.chatId,
        senderId: input.senderId,
        messageId: input.messageId,
      },
      requestedAt: new Date().toISOString(),
    });
    let result;
    try {
      result = options.requestNativeInboundAction
        ? await options.requestNativeInboundAction(request)
        : await requestNativeInboundChannelAction(request, {
            connection: getNats(),
          });
    } catch {
      result = null;
    }
    if (result?.disposition === "handled" && result.text !== undefined) {
      await input.send(input.accountId, input.chatId, result.text);
      return true;
    }
    await input.send(input.accountId, input.chatId, `⚠️ /${parsed.name} is temporarily unavailable.`);
    return true;
  }

  // Permission check
  if (cmd.permission === "admin") {
    const contact = getContact(input.senderId);
    const isAdmin = contact?.tags.includes("admin") ?? false;
    if (!isAdmin) {
      log.info("Slash command denied (no admin tag)", {
        command: parsed.name,
      });
      return false; // No permission → fall through as normal message
    }
  }

  log.info("Executing slash command", {
    command: parsed.name,
    hasArguments: parsed.args.length > 0,
  });

  try {
    const response = await cmd.handler({
      senderId: input.senderId,
      senderName: input.senderName,
      chatId: input.chatId,
      isGroup: input.isGroup,
      args: parsed.args,
      mentions: input.mentions,
      channelType: input.channelType,
      accountId: input.accountId,
      routerConfig: input.routerConfig,
      send: input.send,
    });

    // Send response if handler returned text
    if (response) {
      await input.send(input.accountId, input.chatId, response);
    }
  } catch {
    log.error("Slash command error", { command: parsed.name, code: "handler_failed" });
    await input.send(input.accountId, input.chatId, `⚠️ Error executing /${parsed.name}`);
  }

  return true;
}

function nativeInboundActions(): ReadonlySet<string> {
  const source = process.env.RAVI_NATIVE_CHANNEL_DRIVERS;
  if (source === configuredActionSource) return configuredActions;
  configuredActionSource = source;
  try {
    configuredActions = new Set(configuredNativeInboundActionNames(source));
  } catch {
    configuredActions = new Set();
  }
  return configuredActions;
}
