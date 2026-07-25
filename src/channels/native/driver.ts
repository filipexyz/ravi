import { z } from "zod";
import type { ChannelConfig } from "../../router/router-db.js";
import {
  ChannelBackendOpaqueIdSchema,
  ChannelBackendWireKindSchema,
  type ChannelIngressRequest,
  type ChannelIngressResult,
  type ChannelOutputSink,
  type ExternalChannelIdentity,
} from "../backend.js";
import type { ChannelAdapterHealth } from "../health.js";
import type { RemoteInstallationCredential } from "../../cloud-auth/remote-login.js";
import type {
  ChannelInterruptRequest,
  ChannelInterruptResult,
  ChannelRuntimeEventSink,
  ChannelRuntimeReadbackRequest,
  ChannelRuntimeReadbackResult,
} from "../runtime-events.js";
import type { NativeChatActionDelivery, NativePresenceDelivery, NativeTextDelivery } from "./types.js";
import { createNativeChannelDriverHostLease, type NativeChannelDriverHostLease } from "./host.js";

export const NATIVE_CHANNEL_DRIVER_PROTOCOL = "ravi.channel.native-driver" as const;
export const NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION = 1 as const;
export const NATIVE_CHANNEL_DRIVER_MODULES_ENV = "RAVI_NATIVE_CHANNEL_DRIVERS" as const;

export const NativeChannelDriverCapabilitySchema = z.enum(["inbound", "text_delivery", "chat_actions", "presence"]);

export const NativeChannelDriverCapabilitiesSchema = z.array(NativeChannelDriverCapabilitySchema).min(1).max(4);

export const NativeChannelDriverHostCapabilitySchema = z.enum(["installation_credentials"]);

export const NativeChannelDriverHostCapabilitiesSchema = z.array(NativeChannelDriverHostCapabilitySchema).min(1).max(1);

export const NativeChannelDriverModuleSpecifierSchema = z
  .string()
  .regex(/^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*|file:\/\/\/[^\u0000-\u001f\u007f]+)$/);

export const NativeChannelDriverModuleConfigSchema = z.object({
  protocol: z.literal(NATIVE_CHANNEL_DRIVER_PROTOCOL),
  schemaVersion: z.literal(NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION),
  provider: ChannelBackendWireKindSchema,
  moduleSpecifier: NativeChannelDriverModuleSpecifierSchema,
});

export const NativeChannelDriverDescriptorSchema = z.object({
  protocol: z.literal(NATIVE_CHANNEL_DRIVER_PROTOCOL),
  schemaVersion: z.literal(NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION),
  driverId: ChannelBackendWireKindSchema,
  provider: ChannelBackendWireKindSchema,
  capabilities: NativeChannelDriverCapabilitiesSchema,
  requiredHostCapabilities: NativeChannelDriverHostCapabilitiesSchema.optional(),
});

export const NativeChannelRuntimeDescriptorSchema = z.object({
  protocol: z.literal(NATIVE_CHANNEL_DRIVER_PROTOCOL),
  schemaVersion: z.literal(NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION),
  driverId: ChannelBackendWireKindSchema,
  provider: ChannelBackendWireKindSchema,
  runtimeId: ChannelBackendOpaqueIdSchema,
  channelInstanceId: ChannelBackendOpaqueIdSchema,
  capabilities: NativeChannelDriverCapabilitiesSchema,
});

export const NativeChannelRuntimeHealthSchema = z.object({
  status: z.enum(["disabled", "starting", "connected", "degraded", "reconnecting", "disconnected", "failed"]),
  reason: ChannelBackendWireKindSchema.optional(),
  connectedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  lastPongAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  reconnectCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
});

export type NativeChannelDriverCapability = z.infer<typeof NativeChannelDriverCapabilitySchema>;
export type NativeChannelDriverHostCapability = z.infer<typeof NativeChannelDriverHostCapabilitySchema>;
export type NativeChannelDriverModuleConfig = z.infer<typeof NativeChannelDriverModuleConfigSchema>;
export type NativeChannelDriverDescriptor = z.infer<typeof NativeChannelDriverDescriptorSchema>;
export type NativeChannelRuntimeDescriptor = z.infer<typeof NativeChannelRuntimeDescriptorSchema>;
export type NativeChannelRuntimeHealth = z.infer<typeof NativeChannelRuntimeHealthSchema>;

