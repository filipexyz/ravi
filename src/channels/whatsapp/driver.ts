/**
 * Channel driver for WhatsApp (Baileys), registered in the `ravi channels` runner
 * next to Slack.
 *
 * One runtime per enabled `channels` row with provider `whatsapp`. The row binds the
 * Ravi instance with the same name (or `defaults.instance`), whose
 * `instances.instance_id` UUID is the transport instance id
 * (`listWhatsAppBindings`). The runtime publishes `WhatsAppInboundEvent`s (events.ts)
 * on CHANNEL_INBOUND and answers the daemon/CLI over the NATS RPC
 * (`rpc-server.ts`); it does not use the Channel Backend, so the driver only
 * declares the `inbound` capability.
 *
 * Importing this module never loads Baileys: the runtime (`runtime.ts`) and the
 * Baileys-backed library (`runtime-library.ts`) are dynamic imports resolved when a
 * runtime is created / started, and Baileys itself is loaded by `loadBaileys()`
 * (baileys-loader.ts: the vendored `dist/vendor/baileys.js` next to the bundle, else
 * the bare package). `start()` preloads it and every socket creation awaits it. A
 * load failure surfaces as health `failed` + reason `missing_dependency` and is
 * retried on the next connect.
 */

import type { JetStreamClient } from "nats";
import { z } from "zod";
import { configStore } from "../../config-store.js";
import { getNats } from "../../nats.js";
import type { RouterConfig } from "../../router/types.js";
import { logger } from "../../utils/logger.js";
import {
  NATIVE_CHANNEL_DRIVER_PROTOCOL,
  NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION,
  NativeChannelDriverContractError,
  NativeChannelDriverDescriptorSchema,
  NativeChannelRuntimeDescriptorSchema,
  type NativeChannelDriver,
  type NativeChannelDriverChannelConfig,
  type NativeChannelDriverRuntime,
  type NativeChannelRuntimeHealth,
} from "../native/driver.js";
import { WHATSAPP_DRIVER_ID, WHATSAPP_PROVIDER, listWhatsAppBindings, type WhatsAppBinding } from "./contract.js";
import type { WhatsAppRuntimeOptions } from "./runtime.js";
import type { WhatsAppLibrary } from "./runtime-library.js";
import {
  startWhatsAppRpcServer,
  type WhatsAppRpcDispatcher,
  type WhatsAppRpcServer,
  type WhatsAppRpcServerConnection,
} from "./rpc-server.js";

const log = logger.child("channels:whatsapp:driver");

type BindingConfig = Pick<RouterConfig, "instances" | "channels" | "instanceToAccount">;

/** The runtime surface the driver needs (`WhatsAppRuntime` satisfies it). */
export interface WhatsAppDriverRuntime extends WhatsAppRpcDispatcher {
  start(): void;
  stop(): Promise<void>;
  health(): NativeChannelRuntimeHealth;
}

/**
 * Channel `defaults` the driver reads (everything else is ignored).
 *
 * ```
 * ravi channels set <name> defaults '{"readReceiptMode":"off","whatsapp":{"markOnlineOnConnect":false}}'
 * ```
 */
