import { afterEach, describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import type { ConsoleApiClient } from "../cloud-auth/client.js";
import { CloudAuthError } from "../cloud-auth/errors.js";
import type { CloudCredentials } from "../cloud-auth/types.js";
import type { AppGatewayExecutor, AppGatewayInvokeSession } from "./executor.js";
import type { AppsInvokeFrame } from "./frames.js";
import {
  AppGatewayRelayRunner,
  type AppGatewayRelayRunnerOptions,
  type RelaySocket,
  type RelayTimers,
  type TimerHandle,
} from "./relay-runner.js";
import type { RelayTicket } from "./ticket-client.js";

const CONSOLE_INSTALLATION = "6f1c2b8e-1d2c-4b5a-9e8f-0a1b2c3d4e5f";
const ORG = "0e3c1c9a-2f4b-4d6e-8a1b-3c5d7e9f1a2b";
const REQUEST_ID = "0b6c2f0e-6a4f-4f2a-9d55-3c1f6f3f8a11";

class FakeTimers implements RelayTimers {
  now = 1_790_000_000_000;
  private seq = 0;
  private readonly tasks = new Map<number, { at: number; fn: () => void; every?: number }>();

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = ++this.seq;
    this.tasks.set(id, { at: this.now + ms, fn });
    return id as unknown as TimerHandle;
  }
  setInterval(fn: () => void, ms: number): TimerHandle {
    const id = ++this.seq;
    this.tasks.set(id, { at: this.now + ms, fn, every: ms });
    return id as unknown as TimerHandle;
  }
  clearTimeout(handle: TimerHandle): void {
    this.tasks.delete(handle as unknown as number);
  }
  clearInterval(handle: TimerHandle): void {
    this.tasks.delete(handle as unknown as number);
  }

  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      await flush();
      let next: [number, { at: number; fn: () => void; every?: number }] | null = null;
      for (const entry of this.tasks) {
        if (entry[1].at <= target && (!next || entry[1].at < next[1].at)) next = entry;
      }
      if (!next) break;
      const [id, task] = next;
      this.now = task.at;
      if (task.every) task.at += task.every;
      else this.tasks.delete(id);
      task.fn();
    }
    this.now = target;
    await flush();
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

class FakeSocket extends EventEmitter implements RelaySocket {
  readyState = 0;
  protocol = "";
  readonly sent: string[] = [];
  readonly closes: number[] = [];
  terminated = false;
  /** The relay answers pings through the hibernation auto-response. */
  autoPong = true;

  constructor(
    readonly url: string,
    readonly protocols: string[],
    readonly headers: Record<string, string>,
  ) {
    super();
  }

  send(data: string): void {
    this.sent.push(data);
    if (this.autoPong && data === '{"type":"ping"}') queueMicrotask(() => this.receive('{"type":"pong"}'));
  }
  close(code?: number): void {
    this.closes.push(code ?? 1000);
    this.readyState = 3;
  }
  terminate(): void {
    this.terminated = true;
    this.readyState = 3;
  }

  accept(): void {
    this.readyState = 1;
    this.protocol = "ravi.executor-relay.v1";
    this.emit("open");
  }
  ready(installationId = CONSOLE_INSTALLATION): void {
    this.receive(
      JSON.stringify({
        type: "relay.ready",
        v: 1,
        installationId,
        ticketExpiresAt: 1_790_000_900,
        maxFrameBytes: 1_179_648,
        invokeTimeoutMs: 30_000,
        pingIntervalMs: 25_000,
      }),
    );
  }
  receive(text: string, isBinary = false): void {
    this.emit("message", Buffer.from(text), isBinary);
  }
  serverClose(code: number): void {
    this.readyState = 3;
    this.emit("close", code, Buffer.alloc(0));
  }
}