export type NativeChannelDriverFailureReason =
  | "invalid_driver_configuration"
  | "module_load_failed"
  | "invalid_module_export"
  | "incompatible_abi"
  | "provider_mismatch"
  | "duplicate_provider"
  | "duplicate_driver"
  | "driver_not_registered"
  | "invalid_channel_configuration"
  | "runtime_descriptor_invalid"
  | "runtime_capability_mismatch"
  | "runtime_surface_mismatch"
  | "host_capability_missing"
  | "missing_credentials"
  | "startup_failed"
  | "health_invalid"
  | "stop_failed";

export interface NativeChannelDriverChannelConfig {
  readonly name: string;
  readonly provider: string;
  readonly credentialConnection?: string;
  readonly defaults?: Readonly<Record<string, unknown>>;
}

export interface NativeChannelDriverHost {
  readInstallationCredential(): Promise<RemoteInstallationCredential | null>;
  ingress(request: ChannelIngressRequest): Promise<ChannelIngressResult>;
  interrupt(request: ChannelInterruptRequest): Promise<ChannelInterruptResult>;
  readback(request: ChannelRuntimeReadbackRequest): Promise<ChannelRuntimeReadbackResult>;
  registerOutputSink(
    target: Pick<ExternalChannelIdentity, "channelKind" | "connectionId">,
    sink: ChannelOutputSink,
  ): () => void;
  registerRuntimeEventSink(
    target: Pick<ExternalChannelIdentity, "channelKind" | "connectionId">,
    sink: ChannelRuntimeEventSink,
  ): () => void;
}

export interface NativeChannelDriverContext {
  readonly channel: NativeChannelDriverChannelConfig;
  readonly host: NativeChannelDriverHost;
}

export interface NativeChannelDriverRuntime {
  readonly descriptor: NativeChannelRuntimeDescriptor;
  readonly delivery?: NativeTextDelivery;
  readonly actions?: NativeChatActionDelivery;
  readonly presence?: NativePresenceDelivery;
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
  health(): NativeChannelRuntimeHealth;
}

export interface NativeChannelDriver {
  readonly descriptor: NativeChannelDriverDescriptor;
  createRuntime(context: NativeChannelDriverContext): NativeChannelDriverRuntime | Promise<NativeChannelDriverRuntime>;
}

export interface NativeChannelDriverModule {
  readonly nativeChannelDriver: NativeChannelDriver;
}

export class NativeChannelDriverContractError extends Error {
  constructor(readonly reason: NativeChannelDriverFailureReason) {
    super(reason);
    this.name = "NativeChannelDriverContractError";
  }
}

export class NativeChannelDriverRegistry {
  private readonly driversByProvider = new Map<string, NativeChannelDriver>();
  private readonly providersByDriverId = new Map<string, string>();
  private readonly failuresByProvider = new Map<string, NativeChannelDriverFailureReason>();

  register(input: NativeChannelDriver): void {
    const descriptor = parseDriverDescriptor(input?.descriptor);
    if (typeof input.createRuntime !== "function") {
      throw new NativeChannelDriverContractError("invalid_module_export");
    }
    if (this.driversByProvider.has(descriptor.provider)) {
      throw new NativeChannelDriverContractError("duplicate_provider");
    }
    if (this.providersByDriverId.has(descriptor.driverId)) {
      throw new NativeChannelDriverContractError("duplicate_driver");
    }
    this.driversByProvider.set(descriptor.provider, input);
    this.providersByDriverId.set(descriptor.driverId, descriptor.provider);
    this.failuresByProvider.delete(descriptor.provider);
  }

  get(provider: string): NativeChannelDriver | undefined {
    return this.driversByProvider.get(provider);
  }

