import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { createHash } from "node:crypto";
import { listPendingOutboxBatch, setSyncCursor } from "../sync/db.js";
import { sanitizeSyncPayload } from "../sync/redaction.js";
import {
  CREDENTIAL_INVENTORY_HEARTBEAT_MS,
  CREDENTIAL_INVENTORY_PAGE_MAX_BYTES,
  CREDENTIAL_INVENTORY_MIN_INTERVAL_MS,
  CREDENTIAL_INVENTORY_SYNC_DOMAIN,
  FREE_TEXT_MAX_CHARS,
  SCOPES_MAX_ITEMS,
  guardFreeText,
  type CredentialInventorySyncPayload,
  credentialInventorySyncPayload,
  enqueueCredentialInventorySnapshot,
  paginateCredentialInventoryPayload,
} from "./inventory-sync.js";
import { buildCredentialInventory } from "./inventory.js";
import { closeCredentialsDb, recordCredentialAuditEvent, upsertCredentialConnection } from "./store.js";
import type { CredentialSecretDescription } from "./types.js";

const SECRET_VALUE = "xoxb-sync-must-never-carry-this";
const ENABLED = { RAVI_SYNC_CREDENTIALS_INVENTORY: "1" };
const T0 = Date.parse("2026-11-24T12:00:00Z");

const description: CredentialSecretDescription = {
  available: true,
  exists: true,
  version: 4,
  createdAt: T0 - 86_400_000,
  updatedAt: T0 - 3_600_000,
  deleted: false,
};
// The describer sees the raw ref; it must never leak into the payload.
const describeSecret = async (ref: string): Promise<CredentialSecretDescription> => {
  if (!ref.includes("ravi/credentials")) throw new Error("unexpected ref");
  return description;
};

let stateDir: string;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-credentials-sync-test-");
});

afterEach(async () => {
  closeCredentialsDb();
  await cleanupIsolatedRaviState(stateDir);
});

function seed(connection = "rbbt", label: string | null = null) {
  upsertCredentialConnection({
    provider: "slack",
    connection,
    label,
    backend: "vault",
    secretRef: `vault:secret/ravi/credentials/slack/${connection}#token`,
    scopes: ["chat:write"],
    status: "active",
    owner: "luis",
  });
}

function outbox() {
  return listPendingOutboxBatch({ domain: CREDENTIAL_INVENTORY_SYNC_DOMAIN, limit: 50 }).items;
}

