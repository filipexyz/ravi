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
import type {
  CredentialInventory,
  CredentialInventoryAuditEntry,
  CredentialInventoryItem,
  CredentialSecretDescription,
} from "./types.js";
import { z } from "zod";

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

/**
 * Copy of the Console's `pageSchema` (ravi-console `src/server/console/vault-inventory.ts`, origin/main e6657ecb, 2026-11-25).
 * The Console drops a WHOLE page when any field is over its bound, so the daemon's bounds are checked against what the Console
 * accepts and not against this repo's own constants. Refresh the copy whenever that file changes.
 */
const consoleText = (max: number) => z.string().max(max);
const consoleTimestamp = z.number().int().nonnegative().nullable();
const consolePage = z.object({
  schema: z.literal("credentials.inventory/v1"),
  snapshotId: consoleText(64).min(1),
  page: z.number().int().min(1).max(50),
  pages: z.number().int().min(1).max(50),
  generatedAt: z.number().int().nonnegative(),
  degraded: z.boolean(),
  degradedReasons: z.array(consoleText(40)).max(20),
  total: z.number().int().nonnegative(),
  items: z
    .array(
      z.object({
        id: consoleText(200),
        provider: consoleText(100),
        connection: consoleText(100),
        label: consoleText(200).nullable(),
        backend: consoleText(20),
        secretRefAlias: consoleText(250),
        status: z.enum(["active", "disabled"]),
        scopes: z.array(consoleText(100)).max(100),
        owner: consoleText(200).nullable(),
        purpose: consoleText(200).nullable(),
        createdAt: z.number().int().nonnegative(),
        updatedAt: z.number().int().nonnegative(),
        rotatedAt: consoleTimestamp,
        expiresAt: consoleTimestamp,
        disabledAt: consoleTimestamp,
        lastUsedAt: consoleTimestamp,
        storage: z
          .union([
            z.object({
              available: z.literal(true),
              exists: z.boolean(),
              version: z.number().int().nullable(),
              createdAt: consoleTimestamp,
              updatedAt: consoleTimestamp,
              deleted: z.boolean(),
            }),
            z.object({ available: z.literal(false), reason: consoleText(40) }),
          ])
          .nullable(),
      }),
    )
    .max(500),
  audit: z
    .array(
      z.object({
        at: z.number().int().nonnegative(),
        provider: consoleText(100),
        connection: consoleText(100),
        action: consoleText(200),
        decision: consoleText(200),
        resultStatus: consoleText(200).nullable(),
        errorCode: consoleText(200).nullable(),
      }),
    )
    .max(200),
});

