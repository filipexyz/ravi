/**
 * router-db §7.2: one-time WhatsApp channel backfill (`whatsapp_channels_backfill_v1`).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { ChannelBackendOpaqueIdSchema } from "../channels/backend.js";
import { listWhatsAppBindings, resolveWhatsAppBinding } from "../channels/whatsapp/contract.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { loadRouterConfig } from "./config.js";
import { backfillWhatsAppInstancesToChannels, closeRouterDb, getDb } from "./router-db.js";

const BACKFILL_KEY = "whatsapp_channels_backfill_v1";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EXISTING_ID = "aaaaaaaa-1111-4111-8111-111111111111";

let stateDir: string | null = null;

interface InstanceSeed {
  name: string;
  instanceId?: string | null;
  channel?: string;
  enabled?: boolean;
  deleted?: boolean;
}

interface ChannelRow {
  name: string;
  provider: string;
  enabled: number;
  credential_connection: string | null;
  defaults: string | null;
  deleted_at: number | null;
}

function insertInstance(db: Database, seed: InstanceSeed): void {
  db.prepare(
    `INSERT INTO instances (name, instance_id, channel, enabled, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    seed.name,
    seed.instanceId ?? null,
    seed.channel ?? "whatsapp",
    seed.enabled === false ? 0 : 1,
    1_700_000_000_000,
    1_700_000_000_000,
    seed.deleted ? 1_700_000_000_500 : null,
  );
}

function insertChannel(db: Database, name: string, provider: string, defaults?: Record<string, unknown>): void {
  db.prepare(
    `INSERT INTO channels (name, provider, enabled, credential_connection, defaults, created_at, updated_at, deleted_at)
     VALUES (?, ?, 1, NULL, ?, 1, 1, NULL)`,
  ).run(name, provider, defaults ? JSON.stringify(defaults) : null);
}

/** Fresh DB (init already marked the backfill done on an empty instances table) re-armed for a run. */
function rearmedDb(): Database {
  const db = getDb();
  db.prepare("DELETE FROM router_meta WHERE key = ?").run(BACKFILL_KEY);
  return db;
}

function channel(db: Database, name: string): ChannelRow | null {
  return (db.prepare("SELECT * FROM channels WHERE name = ?").get(name) as ChannelRow | undefined) ?? null;
}

function whatsappChannels(db: Database): ChannelRow[] {
  return db.prepare("SELECT * FROM channels WHERE provider = 'whatsapp' ORDER BY name").all() as ChannelRow[];
}

function instanceId(db: Database, name: string): string | null {
  return (db.prepare("SELECT instance_id FROM instances WHERE name = ?").get(name) as { instance_id: string | null })
    .instance_id;
}