describe("credential inventory over the Console sync bridge", () => {
  it("is opt-in: nothing is enqueued without RAVI_SYNC_CREDENTIALS_INVENTORY=1", async () => {
    seed();
    const result = await enqueueCredentialInventorySnapshot({ env: {}, now: T0, inventory: { describeSecret } });
    expect(result.status).toBe("disabled");
    expect(outbox()).toHaveLength(0);
  });

  it("enqueues a metadata-only payload that the sync redactor leaves intact", async () => {
    seed();
    recordCredentialAuditEvent({
      provider: "slack",
      connection: "rbbt",
      action: "chat.postMessage",
      decision: "allow",
      resultStatus: "secret_resolved",
      actorContextId: "rctx_private_context",
      createdAt: T0 - 1_000,
    });

    const result = await enqueueCredentialInventorySnapshot({ env: ENABLED, now: T0, inventory: { describeSecret } });
    expect(result.status).toBe("enqueued");
    const rows = outbox();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({ domain: "credentials", eventType: "credentials.inventory", entityId: "installation" });

    const payload = row.payload as Record<string, unknown> & { items: Array<Record<string, unknown>> };
    expect(payload.schema).toBe("credentials.inventory/v1");
    // `storage` survives the redactor (a key ending in "secret" would have been blanked).
    expect(payload.items[0]?.storage).toEqual(description);
    expect(payload.items[0]).toMatchObject({
      secretRefAlias: "vault:slack:rbbt",
      owner: "luis",
      lastUsedAt: T0 - 1_000,
    });
    expect("secret" in (payload.items[0] ?? {})).toBe(false);

    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain("[REDACTED");
    expect(serialized).not.toContain(SECRET_VALUE);
    expect(serialized).not.toContain("ravi/credentials");
    expect(serialized).not.toContain("#token");
    expect(serialized).not.toContain("rctx_private_context");
  });

  it("the payload is a fixed point of sanitizeSyncPayload (nothing for the redactor to remove)", async () => {
    seed("rbbt", "Bearer-looking label is still just a label");
    const payload = credentialInventorySyncPayload(
      await buildCredentialInventory({ describeSecret, now: T0, auditLimit: 5 }),
    );
    expect(sanitizeSyncPayload(payload)).toEqual(payload);
  });

  it("asks the Vault at most once per interval, sends a change at the next check, heartbeats, and force always sends", async () => {
    seed();
    let vaultCalls = 0;
    const counting = async (ref: string) => {
      vaultCalls += 1;
      return describeSecret(ref);
    };
    const run = (now: number, force = false) =>
      enqueueCredentialInventorySnapshot({ env: ENABLED, now, force, inventory: { describeSecret: counting } });
    const HB = CREDENTIAL_INVENTORY_HEARTBEAT_MS;
    const MIN = CREDENTIAL_INVENTORY_MIN_INTERVAL_MS;

    expect((await run(T0)).status).toBe("enqueued");
    expect(vaultCalls).toBe(1);
    // Inside the interval nothing is built: the Vault is not asked again (N1).
    expect((await run(T0 + 60_000)).status).toBe("throttled");
    expect((await run(T0 + MIN - 1)).status).toBe("throttled");
    expect(vaultCalls).toBe(1);
    expect((await run(T0 + MIN)).status).toBe("unchanged");
    expect(vaultCalls).toBe(2);
    expect((await run(T0 + HB - 1)).status).toBe("unchanged");
    // Same content, heartbeat due at the next check.
    expect((await run(T0 + HB - 1 + MIN)).status).toBe("enqueued");
    const t = T0 + HB - 1 + MIN;

    seed("sales");
    expect((await run(t + 60_000)).status).toBe("throttled");
    expect((await run(t + MIN)).status).toBe("enqueued");
    expect((await run(t + MIN + 1, true)).status).toBe("enqueued");
    expect(outbox()).toHaveLength(4);
  });

  it("does not touch the Vault when the opt-in is off (N2)", async () => {
    seed();
    let vaultCalls = 0;
    const spy = async (ref: string) => {
      vaultCalls += 1;
      return describeSecret(ref);
    };
    for (const env of [{}, { RAVI_SYNC_CREDENTIALS_INVENTORY: "0" }, { RAVI_SYNC_CREDENTIALS_INVENTORY: "true" }]) {
      const result = await enqueueCredentialInventorySnapshot({ env, now: T0, inventory: { describeSecret: spy } });
      expect(result.status).toBe("disabled");
    }
    expect(vaultCalls).toBe(0);
    expect(outbox()).toHaveLength(0);
  });

  it("caps and scrubs person-typed text before it leaves (N4)", async () => {
    upsertCredentialConnection({
      provider: "slack",
      connection: "rbbt",
      backend: "vault",
      secretRef: "vault:secret/ravi/credentials/slack/rbbt#token",
      status: "active",
      label: `pasted ${"x ".repeat(300)}`,
      owner: "luis hvs.CAESIJ0123456789abcdefghijklmnopqrstuv",
      purpose:
        "bot xoxb-123456789012-abcdefghijkl and eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlLXZhbHVl and ghp_abcdefghijklmnopqrstuvwxyz0123",
      scopes: ["chat:write", `AKIA${"A".repeat(16)}`],
    });
    await enqueueCredentialInventorySnapshot({ env: ENABLED, now: T0, inventory: { describeSecret } });
    const [row] = outbox();
    const item = (row!.payload as { items: Array<Record<string, unknown>> }).items[0]!;
    expect((item.label as string).length).toBeLessThanOrEqual(FREE_TEXT_MAX_CHARS);
    expect(item.owner).toBe("luis [redacted]");
    expect(item.purpose).toBe("bot [redacted] and [redacted] and [redacted]");
    expect(item.scopes).toEqual(["[redacted]", "chat:write"]);
    const serialized = JSON.stringify(row);
    for (const leaked of ["hvs.CAESIJ", "xoxb-1234", "eyJhbGci", "ghp_abcd", "AKIAAAAA"]) {
      expect(serialized).not.toContain(leaked);
    }
  });

  it("force sends even when the opt-in is off", async () => {
    seed();
    const result = await enqueueCredentialInventorySnapshot({
      env: {},
      force: true,
      now: T0,
      inventory: { describeSecret },
    });
    expect(result.status).toBe("enqueued");
    expect(outbox()).toHaveLength(1);
  });
});

