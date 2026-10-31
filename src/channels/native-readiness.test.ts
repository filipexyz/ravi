import { describe, expect, it } from "bun:test";
import type { CredentialConnectionRecord } from "../credentials/types.js";
import type { ChannelConfig } from "../router/router-db.js";
import type { OutboundAccountConfig } from "./account-resolution.js";
import {
  inspectNativeChannelRuntime,
  nativeChannelCredentialIssue,
  nativeOutboundReadiness,
  resetNativeOutboundWarningsForTests,
  warnIfNativeOutboundUndeliverable,
} from "./native-readiness.js";

function slackChannel(overrides: Partial<ChannelConfig> = {}): ChannelConfig {
  return {
    name: "slack-a",
    provider: "slack",
    enabled: true,
    credentialConnection: "slack-a",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function record(overrides: Partial<CredentialConnectionRecord> = {}): CredentialConnectionRecord {
  return {
    id: "cred-1",
    provider: "slack",
    connection: "slack-a",
    label: null,
    backend: "vault",
    secretRef: "vault:secret/ravi/credentials/slack/slack-a#token",
    scopes: [],
    status: "active",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function config(channels: Record<string, ChannelConfig>): OutboundAccountConfig {
  return { channels, instances: {}, instanceToAccount: {} } as OutboundAccountConfig;
}

describe("native channel credential readiness", () => {
  it("names the missing, unknown or disabled broker connection", () => {
    expect(nativeChannelCredentialIssue(slackChannel({ credentialConnection: undefined }), () => null)).toBe(
      "credential_connection_missing",
    );
    expect(nativeChannelCredentialIssue(slackChannel(), () => null)).toBe("connection_not_found");
    expect(nativeChannelCredentialIssue(slackChannel(), () => record({ status: "disabled" }))).toBe(
      "connection_disabled",
    );
    expect(nativeChannelCredentialIssue(slackChannel(), () => record())).toBeNull();
  });

  it("treats a lookup the broker rejects as a missing connection", () => {
    expect(
      nativeChannelCredentialIssue(slackChannel(), () => {
        throw new Error("invalid connection");
      }),
    ).toBe("connection_not_found");
  });

  it("exempts the hub gateway transport, which has no broker connection", () => {
    const gateway = slackChannel({ credentialConnection: undefined, defaults: { transport: "hub_gateway_v1" } });
    expect(nativeChannelCredentialIssue(gateway, () => null)).toBeNull();
  });
});

describe("native outbound readiness", () => {
  it("reports no native channel when the target account resolves to none", () => {
    const readiness = nativeOutboundReadiness(
      { channel: "slack", accountId: "slack-a" },
      { config: config({}), lookup: () => null },
    );
    expect(readiness).toEqual({ ok: false, reason: "no_native_channel" });
  });

  it("reports the channel and connection when the broker has no connection", () => {
    const readiness = nativeOutboundReadiness(
      { channel: "slack", accountId: "slack-a" },
      { config: config({ "slack-a": slackChannel() }), lookup: () => null },
    );
    expect(readiness).toEqual({
      ok: false,
      reason: "connection_not_found",
      channelName: "slack-a",
      credentialConnection: "slack-a",
    });
  });

  it("is ready when the connection is active", () => {
    const readiness = nativeOutboundReadiness(
      { channel: "slack", accountId: "slack-a" },
      { config: config({ "slack-a": slackChannel() }), lookup: () => record() },
    );
    expect(readiness).toEqual({ ok: true, channelName: "slack-a" });
  });

  it("checks a busy target at most once a minute", () => {
    resetNativeOutboundWarningsForTests();
    let lookups = 0;
    const options = {
      config: config({ "slack-a": slackChannel() }),
      lookup: () => {
        lookups++;
        return null;
      },
    };
    const target = { channel: "slack", accountId: "slack-a" };
    expect(warnIfNativeOutboundUndeliverable(target, { ...options, now: 1_000 })).toMatchObject({
      ok: false,
      reason: "connection_not_found",
    });
    expect(warnIfNativeOutboundUndeliverable(target, { ...options, now: 30_000 })).toBeNull();
    expect(warnIfNativeOutboundUndeliverable(target, { ...options, now: 61_001 })).toMatchObject({ ok: false });
    expect(lookups).toBe(2);
    resetNativeOutboundWarningsForTests();
  });
});

describe("native channel runtime inspection", () => {
  it("lists enabled channels with their issue and missing backend prerequisites", () => {
    const snapshot = inspectNativeChannelRuntime({
      listChannels: () => [
        slackChannel({ name: "slack-b", credentialConnection: "slack-b" }),
        slackChannel(),
        slackChannel({ name: "slack-off", enabled: false }),
        slackChannel({ name: "slack-hub", credentialConnection: undefined, defaults: { transport: "hub_gateway_v1" } }),
        slackChannel({ name: "slack-keychain", credentialConnection: "slack-keychain" }),
      ],
      lookup: (_provider, connection) => {
        if (connection === "slack-a") return record();
        if (connection === "slack-keychain") return record({ connection, backend: "keychain" });
        return null;
      },
      commandOnPath: () => false,
      env: { VAULT_ADDR: "https://vault.example.test" },
      runnerStatus: () => "missing",
    });

    expect(snapshot.runnerStatus).toBe("missing");
    expect(snapshot.channels.map((channel) => channel.name)).toEqual([
      "slack-a",
      "slack-b",
      "slack-hub",
      "slack-keychain",
    ]);
    expect(snapshot.channels[0]).toMatchObject({
      issue: null,
      backend: "vault",
      missingPrerequisites: ["VAULT_TOKEN"],
    });
    expect(snapshot.channels[1]).toMatchObject({ issue: "connection_not_found", missingPrerequisites: [] });
    expect(snapshot.channels[2]).toMatchObject({ transport: "hub_gateway_v1", issue: null });
    expect(snapshot.channels[3]).toMatchObject({
      issue: null,
      backend: "keychain",
      missingPrerequisites: ["security"],
    });
    expect(JSON.stringify(snapshot)).not.toContain("vault.example.test");
  });
});
