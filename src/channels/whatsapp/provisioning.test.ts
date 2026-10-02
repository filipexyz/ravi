/**
 * `ensureWhatsAppInstance` (DESIGN-v2 §8.1, addendum R9) against an isolated router DB.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { loadRouterConfig } from "../../router/config.js";
import {
  closeRouterDb,
  dbDeleteInstance,
  dbGetChannel,
  dbGetInstance,
  dbUpdateChannel,
  dbUpsertChannel,
  dbUpsertInstance,
  getDb,
} from "../../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { resolveWhatsAppBinding } from "./contract.js";
import {
  ensureWhatsAppInstance,
  isWhatsAppProvisioningError,
  WHATSAPP_INSTANCE_CONFLICT,
  WHATSAPP_INSTANCE_DELETED,
  type EnsureWhatsAppInstanceOptions,
} from "./provisioning.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EXISTING_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const OTHER_ID = "bbbbbbbb-2222-4222-8222-222222222222";

let stateDir: string | null = null;
let emitted = 0;

function options(extra: EnsureWhatsAppInstanceOptions = {}): EnsureWhatsAppInstanceOptions {
  return {
    emitConfigChanged: () => {
      emitted += 1;
    },
    refreshConfig: () => {},
    ...extra,
  };
}

function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected an error");
}

function channelCount(): number {
  return (getDb().prepare("SELECT COUNT(*) AS n FROM channels").get() as { n: number }).n;
}

describe("ensureWhatsAppInstance", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-whatsapp-provisioning-");
    closeRouterDb();
    emitted = 0;
  });

  afterEach(async () => {
    closeRouterDb();
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("creates an instance with a fresh UUID and a channel row named after it", () => {
    const result = ensureWhatsAppInstance("vendas", options({ dmPolicy: "closed" }));

    expect(result.instanceId).toMatch(UUID_RE);
    expect(result).toMatchObject({
      createdInstance: true,
      mintedInstanceId: true,
      createdChannel: true,
      updatedInstance: false,
    });
    expect(dbGetInstance("vendas")).toMatchObject({
      instanceId: result.instanceId,
      channel: "whatsapp",
      dmPolicy: "closed",
    });
    expect(dbGetChannel("vendas")).toMatchObject({ provider: "whatsapp", enabled: true });
    expect(dbGetChannel("vendas")?.defaults).toBeUndefined();
    expect(resolveWhatsAppBinding(loadRouterConfig(), "vendas")?.instanceId).toBe(result.instanceId);
    expect(emitted).toBe(1);
  });

  it("keeps an existing (Omni-era) UUID and is a no-op on the second call", () => {
    dbUpsertInstance({ name: "main", instanceId: EXISTING_ID, channel: "whatsapp-baileys" });

    const first = ensureWhatsAppInstance("main", options());
    expect(first.instanceId).toBe(EXISTING_ID);
    expect(first).toMatchObject({ createdInstance: false, mintedInstanceId: false, createdChannel: true });

    const second = ensureWhatsAppInstance("main", options());
    expect(second).toMatchObject({
      instanceId: EXISTING_ID,
      createdInstance: false,
      mintedInstanceId: false,
      createdChannel: false,
      updatedInstance: false,
    });
    expect(emitted).toBe(1);
  });

  it("mints a UUID for an existing instance without one and applies changed settings", () => {
    dbUpsertInstance({ name: "suporte", channel: "whatsapp" });

    const result = ensureWhatsAppInstance("suporte", options({ groupPolicy: "closed" }));

    expect(result.instanceId).toMatch(UUID_RE);
    expect(result).toMatchObject({ createdInstance: false, mintedInstanceId: true, updatedInstance: true });
    expect(dbGetInstance("suporte")).toMatchObject({ instanceId: result.instanceId, groupPolicy: "closed" });
  });

  it("uses a sanitized channel name plus defaults.instance for an invalid channel id", () => {
    const result = ensureWhatsAppInstance("Loja São Paulo", options());

    expect(result.channel.name).toBe("Loja-Sao-Paulo");
    expect(dbGetChannel("Loja-Sao-Paulo")).toMatchObject({
      provider: "whatsapp",
      defaults: { instance: "Loja São Paulo" },
    });
    expect(resolveWhatsAppBinding(loadRouterConfig(), "Loja São Paulo")?.instanceId).toBe(result.instanceId);
  });

  it("falls back to a whatsapp-<uuid> channel name when another provider holds the name", () => {
    dbUpsertChannel({ name: "ops", provider: "slack" });

    const result = ensureWhatsAppInstance("ops", options());

    expect(result.channel.name).toBe(`whatsapp-${result.instanceId.slice(0, 8)}`);
    expect(result.channel.defaults).toEqual({ instance: "ops" });
    expect(dbGetChannel("ops")?.provider).toBe("slack");
    expect(resolveWhatsAppBinding(loadRouterConfig(), "ops")?.instanceId).toBe(result.instanceId);
  });

  it("refuses a soft-deleted name and writes nothing", () => {
    dbUpsertInstance({ name: "old", instanceId: EXISTING_ID, channel: "whatsapp" });
    dbDeleteInstance("old");
    const channelsBefore = channelCount();

    const err = captureError(() => ensureWhatsAppInstance("old", options()));

    expect(isWhatsAppProvisioningError(err) && err.code).toBe(WHATSAPP_INSTANCE_DELETED);
    expect((err as Error).message).toContain("ravi instances restore old");
    expect(dbGetInstance("old")).toBeNull();
    expect(channelCount()).toBe(channelsBefore);
    expect(emitted).toBe(0);
  });

  it("refuses a same-named WhatsApp channel bound to another instance and leaves no rows", () => {
    dbUpsertInstance({ name: "other", instanceId: OTHER_ID, channel: "whatsapp" });
    dbUpsertChannel({ name: "taken", provider: "whatsapp", defaults: { instance: "other" } });
    const channelsBefore = channelCount();

    const err = captureError(() => ensureWhatsAppInstance("taken", options()));

    expect(isWhatsAppProvisioningError(err) && err.code).toBe(WHATSAPP_INSTANCE_CONFLICT);
    expect((err as Error).message).toContain('bound to instance "other"');
    expect(dbGetInstance("taken")).toBeNull();
    expect(channelCount()).toBe(channelsBefore);
  });

  it("refuses a disabled WhatsApp channel and tells how to enable it", () => {
    dbUpsertInstance({ name: "paused", instanceId: EXISTING_ID, channel: "whatsapp" });
    dbUpsertChannel({ name: "paused", provider: "whatsapp" });
    dbUpdateChannel("paused", { enabled: false });

    const err = captureError(() => ensureWhatsAppInstance("paused", options({ dmPolicy: "closed" })));

    expect(isWhatsAppProvisioningError(err) && err.code).toBe(WHATSAPP_INSTANCE_CONFLICT);
    expect((err as Error).message).toContain("ravi instances enable paused");
    expect(dbGetInstance("paused")?.dmPolicy).not.toBe("closed");
  });

  it("refuses an instance of another channel type", () => {
    dbUpsertInstance({ name: "tg", channel: "telegram" });

    const err = captureError(() => ensureWhatsAppInstance("tg", options()));

    expect(isWhatsAppProvisioningError(err) && err.code).toBe(WHATSAPP_INSTANCE_CONFLICT);
    expect(dbGetChannel("tg")).toBeNull();
  });

  it("rolls back every write when the binding post-check fails", () => {
    const err = captureError(() =>
      ensureWhatsAppInstance(
        "ghost",
        options({ loadConfig: () => ({ instances: {}, channels: {}, instanceToAccount: {} }) }),
      ),
    );

    expect(isWhatsAppProvisioningError(err) && err.code).toBe(WHATSAPP_INSTANCE_CONFLICT);
    expect(dbGetInstance("ghost")).toBeNull();
    expect(dbGetChannel("ghost")).toBeNull();
    expect(emitted).toBe(0);
  });
});
