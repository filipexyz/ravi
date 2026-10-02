/**
 * Pages app gateway relay runner.
 *
 * Opt-in, per-daemon runner that dials out to the Pages `ExecutorRelay` over
 * WSS and answers `apps.invoke` frames through the installation executor
 * (Console `pages/app-gateway/relay` SPEC, Installation Executor).
 *
 * It never dials out unless `RAVI_APP_GATEWAY_ENABLED=1`, the stored CLI
 * session carries `console.apps.relay`, `apps.gateway.allowed_operations` is
 * non-empty and valid, and this process holds the SQLite relay lease.
 *
 * Tickets, assertions, grants, and bodies are never logged.
 */

import { randomUUID } from "node:crypto";
import { WebSocket as NodeWebSocket, type RawData } from "ws";
import { ConsoleApiClient } from "../cloud-auth/client.js";
import { isCloudAuthError } from "../cloud-auth/errors.js";
import { deleteCloudCredentials, readCloudCredentials, writeCloudCredentials } from "../cloud-auth/storage.js";
import type { CloudCredentials } from "../cloud-auth/types.js";
import { pagesAssertionJwksUrl } from "../pages/assertion-audiences.js";
import { logger } from "../utils/logger.js";
import {
  APP_GATEWAY_ENABLED_ENV,
  APP_GATEWAY_RELAY_SCOPE,
  CLOSE_NORMAL,
  CLOSE_PROTOCOL_ERROR,
  CLOSE_REPLACED,
  CLOSE_TICKET_EXPIRED,
  INVOKE_FRAME_MAX_BYTES,
  PARKED_RECHECK_MS,
  PING_INTERVAL_MS,
  PONG_DEADLINE_MS,
  RECONNECT_BACKOFF_INITIAL_MS,
  RECONNECT_BACKOFF_MAX_MS,
  RECONNECT_BACKOFF_RESET_AFTER_MS,
  RECONNECT_JITTER_RATIO,
  RELAY_LEASE_RENEW_MS,
  RELAY_LEASE_TTL_MS,
  RELAY_READY_TIMEOUT_MS,
  RELAY_SUBPROTOCOL,
  REPLACED_ELSEWHERE_BACKOFF_MS,
  SCOPE_MISSING_PARK_MS,
  TICKET_ERROR_BACKOFF_INITIAL_MS,
  TICKET_ERROR_BACKOFF_MAX_MS,
} from "./constants.js";
import { AppGatewayExecutor, type AppGatewayInvokeSession } from "./executor.js";
import { PING_FRAME, parseInboundFrame } from "./frames.js";
import { AppGatewayJwksClient } from "./jwks.js";
import { acquireRelayLease, relayLeaseKey, releaseRelayLease, renewRelayLease } from "./lease.js";
import { readAllowedOperations } from "./settings.js";
import { fetchRelayTicket, type RelayTicket } from "./ticket-client.js";

const log = logger.child("app-gateway:relay");

/** The subset of a `ws` WebSocket the runner uses (Slack socket-mode factory pattern). */
export interface RelaySocket {
  readonly readyState: number;
  readonly protocol: string;
  on(event: "open", listener: () => void): unknown;
  on(event: "message", listener: (data: RawData, isBinary: boolean) => void): unknown;
  on(event: "close", listener: (code: number, reason: Buffer) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

export type RelaySocketFactory = (
  url: string,
  protocols: string[],
  options: { headers: Record<string, string>; maxPayload: number; handshakeTimeout: number },
) => RelaySocket;

export type TimerHandle = ReturnType<typeof setTimeout>;

/** Timer injection for deterministic lifecycle tests. */
export interface RelayTimers {
  setTimeout(callback: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  setInterval(callback: () => void, ms: number): TimerHandle;
  clearInterval(handle: TimerHandle): void;
}

const SYSTEM_TIMERS: RelayTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle),
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle),
};

export interface RelayLeaseOps {
  acquire(input: { lockKey: string; ownerId: string; ttlMs: number }): boolean;
  renew(input: { lockKey: string; ownerId: string; ttlMs: number }): boolean;
  release(lockKey: string, ownerId: string): void;
}