function credentials(overrides: Partial<CloudCredentials> = {}): CloudCredentials {
  return {
    version: 1,
    consoleUrl: "https://console.ravi.test",
    installationId: "local-generated-installation",
    accessToken: "access",
    refreshToken: "refresh",
    accessTokenExpiresAt: null,
    scopes: ["console.apps.relay"],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

interface Harness {
  runner: AppGatewayRelayRunner;
  timers: FakeTimers;
  sockets: FakeSocket[];
  tickets: number;
  invokes: Array<{ frame: AppsInvokeFrame; session: AppGatewayInvokeSession; signal: AbortSignal }>;
  leases: { held: boolean; acquired: string[]; releases: number };
  settings: Map<string, string>;
  ticketError: Error | null;
}

const runners: AppGatewayRelayRunner[] = [];

afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop();
});

function harness(options: Partial<AppGatewayRelayRunnerOptions> & { creds?: CloudCredentials | null } = {}): Harness {
  const timers = new FakeTimers();
  const state: Harness = {
    runner: null as unknown as AppGatewayRelayRunner,
    timers,
    sockets: [],
    tickets: 0,
    invokes: [],
    leases: { held: false, acquired: [], releases: 0 },
    settings: new Map([["apps.gateway.allowed_operations", "slides:slides.list"]]),
    ticketError: null,
  };
  const executor = {
    refuseMalformed: (requestId: string) =>
      JSON.stringify({ type: "apps.error", v: 1, requestId, error: "payload_invalid" }),
    handleInvoke: async (frame: AppsInvokeFrame, session: AppGatewayInvokeSession, signal: AbortSignal) => {
      state.invokes.push({ frame, session, signal });
      return JSON.stringify({ type: "apps.result", v: 1, requestId: frame.requestId, status: 200, body: null });
    },
  } as unknown as AppGatewayExecutor;
  state.runner = new AppGatewayRelayRunner({
    env: { RAVI_APP_GATEWAY_ENABLED: "1" },
    readCredentials: () => (options.creds === undefined ? credentials() : options.creds),
    createClient: () => ({}) as ConsoleApiClient,
    fetchTicket: async (): Promise<RelayTicket> => {
      state.tickets++;
      if (state.ticketError) throw state.ticketError;
      const nowSeconds = Math.floor(timers.now / 1000);
      return {
        ticket: `h.p${state.tickets}.s`,
        expiresAt: nowSeconds + 900,
        renewAt: nowSeconds + 720,
        relayUrl: "wss://ravi.page/_ravi/executor-relay/v1/connect",
        protocol: "ravi.executor-relay.v1",
        issuer: "https://console.ravi.test",
        installationId: CONSOLE_INSTALLATION,
        organizationId: ORG,
      };
    },
    createExecutor: () => executor,
    openSocket: (url, protocols, socketOptions) => {
      const socket = new FakeSocket(url, protocols, socketOptions.headers);
      state.sockets.push(socket);
      return socket;
    },
    readSetting: (key) => state.settings.get(key) ?? null,
    lease: {
      acquire: ({ lockKey }) => {
        if (state.leases.held) return false;
        state.leases.acquired.push(lockKey);
        return true;
      },
      renew: () => !state.leases.held,
      release: () => {
        state.leases.releases++;
      },
    },
    timers,
    now: () => timers.now,
    random: () => 0.5,
    ...options,
  });
  runners.push(state.runner);
  return state;
}

async function connect(h: Harness): Promise<FakeSocket> {
  await h.runner.start();
  await h.timers.advance(0);
  const socket = h.sockets.at(-1)!;
  socket.accept();
  socket.ready();
  await flush();
  return socket;
}

