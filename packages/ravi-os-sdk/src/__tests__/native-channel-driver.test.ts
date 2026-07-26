import { describe, expect, it } from "bun:test";
import {
  NATIVE_CHANNEL_DRIVER_PROTOCOL,
  NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION,
  MAX_NATIVE_INBOUND_ACTION_IDENTITY_BYTES,
  MAX_NATIVE_INBOUND_ACTION_RESPONSE_BYTES,
  NATIVE_CHANNEL_DEFAULT_LOCAL_AGENT_TEMPLATE_ID,
  NativeChannelDriverDescriptorSchema,
  NativeChannelDriverHostCapabilitiesSchema,
  NativeChannelDriverModuleConfigSchema,
  NativeChannelDriverModuleSpecifierSchema,
  NativeInboundChannelActionRequestSchema,
  NativeInboundChannelActionResultSchema,
  NativeChannelRuntimeDescriptorSchema,
  NativeChannelRuntimeHealthSchema,
  type NativeChannelDriver,
} from "../native-channel-driver.js";

const fixtureDirectory = new URL("./fixtures/native-channel-driver/", import.meta.url);

async function fixture<T>(name: string): Promise<T> {
  return Bun.file(new URL(name, fixtureDirectory)).json() as Promise<T>;
}

describe("native channel driver SDK contract", () => {
  it("parses every generated descriptor fixture", async () => {
    const moduleConfig = await fixture("module-config.json");
    const driverDescriptor = await fixture("driver-descriptor.json");
    const runtimeDescriptor = await fixture("runtime-descriptor.json");
    const installationCredential = await fixture("installation-credential.json");
    const inboundActionRequest = await fixture("inbound-action-request.json");
    const inboundActionResult = await fixture("inbound-action-result.json");

    expect(NativeChannelDriverModuleConfigSchema.parse(moduleConfig)).toEqual(moduleConfig);
    expect(NativeChannelDriverDescriptorSchema.parse(driverDescriptor)).toEqual(driverDescriptor);
    expect(NativeChannelRuntimeDescriptorSchema.parse(runtimeDescriptor)).toEqual(runtimeDescriptor);
    expect(NativeInboundChannelActionRequestSchema.parse(inboundActionRequest)).toEqual(
      inboundActionRequest,
    );
    expect(NativeInboundChannelActionResultSchema.parse(inboundActionResult)).toEqual(
      inboundActionResult,
    );
    expect(installationCredential).toMatchObject({ provider: "example" });
    expect(
      NativeChannelDriverHostCapabilitiesSchema.parse([
        "installation_credentials",
        "local_agent_reconciliation",
      ]),
    ).toEqual([
      "installation_credentials",
      "local_agent_reconciliation",
    ]);
    expect(NATIVE_CHANNEL_DEFAULT_LOCAL_AGENT_TEMPLATE_ID).toBe(
      "native-channel-default",
    );
  });

  it("requires an explicit action declaration and exactly one handled response", async () => {
    const descriptor = await fixture<Record<string, unknown>>("driver-descriptor.json");
    const request = await fixture<Record<string, unknown>>("inbound-action-request.json");
    const handled = await fixture<Record<string, unknown>>("inbound-action-result.json");

    expect(
      NativeChannelDriverDescriptorSchema.safeParse({
        ...descriptor,
        inboundActions: undefined,
      }).success,
    ).toBe(false);
    expect(
      NativeInboundChannelActionResultSchema.safeParse({
        ...handled,
        text: undefined,
      }).success,
    ).toBe(false);
    expect(
      NativeInboundChannelActionResultSchema.safeParse({
        ...handled,
        error: {
          code: "UNAVAILABLE",
          category: "availability",
          retryable: true,
        },
      }).success,
    ).toBe(false);
    expect(
      NativeChannelDriverDescriptorSchema.safeParse({
        ...descriptor,
        capabilities: ["inbound", "inbound"],
      }).success,
    ).toBe(false);
    expect(
      NativeInboundChannelActionRequestSchema.safeParse({
        ...request,
        identity: {
          ...(request.identity as Record<string, unknown>),
          senderId: "é".repeat(MAX_NATIVE_INBOUND_ACTION_IDENTITY_BYTES / 2 + 1),
        },
      }).success,
    ).toBe(false);
    expect(
      NativeInboundChannelActionResultSchema.safeParse({
        ...handled,
        text: "é".repeat(MAX_NATIVE_INBOUND_ACTION_RESPONSE_BYTES / 2 + 1),
      }).success,
    ).toBe(false);
  });

  it("accepts only installed package names and absolute local file URLs", () => {
    expect(NativeChannelDriverModuleSpecifierSchema.parse("@example/native-channel-driver")).toBe(
      "@example/native-channel-driver",
    );
    expect(NativeChannelDriverModuleSpecifierSchema.parse("example-driver")).toBe("example-driver");
    expect(NativeChannelDriverModuleSpecifierSchema.parse("file:///opt/ravi/example-driver.js")).toBe(
      "file:///opt/ravi/example-driver.js",
    );
    expect(NativeChannelDriverModuleSpecifierSchema.safeParse("https://example.test/driver.js").success).toBe(
      false,
    );
    expect(NativeChannelDriverModuleSpecifierSchema.safeParse("./driver.js").success).toBe(false);
  });

  it("rejects incompatible versions and strips content-bearing health fields", async () => {
    const descriptor = await fixture<Record<string, unknown>>("driver-descriptor.json");
    expect(
      NativeChannelDriverDescriptorSchema.safeParse({
        ...descriptor,
        schemaVersion: NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION + 1,
      }).success,
    ).toBe(false);
    expect(
      NativeChannelRuntimeHealthSchema.parse({
        status: "connected",
        payload: "not projected",
      }),
    ).toEqual({ status: "connected" });
  });

  it("exposes a type-complete provider-neutral driver surface", () => {
    const driver: NativeChannelDriver = {
      descriptor: {
        protocol: NATIVE_CHANNEL_DRIVER_PROTOCOL,
        schemaVersion: NATIVE_CHANNEL_DRIVER_SCHEMA_VERSION,
        driverId: "example.native",
        provider: "example",
        capabilities: ["inbound"],
        requiredHostCapabilities: [
          "installation_credentials",
          "local_agent_reconciliation",
        ],
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
    expect(driver.descriptor.provider).toBe("example");
  });
});
