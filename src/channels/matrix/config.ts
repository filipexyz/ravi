/**
 * Matrix Channel Configuration
 *
 * Zod schema for validating Matrix configuration and loading from env.
 */

import { z } from "zod";
import type { MatrixAccountConfig, MatrixConfig } from "./types.js";
import { loadAllCredentials } from "./credentials.js";
import { getDefaultAgentId, getAllAgents } from "../../router/index.js";

// ============================================================================
// Schemas
// ============================================================================

/** Account configuration schema */
export const MatrixAccountConfigSchema = z.object({
  /** Display name for the account */
  name: z.string().optional(),

  /** Whether this account is enabled */
  enabled: z.boolean().default(true),

  /** Matrix homeserver URL */
  homeserver: z.string().url(),

  /** Access token (if using token auth) */
  accessToken: z.string().optional(),

  /** User ID (optional, can be derived from token) */
  userId: z.string().optional(),

  /** Password (if using password auth) */
  password: z.string().optional(),

  /** Enable end-to-end encryption */
  encryption: z.boolean().default(false),

  /** DM policy: how to handle direct messages */
  dmPolicy: z.enum(["open", "closed", "pairing"]).default("open"),

  /** List of user IDs allowed to send DMs */
  allowFrom: z.array(z.string()).default([]),

  /** Room/group policy */
  roomPolicy: z.enum(["open", "closed", "allowlist"]).default("closed"),

  /** List of room IDs/aliases allowed */
  roomAllowlist: z.array(z.string()).default([]),

  /** Send read receipts */
  sendReadReceipts: z.boolean().default(true),

  /** Debounce time in milliseconds */
  debounceMs: z.number().min(0).max(30000).default(0),
});

/** Main Matrix configuration schema */
export const MatrixConfigSchema = z.object({
  /** Account configurations keyed by account ID */
  accounts: z.record(z.string(), MatrixAccountConfigSchema).default({}),
});

// ============================================================================
// Defaults
// ============================================================================

/** Default Matrix configuration */
export const DEFAULT_CONFIG: MatrixConfig = {
  accounts: {},
};

/** Default account configuration (without homeserver) */
export const DEFAULT_ACCOUNT_CONFIG: Omit<MatrixAccountConfig, "homeserver"> = {
  enabled: true,
  encryption: false,
  dmPolicy: "open",
  allowFrom: [],
  roomPolicy: "closed",
  roomAllowlist: [],
  sendReadReceipts: true,
  debounceMs: 0,
};

// ============================================================================
// Input Types
// ============================================================================

export type MatrixAccountConfigInput = z.input<typeof MatrixAccountConfigSchema>;
export type MatrixConfigInput = z.input<typeof MatrixConfigSchema>;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Parse and validate Matrix configuration
 */
export function parseConfig(input: unknown): MatrixConfig {
  return MatrixConfigSchema.parse(input);
}

/**
 * Safely parse Matrix configuration, returning default on error
 */
export function safeParseConfig(input: unknown): MatrixConfig {
  const result = MatrixConfigSchema.safeParse(input);
  return result.success ? result.data : DEFAULT_CONFIG;
}

/**
 * Get account configuration with defaults
 */
export function getAccountConfig(
  config: MatrixConfig,
  accountId: string
): MatrixAccountConfig | undefined {
  return config.accounts[accountId];
}

/**
 * Load Matrix configuration from environment variables
 *
 * Env vars:
 *   MATRIX_HOMESERVER - Homeserver URL (required)
 *   MATRIX_ACCESS_TOKEN - Access token (preferred)
 *   MATRIX_USER_ID - User ID (optional with token, required with password)
 *   MATRIX_PASSWORD - Password (if using password auth)
 *   MATRIX_ENCRYPTION - Enable E2EE (default: false)
 *   MATRIX_DM_POLICY - DM policy: open | closed | pairing (default: open)
 *   MATRIX_ROOM_POLICY - Room policy: open | closed | allowlist (default: closed)
 *   MATRIX_ROOM_ALLOWLIST - Comma-separated room IDs/aliases
 */
