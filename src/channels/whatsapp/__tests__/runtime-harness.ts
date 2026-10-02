/**
 * Test harness for `WhatsAppRuntime`: a fake Baileys socket (EventEmitter `ev`
 * plus mocked socket methods), a fake JetStream client that records publishes, an
 * in-memory auth store, manual timers and a library whose socket/auth/ffmpeg seams
 * are faked while the ported handlers (connection, messages, all-events) stay real.
 *
 * The ported plugin-level tests built a real `WhatsAppPlugin` with a mocked socket; this
 * harness drives the runtime through exactly the same Baileys events.
 */

import { mock } from "bun:test";
import { EventEmitter } from "node:events";
import type { GroupMetadata, WASocket } from "baileys";
import type { JetStreamClient } from "nats";
import type { WhatsAppInboundEvent, WhatsAppInboundEventType } from "../events.js";
import type { Logger } from "../lib/foundation.js";
import type { SocketConfig } from "../lib/socket.js";
import {
  type WhatsAppAuthStorage,
  WhatsAppRuntime,
  type WhatsAppRuntimeOptions,
  type WhatsAppRuntimeTimers,
} from "../runtime.js";
import type { WhatsAppObservedEvent } from "../runtime-events.js";
import { type WhatsAppLibrary, whatsappLibrary } from "../runtime-library.js";
import { loadBaileys } from "../baileys-loader.js";

// The real handlers in the harness library read Baileys values through `baileys()`.
await loadBaileys();

export const OWNER_JID = "5511999990000:7@s.whatsapp.net";
export const OWNER_LID = "99887766554433:7@lid";

let instanceCounter = 0;