describe("credential inventory pages stay under the Console payload limit", () => {
  const CONSOLE_MAX_JSON_FIELD_BYTES = 64 * 1024;

  it("splits a large snapshot into pages under 64 KiB, with every item once and the audit on page 1", async () => {
    for (let i = 0; i < 400; i += 1) {
      upsertCredentialConnection({
        provider: "slack",
        connection: `conn-${String(i).padStart(3, "0")}`,
        backend: "vault",
        secretRef: `vault:secret/ravi/credentials/slack/conn-${i}#token`,
        status: "active",
        label: `Workspace ${i} `.repeat(15),
        purpose: "Posts the daily report to the operations channel",
        owner: "operations team",
      });
    }
    recordCredentialAuditEvent({
      provider: "slack",
      connection: "conn-000",
      action: "chat.postMessage",
      decision: "allow",
      resultStatus: "secret_resolved",
      createdAt: T0 - 1_000,
    });

    const result = await enqueueCredentialInventorySnapshot({ env: ENABLED, now: T0, inventory: { describeSecret } });
    const rows = listPendingOutboxBatch({
      domain: CREDENTIAL_INVENTORY_SYNC_DOMAIN,
      limit: 100,
      maxBytes: 10_000_000,
    }).items;
    expect(result.pages).toBe(rows.length);
    expect(rows.length).toBeGreaterThan(1);

    const pages = rows.map(
      (row) =>
        row.payload as {
          snapshotId: string;
          page: number;
          pages: number;
          total: number;
          items: Array<{ connection: string }>;
          audit: unknown[];
        },
    );
    for (const page of pages) {
      expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(CREDENTIAL_INVENTORY_PAGE_MAX_BYTES);
      expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThan(CONSOLE_MAX_JSON_FIELD_BYTES);
      expect(page.snapshotId).toBe(result.hash!);
      expect(page.pages).toBe(pages.length);
      expect(page.total).toBe(400);
      expect(sanitizeSyncPayload(page)).toEqual(page);
    }
    expect(pages.map((page) => page.page).sort((a, b) => a - b)).toEqual(pages.map((_, index) => index + 1));
    const connections = pages.flatMap((page) => page.items.map((item) => item.connection));
    expect(connections).toHaveLength(400);
    expect(new Set(connections).size).toBe(400);
    expect(pages.find((page) => page.page === 1)?.audit).toHaveLength(1);
    expect(pages.filter((page) => page.page !== 1).every((page) => page.audit.length === 0)).toBe(true);
  });

  it("a small snapshot is a single page 1 of 1", () => {
    const pages = paginateCredentialInventoryPayload(
      {
        schema: "credentials.inventory/v1",
        generatedAt: T0,
        degraded: false,
        degradedReasons: [],
        total: 0,
        items: [],
        audit: [],
      },
      "abc",
    );
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ snapshotId: "abc", page: 1, pages: 1, items: [] });
  });
});