describe("the bounds hold on what the outbox stores (B1 and N1 of the #971 review)", () => {
  /** `n` characters with no token-shaped run: the dots break every run, so only the length rule can act on it. */
  const plain = (n: number) => "ab.".repeat(Math.ceil(n / 3)).slice(0, n);
  /** `n` characters of "Bearer x Bearer x ...": the sync redactor turns each "Bearer x" (8) into "Bearer [REDACTED]" (17). */
  const bearer = (n: number) => "Bearer x ".repeat(Math.ceil(n / 9)).slice(0, n);

  const baseItem: CredentialInventoryItem = {
    id: "slack:rbbt",
    provider: "slack",
    connection: "rbbt",
    label: "Slack",
    backend: "vault",
    secretRefAlias: "vault:slack:rbbt",
    status: "active",
    scopes: ["chat:write"],
    owner: "luis",
    purpose: "posts the daily report",
    createdAt: T0 - 86_400_000,
    updatedAt: T0 - 3_600_000,
    rotatedAt: null,
    expiresAt: null,
    disabledAt: null,
    lastUsedAt: null,
    secret: description,
  };
  const baseAudit: CredentialInventoryAuditEntry = {
    at: T0 - 1_000,
    provider: "slack",
    connection: "rbbt",
    action: "chat.postMessage",
    decision: "allow",
    resultStatus: "secret_resolved",
    errorCode: null,
  };
  const inventoryOf = (
    item: Partial<CredentialInventoryItem> = {},
    audit: Partial<CredentialInventoryAuditEntry> = {},
  ): CredentialInventory => ({
    generatedAt: T0,
    degraded: false,
    degradedReasons: [],
    total: 1,
    items: [{ ...baseItem, ...item }],
    audit: [{ ...baseAudit, ...audit }],
  });

  /** Every page of the snapshot, as the outbox keeps it (it runs the sync redactor again), checked against the Console. */
  function expectConsoleAccepts(inventory: CredentialInventory) {
    const pages = paginateCredentialInventoryPayload(credentialInventorySyncPayload(inventory), "snap");
    expect(pages.length).toBeGreaterThan(0);
    for (const page of pages) {
      const stored = sanitizeSyncPayload(page);
      const result = consolePage.safeParse(stored);
      expect(result.success ? "ok" : result.error.issues.map((issue) => issue.path.join("."))).toBe("ok");
      // Nothing left for the outbox's redactor to change: what was sized and hashed is what is stored.
      expect(stored).toEqual(page);
    }
  }

  it("the schema copy is not vacuous: it takes an ordinary page and refuses a field over its bound", () => {
    const [page] = paginateCredentialInventoryPayload(credentialInventorySyncPayload(inventoryOf()), "snap");
    expect(consolePage.safeParse(page).success).toBe(true);
    expect(
      consolePage.safeParse({ ...page, items: [{ ...page!.items[0], connection: "c".repeat(101) }] }).success,
    ).toBe(false);
    expect(consolePage.safeParse({ ...page, audit: [{ ...page!.audit[0], action: "a".repeat(201) }] }).success).toBe(
      false,
    );
  });

  it("B1: the bounds come after the sync redactor, so a field at its limit that the redactor lengthens stays inside it", () => {
    const purpose =
      `${"Used by the ops team to call the partner API with Bearer auth, rotated monthly. ".repeat(3)}`.slice(0, 200);
    const connection = `svc ${"Bearer x ".repeat(11)}`.slice(0, 100);
    const inventory = inventoryOf(
      { purpose, connection, label: bearer(200), owner: bearer(200), scopes: [bearer(100)] },
      { action: bearer(200), decision: bearer(200), resultStatus: bearer(200), errorCode: bearer(200), connection },
    );
    // The redactor really does lengthen these fields (otherwise this test proves nothing).
    expect(sanitizeSyncPayload({ purpose }).purpose.length).toBeGreaterThan(200);
    expect(sanitizeSyncPayload({ connection }).connection.length).toBeGreaterThan(100);

    const payload = credentialInventorySyncPayload(inventory);
    expect(sanitizeSyncPayload(payload)).toEqual(payload);
    const item = payload.items[0]!;
    expect(item.purpose!.length).toBe(200);
    expect(item.connection.length).toBe(100);
    expect(item.label!.length).toBe(200);
    expect(item.scopes[0]!.length).toBe(100);
    expect(payload.audit[0]!.action.length).toBe(200);
    expect(payload.audit[0]!.errorCode!.length).toBe(200);
    // Redacted, then cut: the secret-shaped words are gone and the field is not just chopped raw.
    expect(item.purpose).toContain("Bearer [REDACTED]");
    expect(item.connection).toContain("Bearer [REDACTED]");
    expect(JSON.stringify(payload)).not.toMatch(/Bearer x/);
    expectConsoleAccepts(inventory);
  });

  it("B1 end to end: text kept in the store that the redactor lengthens still leaves in pages the Console accepts", async () => {
    upsertCredentialConnection({
      provider: "slack",
      connection: "rbbt",
      backend: "vault",
      secretRef: "vault:secret/ravi/credentials/slack/rbbt#token",
      status: "active",
      label: bearer(200),
      owner: bearer(200),
      purpose: "Used by the ops team to call the partner API with Bearer auth, rotated monthly. "
        .repeat(3)
        .slice(0, 200),
      scopes: ["chat:write"],
    });
    recordCredentialAuditEvent({
      provider: "slack",
      connection: "rbbt",
      action: bearer(200),
      decision: "allow",
      resultStatus: bearer(200),
      errorCode: bearer(200),
      createdAt: T0 - 1_000,
    });

    const result = await enqueueCredentialInventorySnapshot({ env: ENABLED, now: T0, inventory: { describeSecret } });
    expect(result.status).toBe("enqueued");
    const rows = outbox();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const parsed = consolePage.safeParse(row.payload);
      expect(parsed.success ? "ok" : parsed.error.issues.map((issue) => issue.path.join("."))).toBe("ok");
      expect(sanitizeSyncPayload(row.payload)).toEqual(row.payload);
    }
    const [page1] = rows.map(
      (row) => row.payload as { items: Array<{ label: string }>; audit: Array<{ action: string }> },
    );
    expect(page1!.items[0]!.label).toContain("Bearer [REDACTED]");
    expect(page1!.audit[0]!.action).toContain("Bearer [REDACTED]");
  });

  // N1: one case per bounded string. The value is 40 over the Console limit, with nothing token-shaped in it, so the length rule is
  // what acts. The cut must land on the limit exactly (a bigger or a smaller cap fails), and a value at the limit goes up as it is.
  const ITEM_LIMITS = [
    ["id", 200],
    ["provider", 100],
    ["connection", 100],
    ["secretRefAlias", 250],
    ["label", 200],
    ["owner", 200],
    ["purpose", 200],
  ] as const;
  for (const [field, limit] of ITEM_LIMITS) {
    it(`item.${field} goes up cut to ${limit}, and as it is at ${limit}`, () => {
      const over = plain(limit + 40);
      const cut = credentialInventorySyncPayload(inventoryOf({ [field]: over })).items[0]![field];
      expect(cut).toBe(`${over.slice(0, limit - 1)}…`);
      const exact = plain(limit);
      expect(credentialInventorySyncPayload(inventoryOf({ [field]: exact })).items[0]![field]).toBe(exact);
      expectConsoleAccepts(inventoryOf({ [field]: over }));
    });
  }

  it("each scope goes up cut to 100, and as it is at 100", () => {
    const over = plain(140);
    expect(credentialInventorySyncPayload(inventoryOf({ scopes: [over] })).items[0]!.scopes).toEqual([
      `${over.slice(0, 99)}…`,
    ]);
    expect(credentialInventorySyncPayload(inventoryOf({ scopes: [plain(100)] })).items[0]!.scopes).toEqual([
      plain(100),
    ]);
    expectConsoleAccepts(inventoryOf({ scopes: [over] }));
  });

  const AUDIT_LIMITS = [
    ["provider", 100],
    ["connection", 100],
    ["action", 200],
    ["decision", 200],
    ["resultStatus", 200],
    ["errorCode", 200],
  ] as const;
  for (const [field, limit] of AUDIT_LIMITS) {
    it(`audit.${field} goes up cut to ${limit}, and as it is at ${limit}`, () => {
      const over = plain(limit + 40);
      const cut = credentialInventorySyncPayload(inventoryOf({}, { [field]: over })).audit[0]![field];
      expect(cut).toBe(`${over.slice(0, limit - 1)}…`);
      const exact = plain(limit);
      expect(credentialInventorySyncPayload(inventoryOf({}, { [field]: exact })).audit[0]![field]).toBe(exact);
      expectConsoleAccepts(inventoryOf({}, { [field]: over }));
    });
  }
});
