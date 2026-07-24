import {
  NATIVE_CHANNEL_DRIVER_PROTOCOL,
  NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION,
  type NativeChannelDriver,
} from "../driver.js";

export const nativeChannelDriver: NativeChannelDriver = {
  descriptor: {
    protocol: NATIVE_CHANNEL_DRIVER_PROTOCOL,
    schemaVersion: NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION,
    driverId: "example.native",
    provider: "example",
    capabilities: ["inbound"],
  },
  createRuntime(context) {
    return {
      descriptor: {
        protocol: NATIVE_CHANNEL_DRIVER_PROTOCOL,
        schemaVersion: NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION,
        driverId: "example.native",
        provider: "example",
        runtimeId: context.channel.name,
        channelInstanceId: context.channel.name,
        capabilities: ["inbound"],
      },
      start() {},
      stop() {},
      health: () => ({ status: "connected" }),
    };
  },
};
