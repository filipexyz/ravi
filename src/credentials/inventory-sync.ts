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
/** The inventory is built (and the Vault asked) at most this often; a change goes up at the next check. */
export const CREDENTIAL_INVENTORY_MIN_INTERVAL_MS = 15 * 60_000;
/** An unchanged inventory still goes up this often, so the Console knows the installation is alive. */
export const CREDENTIAL_INVENTORY_HEARTBEAT_MS = 6 * 60 * 60_000;
const CURSOR_KEY = "inventory";
/** When the inventory was last built (Vault asked), enqueued or not. */
const CHECK_CURSOR_KEY = "inventory.check";

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

/** Longest free text a person-typed field may carry to the Console. */
export const FREE_TEXT_MAX_CHARS = 200;
const SCOPE_MAX_CHARS = 100;
/** Scopes per connection that go up; the rest collapse into one "+N more" entry, so one item always fits a page. */
export const SCOPES_MAX_ITEMS = 50;

/**
 * Token shapes a person might paste into a label, owner or purpose. Matched
 * words are replaced; the field itself still goes up so the Console shows
 * that something was there.
 */
const TOKEN_PATTERNS: RegExp[] = [
  /\b(?:hvs|hvb|hvr|s|b|r)\.[A-Za-z0-9_-]{20,}/g, // Vault / OpenBao tokens
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, // Slack
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bsk-[A-Za-z0-9_-]{12,}/g, // OpenAI-style
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, // JWT
  /\b[A-Za-z0-9+/_-]{40,}={0,2}/g, // any long unbroken key-like run
];

export function guardFreeText(value: string | null, maxChars = FREE_TEXT_MAX_CHARS): string | null {
  if (value === null) return null;
  let text = value;
  for (const pattern of TOKEN_PATTERNS) text = text.replace(pattern, "[redacted]");
  if (text.length <= maxChars) return text;
  // Never cut between the two halves of a surrogate pair (an emoji would leave a lone half).
  let cut = maxChars - 1;
  const last = text.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return `${text.slice(0, cut)}…`;
}

/** Identifiers have no length rule in the store; the Console accepts at most this many characters. */
const IDENTIFIER_MAX_CHARS = 100;

export function credentialInventorySyncPayload(inventory: CredentialInventory): CredentialInventorySyncPayload {
  return {
    schema: CREDENTIAL_INVENTORY_SCHEMA,
    generatedAt: inventory.generatedAt,
    degraded: inventory.degraded,
    degradedReasons: inventory.degradedReasons,
    total: inventory.total,
    items: inventory.items.map(({ secret, ...item }) => ({
      ...item,
      // Bounded to the Console schema, which drops a whole page over any field limit.
      provider: guardFreeText(item.provider, IDENTIFIER_MAX_CHARS) ?? "",
      connection: guardFreeText(item.connection, IDENTIFIER_MAX_CHARS) ?? "",
      secretRefAlias: guardFreeText(item.secretRefAlias, 250) ?? "",
      // Free text typed by people: capped, and token-shaped values never leave.
      label: guardFreeText(item.label),
      owner: guardFreeText(item.owner),
      purpose: guardFreeText(item.purpose),
      scopes: capScopes(item.scopes),
      storage: secret,
    })),
    // Audit strings are system values, but nothing bounds their length: capped like free text.
    audit: inventory.audit.map((entry) => ({
      ...entry,
      provider: guardFreeText(entry.provider, IDENTIFIER_MAX_CHARS) ?? "",
      connection: guardFreeText(entry.connection, IDENTIFIER_MAX_CHARS) ?? "",
      action: guardFreeText(entry.action) ?? "",
      decision: guardFreeText(entry.decision) ?? "",
      resultStatus: guardFreeText(entry.resultStatus),
      errorCode: guardFreeText(entry.errorCode),
    })),
  };
}

function capScopes(scopes: string[]): string[] {
  const kept = scopes.slice(0, SCOPES_MAX_ITEMS).map((scope) => guardFreeText(scope, SCOPE_MAX_CHARS) ?? "");
  const rest = scopes.length - kept.length;
  return rest > 0 ? [...kept, `+${rest} more`] : kept;
}

export interface EnqueueCredentialInventoryResult {
  status: "disabled" | "unchanged" | "throttled" | "enqueued";
  hash: string | null;
  outboxId: string | null;
  outboxIds?: string[];
  pages?: number;
}

/**
 * The Console rejects a sync payload over 64 KiB (`MAX_JSON_FIELD_BYTES`, 413).
 * Each page stays under this, with room for the envelope.
 */
export const CREDENTIAL_INVENTORY_PAGE_MAX_BYTES = 48 * 1024;

/** One page of a snapshot: the Console shows a snapshot only when it has all `pages` of the same `snapshotId`. */
export interface CredentialInventorySyncPage extends CredentialInventorySyncPayload {
  snapshotId: string;
  page: number;
  pages: number;
}

