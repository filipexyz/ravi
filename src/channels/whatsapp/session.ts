/**
 * WhatsApp Session Management
 *
 * Handles Baileys socket lifecycle, authentication, and reconnection.
 */

import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
  type WASocket,
  type ConnectionState,
  type BaileysEventMap,
} from "@whiskeysockets/baileys";
import pino from "pino";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import type { Boom } from "@hapi/boom";
import type { AccountState } from "../types.js";
import type { AccountConfig } from "./config.js";
import { logger } from "../../utils/logger.js";

const log = logger.child("wa:session");

// ============================================================================
// Types
// ============================================================================

/** Session events */
export interface SessionEvents {
  stateChange: (accountId: string, state: AccountState) => void;
  qrCode: (accountId: string, qr: string) => void;
  connected: (accountId: string, user: string) => void;
  disconnected: (accountId: string, reason: string) => void;
  error: (accountId: string, error: Error) => void;
  socketReady: (accountId: string, socket: WASocket) => void;
}

/** Active session info */
export interface ActiveSession {
  accountId: string;
  socket: WASocket;
  state: AccountState;
  lastActivity: number;
  reconnectAttempts: number;
}

// ============================================================================
// Session Manager
// ============================================================================

const DEFAULT_AUTH_DIR = join(homedir(), ".ravi", "whatsapp-auth");
const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30000;

/**
 * WhatsApp Session Manager
 *
 * Manages Baileys socket connections for multiple accounts.
 */
export class SessionManager {
  private sessions = new Map<string, ActiveSession>();
  private listeners = new Map<keyof SessionEvents, Set<SessionEvents[keyof SessionEvents]>>();
  private baileysLogger = pino({ level: "silent" });