  recordFailure(provider: string, reason: NativeChannelDriverFailureReason): void {
    if (!this.driversByProvider.has(provider)) this.failuresByProvider.set(provider, reason);
  }

  failure(provider: string): NativeChannelDriverFailureReason | undefined {
    return this.failuresByProvider.get(provider);
  }
}

export type NativeChannelDriverImporter = (moduleSpecifier: string) => Promise<unknown>;

export interface NativeChannelDriverLoadFailure {
  readonly provider: string;
  readonly reason: NativeChannelDriverFailureReason;
}

export interface NativeChannelDriverLoadResult {
  readonly loadedProviders: readonly string[];
  readonly failures: readonly NativeChannelDriverLoadFailure[];
}

export function parseNativeChannelDriverModuleConfigs(value: string | undefined): NativeChannelDriverModuleConfig[] {
  if (!value?.trim()) return [];
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new NativeChannelDriverContractError("invalid_driver_configuration");
  }
  const parsed = z.array(NativeChannelDriverModuleConfigSchema).safeParse(decoded);
  if (!parsed.success) {
    throw new NativeChannelDriverContractError("invalid_driver_configuration");
  }
  const providers = new Set<string>();
  for (const config of parsed.data) {
    if (providers.has(config.provider)) {
      throw new NativeChannelDriverContractError("duplicate_provider");
    }
    providers.add(config.provider);
  }
  return parsed.data;
}

export async function loadNativeChannelDriverModules(
  configs: readonly NativeChannelDriverModuleConfig[],
  registry: NativeChannelDriverRegistry,
  importer: NativeChannelDriverImporter = (moduleSpecifier) => import(moduleSpecifier),
): Promise<NativeChannelDriverLoadResult> {
  const loadedProviders: string[] = [];
  const failures: NativeChannelDriverLoadFailure[] = [];
  for (const input of configs) {
    const config = NativeChannelDriverModuleConfigSchema.parse(input);
    let moduleValue: unknown;
    try {
      moduleValue = await importer(config.moduleSpecifier);
    } catch {
      const reason = "module_load_failed";
      registry.recordFailure(config.provider, reason);
      failures.push({ provider: config.provider, reason });
      continue;
    }

    let driver: NativeChannelDriver;
    try {
      driver = extractDriver(moduleValue);
      const descriptor = parseDriverDescriptor(driver.descriptor);
      if (descriptor.provider !== config.provider) {
        throw new NativeChannelDriverContractError("provider_mismatch");
      }
      registry.register(driver);
      loadedProviders.push(config.provider);
    } catch (error) {
      const reason = driverFailureReason(error, "invalid_module_export");
      registry.recordFailure(config.provider, reason);
      failures.push({ provider: config.provider, reason });
    }
  }
  return { loadedProviders, failures };
}

interface ActiveNativeChannelRuntime {
  readonly runtime: NativeChannelDriverRuntime;
  readonly descriptor: NativeChannelRuntimeDescriptor;
  readonly healthId: string;
  readonly lease: NativeChannelDriverHostLease;
}

export interface NativeChannelDriverManagerOptions {
  readonly channels: Readonly<Record<string, ChannelConfig>>;
  readonly registry: NativeChannelDriverRegistry;
  readonly createHostLease?: (channel: ChannelConfig, provider: string) => NativeChannelDriverHostLease;
}

export class NativeChannelDriverManager {
  private readonly statuses = new Map<string, ChannelAdapterHealth>();
  private readonly active: ActiveNativeChannelRuntime[] = [];
  private started = false;

