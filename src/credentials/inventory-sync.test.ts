import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { listPendingOutboxBatch } from "../sync/db.js";
import { sanitizeSyncPayload } from "../sync/redaction.js";
import {
  CREDENTIAL_INVENTORY_HEARTBEAT_MS,
  CREDENTIAL_INVENTORY_PAGE_MAX_BYTES,
  CREDENTIAL_INVENTORY_MIN_INTERVAL_MS,
  CREDENTIAL_INVENTORY_SYNC_DOMAIN,
  FREE_TEXT_MAX_CHARS,
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
