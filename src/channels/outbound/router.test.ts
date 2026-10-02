import { describe, expect, it } from "bun:test";
import type { ChannelConfig, InstanceConfig } from "../../router/router-db.js";
import { ChannelTransportError } from "./errors.js";
import { classifyInstanceRoute, createChannelSenderRouter, type SenderRoutingConfig } from "./router.js";
import type { ChannelMessageSender } from "./sender.js";

const WA_BOUND = "11111111-1111-4111-8111-111111111111";
const WA_UNBOUND = "22222222-2222-4222-8222-222222222222";
const TELEGRAM = "33333333-3333-4333-8333-333333333333";
const TWILIO = "44444444-4444-4444-8444-444444444444";
const DELETED = "55555555-5555-4555-8555-555555555555";
const UNMAPPED = "99999999-9999-4999-8999-999999999999";

function instance(name: string, channel: string, instanceId?: string, extra: Partial<InstanceConfig> = {}) {
  const record: InstanceConfig = {
    name,
    channel,
    dmPolicy: "open",
    groupPolicy: "open",
    contactIntakeMode: "pending",
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
  if (instanceId) record.instanceId = instanceId;
  return record;
}

function channel(name: string, extra: Partial<ChannelConfig> = {}): ChannelConfig {
  return { name, provider: "whatsapp", enabled: true, createdAt: 1, updatedAt: 1, ...extra };
}

function config(): SenderRoutingConfig {
  return {
    instances: {
      main: instance("main", "whatsapp-baileys", WA_BOUND),
      loja: instance("loja", "whatsapp", WA_UNBOUND),
      tg: instance("tg", "telegram", TELEGRAM),
      twilio: instance("twilio", "twilio-whatsapp", TWILIO),
      gup: instance("gup", "gupshup"),
      gone: instance("gone", "telegram", DELETED, { deletedAt: 5 }),
      orphan: instance("orphan", "discord"),
    },
    channels: { main: channel("main") },
    instanceToAccount: {
      [WA_BOUND]: "main",
      [WA_UNBOUND]: "loja",
      [TELEGRAM]: "tg",
      [TWILIO]: "twilio",
      [DELETED]: "gone",
    },
  };
}

function fakeSender(label: string) {
  const calls: Array<[string, ...unknown[]]> = [];
  const sender: ChannelMessageSender = {
    send: async (...args) => {
      calls.push(["send", ...args]);
      return { messageId: `${label}-1` };
    },
    sendTyping: async (...args) => {
      calls.push(["sendTyping", ...args]);
    },
    sendReaction: async (...args) => {
      calls.push(["sendReaction", ...args]);
    },
    deleteMessage: async (...args) => {
      calls.push(["deleteMessage", ...args]);
    },
    editMessage: async (...args) => {
      calls.push(["editMessage", ...args]);
    },
    sendMedia: async (...args) => {
      calls.push(["sendMedia", ...args]);
      return { messageId: `${label}-m` };
    },
    sendSticker: async (...args) => {
      calls.push(["sendSticker", ...args]);
      return { messageId: `${label}-s` };
    },
    markRead: async (...args) => {
      calls.push(["markRead", ...args]);
    },
  };
  return { sender, calls };
}

async function rejection(promise: Promise<unknown>): Promise<ChannelTransportError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ChannelTransportError);
    return err as ChannelTransportError;
  }
  throw new Error("expected a rejection");
}

