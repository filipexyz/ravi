/**
 * Matrix Session Manager
 *
 * Manages Matrix client instances, authentication, and connection lifecycle.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  MatrixClient,
  SimpleFsStorageProvider,
  LogService,
  LogLevel,
  type IStorageProvider,
  type ICryptoStorageProvider,
} from "@vector-im/matrix-bot-sdk";
import { EventEmitter } from "node:events";
import type { MatrixAccountConfig, MatrixStoragePaths } from "./types.js";
import type { AccountState } from "../types.js";
import { loadCredentials, saveCredentials, touchCredentials } from "./credentials.js";
import { logger } from "../../utils/logger.js";
import { getRaviStateDir, normalizeUrl, fetchWithTimeout } from "../../utils/paths.js";

const log = logger.child("matrix:session");

// ============================================================================
// Storage Path Resolution
// ============================================================================

function sanitizePathSegment(value: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "unknown";
}

function resolveHomeserverKey(homeserver: string): string {
  try {
    const url = new URL(homeserver);
    if (url.host) return sanitizePathSegment(url.host);
  } catch {
    // fall through
  }
  return sanitizePathSegment(homeserver);
}

function hashAccessToken(accessToken: string): string {
  return crypto.createHash("sha256").update(accessToken).digest("hex").slice(0, 16);
}

/**
 * Resolve storage paths for a Matrix account
 */
export function resolveStoragePaths(params: {
  homeserver: string;
  userId: string;
  accessToken: string;
  accountId: string;
  env?: NodeJS.ProcessEnv;
}): MatrixStoragePaths {
  const env = params.env ?? process.env;
  const stateDir = getRaviStateDir(env);
  const accountKey = sanitizePathSegment(params.accountId);
  const userKey = sanitizePathSegment(params.userId);
  const serverKey = resolveHomeserverKey(params.homeserver);
  const tokenHash = hashAccessToken(params.accessToken);

  const rootDir = path.join(
    stateDir,
    "matrix",
    "accounts",
    accountKey,
    `${serverKey}__${userKey}`,
    tokenHash
  );

  return {
    rootDir,
    storagePath: path.join(rootDir, "bot-storage.json"),
    cryptoPath: path.join(rootDir, "crypto"),
    metaPath: path.join(rootDir, "storage-meta.json"),
    accountKey,
    tokenHash,
  };
}

// ============================================================================
// Session Manager
// ============================================================================

interface SessionState {
  client: MatrixClient | null;
  state: AccountState;
  config: MatrixAccountConfig | null;
  userId: string | null;
}

type SessionEvents = {
  stateChange: [accountId: string, state: AccountState];
  connected: [accountId: string, userId: string];
  disconnected: [accountId: string, reason?: string];
  error: [accountId: string, error: Error];
  clientReady: [accountId: string, client: MatrixClient];
};

class MatrixSessionManager extends EventEmitter {
  private sessions = new Map<string, SessionState>();
  private loggingConfigured = false;

  constructor() {
    super();
  }

  /**
   * Configure Matrix SDK logging (one-time)
   */
  private configureLogging(): void {
    if (this.loggingConfigured) return;

    // Set log level based on RAVI_LOG_LEVEL
    const logLevel = process.env.RAVI_LOG_LEVEL;
    if (logLevel === "debug") {
      LogService.setLevel(LogLevel.DEBUG);
    } else if (logLevel === "warn") {
      LogService.setLevel(LogLevel.WARN);
    } else if (logLevel === "error") {
      LogService.setLevel(LogLevel.ERROR);
    } else {
      LogService.setLevel(LogLevel.INFO);
    }

    // Suppress noisy modules
    LogService.muteModule("MatrixLiteClient");
    LogService.muteModule("RustSdkCryptoStorageProvider");

    this.loggingConfigured = true;
  }

  /**
   * Get session state
   */
  getState(accountId: string): AccountState {
    return this.sessions.get(accountId)?.state ?? "disconnected";
  }

  /**
   * Get client instance
   */
  getClient(accountId: string): MatrixClient | null {
    return this.sessions.get(accountId)?.client ?? null;
  }

