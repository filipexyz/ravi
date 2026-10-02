import { describe, expect, it } from "bun:test";
import type { ChannelConfig, InstanceConfig } from "../../router/router-db.js";
import type { RouterConfig } from "../../router/types.js";
import {
  DEFAULT_WHATSAPP_RPC_TIMEOUT_MS,
  WHATSAPP_RPC_ERROR_CODES,
  WhatsAppRpcRequestSchema,
  whatsappRpcSubject,
  type WhatsAppRpcMethod,
  type WhatsAppRpcRequest,
} from "./contract.js";
import { WHATSAPP_CLIENT_TIMEOUTS_MS, createWhatsAppClient, defaultWhatsAppClientTimeoutMs } from "./client.js";
import { WhatsAppRpcError } from "./errors.js";
import type { requestWhatsAppRpc, WhatsAppRpcConnection } from "./rpc-client.js";

const BOUND_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UNBOUND_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DISABLED_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function instance(name: string, instanceId: string, channel = "whatsapp"): InstanceConfig {
  return {
    name,
    instanceId,
    channel,
    dmPolicy: "open",
    groupPolicy: "open",
    contactIntakeMode: "off",
    createdAt: 0,
    updatedAt: 0,
  } as InstanceConfig;
}

function channel(name: string, extra: Partial<ChannelConfig> = {}): ChannelConfig {
  return { name, provider: "whatsapp", enabled: true, createdAt: 0, updatedAt: 0, ...extra } as ChannelConfig;
}

function config(): Pick<RouterConfig, "instances" | "channels" | "instanceToAccount"> {
  return {
    instances: {
      main: instance("main", BOUND_ID),
      "wa-unbound": instance("wa-unbound", UNBOUND_ID),
      "wa-disabled": instance("wa-disabled", DISABLED_ID),
    },
    channels: {
      main: channel("main"),
      "wa-disabled": channel("wa-disabled", { enabled: false }),
    },
    instanceToAccount: { [BOUND_ID]: "main", [UNBOUND_ID]: "wa-unbound", [DISABLED_ID]: "wa-disabled" },
  };
}

interface RecordedCall {
  instanceId: string;
  method: WhatsAppRpcMethod;
  params: unknown;
  options: Parameters<typeof requestWhatsAppRpc>[3];
}

function fakeRequest(reply: (method: WhatsAppRpcMethod) => unknown = () => ({})) {
  const calls: RecordedCall[] = [];
  const request = (async (instanceId, method, params, options) => {
    calls.push({ instanceId, method, params, options });
    return reply(method);
  }) as typeof requestWhatsAppRpc;
  return { calls, request };
}

async function rejection(promise: Promise<unknown>): Promise<WhatsAppRpcError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(WhatsAppRpcError);
    return err as WhatsAppRpcError;
  }
  throw new Error("expected a rejection");
}