/**
 * Split a snapshot into pages of at most CREDENTIAL_INVENTORY_PAGE_MAX_BYTES
 * (UTF-8 JSON). Page 1 carries the audit; every page repeats the header.
 * Page 1 may hold only the audit when its first item does not fit beside it.
 * An audit too large for a page alone loses its oldest entries (the list is
 * newest first). Every page is measured at the end; one over the limit throws.
 */
export function paginateCredentialInventoryPayload(
  payload: CredentialInventorySyncPayload,
  snapshotId: string,
  maxBytes = CREDENTIAL_INVENTORY_PAGE_MAX_BYTES,
): CredentialInventorySyncPage[] {
  const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
  const audit = [...payload.audit];
  const build = (items: CredentialInventorySyncPayload["items"], page: number): CredentialInventorySyncPage => ({
    ...payload,
    items,
    audit: page === 1 ? audit : [],
    snapshotId,
    page,
    pages: 0,
  });
  // Conservative header: the page-1 audit and the widest page numbers.
  const headerSize = () => size({ ...build([], 1), page: 99_999, pages: 99_999 });
  while (audit.length > 0 && headerSize() > maxBytes) audit.pop();
  const header = headerSize();
  const groups: CredentialInventorySyncPayload["items"][] = [];
  let current: CredentialInventorySyncPayload["items"] = [];
  let bytes = header;
  for (const item of payload.items) {
    const itemBytes = size(item) + 1; // + the separating comma
    // No exception for an empty page: page 1 then goes up with the audit alone.
    if (bytes + itemBytes > maxBytes && (current.length > 0 || groups.length === 0)) {
      groups.push(current);
      current = [];
      bytes = header;
    }
    current.push(item);
    bytes += itemBytes;
  }
  groups.push(current);
  const pages = groups.map((items, index) => ({ ...build(items, index + 1), pages: groups.length }));
  for (const page of pages) {
    const bytes = size(page);
    if (bytes > maxBytes) {
      throw new Error(`credential inventory page ${page.page}/${page.pages} is ${bytes} bytes, over ${maxBytes}`);
    }
  }
  return pages;
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
  // The Vault is asked at most once per interval: the throttle runs BEFORE the inventory is built.
  const lastCheck = getSyncCursor(CREDENTIAL_INVENTORY_SYNC_DOMAIN, CHECK_CURSOR_KEY);
  if (!input.force && lastCheck && now - lastCheck.updatedAt < CREDENTIAL_INVENTORY_MIN_INTERVAL_MS) {
    return { status: "throttled", hash: null, outboxId: null };
  }
  setSyncCursor(CREDENTIAL_INVENTORY_SYNC_DOMAIN, CHECK_CURSOR_KEY, now, undefined, now);
  // Sized and hashed as the outbox will store it: the sync redactor can lengthen text ("Bearer x" -> "Bearer [REDACTED]").
  const payload = sanitizeSyncPayload(
    credentialInventorySyncPayload(await buildCredentialInventory({ ...input.inventory, now })),
  );
  const hash = contentHash(payload);
  const previous = getSyncCursor(CREDENTIAL_INVENTORY_SYNC_DOMAIN, CURSOR_KEY);
  const lastEnqueue = previous?.updatedAt ?? 0;
  if (!input.force && previous?.cursorValue === hash && now - lastEnqueue < CREDENTIAL_INVENTORY_HEARTBEAT_MS) {
    return { status: "unchanged", hash, outboxId: null };
  }
  const pages = paginateCredentialInventoryPayload(payload, hash);
  const outboxIds: string[] = [];
  for (const page of pages) {
    const outbox = enqueueSyncEvent({
      domain: CREDENTIAL_INVENTORY_SYNC_DOMAIN,
      eventType: CREDENTIAL_INVENTORY_EVENT_TYPE,
      entityType: "credential_inventory",
      entityId: "installation",
      idempotencyKey: `credentials.inventory:${hash}:${now}:${page.page}/${page.pages}`,
      payload: page,
      schemaVersion: 1,
      occurredAt: now,
      now,
    });
    if (outbox) outboxIds.push(outbox.id);
  }
  setSyncCursor(CREDENTIAL_INVENTORY_SYNC_DOMAIN, CURSOR_KEY, hash, { enqueuedAt: now }, now);
  return { status: "enqueued", hash, outboxId: outboxIds[0] ?? null, outboxIds, pages: pages.length };
}

/**
 * Wire format in the hash: a cursor written by an older format (the unpaged
 * #970 payload) never matches, so the first check after an upgrade publishes
 * the pages instead of waiting for the heartbeat.
 */
const CREDENTIAL_INVENTORY_WIRE_FORMAT = "paged/v1";

/** Hash of what the Console would show, without the snapshot time. */
function contentHash(payload: CredentialInventorySyncPayload): string {
  const { generatedAt: _generatedAt, ...stable } = payload;
  return createHash("sha256")
    .update(JSON.stringify({ format: CREDENTIAL_INVENTORY_WIRE_FORMAT, ...sanitizeSyncPayload(stable) }))
    .digest("hex")
    .slice(0, 32);
}