describe("Pages app gateway relay runner enablement", () => {
  it("never starts without RAVI_APP_GATEWAY_ENABLED=1", async () => {
    for (const value of [undefined, "0", "true", "yes"]) {
      const h = harness({ env: value === undefined ? {} : { RAVI_APP_GATEWAY_ENABLED: value } });
      await h.runner.start();
      await h.timers.advance(120_000);
      expect(h.tickets).toBe(0);
      expect(h.sockets).toHaveLength(0);
      expect(h.runner.status().state).toBe("stopped");
    }
  });

  it("parks without the relay scope, credentials, allowed operations, or the lease and re-checks every 60 s", async () => {
    const noScope = harness({ creds: credentials({ scopes: ["console.inbox.read"] }) });
    await noScope.runner.start();
    await noScope.timers.advance(0);
    expect(noScope.runner.status()).toMatchObject({ state: "parked", reason: "scope_missing" });

    const loggedOut = harness({ creds: null });
    await loggedOut.runner.start();
    await loggedOut.timers.advance(0);
    expect(loggedOut.runner.status()).toMatchObject({ state: "parked", reason: "not_logged_in" });

    const noOps = harness();
    noOps.settings.set("apps.gateway.allowed_operations", "slides:*");
    await noOps.runner.start();
    await noOps.timers.advance(0);
    expect(noOps.runner.status()).toMatchObject({ state: "parked", reason: "no_allowed_operations" });
    noOps.settings.set("apps.gateway.allowed_operations", "slides:slides.list");
    await noOps.timers.advance(59_000);
    expect(noOps.tickets).toBe(0);
    await noOps.timers.advance(1_000);
    expect(noOps.tickets).toBe(1);

    const leased = harness();
    leased.leases.held = true;
    await leased.runner.start();
    await leased.timers.advance(0);
    expect(leased.runner.status()).toMatchObject({ state: "parked", reason: "lease_held_elsewhere" });

    for (const h of [noScope, loggedOut, leased]) {
      expect(h.tickets).toBe(0);
      expect(h.sockets).toHaveLength(0);
    }
  });

  it("keys the lease by the stored Console URL and installation", async () => {
    const h = harness();
    await connect(h);
    expect(h.leases.acquired).toEqual(["https://console.ravi.test\u0000local-generated-installation"]);
  });
});