export interface RelayTiming {
  parkedRecheckMs: number;
  scopeMissingParkMs: number;
  replacedElsewhereBackoffMs: number;
  reconnectInitialMs: number;
  reconnectMaxMs: number;
  reconnectResetAfterMs: number;
  ticketErrorInitialMs: number;
  ticketErrorMaxMs: number;
  leaseTtlMs: number;
  leaseRenewMs: number;
  readyTimeoutMs: number;
  pongDeadlineMs: number;
  minRenewDelayMs: number;
}

const DEFAULT_TIMING: RelayTiming = {
  parkedRecheckMs: PARKED_RECHECK_MS,
  scopeMissingParkMs: SCOPE_MISSING_PARK_MS,
  replacedElsewhereBackoffMs: REPLACED_ELSEWHERE_BACKOFF_MS,
  reconnectInitialMs: RECONNECT_BACKOFF_INITIAL_MS,
  reconnectMaxMs: RECONNECT_BACKOFF_MAX_MS,
  reconnectResetAfterMs: RECONNECT_BACKOFF_RESET_AFTER_MS,
  ticketErrorInitialMs: TICKET_ERROR_BACKOFF_INITIAL_MS,
  ticketErrorMaxMs: TICKET_ERROR_BACKOFF_MAX_MS,
  leaseTtlMs: RELAY_LEASE_TTL_MS,
  leaseRenewMs: RELAY_LEASE_RENEW_MS,
  readyTimeoutMs: RELAY_READY_TIMEOUT_MS,
  pongDeadlineMs: PONG_DEADLINE_MS,
  // Never fetch tickets in a hot loop when the local clock is far off.
  minRenewDelayMs: 60_000,
};

export interface AppGatewayRelayRunnerOptions {
  env?: NodeJS.ProcessEnv;
  readCredentials?: () => CloudCredentials | null;
  writeCredentials?: (credentials: CloudCredentials) => void;
  deleteCredentials?: () => void;
  createClient?: (consoleUrl: string) => ConsoleApiClient;
  /** Fetch a ticket with the stored credentials. Defaults to `fetchRelayTicket`. */
  fetchTicket?: (input: { client: ConsoleApiClient; credentials: CloudCredentials }) => Promise<RelayTicket>;
  /** Build the executor for one Console (JWKS URL derived from its URL). */
  createExecutor?: (input: { jwksUrl: string }) => AppGatewayExecutor;
  openSocket?: RelaySocketFactory;
  readSetting?: (key: string) => string | null;
  lease?: RelayLeaseOps;
  timing?: Partial<RelayTiming>;
  timers?: RelayTimers;
  now?: () => number;
  random?: () => number;
}

type RunnerState = "stopped" | "parked" | "connecting" | "connected";

interface RelayConnection {
  id: number;
  socket: RelaySocket;
  session: AppGatewayInvokeSession;
  ticket: RelayTicket;
  ready: boolean;
  readyAt: number | null;
  closed: boolean;
  inflight: Set<AbortController>;
  readyTimer: TimerHandle | null;
  pingTimer: TimerHandle | null;
  pongTimer: TimerHandle | null;
}

export interface AppGatewayRelayStatus {
  state: RunnerState;
  connections: number;
  readyConnections: number;
  reason: string | null;
}

export class AppGatewayRelayRunner {
  private readonly env: NodeJS.ProcessEnv;
  private readonly readCredentials: () => CloudCredentials | null;
  private readonly writeCredentials: (credentials: CloudCredentials) => void;
  private readonly deleteCredentials: () => void;
  private readonly createClient: (consoleUrl: string) => ConsoleApiClient;
  private readonly fetchTicket: (input: {
    client: ConsoleApiClient;
    credentials: CloudCredentials;
  }) => Promise<RelayTicket>;
  private readonly createExecutor: (input: { jwksUrl: string }) => AppGatewayExecutor;
  private readonly openSocket: RelaySocketFactory;
  private readonly readSetting: ((key: string) => string | null) | undefined;
  private readonly lease: RelayLeaseOps;
  private readonly timing: RelayTiming;
  private readonly timers: RelayTimers;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly ownerId = randomUUID();