export function loadMatrixConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): MatrixConfig {
  const homeserver = env.MATRIX_HOMESERVER;

  // If no homeserver configured, return empty config
  if (!homeserver) {
    return DEFAULT_CONFIG;
  }

  const accessToken = env.MATRIX_ACCESS_TOKEN;
  const userId = env.MATRIX_USER_ID;
  const password = env.MATRIX_PASSWORD;

  // Need either access token or user/password
  if (!accessToken && (!userId || !password)) {
    return DEFAULT_CONFIG;
  }

  const encryption = env.MATRIX_ENCRYPTION === "true";
  const dmPolicy = (env.MATRIX_DM_POLICY as "open" | "closed" | "pairing") || "open";
  const roomPolicy = (env.MATRIX_ROOM_POLICY as "open" | "closed" | "allowlist") || "closed";
  const roomAllowlist = env.MATRIX_ROOM_ALLOWLIST
    ? env.MATRIX_ROOM_ALLOWLIST.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  const accountConfig: MatrixAccountConfigInput = {
    name: "Matrix",
    enabled: true,
    homeserver,
    accessToken,
    userId,
    password,
    encryption,
    dmPolicy,
    roomPolicy,
    roomAllowlist,
    sendReadReceipts: true,
    debounceMs: 0,
  };

  // Validate and return
  const result = MatrixAccountConfigSchema.safeParse(accountConfig);
  if (!result.success) {
    return DEFAULT_CONFIG;
  }

  // Use the router's default agent ID (not "default")
  const defaultAgentId = getDefaultAgentId();

  return {
    accounts: {
      [defaultAgentId]: result.data,
    },
  };
}

/**
 * Check if Matrix is configured in environment
 */
export function isMatrixConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const homeserver = env.MATRIX_HOMESERVER;
  const accessToken = env.MATRIX_ACCESS_TOKEN;
  const userId = env.MATRIX_USER_ID;
  const password = env.MATRIX_PASSWORD;

  if (!homeserver) return false;
  if (accessToken) return true;
  if (userId && password) return true;

  return false;
}

/**
 * Load Matrix configuration from stored credentials
 * Only loads accounts that are linked to an agent via matrixAccount field
 */
export function loadMatrixConfigFromCredentials(): MatrixConfig {
  const store = loadAllCredentials();
  if (!store || Object.keys(store.accounts).length === 0) {
    return DEFAULT_CONFIG;
  }

  // Get agents that have matrixAccount configured
  const agents = getAllAgents();
  const agentMatrixAccounts = new Set(
    agents.map(a => a.matrixAccount).filter(Boolean)
  );

  const accounts: Record<string, MatrixAccountConfig> = {};

  for (const [accountId, creds] of Object.entries(store.accounts)) {
    // Only enable accounts that are linked to an agent
    const isLinkedToAgent = agentMatrixAccounts.has(accountId);

    if (!isLinkedToAgent) {
      continue; // Skip accounts not linked to any agent
    }

    accounts[accountId] = {
      name: accountId,
      enabled: true,
      homeserver: creds.homeserver,
      accessToken: creds.accessToken,
      userId: creds.userId,
      encryption: false,
      dmPolicy: "open",
      allowFrom: [],
      roomPolicy: "open",
      roomAllowlist: [],
      sendReadReceipts: true,
      debounceMs: 0,
    };
  }

  return { accounts };
}

/**
 * Load Matrix configuration from both environment and credentials
 * Environment config takes precedence for the default agent's account
 */
export function loadMatrixConfig(env: NodeJS.ProcessEnv = process.env): MatrixConfig {
  // Start with credentials-based config (all stored accounts)
  const credsConfig = loadMatrixConfigFromCredentials();

  // Load env-based config (may override the default agent's account)
  const envConfig = loadMatrixConfigFromEnv(env);

  // Merge: credentials first, then env overrides
  return {
    accounts: {
      ...credsConfig.accounts,
      ...envConfig.accounts,
    },
  };
}
