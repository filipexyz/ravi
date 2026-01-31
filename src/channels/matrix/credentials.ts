/**
 * Matrix Credentials Management
 *
 * Unified credentials storage using SQLite (router-db).
 */

import type { MatrixStoredCredentials, MatrixCredentialsStore } from "./types.js";
import { normalizeUrl } from "../../utils/paths.js";
import {
  dbGetMatrixAccount,
  dbListMatrixAccounts,
  dbUpsertMatrixAccount,
  dbDeleteMatrixAccount,
  dbTouchMatrixAccount,
  type MatrixAccount,
} from "../../router/router-db.js";
import { logger } from "../../utils/logger.js";

const log = logger.child("matrix:credentials");

/**
 * Convert SQLite MatrixAccount to MatrixStoredCredentials format
 */
function toStoredCredentials(account: MatrixAccount): MatrixStoredCredentials {
  return {
    homeserver: account.homeserver,
    userId: account.userId,
    accessToken: account.accessToken,
    deviceId: account.deviceId,
    createdAt: new Date(account.createdAt).toISOString(),
    lastUsedAt: account.lastUsedAt ? new Date(account.lastUsedAt).toISOString() : undefined,
  };
}

/**
 * Load Matrix credentials for a specific account
 */
export function loadCredentials(accountId: string): MatrixStoredCredentials | null {
  const account = dbGetMatrixAccount(accountId);
  if (!account) return null;
  return toStoredCredentials(account);
}

/**
 * Load all Matrix credentials
 */
export function loadAllCredentials(): MatrixCredentialsStore | null {
  const accounts = dbListMatrixAccounts();
  if (accounts.length === 0) return null;

  const store: MatrixCredentialsStore = {
    version: 4,
    accounts: {},
  };

  for (const account of accounts) {
    store.accounts[account.username] = toStoredCredentials(account);
  }

  return store;
}

/**
 * Save Matrix credentials for an account
 */
export function saveCredentials(
  accountId: string,
  credentials: Omit<MatrixStoredCredentials, "createdAt" | "lastUsedAt">
): void {
  dbUpsertMatrixAccount({
    username: accountId,
    userId: credentials.userId,
    homeserver: credentials.homeserver,
    accessToken: credentials.accessToken,
    deviceId: credentials.deviceId,
  });
}

/**
 * Update the lastUsedAt timestamp for an account
 */
export function touchCredentials(accountId: string): void {
  dbTouchMatrixAccount(accountId);
}

/**
 * Clear Matrix credentials for a specific account
 */
export function clearCredentials(accountId: string): void {
  try {
    dbDeleteMatrixAccount(accountId);
  } catch (err) {
    log.warn(`Could not delete credentials for ${accountId}: ${err}`);
  }
}

/**
 * Clear all Matrix credentials
 */
export function clearAllCredentials(): void {
  const accounts = dbListMatrixAccounts();
  for (const account of accounts) {
    try {
      dbDeleteMatrixAccount(account.username);
    } catch (err) {
      log.warn(`Could not delete credentials for ${account.username}: ${err}`);
    }
  }
}

/**
 * List all account IDs with stored credentials
 */
export function listAccountIds(): string[] {
  const accounts = dbListMatrixAccounts();
  return accounts.map(a => a.username);
}

/**
 * Check if stored credentials match the config for an account
 */
export function credentialsMatchConfig(
  accountId: string,
  config: { homeserver: string; userId?: string }
): boolean {
  const stored = loadCredentials(accountId);
  if (!stored) return false;

  if (normalizeUrl(stored.homeserver) !== normalizeUrl(config.homeserver)) {
    return false;
  }

  if (config.userId && stored.userId !== config.userId) {
    return false;
  }

  return true;
}