describe("classifyInstanceRoute", () => {
  it("routes bound WhatsApp instances to whatsapp by UUID or account name", () => {
    expect(classifyInstanceRoute(config(), WA_BOUND)).toBe("whatsapp");
    expect(classifyInstanceRoute(config(), "main")).toBe("whatsapp");
  });

  it("routes an unbound canonical WhatsApp instance to whatsapp, never the bridge", () => {
    expect(classifyInstanceRoute(config(), WA_UNBOUND)).toBe("whatsapp");
    expect(classifyInstanceRoute(config(), "loja")).toBe("whatsapp");
  });

  it("marks WhatsApp-family providers ravi does not serve as unsupported", () => {
    expect(classifyInstanceRoute(config(), TWILIO)).toBe("unsupported");
    expect(classifyInstanceRoute(config(), "gup")).toBe("unsupported");
  });

  it("routes other instance records to the bridge", () => {
    expect(classifyInstanceRoute(config(), TELEGRAM)).toBe("bridge");
    expect(classifyInstanceRoute(config(), "orphan")).toBe("bridge");
  });

  it("finds a record by its instanceId when instanceToAccount has no entry", () => {
    const cfg = config();
    cfg.instanceToAccount = {};
    expect(classifyInstanceRoute(cfg, TELEGRAM)).toBe("bridge");
    expect(classifyInstanceRoute(cfg, WA_UNBOUND)).toBe("whatsapp");
  });

  it("treats unmapped UUIDs, deleted records and empty refs as unknown", () => {
    expect(classifyInstanceRoute(config(), UNMAPPED)).toBe("unknown");
    expect(classifyInstanceRoute(config(), DELETED)).toBe("unknown");
    expect(classifyInstanceRoute(config(), "gone")).toBe("unknown");
    expect(classifyInstanceRoute(config(), "  ")).toBe("unknown");
  });
});

