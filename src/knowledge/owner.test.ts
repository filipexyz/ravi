import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { PlatformIdentity } from "../contacts.js";
import type { InstanceConfig } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { resolveOwnerDirectTarget } from "./owner.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-knowledge-owner-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function identity(overrides: Partial<PlatformIdentity>): PlatformIdentity {
  return {
    id: "pi-1",
    ownerType: "contact",
    ownerId: "contact_owner",
    channel: "whatsapp",
    instanceId: "main",
    platformUserId: "5511999990001",
    normalizedPlatformUserId: "5511999990001",
    platformDisplayName: null,
    avatarUrl: null,
    profileData: null,
    isPrimary: true,
    confidence: 1,
    linkedBy: null,
    linkReason: null,
    firstSeenAt: null,
    lastSeenAt: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

function instance(name: string, channel: string): InstanceConfig {
  return {
    name,
    channel,
    dmPolicy: "open",
    groupPolicy: "closed",
    contactIntakeMode: "off",
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  } as InstanceConfig;
}

const INSTANCES = [instance("main", "whatsapp"), instance("backup", "whatsapp"), instance("slack-main", "slack")];
const IDENTITIES = [
  identity({ channel: "slack", instanceId: "slack-main", platformUserId: "U123", normalizedPlatformUserId: "U123" }),
  identity({}),
];

function deps(overrides: Partial<Parameters<typeof resolveOwnerDirectTarget>[0]> = {}) {
  return {
    listOwnerContactIds: () => ["contact_owner"],
    identitiesForContact: () => IDENTITIES,
    readTargetSetting: () => null,
    listInstances: () => INSTANCES,
    ...overrides,
  };
}

describe("resolveOwnerDirectTarget", () => {
  it("resolves the one tagged contact, preferring WhatsApp", () => {
    expect(resolveOwnerDirectTarget(deps())).toEqual({
      channel: "whatsapp",
      accountId: "main",
      to: "5511999990001@s.whatsapp.net",
      chatId: "5511999990001@s.whatsapp.net",
      contactId: "contact_owner",
    });
  });

  it("is null with two tagged contacts or none", () => {
    expect(resolveOwnerDirectTarget(deps({ listOwnerContactIds: () => ["contact_a", "contact_b"] }))).toBeNull();
    expect(resolveOwnerDirectTarget(deps({ listOwnerContactIds: () => [] }))).toBeNull();
  });

  it("ignores a setting naming a number that is not the owner's", () => {
    const target = resolveOwnerDirectTarget(deps({ readTargetSetting: () => "whatsapp:backup:5511888880000" }));
    expect(target?.to).toBe("5511999990001@s.whatsapp.net");
    expect(target?.accountId).toBe("main");
  });

  it("a setting naming the owner's own identity picks it, switching only to a same-channel instance", () => {
    expect(resolveOwnerDirectTarget(deps({ readTargetSetting: () => "slack:slack-main:U123" }))?.channel).toBe("slack");
    expect(
      resolveOwnerDirectTarget(deps({ readTargetSetting: () => "whatsapp:backup:5511999990001" }))?.accountId,
    ).toBe("backup");
    expect(
      resolveOwnerDirectTarget(deps({ readTargetSetting: () => "whatsapp:slack-main:5511999990001" }))?.accountId,
    ).toBe("main");
  });

  it("skips identities owned by an agent and is null without any usable identity", () => {
    expect(
      resolveOwnerDirectTarget(deps({ identitiesForContact: () => [identity({ ownerType: "agent" })] })),
    ).toBeNull();
    expect(resolveOwnerDirectTarget(deps({ identitiesForContact: () => [] }))).toBeNull();
  });

  it("uses the real tag lookup by default and fails closed on an empty install", () => {
    expect(resolveOwnerDirectTarget()).toBeNull();
  });
});