describe("router-db WhatsApp channel backfill", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-router-whatsapp-backfill-");
    closeRouterDb();
  });

  afterEach(async () => {
    closeRouterDb();
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("mints a UUID only when missing, keeps existing ones and mirrors enabled", () => {
    const db = rearmedDb();
    insertInstance(db, { name: "main", instanceId: EXISTING_ID });
    insertInstance(db, { name: "vendas", instanceId: null, enabled: false });
    insertInstance(db, { name: "blank", instanceId: "  " });

    backfillWhatsAppInstancesToChannels(db);

    expect(instanceId(db, "main")).toBe(EXISTING_ID);
    expect(instanceId(db, "vendas")).toMatch(UUID_RE);
    expect(instanceId(db, "blank")).toMatch(UUID_RE);
    expect(channel(db, "main")).toMatchObject({
      provider: "whatsapp",
      enabled: 1,
      credential_connection: null,
      defaults: null,
    });
    expect(channel(db, "vendas")).toMatchObject({ provider: "whatsapp", enabled: 0, defaults: null });
    expect(channel(db, "blank")).toMatchObject({ provider: "whatsapp", enabled: 1 });

    const marker = db.prepare("SELECT value FROM router_meta WHERE key = ?").get(BACKFILL_KEY) as { value: string };
    expect(marker.value).toBe("done");

    // The live config binds every backfilled enabled instance.
    const config = loadRouterConfig();
    expect(resolveWhatsAppBinding(config, EXISTING_ID)?.accountName).toBe("main");
    expect(resolveWhatsAppBinding(config, "vendas")).toBeNull(); // disabled channel
  });

  it("runs once: a later instance gets no channel from the backfill", () => {
    const db = rearmedDb();
    insertInstance(db, { name: "main", instanceId: EXISTING_ID });
    backfillWhatsAppInstancesToChannels(db);
    insertInstance(db, { name: "later", instanceId: null });

    backfillWhatsAppInstancesToChannels(db);
    closeRouterDb();
    const reopened = getDb();

    expect(channel(reopened, "later")).toBeNull();
    expect(instanceId(reopened, "later")).toBeNull();
    expect(whatsappChannels(reopened).map((row) => row.name)).toEqual(["main"]);
  });

  it("runs at DB init when not marked done", () => {
    const db = rearmedDb();
    insertInstance(db, { name: "boot", instanceId: null });
    closeRouterDb();

    const reopened = getDb();
    expect(channel(reopened, "boot")).toMatchObject({ provider: "whatsapp", enabled: 1 });
    expect(instanceId(reopened, "boot")).toMatch(UUID_RE);
  });

  it("skips soft-deleted and non-canonical WhatsApp instances", () => {
    const db = rearmedDb();
    insertInstance(db, { name: "gone", instanceId: null, deleted: true });
    insertInstance(db, {
      name: "twilio",
      instanceId: "bbbbbbbb-2222-4222-8222-222222222222",
      channel: "twilio-whatsapp",
    });
    insertInstance(db, { name: "gup", instanceId: null, channel: "gupshup" });
    insertInstance(db, { name: "tg", instanceId: null, channel: "telegram" });
    insertInstance(db, { name: "baileys", instanceId: null, channel: " WhatsApp-Baileys " });

    backfillWhatsAppInstancesToChannels(db);

    expect(whatsappChannels(db).map((row) => row.name)).toEqual(["baileys"]);
    expect(instanceId(db, "gone")).toBeNull();
    expect(instanceId(db, "gup")).toBeNull();
    expect(instanceId(db, "tg")).toBeNull();
  });

  it("sanitizes an invalid instance name and binds it back through defaults.instance", () => {
    const db = rearmedDb();
    insertInstance(db, { name: "Loja São Paulo", instanceId: EXISTING_ID });

    backfillWhatsAppInstancesToChannels(db);

    const row = channel(db, "Loja-Sao-Paulo");
    expect(row).toMatchObject({ provider: "whatsapp", enabled: 1 });
    expect(JSON.parse(row?.defaults ?? "{}")).toEqual({ instance: "Loja São Paulo" });

    const config = loadRouterConfig();
    const binding = listWhatsAppBindings(config).find((item) => item.channel.name === "Loja-Sao-Paulo");
    expect(binding).toMatchObject({ accountName: "Loja São Paulo", instanceId: EXISTING_ID });
    expect(resolveWhatsAppBinding(config, EXISTING_ID)?.accountName).toBe("Loja São Paulo");
  });

  it("falls back to whatsapp-<uuid8> when the name belongs to another provider's channel", () => {
    const db = rearmedDb();
    insertChannel(db, "suporte", "slack");
    insertInstance(db, { name: "suporte", instanceId: EXISTING_ID });

    backfillWhatsAppInstancesToChannels(db);

    expect(channel(db, "suporte")?.provider).toBe("slack");
    const row = channel(db, "whatsapp-aaaaaaaa");
    expect(row).toMatchObject({ provider: "whatsapp" });
    expect(JSON.parse(row?.defaults ?? "{}")).toEqual({ instance: "suporte" });
  });

  it("does not duplicate an existing WhatsApp channel bound via defaults.instance", () => {
    const db = rearmedDb();
    insertChannel(db, "wa-main", "whatsapp", { instance: "main" });
    insertChannel(db, "baileys-alias", "whatsapp-baileys", { instance: "alias" });
    insertInstance(db, { name: "main", instanceId: EXISTING_ID });
    insertInstance(db, { name: "alias", instanceId: null });

    backfillWhatsAppInstancesToChannels(db);

    expect(whatsappChannels(db).map((row) => row.name)).toEqual(["wa-main"]);
    expect(channel(db, "main")).toBeNull();
    expect(channel(db, "alias")).toBeNull();
    // The UUID is still minted for a bound instance that had none.
    expect(instanceId(db, "alias")).toMatch(UUID_RE);
  });

  it("produces only valid opaque channel ids", () => {
    const db = rearmedDb();
    const names = [
      "Loja São Paulo",
      "-leading",
      "ok.name_1~x",
      "emoji 😀 shop",
      "名前",
      "a".repeat(140),
      "dup!",
      "dup?",
    ];
    for (const name of names) insertInstance(db, { name, instanceId: null });

    backfillWhatsAppInstancesToChannels(db);

    const rows = whatsappChannels(db);
    expect(rows).toHaveLength(names.length);
    for (const row of rows) {
      expect(ChannelBackendOpaqueIdSchema.safeParse(row.name).success).toBe(true);
    }
    const bound = new Set(
      rows.map((row) => (row.defaults ? (JSON.parse(row.defaults) as { instance: string }).instance : row.name)),
    );
    expect(bound).toEqual(new Set(names));
  });
});
