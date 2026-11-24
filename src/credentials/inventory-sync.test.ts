import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { listPendingOutboxBatch } from "../sync/db.js";
import { sanitizeSyncPayload } from "../sync/redaction.js";
import {
  CREDENTIAL_INVENTORY_HEARTBEAT_MS,
  CREDENTIAL_INVENTORY_MIN_INTERVAL_MS,
  CREDENTIAL_INVENTORY_SYNC_DOMAIN,
  credentialInventorySyncPayload,
  enqueueCredentialInventorySnapshot,
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

  it("skips an unchanged inventory until the heartbeat, throttles changes, and force always sends", async () => {
    seed();
    const run = (now: number, force = false) =>
      enqueueCredentialInventorySnapshot({ env: ENABLED, now, force, inventory: { describeSecret } });

    expect((await run(T0)).status).toBe("enqueued");
    expect((await run(T0 + 60_000)).status).toBe("unchanged");
    expect((await run(T0 + CREDENTIAL_INVENTORY_HEARTBEAT_MS - 1)).status).toBe("unchanged");
    expect((await run(T0 + CREDENTIAL_INVENTORY_HEARTBEAT_MS)).status).toBe("enqueued");
    const afterHeartbeat = T0 + CREDENTIAL_INVENTORY_HEARTBEAT_MS;

    seed("sales");
    expect((await run(afterHeartbeat + 60_000)).status).toBe("throttled");
    expect((await run(afterHeartbeat + CREDENTIAL_INVENTORY_MIN_INTERVAL_MS)).status).toBe("enqueued");

    expect((await run(afterHeartbeat + CREDENTIAL_INVENTORY_MIN_INTERVAL_MS + 1, true)).status).toBe("enqueued");
    expect(outbox()).toHaveLength(4);
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
