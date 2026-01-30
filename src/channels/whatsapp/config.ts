/**
 * WhatsApp Channel Configuration
 *
 * Zod schema for validating WhatsApp configuration.
 */

import { z } from "zod";

// ============================================================================
// Schemas
// ============================================================================

/** ACK reaction configuration */
export const AckReactionSchema = z.object({
  /** Emoji to use for ACK reaction */
  emoji: z.string().default("👀"),
  /** Send ACK for direct messages */
  direct: z.boolean().default(true),
  /** Send ACK for group messages */
  group: z.enum(["always", "mentions", "never"]).default("mentions"),
});

/** Account configuration */
export const AccountConfigSchema = z.object({
  /** Display name for the account */
  name: z.string().optional(),

  /** Whether this account is enabled */
  enabled: z.boolean().default(true),

  /** DM policy: how to handle direct messages */
  dmPolicy: z.enum(["pairing", "open", "closed"]).default("pairing"),

  /** List of phone numbers allowed to send DMs */
  allowFrom: z.array(z.string()).default([]),

  /** Group policy: how to handle group messages */
  groupPolicy: z.enum(["open", "allowlist", "closed"]).default("closed"),

  /** List of group IDs allowed to receive messages from */
  groupAllowFrom: z.array(z.string()).default([]),

  /** Send read receipts (blue ticks) */
  sendReadReceipts: z.boolean().default(true),

  /** ACK reaction configuration */
  ackReaction: AckReactionSchema.optional(),

  /** Debounce time in milliseconds for rapid messages */
  debounceMs: z.number().min(0).max(30000).default(500),

  /** Auth directory path (default: ~/.ravi/whatsapp-auth/{accountId}) */
  authDir: z.string().optional(),
});

/** Main WhatsApp configuration */
export const WhatsAppConfigSchema = z.object({
  /** Account configurations keyed by account ID */
  accounts: z.record(z.string(), AccountConfigSchema).default({}),
});

// ============================================================================
// Types
// ============================================================================

export type AckReactionConfig = z.infer<typeof AckReactionSchema>;
export type AccountConfig = z.infer<typeof AccountConfigSchema>;
export type WhatsAppConfig = z.infer<typeof WhatsAppConfigSchema>;

/** Input types for partial configuration (before Zod applies defaults) */
export type AccountConfigInput = z.input<typeof AccountConfigSchema>;
export type WhatsAppConfigInput = z.input<typeof WhatsAppConfigSchema>;

// ============================================================================
// Defaults
// ============================================================================

/** Default WhatsApp configuration */
export const DEFAULT_CONFIG: WhatsAppConfig = {
  accounts: {},
};

/** Default account configuration */
export const DEFAULT_ACCOUNT_CONFIG: AccountConfig = {
  enabled: true,
  dmPolicy: "pairing",
  allowFrom: [],
  groupPolicy: "closed",
  groupAllowFrom: [],
  sendReadReceipts: true,
  debounceMs: 500,
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Parse and validate WhatsApp configuration
 */
export function parseConfig(input: unknown): WhatsAppConfig {
  return WhatsAppConfigSchema.parse(input);
}

/**
 * Safely parse WhatsApp configuration, returning default on error
 */
export function safeParseConfig(input: unknown): WhatsAppConfig {
  const result = WhatsAppConfigSchema.safeParse(input);
  return result.success ? result.data : DEFAULT_CONFIG;
}

/**
 * Get account configuration with defaults
 */
export function getAccountConfig(
  config: WhatsAppConfig,
  accountId: string
): AccountConfig {
  return config.accounts[accountId] ?? DEFAULT_ACCOUNT_CONFIG;
}

/**
 * Merge account configuration with defaults
 */
export function mergeAccountConfig(
  partial: Partial<AccountConfig>
): AccountConfig {
  return AccountConfigSchema.parse({
    ...DEFAULT_ACCOUNT_CONFIG,
    ...partial,
  });
}