describe("Pages app gateway relay runner connection", () => {
  it("dials with the ticket in Authorization, answers invokes on the same socket, and binds to the ticket installation", async () => {
    const h = harness();
    const socket = await connect(h);
    expect(socket.url).toBe("wss://ravi.page/_ravi/executor-relay/v1/connect");
    expect(socket.protocols).toEqual(["ravi.executor-relay.v1"]);
    expect(socket.headers).toEqual({ Authorization: "Bearer h.p1.s" });
    expect(socket.url).not.toContain("h.p1.s");
    expect(h.runner.status()).toMatchObject({ state: "connected", readyConnections: 1 });

    socket.receive(
      JSON.stringify({
        type: "apps.invoke",
        v: 1,
        requestId: REQUEST_ID,
        appId: "slides",
        operation: "slides.list",
        assertion: "a.b.c",
        grant: "d.e.f",
        body: {},
      }),
    );
    await flush();
    expect(h.invokes).toHaveLength(1);
    expect(h.invokes[0]!.session).toEqual({
      installationId: CONSOLE_INSTALLATION,
      organizationId: ORG,
      issuer: "https://console.ravi.test",
    });
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({ type: "apps.result", requestId: REQUEST_ID });

    socket.receive(
      JSON.stringify({
        type: "apps.invoke",
        v: 1,
        requestId: REQUEST_ID,
        appId: "Bad",
        operation: "x",
        assertion: "",
        grant: "",
        body: {},
      }),
    );
    await flush();
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({ type: "apps.error", error: "payload_invalid" });
  });

  it("closes with 4003 on protocol errors and on a relay.ready for another installation", async () => {
    const h = harness();
    const socket = await connect(h);
    socket.receive('{"type":"apps.invoke","v":1,"extra":true}');
    expect(socket.closes).toEqual([4003]);
    await h.timers.advance(1_000);
    const second = h.sockets.at(-1)!;
    expect(second).not.toBe(socket);
    second.accept();
    second.ready("00000000-0000-4000-8000-000000000000");
    expect(second.closes).toEqual([4003]);

    await h.timers.advance(2_000);
    const third = h.sockets.at(-1)!;
    third.accept();
    third.receive("{}", true);
    expect(third.closes).toEqual([4003]);
  });

  it("pings every interval and terminates when no pong arrives within 10 s", async () => {
    const h = harness();
    const socket = await connect(h);
    socket.autoPong = false;
    await h.timers.advance(25_000);
    expect(socket.sent).toEqual(['{"type":"ping"}']);
    socket.receive('{"type":"pong"}');
    await h.timers.advance(25_000);
    expect(socket.sent).toEqual(['{"type":"ping"}', '{"type":"ping"}']);
    await h.timers.advance(10_000);
    expect(socket.terminated).toBe(true);
    await h.timers.advance(1_000);
    expect(h.sockets).toHaveLength(2);
  });

  it("aborts invokes in flight when their socket closes", async () => {
    let resolveInvoke: ((value: string) => void) | null = null;
    const signals: AbortSignal[] = [];
    const executor = {
      refuseMalformed: () => "",
      handleInvoke: (_frame: AppsInvokeFrame, _session: AppGatewayInvokeSession, signal: AbortSignal) => {
        signals.push(signal);
        return new Promise<string>((resolve) => {
          resolveInvoke = resolve;
        });
      },
    } as unknown as AppGatewayExecutor;
    const slow = harness({ createExecutor: () => executor });
    const socket = await connect(slow);
    socket.receive(
      JSON.stringify({
        type: "apps.invoke",
        v: 1,
        requestId: REQUEST_ID,
        appId: "slides",
        operation: "slides.list",
        assertion: "a.b.c",
        grant: "d.e.f",
        body: {},
      }),
    );
    await flush();
    expect(signals[0]!.aborted).toBe(false);
    socket.serverClose(1006);
    expect(signals[0]!.aborted).toBe(true);
    resolveInvoke!("late");
    await flush();
    expect(socket.sent).not.toContain("late");
  });

  it("renews at renewAt on a second socket and does not reconnect when the old one is replaced (4000)", async () => {
    const h = harness();
    const first = await connect(h);
    await h.timers.advance(719_000);
    expect(h.tickets).toBe(1);
    await h.timers.advance(1_000);
    expect(h.tickets).toBe(2);
    const second = h.sockets.at(-1)!;
    expect(second).not.toBe(first);
    expect(second.headers).toEqual({ Authorization: "Bearer h.p2.s" });
    second.accept();
    second.ready();
    first.serverClose(4000);
    await h.timers.advance(120_000);
    expect(h.sockets).toHaveLength(2);
    expect(h.tickets).toBe(2);
    expect(h.runner.status()).toMatchObject({ state: "connected", connections: 1, readyConnections: 1 });
  });

  it("reconnects with normal backoff when its own renewal socket closes before the old one gets 4000", async () => {
    const h = harness();
    const first = await connect(h);
    await h.timers.advance(720_000);
    expect(h.tickets).toBe(2);
    const second = h.sockets.at(-1)!;
    second.accept();
    second.ready();
    // The relay drains the first socket for the second; the second dies first.
    second.serverClose(1006);
    expect(h.runner.status()).toMatchObject({ state: "connected", connections: 1 });
    first.serverClose(4000);
    expect(h.runner.status()).toMatchObject({ state: "connecting", connections: 0 });
    expect(h.runner.status().reason).not.toBe("replaced_elsewhere");
    expect(h.leases.releases).toBe(0);

    await h.timers.advance(999);
    expect(h.tickets).toBe(2);
    await h.timers.advance(1);
    expect(h.tickets).toBe(3);
    const third = h.sockets.at(-1)!;
    expect(third).not.toBe(second);
    third.accept();
    third.ready();
    expect(h.runner.status()).toMatchObject({ state: "connected", connections: 1, readyConnections: 1 });
  });

  it("still backs off 60 s on 4000 when its renewal socket was never accepted by the relay", async () => {
    const h = harness();
    const first = await connect(h);
    await h.timers.advance(720_000);
    expect(h.tickets).toBe(2);
    // Handshake refused: the relay never accepted it, so it replaced nothing.
    h.sockets.at(-1)!.serverClose(1006);
    first.serverClose(4000);
    expect(h.runner.status()).toMatchObject({ state: "parked", reason: "replaced_elsewhere" });
    await h.timers.advance(59_000);
    expect(h.tickets).toBe(2);
    await h.timers.advance(1_000);
    expect(h.tickets).toBe(3);
  });

  it("backs off 60 s when replaced by another process and reconnects at once on 4001", async () => {
    const h = harness();
    const socket = await connect(h);
    socket.serverClose(4000);
    expect(h.runner.status()).toMatchObject({ state: "parked", reason: "replaced_elsewhere" });
    await h.timers.advance(59_000);
    expect(h.tickets).toBe(1);
    await h.timers.advance(1_000);
    expect(h.tickets).toBe(2);

    const next = h.sockets.at(-1)!;
    next.accept();
    next.ready();
    next.serverClose(4001);
    await h.timers.advance(0);
    expect(h.tickets).toBe(3);
  });

  it("reconnects with doubling backoff capped at 60 s and resets after a 60 s ready connection", async () => {
    const h = harness();
    let socket = await connect(h);
    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      socket.serverClose(4002);
      const before = h.sockets.length;
      let waited = 0;
      while (h.sockets.length === before) {
        await h.timers.advance(500);
        waited += 500;
      }
      delays.push(waited);
      socket = h.sockets.at(-1)!;
      socket.accept();
      socket.ready();
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);

    await h.timers.advance(60_000);
    socket.serverClose(1000);
    await h.timers.advance(1_000);
    expect(h.sockets.at(-1)).not.toBe(socket);
  });

  it("maps ticket errors to park and backoff delays", async () => {
    const cases: Array<[Error, number]> = [
      [new CloudAuthError("AUTH_REQUIRED", "x"), 60_000],
      [new CloudAuthError("INSTALLATION_REVOKED", "x"), 60_000],
      [new CloudAuthError("PROJECT_ACCESS_DENIED", "x"), 300_000],
      [new CloudAuthError("RATE_LIMITED", "x", { retryAfterMs: 42_000 }), 42_000],
      [new CloudAuthError("SERVER_UNAVAILABLE", "x"), 5_000],
    ];
    for (const [error, delay] of cases) {
      const h = harness();
      h.ticketError = error;
      await h.runner.start();
      await h.timers.advance(0);
      expect(h.tickets).toBe(1);
      await h.timers.advance(delay - 1);
      expect(h.tickets).toBe(1);
      await h.timers.advance(1);
      expect(h.tickets).toBe(2);
      expect(h.sockets).toHaveLength(0);
    }
  });

  it("disconnects and parks when the lease is lost or the allowlist is emptied", async () => {
    const h = harness();
    const socket = await connect(h);
    h.settings.set("apps.gateway.allowed_operations", "");
    await h.timers.advance(20_000);
    expect(socket.closes).toEqual([1000]);
    expect(h.runner.status()).toMatchObject({ state: "parked", reason: "no_allowed_operations" });

    const leased = harness();
    const other = await connect(leased);
    leased.leases.held = true;
    await leased.timers.advance(20_000);
    expect(other.closes).toEqual([1000]);
    expect(leased.runner.status()).toMatchObject({ state: "parked", reason: "lease_lost" });
  });

  it("closes sockets and releases the lease on stop", async () => {
    const h = harness();
    const socket = await connect(h);
    await h.runner.stop();
    expect(socket.closes).toEqual([1000]);
    expect(h.leases.releases).toBeGreaterThan(0);
    expect(h.runner.status().state).toBe("stopped");
  });
});