/** Unique per test: the ported connection handler keeps module-level state per instance id. */
export function uniqueInstanceId(prefix = "inst"): string {
  instanceCounter++;
  return `${prefix}-${process.pid}-${instanceCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

export const flush = (ms = 15) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ============================================================================
// Fake socket
// ============================================================================

/** Group fixtures: only `id` is required (Baileys fills the rest on the wire). */
export type GroupFixture = Partial<GroupMetadata> & { id: string };

export interface FakeSocketOptions {
  user?: { id: string; name?: string; lid?: string };
  groups?: Record<string, GroupFixture>;
}

export function createFakeSocket(options: FakeSocketOptions = {}) {
  const ev = new EventEmitter();
  ev.setMaxListeners(100);
  const groups = { ...options.groups } as Record<string, GroupMetadata>;
  let sentCounter = 0;

  const fake = {
    ev,
    user: options.user ?? { id: OWNER_JID, name: "Ravi Bot", lid: OWNER_LID },
    logger: undefined as unknown,
    sendMessage: mock(async (jid: string, content: Record<string, unknown>, _opts?: unknown) => {
      sentCounter++;
      const id = `SENT-${sentCounter}`;
      return { key: { id, remoteJid: jid, fromMe: true }, message: { conversation: String(content.text ?? "") } };
    }),
    presenceSubscribe: mock(async (_jid: string) => {}),
    sendPresenceUpdate: mock(async (_type: string, _jid?: string) => {}),
    readMessages: mock(async (_keys: unknown[]) => {}),
    groupMetadata: mock(async (jid: string): Promise<GroupMetadata> => {
      const metadata = groups[jid];
      if (!metadata) throw new Error(`item-not-found: ${jid}`);
      return metadata;
    }),
    groupFetchAllParticipating: mock(async (): Promise<Record<string, GroupMetadata>> => ({ ...groups })),
    getUSyncDevices: mock(async (jids: string[], _useCache: boolean, _ignoreZero: boolean) =>
      jids.map((jid) => ({ jid })),
    ),
    assertSessions: mock(async (_jids: string[], _force: boolean) => true),
    profilePictureUrl: mock(async (_jid: string, _type?: string) => "https://pps.whatsapp.net/me.jpg"),
    requestPairingCode: mock(async (_phone: string) => "ABCD1234"),
    sendPasskeyResponse: mock(async (_credential: unknown) => {}),
    sendPasskeyConfirmation: mock(async () => {}),
    onWhatsApp: mock(
      async (..._phones: string[]): Promise<Array<{ exists: boolean; jid: string; notify?: string }>> => [],
    ),
    getBusinessProfile: mock(async (_jid: string): Promise<unknown> => undefined),
    groupCreate: mock(
      async (subject: string, participants: string[]): Promise<GroupMetadata> =>
        ({
          id: "120363999999999999@g.us",
          subject,
          owner: OWNER_JID,
          creation: 1_700_000_000,
          participants: participants.map((id) => ({ id, admin: null })),
        }) as GroupMetadata,
    ),
    groupParticipantsUpdate: mock(async (_jid: string, participants: string[], _action: string) =>
      participants.map((jid) => ({ jid, status: "200" })),
    ),
    groupInviteCode: mock(async (_jid: string): Promise<string | undefined> => "INVITECODE"),
    groupRevokeInvite: mock(async (_jid: string): Promise<string | undefined> => "NEWCODE"),
    groupAcceptInvite: mock(async (_code: string): Promise<string | undefined> => "120363555555555555@g.us"),
    groupLeave: mock(async (_jid: string) => {}),
    groupUpdateSubject: mock(async (_jid: string, _subject: string) => {}),
    groupUpdateDescription: mock(async (_jid: string, _description?: string) => {}),
    groupSettingUpdate: mock(async (_jid: string, _setting: string) => {}),
    signalRepository: {
      lidMapping: {
        getLIDForPN: mock(async (_pn: string): Promise<string | null> => null),
        getPNForLID: mock(async (_lid: string): Promise<string | null> => null),
      },
    },
    logout: mock(async () => {}),
    end: mock((_error?: unknown) => {}),
  };

  return {
    fake,
    groups,
    sock: fake as unknown as WASocket,
    emit: (event: string, data: unknown) => ev.emit(event, data),
  };
}

export type FakeSocket = ReturnType<typeof createFakeSocket>;

// ============================================================================
// Fake JetStream
// ============================================================================

export interface PublishedRecord {
  subject: string;
  msgID?: string;
  /** The decoded wire event (`WhatsAppInboundEvent`, events.ts). */
  event: WhatsAppInboundEvent;
  raw: string;
}

/** A published record whose event is narrowed to one inbound event type. */
export type PublishedRecordOf<T extends WhatsAppInboundEventType> = PublishedRecord & {
  event: Extract<WhatsAppInboundEvent, { type: T }>;
};

export function createFakeJetStream(options: { failTimes?: number } = {}) {
  const published: PublishedRecord[] = [];
  let failures = options.failTimes ?? 0;
  const publish = mock(async (subject: string, data: Uint8Array, opts?: { msgID?: string }) => {
    if (failures > 0) {
      failures--;
      throw new Error("no responders available for request");
    }
    const raw = new TextDecoder().decode(data);
    published.push({ subject, msgID: opts?.msgID, event: JSON.parse(raw) as WhatsAppInboundEvent, raw });
    return { seq: published.length, duplicate: false };
  });
  return { js: { publish } as unknown as JetStreamClient, publish, published };
}

// ============================================================================
// Auth store + timers
// ============================================================================

export function createMemoryAuthStorage(options: { registered?: boolean } = {}) {
  const data = new Map<string, unknown>();
  const flags = { registered: options.registered ?? false, manualDisconnected: false };
  const storage: WhatsAppAuthStorage = {
    async get<T>(key: string) {
      return (data.has(key) ? data.get(key) : null) as T | null;
    },
    async set<T>(key: string, value: T) {
      data.set(key, value);
    },
    async delete(key: string) {
      return data.delete(key);
    },
    async has(key: string) {
      return data.has(key);
    },
    async keys() {
      return [...data.keys()];
    },
    hasRegisteredCreds: () => flags.registered,
    isManuallyDisconnected: () => flags.manualDisconnected,
    setManuallyDisconnected: (_instanceId: string, disconnected: boolean) => {
      flags.manualDisconnected = disconnected;
    },
  };
  return { storage, flags, data };
}

type TimerHandle = ReturnType<typeof setTimeout>;

export function createManualTimers() {
  let nextId = 1;
  const pending = new Map<number, { callback: () => void; ms: number }>();
  const timers: WhatsAppRuntimeTimers = {
    setTimeout: (callback, ms) => {
      const id = nextId++;
      pending.set(id, { callback, ms });
      return id as unknown as TimerHandle;
    },
    clearTimeout: (handle) => {
      pending.delete(handle as unknown as number);
    },
  };
  return {
    timers,
    pending,
    delays: () => [...pending.values()].map((entry) => entry.ms),
    /** Fire every pending timer once (timers armed while firing stay pending). */
    runAll: () => {
      const entries = [...pending.entries()];
      for (const [id, entry] of entries) {
        pending.delete(id);
        entry.callback();
      }
    },
  };
}

// ============================================================================
// Runtime harness
// ============================================================================

export interface HarnessOptions extends Partial<Omit<WhatsAppRuntimeOptions, "instanceId" | "jetstream">> {
  instanceId?: string;
  registered?: boolean;
  /** creds.me.id returned by the fake auth state (default: owner JID when registered). */
  credsMeId?: string | null;
  socketOptions?: WhatsAppRuntimeOptions["socketOptions"];
  socket?: FakeSocketOptions;
  publishFailTimes?: number;
  library?: Partial<WhatsAppLibrary>;
  /** Share an auth store between harnesses (simulates a runner restart on the same `auth.db`). */
  auth?: ReturnType<typeof createMemoryAuthStorage>;
}

export function createHarness(options: HarnessOptions = {}) {
  const {
    instanceId: requestedInstanceId,
    registered: _registered,
    credsMeId: _credsMeId,
    socket: _socket,
    publishFailTimes: _publishFailTimes,
    library: _library,
    auth: _auth,
    ...runtimeOverrides
  } = options;
  const instanceId = requestedInstanceId ?? uniqueInstanceId();
  const { js, publish, published } = createFakeJetStream({ failTimes: options.publishFailTimes });
  const auth = options.auth ?? createMemoryAuthStorage({ registered: options.registered ?? true });
  const manual = createManualTimers();
  const clock = { now: 1_750_000_000_000 };
  const sockets: FakeSocket[] = [];
  const socketConfigs: SocketConfig[] = [];
  const observed: WhatsAppObservedEvent[] = [];
  const ensureInboundStream = mock(async () => {});
  const saveCreds = mock(async () => {});
  const authFlush = mock(async (_options?: { timeoutMs?: number }) => true);
  const authDiscard = mock(async () => {});

  const library: WhatsAppLibrary = {
    ...whatsappLibrary,
    createSocket: mock(async (config: SocketConfig) => {
      socketConfigs.push(config);
      const created = createFakeSocket(options.socket);
      sockets.push(created);
      return created.sock;
    }),
    closeSocket: mock(async (sock: WASocket, logout = false) => {
      if (logout) await sock.logout();
      sock.end(undefined);
    }),
    createStorageAuthState: mock(async () => {
      const meId = options.credsMeId === undefined ? (auth.flags.registered ? OWNER_JID : null) : options.credsMeId;
      const state = { creds: meId ? { me: { id: meId }, registered: true } : {}, keys: {} };
      return {
        state,
        saveCreds,
        flush: authFlush,
        discard: authDiscard,
        pendingWrites: () => 0,
      } as unknown as Awaited<ReturnType<WhatsAppLibrary["createStorageAuthState"]>>;
    }),
    clearAuthState: mock(async () => {
      auth.flags.registered = false;
    }),
    convertBufferForVoiceNote: mock(async (_buffer: Buffer, _mimeType?: string) => ({
      buffer: Buffer.from("OggS-converted"),
      mimeType: "audio/ogg; codecs=opus",
    })),
    ...options.library,
  };

  const runtime = new WhatsAppRuntime({
    instanceId,
    accountName: "main",
    jetstream: js,
    ensureInboundStream,
    authStorage: auth.storage,
    now: () => clock.now,
    loadLibrary: async () => library,
    mediaBaseDir: "/tmp/ravi-whatsapp-runtime-test-media",
    logger: silentLogger,
    outboundTiming: {
      humanDelayEnabled: false,
      humanDelayMinMs: 0,
      humanDelayMaxMs: 0,
      typingSimulationEnabled: false,
      typingDelayBaseMs: 0,
      typingDelayPerCharMs: 0,
      typingDelayMaxMs: 0,
      typingDefaultMs: 0,
    },
    env: {},
    timers: manual.timers,
    sleep: async () => {},
    reconnect: { maxRetries: 2, baseDelay: 1, maxDelay: 2 },
    onEvent: (event) => observed.push(event),
    convertSticker: async () => Buffer.from("RIFF0000WEBPVP8 converted"),
    ...runtimeOverrides,
  });

  const socket = (index = -1): FakeSocket => {
    const entry = index < 0 ? sockets[sockets.length + index] : sockets[index];
    if (!entry) throw new Error(`no fake socket at ${index} (created: ${sockets.length})`);
    return entry;
  };

  /** start() and wait for the first socket. */
  const startAndWaitForSocket = async () => {
    runtime.start();
    await flush();
    return socket();
  };

  /** start(), then emit `connection: open` on the socket: state `connected`. */
  const connect = async () => {
    const sock = await startAndWaitForSocket();
    sock.emit("connection.update", { connection: "open" });
    await flush();
    return sock;
  };

  const publishedOfType = <T extends WhatsAppInboundEventType>(type: T): PublishedRecordOf<T>[] =>
    published.filter((record): record is PublishedRecordOf<T> => record.event.type === type);
  const observedOfType = (type: string) => observed.filter((event) => event.type === type);

  return {
    instanceId,
    runtime,
    library,
    js,
    publish,
    published,
    publishedOfType,
    observed,
    observedOfType,
    auth,
    manual,
    clock,
    sockets,
    socketConfigs,
    socket,
    ensureInboundStream,
    saveCreds,
    authFlush,
    authDiscard,
    startAndWaitForSocket,
    connect,
  };
}

export type Harness = ReturnType<typeof createHarness>;