  /**
   * Get user ID for account
   */
  getUserId(accountId: string): string | null {
    return this.sessions.get(accountId)?.userId ?? null;
  }

  /**
   * Start a Matrix session
   */
  async start(accountId: string, config: MatrixAccountConfig): Promise<void> {
    this.configureLogging();

    // Check if already running
    const existing = this.sessions.get(accountId);
    if (existing?.state === "connected" || existing?.state === "connecting") {
      log.warn(`Session ${accountId} already ${existing.state}`);
      return;
    }

    // Update state
    this.updateState(accountId, "connecting", config);

    try {
      // Resolve credentials (from config or stored)
      const credentials = await this.resolveCredentials(accountId, config);
      if (!credentials) {
        throw new Error("No valid credentials available");
      }

      // Create client
      const client = await this.createClient(accountId, config, credentials);

      // Get user ID
      const userId = await client.getUserId();
      log.info(`Logged in as ${userId}`);

      // Start syncing (before updating session to avoid race condition)
      await client.start();

      // Update session only after successful start
      const session = this.sessions.get(accountId);
      if (session) {
        session.client = client;
        session.userId = userId;
      }

      // Update state to connected
      this.updateState(accountId, "connected", config);
      this.emit("connected", accountId, userId);
      this.emit("clientReady", accountId, client);

      // Touch credentials to update lastUsedAt
      touchCredentials(accountId);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error(`Failed to start session ${accountId}:`, error);
      this.updateState(accountId, "error", config);
      this.emit("error", accountId, error);
      throw error;
    }
  }

  /**
   * Stop a Matrix session
   */
  async stop(accountId: string): Promise<void> {
    const session = this.sessions.get(accountId);
    if (!session?.client) {
      log.debug(`Session ${accountId} not running`);
      return;
    }

    try {
      session.client.stop();
      log.info(`Stopped session ${accountId}`);
    } catch (err) {
      log.warn(`Error stopping session ${accountId}:`, err);
    }

    this.updateState(accountId, "disconnected");
    this.emit("disconnected", accountId);
  }

  /**
   * Stop all sessions
   */
  async stopAll(): Promise<void> {
    const accountIds = Array.from(this.sessions.keys());
    await Promise.all(accountIds.map((id) => this.stop(id)));
  }

  /**
   * Resolve credentials from config or stored credentials
   */
  private async resolveCredentials(
    accountId: string,
    config: MatrixAccountConfig
  ): Promise<{ homeserver: string; accessToken: string; userId: string } | null> {
    // First try direct access token from config
    if (config.accessToken) {
      // Get user ID via whoami if not provided
      let userId = config.userId;
      if (!userId) {
        try {
          const whoamiUrl = `${config.homeserver}/_matrix/client/v3/account/whoami`;
          const response = await fetchWithTimeout(whoamiUrl, {
            headers: { Authorization: `Bearer ${config.accessToken}` },
          });
          if (!response.ok) {
            throw new Error(`whoami failed: ${response.status}`);
          }
          const data = (await response.json()) as { user_id: string };
          userId = data.user_id;
        } catch (err) {
          log.error("Failed to get user ID from access token:", err);
          return null;
        }
      }

      // Save credentials for this account
      saveCredentials(accountId, {
        homeserver: config.homeserver,
        accessToken: config.accessToken,
        userId,
      });

      return {
        homeserver: config.homeserver,
        accessToken: config.accessToken,
        userId,
      };
    }

    // Try stored credentials for this account
    const stored = loadCredentials(accountId);
    if (stored) {
      // Verify homeserver matches if specified in config
      if (config.homeserver) {
        if (normalizeUrl(stored.homeserver) !== normalizeUrl(config.homeserver)) {
          log.warn(`Stored credentials homeserver mismatch for ${accountId}`);
          return null;
        }
      }
      return {
        homeserver: stored.homeserver,
        accessToken: stored.accessToken,
        userId: stored.userId,
      };
    }

    // Try password login
    if (config.userId && config.password) {
      try {
        const credentials = await this.loginWithPassword(
          accountId,
          config.homeserver,
          config.userId,
          config.password
        );
        return credentials;
      } catch (err) {
        log.error("Password login failed:", err);
        return null;
      }
    }

    return null;
  }

