import type { ChannelConfig } from "../../router/router-db.js";
import {
  NATIVE_CHANNEL_DRIVER_PROTOCOL,
  NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION,
  NativeChannelDriverContractError,
  NativeChannelDriverDescriptorSchema,
  NativeChannelRuntimeDescriptorSchema,
  type NativeChannelDriver,
  type NativeChannelRuntimeHealth,
} from "../native/driver.js";
import { createSlackNativeRuntimeFromEnv, type SlackNativeRuntime, type SlackSocketModeStatus } from "./socket-mode.js";

export interface SlackNativeChannelDriverOptions {
  readonly createRuntime?: (
    env: NodeJS.ProcessEnv,
    options: { channel: ChannelConfig },
  ) => Promise<SlackNativeRuntime | null>;
}

export function createSlackNativeChannelDriver(
  env: NodeJS.ProcessEnv = process.env,
  options: SlackNativeChannelDriverOptions = {},
): NativeChannelDriver {
  const descriptor = NativeChannelDriverDescriptorSchema.parse({
    protocol: NATIVE_CHANNEL_DRIVER_PROTOCOL,
    schemaVersion: NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION,
    driverId: "ravi.slack",
    provider: "slack",
    capabilities: ["inbound", "text_delivery", "chat_actions", "presence"],
  });

  return {
    descriptor,
    async createRuntime(context) {
      const channel: ChannelConfig = {
        name: context.channel.name,
        provider: context.channel.provider,
        ...(context.channel.credentialConnection ? { credentialConnection: context.channel.credentialConnection } : {}),
        ...(context.channel.defaults ? { defaults: { ...context.channel.defaults } } : {}),
        createdAt: 0,
        updatedAt: 0,
      };
      const native = await (options.createRuntime ?? createSlackNativeRuntimeFromEnv)(env, { channel });
      if (!native) {
        throw new NativeChannelDriverContractError("missing_credentials");
      }
      const runtimeDescriptor = NativeChannelRuntimeDescriptorSchema.parse({
        protocol: NATIVE_CHANNEL_DRIVER_PROTOCOL,
        schemaVersion: NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION,
        driverId: descriptor.driverId,
        provider: descriptor.provider,
        runtimeId: channel.name,
        channelInstanceId: channel.name,
        capabilities: [...descriptor.capabilities],
      });
      return {
        descriptor: runtimeDescriptor,
        delivery: native.delivery,
        actions: native.actions,
        presence: native.presence,
        start: () => native.socketMode.start(),
        stop: () => native.socketMode.stop(),
        health: () => slackNativeRuntimeHealth(native.socketMode.status()),
      };
    },
  };
}

export function slackNativeRuntimeHealth(status: SlackSocketModeStatus): NativeChannelRuntimeHealth {
  return {
    status:
      status.state === "stopped"
        ? "disconnected"
        : status.state === "connecting"
          ? "starting"
          : status.state === "reconnecting"
            ? "reconnecting"
            : "connected",
    ...(status.reason ? { reason: status.reason } : {}),
    ...(status.connectedAt !== undefined ? { connectedAt: status.connectedAt } : {}),
    ...(status.lastPongAt !== undefined ? { lastPongAt: status.lastPongAt } : {}),
    reconnectCount: status.reconnectCount,
  };
}