describe("createWhatsAppClient", () => {
  it("resolves an account name or the instance UUID to the bound instance UUID", async () => {
    const { calls, request } = fakeRequest(() => ({ messageId: "M1", status: "sent" }));
    const client = createWhatsAppClient({ getConfig: config, request });

    await client.messages.sendText("main", { to: "5511@s.whatsapp.net", text: "oi" });
    await client.messages.sendText(BOUND_ID, { to: "5511@s.whatsapp.net", text: "oi" });

    expect(calls.map((call) => call.instanceId)).toEqual([BOUND_ID, BOUND_ID]);
    expect(calls[0]).toMatchObject({ method: "messages.sendText", params: { to: "5511@s.whatsapp.net", text: "oi" } });
    expect(client.resolveBinding("main")?.instanceId).toBe(BOUND_ID);
    expect(client.resolveBinding(BOUND_ID)?.accountName).toBe("main");
  });

  it("rejects an unbound ref with 404 WHATSAPP_NOT_BOUND and never calls the runner", async () => {
    const { calls, request } = fakeRequest();
    const client = createWhatsAppClient({ getConfig: config, request });

    const byUuid = await rejection(client.connection.status(UNBOUND_ID, {}));
    expect(byUuid.status).toBe(404);
    expect(byUuid.code).toBe(WHATSAPP_RPC_ERROR_CODES.notBound);
    expect(byUuid.retryable).toBe(false);
    expect(byUuid.message).toBe(
      `Instance ${UNBOUND_ID} is not bound to a WhatsApp channel. Run: ravi instances connect wa-unbound`,
    );

    const disabled = await rejection(client.request("wa-disabled", "connection.status", {}));
    expect(disabled.message).toContain("ravi instances connect wa-disabled");

    const unknown = await rejection(client.messages.sendText("ghost", { to: "x", text: "y" }));
    expect(unknown.message).toContain("Instance ghost is not bound");

    expect(client.resolveBinding(UNBOUND_ID)).toBeNull();
    expect(client.resolveBinding(null)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("reads the live config on every call", async () => {
    const { calls, request } = fakeRequest();
    let current = config();
    const client = createWhatsAppClient({ getConfig: () => current, request });

    await rejection(client.connection.disconnect("wa-unbound", {}));
    current = { ...current, channels: { ...current.channels, "wa-unbound": channel("wa-unbound") } };
    await client.connection.disconnect("wa-unbound", {});

    expect(calls).toHaveLength(1);
    expect(calls[0]!.instanceId).toBe(UNBOUND_ID);
  });

  it("applies the per-method default timeouts and lets the caller override them", async () => {
    const { calls, request } = fakeRequest();
    const client = createWhatsAppClient({ getConfig: config, request });

    await client.connection.status("main", {});
    await client.presence.set("main", { to: "x@g.us", state: "typing" });
    await client.messages.markRead("main", { chatId: "x@g.us", messageIds: ["m"] });
    await client.messages.sendMedia("main", { to: "x@g.us", type: "image", filePath: "/tmp/a.png" });
    await client.messages.sendSticker("main", { to: "x@g.us", filePath: "/tmp/a.webp" });
    await client.messages.sendText("main", { to: "x@g.us", text: "t" });
    await client.groups.list("main", {});
    await client.connection.status("main", {}, { timeoutMs: WHATSAPP_CLIENT_TIMEOUTS_MS.listStatus });

    expect(calls.map((call) => call.options?.timeoutMs)).toEqual([
      10_000,
      10_000,
      15_000,
      120_000,
      120_000,
      DEFAULT_WHATSAPP_RPC_TIMEOUT_MS,
      DEFAULT_WHATSAPP_RPC_TIMEOUT_MS,
      2_500,
    ]);
    expect(defaultWhatsAppClientTimeoutMs("groups.metadata")).toBe(60_000);
  });

  it("exposes every RPC method under its namespace", async () => {
    const { calls, request } = fakeRequest();
    const client = createWhatsAppClient({ getConfig: config, request });
    const group = "120363@g.us";

    await client.connection.connect("main", {});
    await client.connection.logout("main", {});
    await client.connection.pairingCode("main", { phoneNumber: "5511999999999" });
    await client.groups.create("main", { subject: "S", participants: [] });
    await client.groups.addParticipants("main", { groupJid: group, participants: ["1@s.whatsapp.net"] });
    await client.groups.updateParticipants("main", {
      groupJid: group,
      action: "remove",
      participants: ["1@s.whatsapp.net"],
    });
    await client.groups.getInvite("main", { groupJid: group });
    await client.groups.revokeInvite("main", { groupJid: group });
    await client.groups.join("main", { code: "abc" });
    await client.groups.leave("main", { groupJid: group });
    await client.groups.rename("main", { groupJid: group, subject: "N" });
    await client.groups.setDescription("main", { groupJid: group, description: "d" });
    await client.groups.setSettings("main", { groupJid: group, setting: "announcement" });
    await client.groups.metadata("main", { groupJid: group });
    await client.messages.react("main", { to: group, messageId: "m", emoji: "x" });
    await client.messages.edit("main", { chatId: group, messageId: "m", text: "t" });
    await client.messages.delete("main", { chatId: group, messageId: "m" });

    expect(calls.map((call) => call.method)).toEqual([
      "connection.connect",
      "connection.logout",
      "connection.pairingCode",
      "groups.create",
      "groups.addParticipants",
      "groups.updateParticipants",
      "groups.getInvite",
      "groups.revokeInvite",
      "groups.join",
      "groups.leave",
      "groups.rename",
      "groups.setDescription",
      "groups.setSettings",
      "groups.metadata",
      "messages.react",
      "messages.edit",
      "messages.delete",
    ]);
  });

  it("uses the real RPC client over the given connection by default", async () => {
    const requests: Array<{ subject: string; request: WhatsAppRpcRequest; timeout: number }> = [];
    const connection: WhatsAppRpcConnection = {
      async request(subject, data, options) {
        const request = WhatsAppRpcRequestSchema.parse(JSON.parse(new TextDecoder().decode(data)));
        requests.push({ subject, request, timeout: options.timeout });
        const reply = { ok: true, requestId: request.requestId, data: { messageId: "R1", status: "sent" } };
        return { data: new TextEncoder().encode(JSON.stringify(reply)) };
      },
    };
    const client = createWhatsAppClient({ getConfig: config, connection });

    await expect(client.messages.sendText("main", { to: "x@g.us", text: "hi" })).resolves.toEqual({
      messageId: "R1",
      status: "sent",
    });
    expect(requests[0]!.subject).toBe(whatsappRpcSubject(BOUND_ID));
    expect(requests[0]!.request).toMatchObject({ schemaVersion: 2, method: "messages.sendText", instanceId: BOUND_ID });
    expect(requests[0]!.timeout).toBe(DEFAULT_WHATSAPP_RPC_TIMEOUT_MS);
  });
});