  /**
   * Login with password and get access token
   */
  private async loginWithPassword(
    accountId: string,
    homeserver: string,
    userId: string,
    password: string
  ): Promise<{ homeserver: string; accessToken: string; userId: string; deviceId?: string }> {
    const loginUrl = `${homeserver}/_matrix/client/v3/login`;

    const response = await fetchWithTimeout(loginUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "m.login.password",
        identifier: {
          type: "m.id.user",
          user: userId,
        },
        password,
        initial_device_display_name: `Ravi Bot (${accountId})`,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Login failed: ${error}`);
    }

    const data = (await response.json()) as {
      access_token: string;
      user_id: string;
      device_id?: string;
    };

    // Save credentials for this account
    saveCredentials(accountId, {
      homeserver,
      accessToken: data.access_token,
      userId: data.user_id,
      deviceId: data.device_id,
    });

    return {
      homeserver,
      accessToken: data.access_token,
      userId: data.user_id,
      deviceId: data.device_id,
    };
  }

  /**
   * Create a Matrix client instance
   */
  private async createClient(
    accountId: string,
    config: MatrixAccountConfig,
    credentials: { homeserver: string; accessToken: string; userId: string }
  ): Promise<MatrixClient> {
    // Resolve storage paths
    const storagePaths = resolveStoragePaths({
      homeserver: credentials.homeserver,
      userId: credentials.userId,
      accessToken: credentials.accessToken,
      accountId,
    });

    // Create storage directory
    fs.mkdirSync(storagePaths.rootDir, { recursive: true });

    // Create storage provider
    const storage: IStorageProvider = new SimpleFsStorageProvider(storagePaths.storagePath);

    // Create crypto storage if encryption is enabled
    let cryptoStorage: ICryptoStorageProvider | undefined;
    if (config.encryption) {
      fs.mkdirSync(storagePaths.cryptoPath, { recursive: true });

      try {
        const { StoreType } = await import("@matrix-org/matrix-sdk-crypto-nodejs");
        const { RustSdkCryptoStorageProvider } = await import("@vector-im/matrix-bot-sdk");
        cryptoStorage = new RustSdkCryptoStorageProvider(
          storagePaths.cryptoPath,
          StoreType.Sqlite
        );
        log.info("E2EE enabled with crypto storage");
      } catch (err) {
        log.warn("Failed to initialize crypto storage, E2EE disabled:", err);
      }
    }

    // Write storage metadata
    this.writeStorageMeta(storagePaths, credentials, accountId);

    // Create client
    const client = new MatrixClient(
      credentials.homeserver,
      credentials.accessToken,
      storage,
      cryptoStorage
    );

    return client;
  }

  /**
   * Write storage metadata file
   */
  private writeStorageMeta(
    storagePaths: MatrixStoragePaths,
    credentials: { homeserver: string; userId: string },
    accountId: string
  ): void {
    try {
      const payload = {
        homeserver: credentials.homeserver,
        userId: credentials.userId,
        accountId,
        accessTokenHash: storagePaths.tokenHash,
        createdAt: new Date().toISOString(),
      };
      fs.writeFileSync(storagePaths.metaPath, JSON.stringify(payload, null, 2), "utf-8");
    } catch (err) {
      log.debug(`Failed to write storage meta: ${err}`);
    }
  }

  /**
   * Update session state and emit event
   */
  private updateState(
    accountId: string,
    state: AccountState,
    config?: MatrixAccountConfig
  ): void {
    let session = this.sessions.get(accountId);
    if (!session) {
      session = {
        client: null,
        state: "disconnected",
        config: config ?? null,
        userId: null,
      };
      this.sessions.set(accountId, session);
    }

    session.state = state;
    if (config) {
      session.config = config;
    }

    this.emit("stateChange", accountId, state);
  }

  // TypeScript event typing
  on<K extends keyof SessionEvents>(event: K, listener: (...args: SessionEvents[K]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  emit<K extends keyof SessionEvents>(event: K, ...args: SessionEvents[K]): boolean {
    return super.emit(event, ...args);
  }
}

// Export singleton
export const sessionManager = new MatrixSessionManager();