  private running = false;
  private state: RunnerState = "stopped";
  private reason: string | null = null;
  private timer: TimerHandle | null = null;
  private renewTicketTimer: TimerHandle | null = null;
  private leaseTimer: TimerHandle | null = null;
  private leaseKey: string | null = null;
  private executor: { jwksUrl: string; instance: AppGatewayExecutor } | null = null;
  private readonly connections = new Set<RelayConnection>();
  private connectionSeq = 0;
  /** Highest connection id the relay accepted (upgrade done); it drains every older socket of ours with 4000. */
  private latestAcceptedConnectionId = 0;
  private reconnectBackoffMs = 0;
  private ticketBackoffMs = 0;
  private loggedScopeMissing = false;
  private loggedReplacedElsewhere = false;
  private tickInFlight = false;

  constructor(options: AppGatewayRelayRunnerOptions = {}) {
    this.env = options.env ?? process.env;
    this.readCredentials = options.readCredentials ?? (() => readCloudCredentials(this.env));
    this.writeCredentials = options.writeCredentials ?? ((credentials) => writeCloudCredentials(credentials, this.env));
    this.deleteCredentials = options.deleteCredentials ?? (() => deleteCloudCredentials(this.env));
    this.createClient = options.createClient ?? ((consoleUrl) => new ConsoleApiClient({ consoleUrl }));
    this.fetchTicket =
      options.fetchTicket ??
      ((input) =>
        fetchRelayTicket({
          ...input,
          store: { write: this.writeCredentials, delete: this.deleteCredentials },
          env: this.env,
        }));
    this.createExecutor = options.createExecutor ?? defaultExecutorFactory(this.env);
    this.openSocket =
      options.openSocket ??
      ((url, protocols, socketOptions) => new NodeWebSocket(url, protocols, socketOptions) as unknown as RelaySocket);
    this.readSetting = options.readSetting;
    this.lease = options.lease ?? {
      acquire: acquireRelayLease,
      renew: renewRelayLease,
      release: (lockKey, ownerId) => void releaseRelayLease(lockKey, ownerId),
    };
    this.timing = { ...DEFAULT_TIMING, ...options.timing };
    this.timers = options.timers ?? SYSTEM_TIMERS;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  static isEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env[APP_GATEWAY_ENABLED_ENV] === "1";
  }

  status(): AppGatewayRelayStatus {
    const ready = [...this.connections].filter((connection) => connection.ready && !connection.closed).length;
    return { state: this.state, connections: this.connections.size, readyConnections: ready, reason: this.reason };
  }

  /** Starts only when `RAVI_APP_GATEWAY_ENABLED=1`; otherwise a no-op. */
  async start(): Promise<void> {
    if (this.running) return;
    if (!AppGatewayRelayRunner.isEnabled(this.env)) {
      log.debug("Pages app gateway relay disabled", { env: APP_GATEWAY_ENABLED_ENV });
      return;
    }
    this.running = true;
    this.state = "parked";
    log.info("Starting Pages app gateway relay runner");
    this.schedule(0);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.state = "stopped";
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = null;
    this.clearTicketRenewal();
    for (const connection of [...this.connections]) this.closeConnection(connection, CLOSE_NORMAL, "daemon stopping");
    this.connections.clear();
    this.releaseLease();
    log.info("Stopped Pages app gateway relay runner");
  }

  // --------------------------------------------------------------------------
  // Enablement, lease, ticket
  // --------------------------------------------------------------------------

  private schedule(delayMs: number): void {
    if (!this.running) return;
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = this.timers.setTimeout(
      () => {
        this.timer = null;
        void this.tick();
      },
      Math.max(0, delayMs),
    );
  }

  private park(reason: string, delayMs: number): void {
    this.state = "parked";
    this.reason = reason;
    this.releaseLease();
    this.schedule(delayMs);
  }

  private async tick(): Promise<void> {
    if (!this.running || this.tickInFlight || this.liveConnections() > 0) return;
    this.tickInFlight = true;
    try {
      await this.connectFresh();
    } catch (error) {
      log.warn("Pages app gateway relay tick failed", { error: error instanceof Error ? error.name : "unknown" });
      this.park("tick_failed", this.nextTicketBackoff());
    } finally {
      this.tickInFlight = false;
    }
  }

