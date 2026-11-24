import { createHash } from "node:crypto";
import { enqueueSyncEvent, getSyncCursor, setSyncCursor } from "../sync/db.js";
import { sanitizeSyncPayload } from "../sync/redaction.js";
import { buildCredentialInventory, type BuildCredentialInventoryInput } from "./inventory.js";
import type { CredentialInventory, CredentialInventoryItem } from "./types.js";

/** Opt-in: sending credential metadata to the Console is a new egress. */
export const CREDENTIAL_INVENTORY_SYNC_ENV = "RAVI_SYNC_CREDENTIALS_INVENTORY";
export const CREDENTIAL_INVENTORY_SYNC_DOMAIN = "credentials";
export const CREDENTIAL_INVENTORY_EVENT_TYPE = "credentials.inventory";
export const CREDENTIAL_INVENTORY_SCHEMA = "credentials.inventory/v1";
/** A changed inventory goes up at most this often. */
export const CREDENTIAL_INVENTORY_MIN_INTERVAL_MS = 15 * 60_000;
/** An unchanged inventory still goes up this often, so the Console knows the installation is alive. */
export const CREDENTIAL_INVENTORY_HEARTBEAT_MS = 6 * 60 * 60_000;
const CURSOR_KEY = "inventory";

export function isCredentialInventorySyncEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[CREDENTIAL_INVENTORY_SYNC_ENV] === "1";
}

/**
 * The Console payload. `secret` becomes `storage`: the sync redactor blanks any
 * key that ends in "secret", and this field never holds one (it is the
 * backend's version/time description).
 */
export interface CredentialInventorySyncPayload {
  schema: typeof CREDENTIAL_INVENTORY_SCHEMA;
  generatedAt: number;
  degraded: boolean;
  degradedReasons: CredentialInventory["degradedReasons"];
  total: number;
  items: Array<Omit<CredentialInventoryItem, "secret"> & { storage: CredentialInventoryItem["secret"] }>;
  audit: CredentialInventory["audit"];
}

export function credentialInventorySyncPayload(inventory: CredentialInventory): CredentialInventorySyncPayload {
  return {
    schema: CREDENTIAL_INVENTORY_SCHEMA,
    generatedAt: inventory.generatedAt,
    degraded: inventory.degraded,
    degradedReasons: inventory.degradedReasons,
    total: inventory.total,
    items: inventory.items.map(({ secret, ...item }) => ({ ...item, storage: secret })),
    audit: inventory.audit,
  };
}

export interface EnqueueCredentialInventoryResult {
  status: "disabled" | "unchanged" | "throttled" | "enqueued";
  hash: string | null;
  outboxId: string | null;
}

/**
 * Snapshot the inventory into the sync outbox when it changed (at most every
 * 15 min) or as a 6 h heartbeat. Opt-in by `RAVI_SYNC_CREDENTIALS_INVENTORY=1`
 * unless `force`. The payload is metadata only and passes the sync redactor
 * unchanged.
 */
export async function enqueueCredentialInventorySnapshot(
  input: {
    now?: number;
    force?: boolean;
    env?: Record<string, string | undefined>;
    inventory?: Omit<BuildCredentialInventoryInput, "now">;
  } = {},
): Promise<EnqueueCredentialInventoryResult> {
  if (!input.force && !isCredentialInventorySyncEnabled(input.env)) {
    return { status: "disabled", hash: null, outboxId: null };
  }
  const now = input.now ?? Date.now();
  const payload = credentialInventorySyncPayload(await buildCredentialInventory({ ...input.inventory, now }));
  const hash = contentHash(payload);
  const previous = getSyncCursor(CREDENTIAL_INVENTORY_SYNC_DOMAIN, CURSOR_KEY);
  const lastAt = previous?.updatedAt ?? 0;
  const age = now - lastAt;
  if (!input.force && previous?.cursorValue === hash && age < CREDENTIAL_INVENTORY_HEARTBEAT_MS) {
    return { status: "unchanged", hash, outboxId: null };
  }
  if (!input.force && previous && previous.cursorValue !== hash && age < CREDENTIAL_INVENTORY_MIN_INTERVAL_MS) {
    return { status: "throttled", hash, outboxId: null };
  }
  const outbox = enqueueSyncEvent({
    domain: CREDENTIAL_INVENTORY_SYNC_DOMAIN,
    eventType: CREDENTIAL_INVENTORY_EVENT_TYPE,
    entityType: "credential_inventory",
    entityId: "installation",
    idempotencyKey: `credentials.inventory:${hash}:${now}`,
    payload,
    schemaVersion: 1,
    occurredAt: now,
    now,
  });
  setSyncCursor(CREDENTIAL_INVENTORY_SYNC_DOMAIN, CURSOR_KEY, hash, { enqueuedAt: now }, now);
  return { status: "enqueued", hash, outboxId: outbox?.id ?? null };
}

/** Hash of what the Console would show, without the snapshot time. */
function contentHash(payload: CredentialInventorySyncPayload): string {
  const { generatedAt: _generatedAt, ...stable } = payload;
  return createHash("sha256")
    .update(JSON.stringify(sanitizeSyncPayload(stable)))
    .digest("hex")
    .slice(0, 32);
}