describe("pagination edge cases from the bot review of #971", () => {
  const item = (connection: string, scopes: string[]): CredentialInventorySyncPayload["items"][number] =>
    ({
      provider: "slack",
      connection,
      label: null,
      owner: null,
      purpose: null,
      scopes,
      status: "active",
      storage: null,
    }) as unknown as CredentialInventorySyncPayload["items"][number];
  const base = (items: CredentialInventorySyncPayload["items"], audit: CredentialInventorySyncPayload["audit"]) => ({
    schema: "credentials.inventory/v1" as const,
    generatedAt: T0,
    degraded: false,
    degradedReasons: [],
    total: items.length,
    items,
    audit,
  });
  const auditEntry = (i: number) => ({
    at: T0 - i,
    provider: "slack",
    connection: `conn-${i}`,
    action: "a".repeat(150),
    decision: "allow",
    resultStatus: "secret_resolved",
    errorCode: null,
  });
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

  it("page 1 goes up with the audit alone when the first item fits by itself but not beside the audit", () => {
    const max = 4_000;
    const audit = Array.from({ length: 10 }, (_, i) => auditEntry(i)); // ~2.4 KB
    const big = item(
      "big",
      Array.from({ length: 20 }, (_, i) => `scope-${i}-${"x".repeat(80)}`),
    ); // ~2 KB
    expect(bytes(big)).toBeLessThan(max - bytes(base([], [])) - 200);
    const pages = paginateCredentialInventoryPayload(base([big, item("small", [])], audit), "s", max);
    for (const page of pages) expect(bytes(page)).toBeLessThanOrEqual(max);
    expect(pages[0]).toMatchObject({ page: 1, items: [] });
    expect(pages[0]!.audit).toHaveLength(10);
    expect(pages.flatMap((page) => page.items.map((entry) => entry.connection))).toEqual(["big", "small"]);
  });

  it("an audit too large for a page alone loses its oldest entries and the page stays under the limit", () => {
    const max = 2_000;
    const audit = Array.from({ length: 20 }, (_, i) => auditEntry(i));
    const pages = paginateCredentialInventoryPayload(base([item("a", [])], audit), "s", max);
    for (const page of pages) expect(bytes(page)).toBeLessThanOrEqual(max);
    const kept = pages[0]!.audit;
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(20);
    expect(kept).toEqual(audit.slice(0, kept.length)); // newest first: the tail goes
  });

  it("never cuts a surrogate pair in half (N9)", () => {
    const text = `${"a ".repeat((FREE_TEXT_MAX_CHARS - 2) / 2)}😀😀😀`;
    const guarded = guardFreeText(text)!;
    expect(guarded.length).toBeLessThanOrEqual(FREE_TEXT_MAX_CHARS);
    expect(guarded.endsWith("…")).toBe(true);
    const beforeEllipsis = guarded.charCodeAt(guarded.length - 2);
    expect(beforeEllipsis >= 0xd800 && beforeEllipsis <= 0xdbff).toBe(false);
    expect(guarded).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("bounds identifiers to what the Console schema accepts", async () => {
    const long = `c${"x".repeat(180)}`;
    upsertCredentialConnection({
      provider: "slack",
      connection: long,
      backend: "vault",
      secretRef: "vault:secret/ravi/credentials/slack/long#token",
      status: "active",
    });
    const payload = credentialInventorySyncPayload(await buildCredentialInventory({ now: T0, describeSecret }));
    expect(payload.items[0]!.connection.length).toBeLessThanOrEqual(100);
    expect(payload.items[0]!.secretRefAlias.length).toBeLessThanOrEqual(250);
  });

  it("throws instead of emitting a page over the limit when one item cannot fit by itself", () => {
    const huge = item(
      "huge",
      Array.from({ length: 40 }, (_, i) => `scope-${i}-${"x".repeat(80)}`),
    );
    expect(() => paginateCredentialInventoryPayload(base([huge], []), "s", 1_000)).toThrow(/over 1000/);
  });

  it("caps the scopes of one connection so one item always fits a page", async () => {
    upsertCredentialConnection({
      provider: "google",
      connection: "wide",
      backend: "vault",
      secretRef: "vault:secret/ravi/credentials/google/wide#token",
      status: "active",
      scopes: Array.from({ length: 625 }, (_, i) => `https://www.googleapis.com/auth/resource-${i}-${"r".repeat(50)}`),
    });
    const payload = credentialInventorySyncPayload(await buildCredentialInventory({ now: T0, describeSecret }));
    const scopes = payload.items[0]!.scopes;
    expect(scopes).toHaveLength(SCOPES_MAX_ITEMS + 1);
    expect(scopes.at(-1)).toBe(`+${625 - SCOPES_MAX_ITEMS} more`);
  });

  it("sizes pages after the sync redactor, which lengthens labels like 'Bearer token'", async () => {
    for (let i = 0; i < 400; i += 1) {
      upsertCredentialConnection({
        provider: "slack",
        connection: `conn-${String(i).padStart(3, "0")}`,
        backend: "vault",
        secretRef: `vault:secret/ravi/credentials/slack/conn-${i}#token`,
        status: "active",
        label: "Bearer token for the operations workspace",
      });
    }
    await enqueueCredentialInventorySnapshot({ env: ENABLED, now: T0, inventory: { describeSecret } });
    const rows = listPendingOutboxBatch({
      domain: CREDENTIAL_INVENTORY_SYNC_DOMAIN,
      limit: 100,
      maxBytes: 10_000_000,
    }).items;
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect(bytes(row.payload)).toBeLessThanOrEqual(CREDENTIAL_INVENTORY_PAGE_MAX_BYTES);
    }
    expect((rows[0]!.payload as { items: Array<{ label: string }> }).items[0]!.label).toBe(
      "Bearer [REDACTED] for the operations workspace",
    );
  });

  it("a cursor written by the unpaged format (#970) does not hold back the first paged publication", async () => {
    seed("rbbt");
    const payload = sanitizeSyncPayload(
      credentialInventorySyncPayload(await buildCredentialInventory({ now: T0, describeSecret })),
    );
    const { generatedAt: _generatedAt, ...stable } = payload;
    const legacyHash = createHash("sha256").update(JSON.stringify(stable)).digest("hex").slice(0, 32);
    setSyncCursor(CREDENTIAL_INVENTORY_SYNC_DOMAIN, "inventory", legacyHash, { enqueuedAt: T0 - 60_000 }, T0 - 60_000);
    const result = await enqueueCredentialInventorySnapshot({ env: ENABLED, now: T0, inventory: { describeSecret } });
    expect(result.status).toBe("enqueued");
    expect(result.hash).not.toBe(legacyHash);
  });
});