  private async connectFresh(): Promise<void> {
    const credentials = this.readCredentials();
    if (!credentials) return this.park("not_logged_in", this.timing.parkedRecheckMs);
    if (!(credentials.scopes ?? []).includes(APP_GATEWAY_RELAY_SCOPE)) {
      if (!this.loggedScopeMissing) {
        this.loggedScopeMissing = true;
        log.warn("Pages app gateway relay needs `ravi login`: the CLI session lacks the relay scope", {
          scope: APP_GATEWAY_RELAY_SCOPE,
        });
      }
      return this.park("scope_missing", this.timing.parkedRecheckMs);
    }
    this.loggedScopeMissing = false;
    if (!this.hasAllowedOperations()) return this.park("no_allowed_operations", this.timing.parkedRecheckMs);

    const lockKey = relayLeaseKey(credentials.consoleUrl, credentials.installationId);
    if (!this.holdLease(lockKey)) return this.park("lease_held_elsewhere", this.timing.parkedRecheckMs);

    this.state = "connecting";
    const ticket = await this.requestTicket(credentials);
    if (!ticket || !this.running) return;
    this.openConnection(credentials, ticket);
  }

  /** Fetch a ticket; on failure parks or backs off per the ticket error table and returns null. */
  private async requestTicket(credentials: CloudCredentials): Promise<RelayTicket | null> {
    try {
      const ticket = await this.fetchTicket({ client: this.createClient(credentials.consoleUrl), credentials });
      this.ticketBackoffMs = 0;
      return ticket;
    } catch (error) {
      const delay = this.ticketErrorDelay(error);
      if (this.liveConnections() === 0) this.park(delay.reason, delay.ms);
      else this.scheduleTicketRenewal(delay.ms);
      return null;
    }
  }