  constructor(private readonly options: NativeChannelDriverManagerOptions) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.statuses.clear();
    const channels = Object.values(this.options.channels)
      .filter((channel) => channel.enabled !== false)
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const [index, channel] of channels.entries()) {
      await this.startChannel(channel, index);
    }
  }

  async stop(): Promise<void> {
    for (const active of [...this.active].reverse()) {
      let reason: NativeChannelDriverFailureReason | undefined;
      try {
        await active.runtime.stop();
      } catch {
        reason = "stop_failed";
      } finally {
        active.lease.dispose();
      }
      this.statuses.set(active.healthId, {
        id: active.healthId,
        channelId: active.descriptor.provider,
        status: reason ? "failed" : "disconnected",
        ...(reason ? { reason } : {}),
      });
    }
    this.active.length = 0;
    this.started = false;
  }

  deliveries(): NativeTextDelivery[] {
    return this.active.flatMap(({ runtime }) => (runtime.delivery ? [runtime.delivery] : []));
  }

  actionDeliveries(): NativeChatActionDelivery[] {
    return this.active.flatMap(({ runtime }) => (runtime.actions ? [runtime.actions] : []));
  }

  presenceDeliveries(): NativePresenceDelivery[] {
    return this.active.flatMap(({ runtime }) => (runtime.presence ? [runtime.presence] : []));
  }

  health(): ChannelAdapterHealth[] {
    const statuses = new Map(this.statuses);
    for (const active of this.active) {
      let health: NativeChannelRuntimeHealth;
      try {
        health = NativeChannelRuntimeHealthSchema.parse(active.runtime.health());
      } catch {
        health = { status: "failed", reason: "health_invalid" };
      }
      statuses.set(active.healthId, {
        id: active.healthId,
        channelId: active.descriptor.provider,
        ...health,
      });
    }
    return [...statuses.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  private async startChannel(channel: ChannelConfig, index: number): Promise<void> {
    const pendingId = pendingHealthId(channel, index);
    let provider: string;
    try {
      provider = ChannelBackendWireKindSchema.parse(channel.provider);
      ChannelBackendOpaqueIdSchema.parse(channel.name);
    } catch {
      this.statuses.set(pendingId, {
        id: pendingId,
        channelId: "native",
        status: "failed",
        reason: "invalid_channel_configuration",
      });
      return;
    }

    const driver = this.options.registry.get(provider);
    if (!driver) {
      this.statuses.set(pendingId, {
        id: pendingId,
        channelId: provider,
        status: "failed",
        reason: this.options.registry.failure(provider) ?? "driver_not_registered",
      });
      return;
    }

    this.statuses.set(pendingId, {
      id: pendingId,
      channelId: provider,
      status: "starting",
    });
    const createHostLease =
      this.options.createHostLease ??
      ((configuredChannel, configuredProvider) =>
        createNativeChannelDriverHostLease({
          channel: configuredChannel,
          provider: configuredProvider,
        }));
    let lease: NativeChannelDriverHostLease | undefined;
    let runtime: NativeChannelDriverRuntime | undefined;
    try {
      lease = createHostLease(channel, provider);
      const driverDescriptor = parseDriverDescriptor(driver.descriptor);
      assertHostCapabilities(driverDescriptor, lease.host);
      runtime = await driver.createRuntime({
        channel: {
          name: channel.name,
          provider,
          ...(channel.credentialConnection ? { credentialConnection: channel.credentialConnection } : {}),
          ...(channel.defaults ? { defaults: channel.defaults } : {}),
        },
        host: lease.host,
      });
      const descriptor = validateRuntime(driverDescriptor, channel, runtime);
      const healthId = runtimeHealthId(descriptor);
      if (this.active.some((active) => active.healthId === healthId)) {
        throw new NativeChannelDriverContractError("runtime_descriptor_invalid");
      }
      await runtime.start();
      this.statuses.delete(pendingId);
      this.active.push({ runtime, descriptor, healthId, lease });
    } catch (error) {
      if (runtime) {
        try {
          await runtime.stop();
        } catch {
          // Startup remains the primary stable failure reason.
        }
      }
      lease?.dispose();
      this.statuses.set(pendingId, {
        id: pendingId,
        channelId: provider,
        status: "failed",
        reason: driverFailureReason(error, "startup_failed"),
      });
    }
  }
}

function assertHostCapabilities(descriptor: NativeChannelDriverDescriptor, host: NativeChannelDriverHost): void {
  for (const capability of descriptor.requiredHostCapabilities ?? []) {
    if (capability === "installation_credentials" && typeof host.readInstallationCredential !== "function") {
      throw new NativeChannelDriverContractError("host_capability_missing");
    }
  }
}

function extractDriver(moduleValue: unknown): NativeChannelDriver {
  if (!isRecord(moduleValue) || !("nativeChannelDriver" in moduleValue)) {
    throw new NativeChannelDriverContractError("invalid_module_export");
  }
  const driver = moduleValue.nativeChannelDriver;
  if (!isRecord(driver) || typeof driver.createRuntime !== "function") {
    throw new NativeChannelDriverContractError("invalid_module_export");
  }
  return driver as unknown as NativeChannelDriver;
}

function parseDriverDescriptor(value: unknown): NativeChannelDriverDescriptor {
  const parsed = NativeChannelDriverDescriptorSchema.safeParse(value);
  if (!parsed.success) {
    const record = isRecord(value) ? value : undefined;
    if (
      record?.protocol !== NATIVE_CHANNEL_DRIVER_PROTOCOL ||
      record?.schemaVersion !== NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION
    ) {
      throw new NativeChannelDriverContractError("incompatible_abi");
    }
    throw new NativeChannelDriverContractError("invalid_module_export");
  }
  return parsed.data;
}

function validateRuntime(
  driver: NativeChannelDriverDescriptor,
  channel: ChannelConfig,
  runtime: NativeChannelDriverRuntime,
): NativeChannelRuntimeDescriptor {
  if (!isRecord(runtime)) {
    throw new NativeChannelDriverContractError("runtime_descriptor_invalid");
  }
  const parsed = NativeChannelRuntimeDescriptorSchema.safeParse(runtime.descriptor);
  if (!parsed.success) {
    throw new NativeChannelDriverContractError("runtime_descriptor_invalid");
  }
  const descriptor = parsed.data;
  if (
    descriptor.driverId !== driver.driverId ||
    descriptor.provider !== driver.provider ||
    descriptor.channelInstanceId !== channel.name
  ) {
    throw new NativeChannelDriverContractError("runtime_descriptor_invalid");
  }
  if (descriptor.capabilities.some((capability) => !driver.capabilities.includes(capability))) {
    throw new NativeChannelDriverContractError("runtime_capability_mismatch");
  }
  if (
    typeof runtime.start !== "function" ||
    typeof runtime.stop !== "function" ||
    typeof runtime.health !== "function"
  ) {
    throw new NativeChannelDriverContractError("runtime_surface_mismatch");
  }
  validateOptionalSurface(descriptor, "text_delivery", runtime.delivery, "deliverText");
  validateOptionalSurface(descriptor, "chat_actions", runtime.actions, "executeChatAction");
  validateOptionalSurface(descriptor, "presence", runtime.presence, "sendPresence");
  return descriptor;
}

function validateOptionalSurface(
  descriptor: NativeChannelRuntimeDescriptor,
  capability: Exclude<NativeChannelDriverCapability, "inbound">,
  surface: unknown,
  method: string,
): void {
  const declared = descriptor.capabilities.includes(capability);
  const valid =
    isRecord(surface) &&
    surface.channelId === descriptor.provider &&
    typeof surface.supports === "function" &&
    typeof surface[method] === "function";
  if (declared !== valid) {
    throw new NativeChannelDriverContractError("runtime_surface_mismatch");
  }
}

function pendingHealthId(channel: ChannelConfig, index: number): string {
  const provider = ChannelBackendWireKindSchema.safeParse(channel.provider);
  const name = ChannelBackendOpaqueIdSchema.safeParse(channel.name);
  if (provider.success && name.success) return `${provider.data}:${name.data}`;
  return `native:invalid-${index + 1}`;
}

function runtimeHealthId(descriptor: NativeChannelRuntimeDescriptor): string {
  return `${descriptor.provider}:${descriptor.channelInstanceId}:${descriptor.runtimeId}`;
}

function driverFailureReason(
  error: unknown,
  fallback: NativeChannelDriverFailureReason,
): NativeChannelDriverFailureReason {
  return error instanceof NativeChannelDriverContractError ? error.reason : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
