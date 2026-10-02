import { describe, expect, it } from "bun:test";
import type { ChannelConfig } from "../router/router-db.js";
import type { InstanceConfig } from "../router/router-db.js";
import {
  findNativeChannelAccount,
  nativeAccountAliases,
  nativeChannelCredentialConfigured,
  resolveOutboundAccount,
  unresolvedAccountError,
  type OutboundAccountConfig,
} from "./account-resolution.js";

const WA_UUID = "11111111-1111-1111-1111-111111111111";
const TG_UUID = "22222222-2222-2222-2222-222222222222";
const UNMAPPED_UUID = "33333333-3333-4333-8333-333333333333";

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

function whatsappChannel(overrides: Partial<ChannelConfig> = {}): ChannelConfig {
  return {
    name: "main",
    provider: "whatsapp",
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function whatsappInstance(overrides: Partial<InstanceConfig> = {}): InstanceConfig {
  return {
    name: "main",
    instanceId: WA_UUID,
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
  it("resolves a native Slack account without an instance UUID", () => {
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

  it("resolves a bound WhatsApp account by name, UUID and with a whatsapp/whatsapp-baileys hint", () => {
    const cfg = config({
      channels: { main: whatsappChannel() },
      instances: { main: whatsappInstance() },
      instanceToAccount: { [WA_UUID]: "main" },
    });
    const expected = { kind: "whatsapp" as const, instanceId: WA_UUID, channelName: "main", bound: true };

    expect(resolveOutboundAccount("main", { config: cfg })).toEqual({ ...expected, accountId: "main" });
    expect(resolveOutboundAccount(WA_UUID, { config: cfg })).toEqual({ ...expected, accountId: WA_UUID });
    expect(resolveOutboundAccount("main", { channel: "whatsapp", config: cfg })).toEqual({
      ...expected,
      accountId: "main",
    });
    expect(resolveOutboundAccount(WA_UUID, { channel: "whatsapp-baileys", config: cfg })).toEqual({
      ...expected,
      accountId: WA_UUID,
    });
  });

  it("resolves a WhatsApp account whose channel name differs from the instance name (defaults.instance)", () => {
    const resolved = resolveOutboundAccount("Loja São Paulo", {
      channel: "whatsapp-baileys",
      config: config({
        channels: {
          "Loja-Sao-Paulo": whatsappChannel({ name: "Loja-Sao-Paulo", defaults: { instance: "Loja São Paulo" } }),
        },
        instances: { "Loja São Paulo": whatsappInstance({ name: "Loja São Paulo" }) },
        instanceToAccount: { [WA_UUID]: "Loja São Paulo" },
      }),
    });

    expect(resolved).toEqual({
      kind: "whatsapp",
      accountId: "Loja São Paulo",
      instanceId: WA_UUID,
      channelName: "Loja-Sao-Paulo",
      bound: true,
    });
  });

  it("resolves an unbound WhatsApp instance as whatsapp with bound:false (never the bridge)", () => {
    const unbound = config({
      instances: { main: whatsappInstance() },
      instanceToAccount: { [WA_UUID]: "main" },
    });
    expect(resolveOutboundAccount("main", { channel: "whatsapp", config: unbound })).toEqual({
      kind: "whatsapp",
      accountId: "main",
      instanceId: WA_UUID,
      channelName: null,
      bound: false,
    });

    // A disabled WhatsApp channel does not bind, but is still reported.
    const disabledChannel = config({
      channels: { main: whatsappChannel({ enabled: false }) },
      instances: { main: whatsappInstance() },
      instanceToAccount: { [WA_UUID]: "main" },
    });
    expect(resolveOutboundAccount(WA_UUID, { config: disabledChannel })).toEqual({
      kind: "whatsapp",
      accountId: WA_UUID,
      instanceId: WA_UUID,
      channelName: "main",
      bound: false,
    });
  });

  it("returns not_bound for a WhatsApp instance without a UUID", () => {
    const resolved = resolveOutboundAccount("main", {
      channel: "whatsapp",
      config: config({ instances: { main: whatsappInstance({ instanceId: undefined }) } }),
    });

    expect(resolved).toEqual({ kind: "unresolved", accountId: "main", reason: "not_bound" });
    expect(unresolvedAccountError(resolved as Extract<typeof resolved, { kind: "unresolved" }>)).toBe(
      "WhatsApp instance main is not connected: ravi instances connect main",
    );
  });

  it("returns disabled for a disabled WhatsApp instance, by name and by UUID", () => {
    const cfg = config({
      channels: { main: whatsappChannel() },
      instances: { main: whatsappInstance({ enabled: false }) },
      instanceToAccount: { [WA_UUID]: "main" },
    });

    expect(resolveOutboundAccount("main", { channel: "whatsapp", config: cfg })).toEqual({
      kind: "unresolved",
      accountId: "main",
      reason: "disabled",
    });
    expect(resolveOutboundAccount(WA_UUID, { config: cfg })).toEqual({
      kind: "unresolved",
      accountId: WA_UUID,
      reason: "disabled",
    });
  });

  it("resolves a Telegram instance to the legacy bridge by UUID and by name", () => {
    const cfg = config({
      instances: { tg: whatsappInstance({ name: "tg", instanceId: TG_UUID, channel: "telegram" }) },
      instanceToAccount: { [TG_UUID]: "tg" },
    });

    expect(resolveOutboundAccount(TG_UUID, { channel: "telegram", config: cfg })).toEqual({
      kind: "bridge",
      accountId: TG_UUID,
      instanceId: TG_UUID,
    });
    expect(resolveOutboundAccount("tg", { config: cfg })).toEqual({
      kind: "bridge",
      accountId: "tg",
      instanceId: TG_UUID,
    });
  });

  it("returns not_found for an unmapped UUID instead of passing it through", () => {
    for (const channel of [undefined, "whatsapp", "whatsapp-baileys", "telegram"]) {
      expect(resolveOutboundAccount(UNMAPPED_UUID, { channel, config: config() })).toEqual({
        kind: "unresolved",
        accountId: UNMAPPED_UUID,
        reason: "not_found",
      });
    }
  });

  it("returns unsupported for a twilio-whatsapp or gupshup instance, and for such a hint", () => {
    const cfg = config({
      instances: {
        twilio: whatsappInstance({ name: "twilio", instanceId: TG_UUID, channel: "twilio-whatsapp" }),
        gup: whatsappInstance({ name: "gup", instanceId: UNMAPPED_UUID, channel: "gupshup" }),
      },
      instanceToAccount: { [TG_UUID]: "twilio", [UNMAPPED_UUID]: "gup" },
    });

    expect(resolveOutboundAccount("twilio", { config: cfg })).toEqual({
      kind: "unresolved",
      accountId: "twilio",
      reason: "unsupported",
    });
    expect(resolveOutboundAccount(TG_UUID, { channel: "whatsapp", config: cfg })).toMatchObject({
      reason: "unsupported",
    });
    expect(resolveOutboundAccount("gup", { channel: "telegram", config: cfg })).toMatchObject({
      reason: "unsupported",
    });
    expect(resolveOutboundAccount("someone", { channel: "twilio-whatsapp", config: config() })).toEqual({
      kind: "unresolved",
      accountId: "someone",
      reason: "unsupported",
    });
  });

  it("ignores deleted instance records", () => {
    const resolved = resolveOutboundAccount("main", {
      config: config({
        instances: { main: whatsappInstance({ deletedAt: 5 }) },
        instanceToAccount: { [WA_UUID]: "main" },
      }),
    });

    expect(resolved).toEqual({ kind: "unresolved", accountId: "main", reason: "not_found" });
  });

  it("does not let a same-named Slack channel steal a WhatsApp account", () => {
    const resolved = resolveOutboundAccount("main", {
      channel: "whatsapp",
      config: config({
        channels: { main: slackChannel({ name: "main" }) },
        instances: { main: whatsappInstance() },
        instanceToAccount: { [WA_UUID]: "main" },
      }),
    });

    expect(resolved).toEqual({
      kind: "whatsapp",
      accountId: "main",
      instanceId: WA_UUID,
      channelName: null,
      bound: false,
    });
  });

  it("keeps a Slack-hinted send on the native Slack channel when a same-named WhatsApp instance exists", () => {
    const cfg = config({
      channels: { main: slackChannel({ name: "main", credentialConnection: "main-secret" }) },
      instances: { main: whatsappInstance() },
      instanceToAccount: { [WA_UUID]: "main" },
    });

    expect(resolveOutboundAccount("main", { channel: "slack", config: cfg })).toMatchObject({
      kind: "native",
      accountId: "main",
      instanceId: "main",
      provider: "slack",
      channelName: "main",
    });
    // Without a Slack hint the WhatsApp instance still wins.
    expect(resolveOutboundAccount("main", { channel: "whatsapp", config: cfg })).toMatchObject({ kind: "whatsapp" });
    expect(resolveOutboundAccount("main", { config: cfg })).toMatchObject({ kind: "whatsapp" });
    // A Slack hint with no matching native channel still falls through to the WhatsApp record.
    const noSlack = config({ instances: { main: whatsappInstance() }, instanceToAccount: { [WA_UUID]: "main" } });
    expect(resolveOutboundAccount("main", { channel: "slack", config: noSlack })).toMatchObject({ kind: "whatsapp" });
  });

  it("prefers native Slack over a leftover bridge mapping when the channel is Slack", () => {
    const resolved = resolveOutboundAccount("hana-slack", {
      channel: "slack",
      config: config({
        channels: { "hana-slack": slackChannel() },
        instances: { "hana-slack": whatsappInstance({ name: "hana-slack", channel: "slack" }) },
        instanceToAccount: { [WA_UUID]: "hana-slack" },
      }),
    });

    expect(resolved.kind).toBe("native");
  });

  it("prefers the instance record over a same-named Slack channel when no channel hint is given", () => {
    const cfg = config({
      channels: { main: slackChannel({ name: "main" }) },
      instances: { main: whatsappInstance() },
      instanceToAccount: { [WA_UUID]: "main" },
    });
    expect(resolveOutboundAccount("main", { config: cfg })).toMatchObject({ kind: "whatsapp", instanceId: WA_UUID });

    const bridged = config({
      channels: { main: slackChannel({ name: "main" }) },
      instances: { main: whatsappInstance({ channel: "discord" }) },
      instanceToAccount: { [WA_UUID]: "main" },
    });
    expect(resolveOutboundAccount("main", { config: bridged })).toEqual({
      kind: "bridge",
      accountId: "main",
      instanceId: WA_UUID,
    });
  });

  it("falls back to native Slack when there is no instance record and no channel hint", () => {
    const resolved = resolveOutboundAccount("hana-slack", {
      config: config({ channels: { "hana-slack": slackChannel() } }),
    });

    expect(resolved.kind).toBe("native");
  });

  it("rejects disabled bridge instances and disabled native channels", () => {
    expect(
      resolveOutboundAccount("tg", {
        channel: "telegram",
        config: config({
          instances: { tg: whatsappInstance({ name: "tg", instanceId: TG_UUID, channel: "telegram", enabled: false }) },
          instanceToAccount: { [TG_UUID]: "tg" },
        }),
      }),
    ).toEqual({ kind: "unresolved", accountId: "tg", reason: "disabled" });

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

  it("reports missing native credentials without inventing an instance", () => {
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
  it("derives slug and UUID aliases from instance maps", () => {
    expect(
      nativeAccountAliases(
        config({
          instances: { "hana-slack": whatsappInstance({ name: "hana-slack", instanceId: WA_UUID }) },
          instanceToAccount: { [WA_UUID]: "hana-slack" },
        }),
        WA_UUID,
      ),
    ).toEqual(expect.arrayContaining(["hana-slack", WA_UUID.toLowerCase()]));
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