  private ticketErrorDelay(error: unknown): { reason: string; ms: number } {
    if (isCloudAuthError(error)) {
      log.warn("Pages app gateway relay ticket request failed", { code: error.code, status: error.status });
      if (
        error.code === "AUTH_REQUIRED" ||
        error.code === "INSTALLATION_REVOKED" ||
        error.code === "CREDENTIALS_INVALID"
      ) {
        return { reason: error.code, ms: this.timing.parkedRecheckMs };
      }
      if (error.code === "PROJECT_ACCESS_DENIED") return { reason: error.code, ms: this.timing.scopeMissingParkMs };
      if (error.code === "RATE_LIMITED" && error.retryAfterMs !== undefined) {
        return { reason: error.code, ms: Math.max(error.retryAfterMs, 1_000) };
      }
      return { reason: error.code, ms: this.nextTicketBackoff() };
    }
    log.warn("Pages app gateway relay ticket request failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return { reason: "ticket_error", ms: this.nextTicketBackoff() };
  }

  private nextTicketBackoff(): number {
    this.ticketBackoffMs =
      this.ticketBackoffMs === 0
        ? this.timing.ticketErrorInitialMs
        : Math.min(this.ticketBackoffMs * 2, this.timing.ticketErrorMaxMs);
    return this.jitter(this.ticketBackoffMs);
  }

  private nextReconnectBackoff(): number {
    this.reconnectBackoffMs =
      this.reconnectBackoffMs === 0
        ? this.timing.reconnectInitialMs
        : Math.min(this.reconnectBackoffMs * 2, this.timing.reconnectMaxMs);
    return this.jitter(this.reconnectBackoffMs);
  }

  /** ±20 % jitter. */
  private jitter(ms: number): number {
    const factor = 1 + (this.random() * 2 - 1) * RECONNECT_JITTER_RATIO;
    return Math.max(0, Math.round(ms * factor));
  }

  private hasAllowedOperations(): boolean {
    const allowed = this.readSetting ? readAllowedOperations(this.readSetting) : readAllowedOperations();
    return allowed.size > 0;
  }

  private holdLease(lockKey: string): boolean {
    if (this.leaseKey && this.leaseKey !== lockKey) this.releaseLease();
    const acquired = this.lease.acquire({ lockKey, ownerId: this.ownerId, ttlMs: this.timing.leaseTtlMs });
    if (!acquired) return false;
    this.leaseKey = lockKey;
    if (!this.leaseTimer) {
      this.leaseTimer = this.timers.setInterval(() => this.renewLease(), this.timing.leaseRenewMs);
    }
    return true;
  }

  private renewLease(): void {
    if (!this.leaseKey) return;
    let renewed = false;
    try {
      renewed = this.lease.renew({ lockKey: this.leaseKey, ownerId: this.ownerId, ttlMs: this.timing.leaseTtlMs });
    } catch {
      renewed = false;
    }
    if (!renewed) {
      log.warn("Pages app gateway relay lease lost; disconnecting");
      this.disconnectAll("lease_lost", this.timing.parkedRecheckMs);
      return;
    }
    if (!this.hasAllowedOperations()) {
      log.info("Pages app gateway relay parked: apps.gateway.allowed_operations is empty");
      this.disconnectAll("no_allowed_operations", this.timing.parkedRecheckMs);
    }
  }

  private releaseLease(): void {
    if (this.leaseTimer) this.timers.clearInterval(this.leaseTimer);
    this.leaseTimer = null;
    if (!this.leaseKey) return;
    try {
      this.lease.release(this.leaseKey, this.ownerId);
    } catch {
      // The 60 s TTL frees it anyway.
    }
    this.leaseKey = null;
  }

  private disconnectAll(reason: string, parkMs: number): void {
    this.clearTicketRenewal();
    for (const connection of [...this.connections]) {
      this.connections.delete(connection);
      this.closeConnection(connection, CLOSE_NORMAL, reason);
    }
    this.park(reason, parkMs);
  }

  // --------------------------------------------------------------------------
  // Ticket renewal
  // --------------------------------------------------------------------------

  private scheduleTicketRenewal(delayMs: number): void {
    this.clearTicketRenewal();
    if (!this.running) return;
    this.renewTicketTimer = this.timers.setTimeout(
      () => {
        this.renewTicketTimer = null;
        void this.renewTicket();
      },
      Math.max(0, delayMs),
    );
  }

  private clearTicketRenewal(): void {
    if (this.renewTicketTimer) this.timers.clearTimeout(this.renewTicketTimer);
    this.renewTicketTimer = null;
  }

  /** At `renewAt`: fetch a new ticket and open a second socket; the relay drains the old one with 4000. */
  private async renewTicket(): Promise<void> {
    if (!this.running) return;
    if (this.liveConnections() === 0) {
      this.schedule(0);
      return;
    }
    const credentials = this.readCredentials();
    if (!credentials) {
      this.disconnectAll("not_logged_in", this.timing.parkedRecheckMs);
      return;
    }
    const lockKey = relayLeaseKey(credentials.consoleUrl, credentials.installationId);
    if (lockKey !== this.leaseKey) {
      // Logged into another Console or installation: start over under the new lease.
      this.disconnectAll("credentials_changed", 0);
      return;
    }
    try {
      const ticket = await this.fetchTicket({ client: this.createClient(credentials.consoleUrl), credentials });
      this.ticketBackoffMs = 0;
      if (!this.running) return;
      this.openConnection(credentials, ticket);
    } catch (error) {
      const delay = this.ticketErrorDelay(error);
      this.scheduleTicketRenewal(delay.ms);
    }
  }

  // --------------------------------------------------------------------------
  // Socket lifecycle
  // --------------------------------------------------------------------------

  private liveConnections(): number {
    return [...this.connections].filter((connection) => !connection.closed).length;
  }

  private executorFor(consoleUrl: string): AppGatewayExecutor {
    const jwksUrl = pagesAssertionJwksUrl(consoleUrl);
    if (!this.executor || this.executor.jwksUrl !== jwksUrl) {
      this.executor = { jwksUrl, instance: this.createExecutor({ jwksUrl }) };
    }
    return this.executor.instance;
  }

  private openConnection(credentials: CloudCredentials, ticket: RelayTicket): void {
    const executor = this.executorFor(credentials.consoleUrl);
    let socket: RelaySocket;
    try {
      socket = this.openSocket(ticket.relayUrl, [RELAY_SUBPROTOCOL], {
        headers: { Authorization: `Bearer ${ticket.ticket}` },
        // Frames above the cap are refused by the parser (4003); this only bounds memory.
        maxPayload: INVOKE_FRAME_MAX_BYTES + 4_096,
        handshakeTimeout: this.timing.readyTimeoutMs,
      });
    } catch (error) {
      log.warn("Pages app gateway relay socket could not be opened", {
        error: error instanceof Error ? error.name : "unknown",
      });
      if (this.liveConnections() === 0) this.park("socket_open_failed", this.nextReconnectBackoff());
      return;
    }

    const connection: RelayConnection = {
      id: ++this.connectionSeq,
      socket,
      session: {
        installationId: ticket.installationId,
        organizationId: ticket.organizationId,
        issuer: ticket.issuer,
      },
      ticket,
      ready: false,
      readyAt: null,
      closed: false,
      inflight: new Set(),
      readyTimer: null,
      pingTimer: null,
      pongTimer: null,
    };
    this.connections.add(connection);
    this.state = this.state === "connected" ? "connected" : "connecting";

    socket.on("open", () => {
      if (connection.closed) return;
      this.latestAcceptedConnectionId = Math.max(this.latestAcceptedConnectionId, connection.id);
      if (socket.protocol !== RELAY_SUBPROTOCOL) {
        this.protocolError(connection, "subprotocol not selected");
        return;
      }
      connection.readyTimer = this.timers.setTimeout(() => {
        connection.readyTimer = null;
        if (!connection.ready) {
          log.warn("Pages app gateway relay sent no relay.ready in time", { connection: connection.id });
          this.terminateConnection(connection);
        }
      }, this.timing.readyTimeoutMs);
    });
    socket.on("message", (data, isBinary) => this.onMessage(connection, executor, data, isBinary));
    socket.on("error", (error) => {
      log.debug("Pages app gateway relay socket error", { connection: connection.id, error: error.name });
    });
    socket.on("close", (code) => this.onClose(connection, code));
  }

  private onMessage(connection: RelayConnection, executor: AppGatewayExecutor, data: RawData, isBinary: boolean): void {
    if (connection.closed) return;
    const text = rawDataToText(data);
    const parsed = parseInboundFrame(text ?? "", isBinary || text === null);
    switch (parsed.kind) {
      case "pong":
        if (connection.pongTimer) this.timers.clearTimeout(connection.pongTimer);
        connection.pongTimer = null;
        return;
      case "ready":
        if (connection.ready || parsed.frame.installationId !== connection.session.installationId) {
          this.protocolError(connection, "relay.ready mismatch");
          return;
        }
        this.onReady(connection, parsed.frame.pingIntervalMs);
        return;
      case "invalid-invoke":
        this.send(connection, executor.refuseMalformed(parsed.requestId));
        return;
      case "invoke": {
        const controller = new AbortController();
        connection.inflight.add(controller);
        void executor
          .handleInvoke(parsed.frame, connection.session, controller.signal)
          .then((response) => this.send(connection, response))
          .finally(() => connection.inflight.delete(controller));
        return;
      }
      case "protocol-error":
        this.protocolError(connection, parsed.reason);
        return;
    }
  }

  private onReady(connection: RelayConnection, pingIntervalMs: number): void {
    connection.ready = true;
    connection.readyAt = this.now();
    if (connection.readyTimer) this.timers.clearTimeout(connection.readyTimer);
    connection.readyTimer = null;
    this.state = "connected";
    this.reason = null;
    this.loggedReplacedElsewhere = false;
    const interval = Math.min(Math.max(pingIntervalMs, 1_000), PING_INTERVAL_MS);
    connection.pingTimer = this.timers.setInterval(() => this.ping(connection), interval);
    const renewInMs = Math.max(connection.ticket.renewAt * 1000 - this.now(), this.timing.minRenewDelayMs);
    this.scheduleTicketRenewal(renewInMs);
    log.info("Pages app gateway relay connected", { connection: connection.id });
  }

  private ping(connection: RelayConnection): void {
    if (connection.closed || connection.pongTimer) return;
    this.send(connection, PING_FRAME);
    connection.pongTimer = this.timers.setTimeout(() => {
      connection.pongTimer = null;
      log.warn("Pages app gateway relay missed pong; reconnecting", { connection: connection.id });
      this.terminateConnection(connection);
    }, this.timing.pongDeadlineMs);
  }

  private send(connection: RelayConnection, frame: string): void {
    if (connection.closed || connection.socket.readyState !== NodeWebSocket.OPEN) return;
    try {
      connection.socket.send(frame);
    } catch {
      // The close handler takes it from here.
    }
  }

  private protocolError(connection: RelayConnection, reason: string): void {
    log.warn("Pages app gateway relay protocol error", {
      connection: connection.id,
      code: CLOSE_PROTOCOL_ERROR,
      reason,
    });
    this.closeConnection(connection, CLOSE_PROTOCOL_ERROR, "protocol error");
    // Some transports never emit close after close(); make sure the runner moves on.
    this.onClose(connection, CLOSE_PROTOCOL_ERROR);
  }

  private terminateConnection(connection: RelayConnection): void {
    try {
      connection.socket.terminate();
    } catch {
      // Already gone.
    }
    this.onClose(connection, 1006);
  }

  private closeConnection(connection: RelayConnection, code: number, reason: string): void {
    this.teardown(connection);
    try {
      connection.socket.close(code, reason);
    } catch {
      // Already closed.
    }
  }

  /** Stop timers and abort invokes that arrived on this socket: nobody can receive their answer. */
  private teardown(connection: RelayConnection): void {
    connection.closed = true;
    if (connection.readyTimer) this.timers.clearTimeout(connection.readyTimer);
    if (connection.pingTimer) this.timers.clearInterval(connection.pingTimer);
    if (connection.pongTimer) this.timers.clearTimeout(connection.pongTimer);
    connection.readyTimer = null;
    connection.pingTimer = null;
    connection.pongTimer = null;
    for (const controller of connection.inflight) controller.abort();
  }

  private onClose(connection: RelayConnection, code: number): void {
    if (!this.connections.has(connection)) return;
    this.connections.delete(connection);
    this.teardown(connection);
    if (!this.running) return;

    const lastedMs = connection.readyAt === null ? 0 : this.now() - connection.readyAt;
    if (connection.ready && lastedMs >= this.timing.reconnectResetAfterMs) this.reconnectBackoffMs = 0;

    // Another socket of ours is still up or opening: it carries on. A renewal
    // socket that died before relay.ready is retried while the old one serves.
    if (this.liveConnections() > 0) {
      log.debug("Pages app gateway relay socket closed; another socket carries on", {
        connection: connection.id,
        code,
      });
      if (!connection.ready) this.scheduleTicketRenewal(this.nextReconnectBackoff());
      return;
    }
    this.clearTicketRenewal();

    // 4000 on a socket older than one this runner opened and the relay
    // accepted is our own renewal replacing it. That newer socket already
    // closed, so nobody else holds the installation: reconnect normally.
    if (code === CLOSE_REPLACED && connection.id >= this.latestAcceptedConnectionId) {
      if (!this.loggedReplacedElsewhere) {
        this.loggedReplacedElsewhere = true;
        log.warn("Pages app gateway relay replaced by another process for this installation; backing off");
      }
      this.park("replaced_elsewhere", this.timing.replacedElsewhereBackoffMs);
      return;
    }
    if (code === CLOSE_TICKET_EXPIRED) {
      this.state = "connecting";
      this.schedule(0);
      return;
    }
    log.info("Pages app gateway relay disconnected", { connection: connection.id, code });
    this.state = "connecting";
    this.schedule(this.nextReconnectBackoff());
  }
}

function rawDataToText(data: RawData): string | null {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return null;
}

function defaultExecutorFactory(env: NodeJS.ProcessEnv): (input: { jwksUrl: string }) => AppGatewayExecutor {
  return ({ jwksUrl }) => {
    const jwks = new AppGatewayJwksClient({ url: jwksUrl });
    return new AppGatewayExecutor({ resolveKey: jwks.resolveKey, env });
  };
}