describe("createChannelSenderRouter", () => {
  it("sends an unbound canonical WhatsApp instance to the WhatsApp sender", async () => {
    const wa = fakeSender("wa");
    const bridge = fakeSender("bridge");
    const router = createChannelSenderRouter({ whatsapp: wa.sender, bridge: bridge.sender, getConfig: config });

    await expect(router.send(WA_UNBOUND, "5511@s.whatsapp.net", "hi")).resolves.toEqual({ messageId: "wa-1" });
    await router.sendMedia(WA_BOUND, "5511@s.whatsapp.net", "a.png", "image", "a.png", "cap", false);

    expect(router.routeFor(WA_UNBOUND)).toBe("whatsapp");
    expect(wa.calls.map((call) => call[0])).toEqual(["send", "sendMedia"]);
    expect(wa.calls[1]).toEqual([
      "sendMedia",
      WA_BOUND,
      "5511@s.whatsapp.net",
      "a.png",
      "image",
      "a.png",
      "cap",
      false,
    ]);
    expect(bridge.calls).toEqual([]);
  });

  it("passes a reaction target through only when the caller has one", async () => {
    const wa = fakeSender("wa");
    const router = createChannelSenderRouter({ whatsapp: wa.sender, bridge: null, getConfig: config });

    await router.sendReaction(WA_BOUND, "120363@g.us", "m1", "👍", { participant: "123@lid", fromMe: false });
    await router.sendReaction(WA_BOUND, "120363@g.us", "m2", "👍");

    expect(wa.calls).toEqual([
      ["sendReaction", WA_BOUND, "120363@g.us", "m1", "👍", { participant: "123@lid", fromMe: false }],
      ["sendReaction", WA_BOUND, "120363@g.us", "m2", "👍"],
    ]);
  });

  it("refuses an unmapped UUID with INSTANCE_NOT_FOUND and never calls the bridge", async () => {
    const wa = fakeSender("wa");
    const bridge = fakeSender("bridge");
    const router = createChannelSenderRouter({ whatsapp: wa.sender, bridge: bridge.sender, getConfig: config });

    const err = await rejection(router.send(UNMAPPED, "x", "hi"));

    expect(err.status).toBe(404);
    expect(err.code).toBe("INSTANCE_NOT_FOUND");
    expect(err.retryable).toBe(false);
    expect(router.routeFor(UNMAPPED)).toBe("unknown");
    expect(bridge.calls).toEqual([]);
    expect(wa.calls).toEqual([]);
  });

  it("refuses twilio-whatsapp with CHANNEL_PROVIDER_UNSUPPORTED", async () => {
    const wa = fakeSender("wa");
    const bridge = fakeSender("bridge");
    const router = createChannelSenderRouter({ whatsapp: wa.sender, bridge: bridge.sender, getConfig: config });

    const err = await rejection(router.sendReaction(TWILIO, "x", "m1", "👍"));

    expect(err.status).toBe(422);
    expect(err.code).toBe("CHANNEL_PROVIDER_UNSUPPORTED");
    expect(err.retryable).toBe(false);
    expect(bridge.calls).toEqual([]);
    expect(wa.calls).toEqual([]);
  });

  it("sends telegram through the bridge", async () => {
    const wa = fakeSender("wa");
    const bridge = fakeSender("bridge");
    const router = createChannelSenderRouter({ whatsapp: wa.sender, bridge: bridge.sender, getConfig: config });

    await expect(router.send(TELEGRAM, "chat", "hi", { threadId: "t1" })).resolves.toEqual({ messageId: "bridge-1" });
    await router.editMessage(TELEGRAM, "chat", "m1", "edited");
    await router.deleteMessage(TELEGRAM, "chat", "m1");
    await router.sendSticker(TELEGRAM, "chat", "s.webp");

    expect(router.hasBridge).toBe(true);
    expect(bridge.calls).toEqual([
      ["send", TELEGRAM, "chat", "hi", { threadId: "t1" }],
      ["editMessage", TELEGRAM, "chat", "m1", "edited"],
      ["deleteMessage", TELEGRAM, "chat", "m1"],
      ["sendSticker", TELEGRAM, "chat", "s.webp"],
    ]);
    expect(wa.calls).toEqual([]);
  });

  it("refuses telegram with LEGACY_BRIDGE_NOT_CONFIGURED when there is no bridge", async () => {
    const wa = fakeSender("wa");
    const router = createChannelSenderRouter({ whatsapp: wa.sender, bridge: null, getConfig: config });

    const err = await rejection(router.send(TELEGRAM, "chat", "hi"));

    expect(router.hasBridge).toBe(false);
    expect(err.status).toBe(503);
    expect(err.code).toBe("LEGACY_BRIDGE_NOT_CONFIGURED");
    expect(err.retryable).toBe(false);
    expect(wa.calls).toEqual([]);
  });

  it("never throws from sendTyping/markRead, whatever the route", async () => {
    const throwing: ChannelMessageSender = {
      ...fakeSender("wa").sender,
      sendTyping: async () => {
        throw new Error("boom");
      },
      markRead: async () => {
        throw new Error("boom");
      },
    };
    const router = createChannelSenderRouter({ whatsapp: throwing, getConfig: config });

    for (const ref of [WA_BOUND, UNMAPPED, TWILIO, TELEGRAM]) {
      await expect(router.sendTyping(ref, "x", true)).resolves.toBeUndefined();
      await expect(router.markRead(ref, "x", ["m1"])).resolves.toBeUndefined();
    }
  });

  it("delivers typing and read receipts to the routed sender", async () => {
    const wa = fakeSender("wa");
    const bridge = fakeSender("bridge");
    const router = createChannelSenderRouter({ whatsapp: wa.sender, bridge: bridge.sender, getConfig: config });

    await router.sendTyping(WA_BOUND, "x", false);
    await router.markRead(TELEGRAM, "chat", ["m1", "m2"]);

    expect(wa.calls).toEqual([["sendTyping", WA_BOUND, "x", false]]);
    expect(bridge.calls).toEqual([["markRead", TELEGRAM, "chat", ["m1", "m2"]]]);
  });

  it("reads the live config on every call", async () => {
    const wa = fakeSender("wa");
    let current = config();
    const router = createChannelSenderRouter({ whatsapp: wa.sender, getConfig: () => current });

    expect(router.routeFor(UNMAPPED)).toBe("unknown");
    current = {
      ...current,
      instances: { ...current.instances, novo: instance("novo", "whatsapp-baileys", UNMAPPED) },
      instanceToAccount: { ...current.instanceToAccount, [UNMAPPED]: "novo" },
    };

    expect(router.routeFor(UNMAPPED)).toBe("whatsapp");
    await expect(router.send(UNMAPPED, "x", "hi")).resolves.toEqual({ messageId: "wa-1" });
  });
});