  // Group metadata cache - critical for avoiding "No sessions" error
  private groupMetadataCache = new Map<string, { metadata: unknown; timestamp: number }>();
  private readonly GROUP_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  /**
   * Start a session for an account
   */
  async start(accountId: string, config: AccountConfig): Promise<WASocket> {
    // Check if already connected
    const existing = this.sessions.get(accountId);
    if (existing && existing.state === "connected") {
      log.info(`Session ${accountId} already connected`);
      return existing.socket;
    }

    // Get auth directory
    const authDir = config.authDir ?? join(DEFAULT_AUTH_DIR, accountId);
    mkdirSync(authDir, { recursive: true });

    log.info(`Starting session ${accountId}`, { authDir });
    this.emit("stateChange", accountId, "connecting");

    // Load auth state
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    log.debug(`Using Baileys version`, { version });

    // Create socket with cachedGroupMetadata to avoid "No sessions" error
    const socket = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, this.baileysLogger),
      },
      browser: Browsers.ubuntu("Chrome"),
      logger: this.baileysLogger,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      // Critical for group messaging - caches participant info to avoid rate limits
      // and "No sessions" errors when encrypting messages for group members
      cachedGroupMetadata: async (jid) => {
        const cached = this.groupMetadataCache.get(jid);
        if (cached && Date.now() - cached.timestamp < this.GROUP_CACHE_TTL) {
          return cached.metadata as Awaited<ReturnType<WASocket["groupMetadata"]>>;
        }
        return undefined;
      },
    });

    // Create session record
    const session: ActiveSession = {
      accountId,
      socket,
      state: "connecting",
      lastActivity: Date.now(),
      reconnectAttempts: 0,
    };
    this.sessions.set(accountId, session);

    // Handle connection updates
    socket.ev.on("connection.update", (update) => {
      this.handleConnectionUpdate(accountId, config, update);
    });

    // Handle credential updates
    socket.ev.on("creds.update", saveCreds);

    // Update group metadata cache on group events
    socket.ev.on("groups.update", async (updates) => {
      for (const update of updates) {
        if (update.id) {
          try {
            const metadata = await socket.groupMetadata(update.id);
            this.groupMetadataCache.set(update.id, { metadata, timestamp: Date.now() });
            log.debug("Group metadata cached", { jid: update.id });
          } catch (err) {
            log.debug("Failed to cache group metadata", { jid: update.id, error: err });
          }
        }
      }
    });

    socket.ev.on("group-participants.update", async (update) => {
      try {
        const metadata = await socket.groupMetadata(update.id);
        this.groupMetadataCache.set(update.id, { metadata, timestamp: Date.now() });
        log.debug("Group metadata refreshed after participant update", { jid: update.id });
      } catch (err) {
        log.debug("Failed to refresh group metadata", { jid: update.id, error: err });
      }
    });

    // Emit socketReady so listeners can subscribe to message events
    this.emit("socketReady", accountId, socket);

    return socket;
  }

  /**
   * Stop a session
   */
  async stop(accountId: string): Promise<void> {
    const session = this.sessions.get(accountId);
    if (!session) {
      log.debug(`Session ${accountId} not found`);
      return;
    }

    log.info(`Stopping session ${accountId}`);
    session.socket.end(undefined);
    this.sessions.delete(accountId);
    this.emit("stateChange", accountId, "disconnected");
  }

  /**
   * Stop all sessions
   */
  async stopAll(): Promise<void> {
    for (const accountId of this.sessions.keys()) {
      await this.stop(accountId);
    }
  }

  /**
   * Get session socket
   */
  getSocket(accountId: string): WASocket | null {
    return this.sessions.get(accountId)?.socket ?? null;
  }

  /**
   * Get session state
   */
  getState(accountId: string): AccountState {
    return this.sessions.get(accountId)?.state ?? "disconnected";
  }

  /**
   * Get all active session IDs
   */
  getActiveAccounts(): string[] {
    return Array.from(this.sessions.keys());
  }

  /**
   * Subscribe to events
   */
  on<K extends keyof SessionEvents>(
    event: K,
    callback: SessionEvents[K]
  ): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback as SessionEvents[keyof SessionEvents]);

    return () => {
      this.listeners.get(event)?.delete(callback as SessionEvents[keyof SessionEvents]);
    };
  }

  /**
   * Subscribe to socket events for an account
   */
  onSocketEvent<K extends keyof BaileysEventMap>(
    accountId: string,
    event: K,
    callback: (data: BaileysEventMap[K]) => void
  ): () => void {
    const session = this.sessions.get(accountId);
    if (!session) {
      log.warn(`Cannot subscribe to ${event} - session ${accountId} not found`);
      return () => {};
    }

    session.socket.ev.on(event, callback);
    return () => {
      session.socket.ev.off(event, callback);
    };
  }

  /**
   * Update last activity timestamp
   */
  touch(accountId: string): void {
    const session = this.sessions.get(accountId);
    if (session) {
      session.lastActivity = Date.now();
    }
  }

  /**
   * Cache group metadata (called after successful fetch)
   */
  cacheGroupMetadata(jid: string, metadata: unknown): void {
    this.groupMetadataCache.set(jid, { metadata, timestamp: Date.now() });
  }

  /**
   * Pre-fetch and cache group metadata for a JID
   */
  async prefetchGroupMetadata(accountId: string, jid: string): Promise<void> {
    const session = this.sessions.get(accountId);
    if (!session) return;

    try {
      const metadata = await session.socket.groupMetadata(jid);
      this.groupMetadataCache.set(jid, { metadata, timestamp: Date.now() });
      log.debug("Group metadata prefetched", { jid, participants: (metadata as { participants?: unknown[] }).participants?.length });
    } catch (err) {
      log.debug("Failed to prefetch group metadata", { jid, error: err });
    }
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  private emit<K extends keyof SessionEvents>(
    event: K,
    ...args: Parameters<SessionEvents[K]>
  ): void {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      for (const callback of callbacks) {
        try {
          (callback as (...args: unknown[]) => void)(...args);
        } catch (err) {
          log.error(`Error in ${event} listener`, err);
        }
      }
    }
  }

  private handleConnectionUpdate(
    accountId: string,
    config: AccountConfig,
    update: Partial<ConnectionState>
  ): void {
    const { connection, lastDisconnect, qr } = update;
    const session = this.sessions.get(accountId);

    log.debug(`Connection update for ${accountId}`, {
      connection,
      hasQr: !!qr,
    });

    // QR code received
    if (qr) {
      if (session) {
        session.state = "qr";
      }
      this.emit("stateChange", accountId, "qr");
      this.emit("qrCode", accountId, qr);
    }

    // Connecting
    if (connection === "connecting") {
      if (session) {
        session.state = "connecting";
      }
      this.emit("stateChange", accountId, "connecting");
    }

    // Connected
    if (connection === "open") {
      if (session) {
        session.state = "connected";
        session.reconnectAttempts = 0;
        session.lastActivity = Date.now();
      }
      const user = session?.socket.user?.id ?? "unknown";
      log.info(`Session ${accountId} connected`, { user });
      this.emit("stateChange", accountId, "connected");
      this.emit("connected", accountId, user);
    }

    // Disconnected
    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const reason = DisconnectReason[statusCode] ?? "unknown";
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      log.warn(`Session ${accountId} disconnected`, { statusCode, reason });

      if (session) {
        session.state = "disconnected";
      }

      this.emit("stateChange", accountId, "disconnected");
      this.emit("disconnected", accountId, reason);

      // Handle reconnection
      if (shouldReconnect && session) {
        this.handleReconnect(accountId, config);
      } else if (statusCode === DisconnectReason.loggedOut) {
        log.error(`Session ${accountId} logged out - re-authentication required`);
        this.sessions.delete(accountId);
      }
    }
  }

  private handleReconnect(accountId: string, config: AccountConfig): void {
    const session = this.sessions.get(accountId);
    if (!session) return;

    session.reconnectAttempts++;

    // Reset attempts counter after max reached (keep trying forever with max delay)
    if (session.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      log.warn(`Session ${accountId} max reconnection attempts reached, will keep trying`);
      session.reconnectAttempts = MAX_RECONNECT_ATTEMPTS; // Cap at max for delay calculation
    }

    // Exponential backoff (capped at MAX_RECONNECT_DELAY)
    const delay = Math.min(
      BASE_RECONNECT_DELAY * Math.pow(2, session.reconnectAttempts),
      MAX_RECONNECT_DELAY
    );

    log.info(`Reconnecting ${accountId} in ${delay}ms (attempt ${session.reconnectAttempts})`);

    setTimeout(async () => {
      try {
        await this.start(accountId, config);
      } catch (err) {
        log.error(`Reconnection failed for ${accountId}`, err);
        this.emit("error", accountId, err as Error);
        // Keep trying to reconnect
        this.handleReconnect(accountId, config);
      }
    }, delay);
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

/** Global session manager instance */
export const sessionManager = new SessionManager();