export const WhatsAppChannelDefaultsSchema = z
  .object({
    /** Bound instance name when it differs from the channel name. */
    instance: z.string().optional(),
    readReceiptMode: z.enum(["on", "off", "exclude-self"]).optional(),
    /**
     * Forces the ingestMode of Baileys offline backlog (`append`). Unset (default):
     * age-aware, backlog older than `offlineStaleMs` is "history-sync", younger is "realtime".
     */
    offlineIngestMode: z.enum(["realtime", "history-sync"]).optional(),
    /** Age (ms, by `messageTimestamp`) from which offline backlog is history. Default 10 minutes. */
    offlineStaleMs: z.number().int().nonnegative().optional(),
    historyDownloadMedia: z.boolean().optional(),
    /** Connect at start when paired creds exist (default true). */
    autoConnect: z.boolean().optional(),
    /** Socket options (`WhatsAppConnectionOptionsSchema`, validated by the runtime module). */
    whatsapp: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export type WhatsAppChannelDefaults = z.infer<typeof WhatsAppChannelDefaultsSchema>;

export type WhatsAppRuntimeFactoryOptions = Omit<WhatsAppRuntimeOptions, "socketOptions"> & {
  /** Raw `defaults.whatsapp`; the default factory validates it with `WhatsAppConnectionOptionsSchema`. */
  socketOptions?: Record<string, unknown>;
};

export interface WhatsAppChannelDriverOptions {
  /** Live router config. Default: `configStore.getConfig()`. */
  readonly getConfig?: () => BindingConfig;
  /** NATS connection for the RPC server. Default: the runner's `getNats()`. */
  readonly connection?: () => WhatsAppRpcServerConnection;
  /** JetStream client for CHANNEL_INBOUND. Default: `getNats().jetstream()` (resolved lazily). */
  readonly jetstream?: () => JetStreamClient;
  /**
   * Builds the runtime. Default: dynamic import of `runtime.ts` and
   * `new WhatsAppRuntime(options)` (socket options validated first).
   */
  readonly createRuntime?: (
    options: WhatsAppRuntimeFactoryOptions,
  ) => WhatsAppDriverRuntime | Promise<WhatsAppDriverRuntime>;
  /** Loads the Baileys-backed library. Default: `loadWhatsAppLibrary()` (awaits `loadBaileys()`). */
  readonly loadLibrary?: () => Promise<WhatsAppLibrary>;
  /** Extra runtime options (tests: auth storage, timers, ...). */
  readonly runtimeOptions?: Partial<Omit<WhatsAppRuntimeOptions, "instanceId" | "jetstream" | "loadLibrary">>;
  /** Drain budget for in-flight RPCs on stop. */
  readonly rpcDrainTimeoutMs?: number;
}

const defaultLoadLibrary = async (): Promise<WhatsAppLibrary> =>
  (await import("./runtime-library.js")).loadWhatsAppLibrary();

async function defaultCreateRuntime(options: WhatsAppRuntimeFactoryOptions): Promise<WhatsAppDriverRuntime> {
  const { WhatsAppRuntime, WhatsAppConnectionOptionsSchema } = await import("./runtime.js");
  const socketOptions = WhatsAppConnectionOptionsSchema.safeParse(options.socketOptions ?? {});
  if (!socketOptions.success) {
    throw new NativeChannelDriverContractError("invalid_channel_configuration");
  }
  return new WhatsAppRuntime({ ...options, socketOptions: socketOptions.data });
}

/** The binding a WhatsApp channel resolves to in `config`, if any. */
export function resolveWhatsAppChannelBinding(config: BindingConfig, channelName: string): WhatsAppBinding | undefined {
  return listWhatsAppBindings(config).find((binding) => binding.channel.name === channelName);
}

/**
 * Reconcile key for a channel's binding: changes when the bound instance or its
 * transport UUID changes, so the runner restarts the runtime even though the
 * `channels` row itself did not change.
 */
export function whatsappChannelBindingKey(config: BindingConfig, channelName: string): string {
  const binding = resolveWhatsAppChannelBinding(config, channelName);
  return binding ? `${binding.accountName}:${binding.instanceId}` : "unbound";
}

export function createWhatsAppChannelDriver(options: WhatsAppChannelDriverOptions = {}): NativeChannelDriver {
  const descriptor = NativeChannelDriverDescriptorSchema.parse({
    protocol: NATIVE_CHANNEL_DRIVER_PROTOCOL,
    schemaVersion: NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION,
    driverId: WHATSAPP_DRIVER_ID,
    provider: WHATSAPP_PROVIDER,
    capabilities: ["inbound"],
  });
  const getConfig = options.getConfig ?? (() => configStore.getConfig());
  const getConnection = options.connection ?? (() => getNats());
  const getJetStream = options.jetstream ?? (() => getNats().jetstream());
  const loadLibrary = options.loadLibrary ?? defaultLoadLibrary;
  const createRuntime = options.createRuntime ?? defaultCreateRuntime;
  /** instanceId → channel name: one socket per WhatsApp account per runner. */
  const owners = new Map<string, string>();

  return {
    descriptor,
    async createRuntime(context): Promise<NativeChannelDriverRuntime> {
      const channel = context.channel;
      const defaults = WhatsAppChannelDefaultsSchema.safeParse(channel.defaults ?? {});
      if (!defaults.success) {
        throw new NativeChannelDriverContractError("invalid_channel_configuration");
      }
      const binding = resolveBinding(getConfig, channel);
      const owner = owners.get(binding.instanceId);
      if (owner !== undefined && owner !== channel.name) {
        log.warn("WhatsApp instance is already owned by another native channel", {
          channel: channel.name,
          owner,
          instance: binding.accountName,
        });
        throw new NativeChannelDriverContractError("invalid_channel_configuration");
      }

      // One library load shared by the dependency probe and the runtime. A failed load
      // is forgotten, so the runtime's next connect (or the next start) tries again.
      let libraryLoad: Promise<WhatsAppLibrary> | null = null;
      let dependency: "unknown" | "ready" | "missing" = "unknown";
      const loadLibraryOnce = () => {
        if (libraryLoad) return libraryLoad;
        const attempt = loadLibrary().then(
          (library) => {
            dependency = "ready";
            return library;
          },
          (error: unknown) => {
            dependency = "missing";
            if (libraryLoad === attempt) libraryLoad = null;
            throw error;
          },
        );
        libraryLoad = attempt;
        return attempt;
      };

      const runtime = await createRuntime({
        ...options.runtimeOptions,
        instanceId: binding.instanceId,
        accountName: binding.accountName,
        jetstream: getJetStream,
        loadLibrary: loadLibraryOnce,
        ...(defaults.data.whatsapp ? { socketOptions: defaults.data.whatsapp } : {}),
        ...(defaults.data.readReceiptMode ? { readReceiptMode: defaults.data.readReceiptMode } : {}),
        ...(defaults.data.offlineIngestMode ? { offlineIngestMode: defaults.data.offlineIngestMode } : {}),
        ...(defaults.data.offlineStaleMs !== undefined ? { offlineStaleMs: defaults.data.offlineStaleMs } : {}),
        ...(defaults.data.historyDownloadMedia !== undefined
          ? { historyDownloadMedia: defaults.data.historyDownloadMedia }
          : {}),
        ...(defaults.data.autoConnect !== undefined ? { autoConnect: defaults.data.autoConnect } : {}),
      });
      owners.set(binding.instanceId, channel.name);

      const runtimeDescriptor = NativeChannelRuntimeDescriptorSchema.parse({
        protocol: NATIVE_CHANNEL_DRIVER_PROTOCOL,
        schemaVersion: NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION,
        driverId: descriptor.driverId,
        provider: descriptor.provider,
        runtimeId: channel.name,
        channelInstanceId: channel.name,
        capabilities: [...descriptor.capabilities],
      });

      let server: WhatsAppRpcServer | null = null;
      let stopped = false;
      const release = () => {
        if (owners.get(binding.instanceId) === channel.name) owners.delete(binding.instanceId);
      };

      return {
        descriptor: runtimeDescriptor,
        start() {
          if (stopped) throw new NativeChannelDriverContractError("startup_failed");
          // Probe Baileys in the background; never blocks start.
          loadLibraryOnce().catch((error: unknown) => {
            log.error("WhatsApp native channel cannot load baileys", {
              channel: channel.name,
              instance: binding.accountName,
              error: error instanceof Error ? error.message : String(error),
            });
          });
          runtime.start();
          server = startWhatsAppRpcServer({
            instanceId: binding.instanceId,
            connection: getConnection(),
            dispatcher: runtime,
          });
          log.info("WhatsApp native channel started", {
            channel: channel.name,
            instance: binding.accountName,
            instanceId: binding.instanceId,
            rpcSubject: server.subject,
          });
        },
        async stop() {
          if (stopped) return;
          stopped = true;
          const rpcStopped = server?.stop({ drainTimeoutMs: options.rpcDrainTimeoutMs });
          try {
            await runtime.stop();
          } finally {
            await rpcStopped;
            server = null;
            release();
          }
        },
        health() {
          if (dependency === "missing") return { status: "failed", reason: "missing_dependency" };
          return runtime.health();
        },
      };
    },
  };
}

function resolveBinding(getConfig: () => BindingConfig, channel: NativeChannelDriverChannelConfig): WhatsAppBinding {
  let binding: WhatsAppBinding | undefined;
  try {
    binding = resolveWhatsAppChannelBinding(getConfig(), channel.name);
  } catch (error) {
    log.warn("Could not read the router config for a WhatsApp native channel", {
      channel: channel.name,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (!binding) {
    log.warn("WhatsApp native channel has no bound instance with a transport id", {
      channel: channel.name,
      instance: typeof channel.defaults?.instance === "string" ? channel.defaults.instance : channel.name,
    });
    throw new NativeChannelDriverContractError("invalid_channel_configuration");
  }
  return binding;
}
