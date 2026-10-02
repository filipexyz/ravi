import { describe, expect, it } from "bun:test";
import type { ChannelConfig, InstanceConfig } from "../../router/router-db.js";
import {
  findWhatsAppChannelForInstance,
  InstanceIdSchema,
  isWhatsAppBound,
  isWhatsAppChannelType,
  isWhatsAppFamilyChannelType,
  isWhatsAppInstanceConfig,
  listWhatsAppBindings,
  type OwnershipConfig,
  resolveWhatsAppBinding,
} from "./contract.js";

const MAIN_ID = "11111111-1111-4111-8111-111111111111";
const LOJA_ID = "22222222-2222-4222-8222-222222222222";
const OFF_ID = "33333333-3333-4333-8333-333333333333";

function instance(name: string, instanceId?: string, extra: Partial<InstanceConfig> = {}): InstanceConfig {
  return {
    name,
    channel: "whatsapp-baileys",
    dmPolicy: "open",
    groupPolicy: "open",
    contactIntakeMode: "pending",
    createdAt: 1,
    updatedAt: 1,
    ...(instanceId ? { instanceId } : {}),
    ...extra,
  };
}

function channel(name: string, extra: Partial<ChannelConfig> = {}): ChannelConfig {
  return { name, provider: "whatsapp", enabled: true, createdAt: 1, updatedAt: 1, ...extra };
}

function config(): OwnershipConfig {
  return {
    instances: {
      main: instance("main", MAIN_ID),
      "Loja São Paulo": instance("Loja São Paulo", LOJA_ID),
      off: instance("off", OFF_ID),
      noid: instance("noid"),
    },
    channels: {
      main: channel("main"),
      "Loja-Sao-Paulo": channel("Loja-Sao-Paulo", { defaults: { instance: "Loja São Paulo" } }),
      off: channel("off", { enabled: false }),
      noid: channel("noid"),
      slack: channel("slack", { provider: "slack" }),
      old: channel("old", { deletedAt: 9, defaults: { instance: "main" } }),
    },
    instanceToAccount: { [MAIN_ID]: "main", [LOJA_ID]: "Loja São Paulo", [OFF_ID]: "off" },
  };
}

describe("WhatsApp bindings", () => {
  it("lists enabled channels bound to an instance with a transport id", () => {
    const bindings = listWhatsAppBindings(config());
    expect(bindings.map((binding) => [binding.accountName, binding.instanceId, binding.channel.name])).toEqual([
      ["main", MAIN_ID, "main"],
      ["Loja São Paulo", LOJA_ID, "Loja-Sao-Paulo"],
    ]);
  });

  it("resolves by UUID or account name, honouring defaults.instance", () => {
    expect(resolveWhatsAppBinding(config(), MAIN_ID)?.accountName).toBe("main");
    expect(resolveWhatsAppBinding(config(), " main ")?.instanceId).toBe(MAIN_ID);
    expect(resolveWhatsAppBinding(config(), LOJA_ID)?.channel.name).toBe("Loja-Sao-Paulo");
    expect(resolveWhatsAppBinding(config(), "Loja São Paulo")?.instanceId).toBe(LOJA_ID);
    expect(isWhatsAppBound(config(), MAIN_ID)).toBe(true);
  });

  it("does not bind disabled channels, instances without a UUID or unknown refs", () => {
    expect(resolveWhatsAppBinding(config(), OFF_ID)).toBeNull();
    expect(resolveWhatsAppBinding(config(), "noid")).toBeNull();
    expect(resolveWhatsAppBinding(config(), "nope")).toBeNull();
    expect(resolveWhatsAppBinding(config(), "")).toBeNull();
    expect(resolveWhatsAppBinding(config(), null)).toBeNull();
    expect(isWhatsAppBound(config(), undefined)).toBe(false);
  });

  it("reports whether a ref is bound", () => {
    expect(isWhatsAppBound(config(), LOJA_ID)).toBe(true);
    expect(isWhatsAppBound(config(), "Loja São Paulo")).toBe(true);
    expect(isWhatsAppBound(config(), OFF_ID)).toBe(false);
    expect(isWhatsAppBound(config(), "noid")).toBe(false);
  });
});

describe("findWhatsAppChannelForInstance", () => {
  it("finds the bound channel, including disabled ones", () => {
    expect(findWhatsAppChannelForInstance(config(), "main")?.name).toBe("main");
    expect(findWhatsAppChannelForInstance(config(), "Loja São Paulo")?.name).toBe("Loja-Sao-Paulo");
    expect(findWhatsAppChannelForInstance(config(), "off")?.enabled).toBe(false);
  });

  it("ignores deleted and non-WhatsApp channels", () => {
    const cfg = config();
    expect(findWhatsAppChannelForInstance({ channels: { old: cfg.channels!.old! } }, "main")).toBeNull();
    expect(findWhatsAppChannelForInstance(cfg, "slack")).toBeNull();
    expect(findWhatsAppChannelForInstance(cfg, "missing")).toBeNull();
    expect(findWhatsAppChannelForInstance(cfg, " ")).toBeNull();
    expect(findWhatsAppChannelForInstance({}, "main")).toBeNull();
  });
});

describe("WhatsApp channel type predicates", () => {
  it("serves exactly the canonical WhatsApp types natively", () => {
    for (const type of ["whatsapp", "whatsapp-baileys", "whatsapp baileys", " WhatsApp-Baileys "]) {
      expect({ type, native: isWhatsAppChannelType(type) }).toEqual({ type, native: true });
    }
    for (const type of ["twilio-whatsapp", "whatsapp-cloud", "gupshup", "telegram", "discord", "", null, undefined]) {
      expect({ type, native: isWhatsAppChannelType(type) }).toEqual({ type, native: false });
    }
  });

  it("recognises every WhatsApp-family type", () => {
    for (const type of ["whatsapp", "whatsapp-baileys", "twilio-whatsapp", "WhatsApp-Cloud", "gupshup", " Gupshup "]) {
      expect({ type, family: isWhatsAppFamilyChannelType(type) }).toEqual({ type, family: true });
    }
    for (const type of ["telegram", "discord", "slack", "", null, undefined]) {
      expect({ type, family: isWhatsAppFamilyChannelType(type) }).toEqual({ type, family: false });
    }
  });

  it("classifies instance records by their channel", () => {
    expect(isWhatsAppInstanceConfig({ channel: "whatsapp-baileys" })).toBe(true);
    expect(isWhatsAppInstanceConfig({ channel: "twilio-whatsapp" })).toBe(false);
    expect(isWhatsAppInstanceConfig({ channel: "telegram" })).toBe(false);
    expect(isWhatsAppInstanceConfig(null)).toBe(false);
  });
});

describe("InstanceIdSchema", () => {
  it("accepts instance UUIDs and rejects wildcards, spaces and empty ids", () => {
    expect(InstanceIdSchema.safeParse(MAIN_ID).success).toBe(true);
    expect(InstanceIdSchema.safeParse("a b").success).toBe(false);
    expect(InstanceIdSchema.safeParse("a*").success).toBe(false);
    expect(InstanceIdSchema.safeParse("").success).toBe(false);
  });
});
