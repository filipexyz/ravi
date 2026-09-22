import { describe, expect, it } from "bun:test";
import type { ChannelConfig } from "../router/router-db.js";
import type { InstanceConfig } from "../router/router-db.js";
import {
  findNativeChannelAccount,
  nativeAccountAliases,
  nativeChannelCredentialConfigured,
  resolveOutboundAccount,
  type OutboundAccountConfig,
} from "./account-resolution.js";

const OMNI_UUID = "11111111-1111-1111-1111-111111111111";

function slackChannel(overrides: Partial<ChannelConfig> = {}): ChannelConfig {
  return {
    name: "hana-slack",
    provider: "slack",
    enabled: true,
    credentialConnection: "hana-slack-secret",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function omniInstance(overrides: Partial<InstanceConfig> = {}): InstanceConfig {
  return {
    name: "main",
    instanceId: OMNI_UUID,
    channel: "whatsapp",
    dmPolicy: "open",
    groupPolicy: "open",
    contactIntakeMode: "off",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function config(overrides: Partial<OutboundAccountConfig> = {}): OutboundAccountConfig {
  return {
    channels: {},
    instances: {},
    instanceToAccount: {},
    ...overrides,
  };
}

describe("resolveOutboundAccount", () => {
  it("resolves a native Slack account without an Omni instance UUID", () => {
    const resolved = resolveOutboundAccount("hana-slack", {
      channel: "slack",
      config: config({ channels: { "hana-slack": slackChannel() } }),
    });

    expect(resolved).toMatchObject({
      kind: "native",
      accountId: "hana-slack",
      instanceId: "hana-slack",
      provider: "slack",
      credentialConfigured: true,
    });
  });

  it("matches native Slack accounts by credential connection id", () => {
    const resolved = resolveOutboundAccount("hana-slack-secret", {
      channel: "slack",
      config: config({ channels: { workspace: slackChannel() } }),
    });

    expect(resolved).toMatchObject({
      kind: "native",
      instanceId: "hana-slack",
      channelName: "hana-slack",
    });
  });

  it("keeps Omni name and UUID resolution for WhatsApp", () => {
    const cfg = config({
      instances: { main: omniInstance() },
      instanceToAccount: { [OMNI_UUID]: "main" },
    });

    expect(resolveOutboundAccount("main", { channel: "whatsapp", config: cfg })).toEqual({
      kind: "omni",
      accountId: "main",
      instanceId: OMNI_UUID,
    });
    expect(resolveOutboundAccount(OMNI_UUID, { channel: "whatsapp", config: cfg })).toEqual({
      kind: "omni",
      accountId: OMNI_UUID,
      instanceId: OMNI_UUID,
    });
  });

  it("does not let a same-named Slack channel steal a WhatsApp Omni account", () => {
    const resolved = resolveOutboundAccount("main", {
      channel: "whatsapp",
      config: config({
        channels: { main: slackChannel({ name: "main" }) },
        instances: { main: omniInstance() },
        instanceToAccount: { [OMNI_UUID]: "main" },
      }),
    });

    expect(resolved).toEqual({
      kind: "omni",
      accountId: "main",
      instanceId: OMNI_UUID,
    });
  });

  it("prefers native Slack over a leftover Omni mapping when the channel is Slack", () => {
    const resolved = resolveOutboundAccount("hana-slack", {
      channel: "slack",
      config: config({
        channels: { "hana-slack": slackChannel() },
        instances: { "hana-slack": omniInstance({ name: "hana-slack", channel: "slack" }) },
        instanceToAccount: { [OMNI_UUID]: "hana-slack" },
      }),
    });

    expect(resolved.kind).toBe("native");
  });

  it("preserves Omni when no channel hint is given and an Omni mapping exists", () => {
    const resolved = resolveOutboundAccount("main", {
      config: config({
        channels: { main: slackChannel({ name: "main" }) },
        instances: { main: omniInstance() },
        instanceToAccount: { [OMNI_UUID]: "main" },
      }),
    });

    expect(resolved).toEqual({
      kind: "omni",
      accountId: "main",
      instanceId: OMNI_UUID,
    });
  });

  it("falls back to native Slack when there is no Omni mapping and no channel hint", () => {
    const resolved = resolveOutboundAccount("hana-slack", {
      config: config({ channels: { "hana-slack": slackChannel() } }),
    });

    expect(resolved.kind).toBe("native");
  });

  it("rejects disabled Omni instances and disabled native channels", () => {
    expect(
      resolveOutboundAccount("main", {
        channel: "whatsapp",
        config: config({
          instances: { main: omniInstance({ enabled: false }) },
          instanceToAccount: { [OMNI_UUID]: "main" },
        }),
      }),
    ).toEqual({ kind: "unresolved", accountId: "main", reason: "disabled" });

    expect(
      resolveOutboundAccount("hana-slack", {
        channel: "slack",
        config: config({ channels: { "hana-slack": slackChannel({ enabled: false }) } }),
      }),
    ).toEqual({ kind: "unresolved", accountId: "hana-slack", reason: "not_found" });
  });

  it("returns not_found for an unknown account", () => {
    expect(resolveOutboundAccount("ghost", { channel: "slack", config: config() })).toEqual({
      kind: "unresolved",
      accountId: "ghost",
      reason: "not_found",
    });
    expect(resolveOutboundAccount("", { config: config() })).toEqual({
      kind: "unresolved",
      accountId: "",
      reason: "empty",
    });
  });

  it("reports missing native credentials without inventing an Omni instance", () => {
    const resolved = resolveOutboundAccount("hana-slack", {
      channel: "slack",
      config: config({ channels: { "hana-slack": slackChannel({ credentialConnection: undefined }) } }),
    });

    expect(resolved).toMatchObject({
      kind: "native",
      credentialConfigured: false,
    });
  });
});

describe("native channel helpers", () => {
  it("derives slug and UUID aliases from Omni instance maps", () => {
    expect(
      nativeAccountAliases(
        config({
          instances: { "hana-slack": omniInstance({ name: "hana-slack", instanceId: OMNI_UUID }) },
          instanceToAccount: { [OMNI_UUID]: "hana-slack" },
        }),
        OMNI_UUID,
      ),
    ).toEqual(expect.arrayContaining(["hana-slack", OMNI_UUID.toLowerCase()]));
  });

  it("does not treat an arbitrary string as a native account", () => {
    expect(findNativeChannelAccount({ "hana-slack": slackChannel() }, "C123")).toBeUndefined();
    expect(
      nativeChannelCredentialConfigured(config({ channels: { "hana-slack": slackChannel() } }), "missing", "slack"),
    ).toBe(false);
    expect(
      nativeChannelCredentialConfigured(config({ channels: { "hana-slack": slackChannel() } }), "hana-slack", "slack"),
    ).toBe(true);
  });
});
