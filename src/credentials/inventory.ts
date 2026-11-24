import { describeSecret } from "./backends.js";
import {
  listCredentialConnections,
  listCredentialLastUsedAt,
  listRecentCredentialAuditEvents,
  type CredentialStoreOptions,
} from "./store.js";
import type {
  CredentialConnectionRecord,
  CredentialInventory,
  CredentialInventoryItem,
  CredentialSecretDescription,
  CredentialSecretUnavailableReason,
} from "./types.js";

/** Hard cap: the inventory is a bounded snapshot, not a paginated listing. */
export const CREDENTIAL_INVENTORY_MAX_ITEMS = 500;
const DESCRIBE_CONCURRENCY = 4;

export interface BuildCredentialInventoryInput {
  /** Ask each backend for metadata (versions, times). Never reads a value. Default true. */
  describe?: boolean;
  /** Recent audit rows to include, 0..200. Default 20. */
  auditLimit?: number;
  now?: number;
  options?: CredentialStoreOptions;
  /** Injected in tests; defaults to the backend describer. */
  describeSecret?: (secretRef: string) => Promise<CredentialSecretDescription>;
}

/**
 * Metadata-only snapshot of every credential connection (active and
 * disabled). It is the payload the Console shows; it MUST NOT carry secret
 * values, backend paths or keys. Backend refusals degrade the item instead of
 * failing the snapshot.
 */
export async function buildCredentialInventory(
  input: BuildCredentialInventoryInput = {},
): Promise<CredentialInventory> {
  const page = listCredentialConnections(
    { includeDisabled: true, limit: CREDENTIAL_INVENTORY_MAX_ITEMS, offset: 0 },
    input.options,
  );
  const lastUsed = listCredentialLastUsedAt(input.options);
  const describe = input.describe === false ? null : (input.describeSecret ?? ((ref: string) => describeSecret(ref)));
  const descriptions = describe
    ? await mapLimited(page.items, DESCRIBE_CONCURRENCY, (record) =>
        describe(record.secretRef).catch(
          // no-cause: A backend error can echo the secret ref or a token; the snapshot keeps only the fixed reason.
          (): CredentialSecretDescription => ({ available: false, reason: "error" }),
        ),
      )
    : null;

  const reasons = new Set<CredentialSecretUnavailableReason>();
  const items = page.items.map((record, index): CredentialInventoryItem => {
    const secret = descriptions ? (descriptions[index] ?? null) : null;
    if (secret && !secret.available && secret.reason !== "unsupported") reasons.add(secret.reason);
    return inventoryItem(record, lastUsed.get(`${record.provider}:${record.connection}`) ?? null, secret);
  });

  return {
    generatedAt: input.now ?? Date.now(),
    degraded: reasons.size > 0,
    degradedReasons: Array.from(reasons).sort(),
    total: page.total,
    items,
    audit: listRecentCredentialAuditEvents(input.auditLimit ?? 20, input.options).map((event) => ({
      at: event.createdAt,
      provider: event.provider,
      connection: event.connection,
      action: event.action,
      decision: event.decision,
      resultStatus: event.resultStatus,
      errorCode: event.errorCode,
    })),
  };
}

/** Alias that names the connection, not the backend coordinate (no Vault path, no key). */
export function credentialSecretRefAlias(
  record: Pick<CredentialConnectionRecord, "backend" | "provider" | "connection">,
): string {
  return `${record.backend}:${record.provider}:${record.connection}`;
}

function inventoryItem(
  record: CredentialConnectionRecord,
  lastUsedAt: number | null,
  secret: CredentialSecretDescription | null,
): CredentialInventoryItem {
  return {
    id: record.id,
    provider: record.provider,
    connection: record.connection,
    label: record.label,
    backend: record.backend,
    secretRefAlias: credentialSecretRefAlias(record),
    status: record.status,
    scopes: record.scopes,
    owner: record.owner,
    purpose: record.purpose,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    rotatedAt: record.rotatedAt,
    expiresAt: record.expiresAt,
    disabledAt: record.disabledAt,
    lastUsedAt,
    secret,
  };
}

async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}
