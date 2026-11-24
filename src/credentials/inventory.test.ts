import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeSecret } from "./backends.js";
import { buildCredentialInventory } from "./inventory.js";
import {
  closeCredentialsDb,
  getCredentialConnection,
  recordCredentialAuditEvent,
  setCredentialConnectionStatus,
  upsertCredentialConnection,
  type CredentialStoreOptions,
} from "./store.js";

const SECRET_VALUE = "xoxb-inventory-must-never-carry-this";
const VAULT_ENV = { VAULT_ADDR: "https://bao.test:8200", VAULT_TOKEN: "hvs.test-token" } as NodeJS.ProcessEnv;

let stateDir: string | null = null;

afterEach(() => {
  closeCredentialsDb();
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  stateDir = null;
});

function tempOptions(): CredentialStoreOptions {
  stateDir = mkdtempSync(join(tmpdir(), "ravi-credentials-inventory-"));
  return { dbPath: join(stateDir, "credentials.db") };
}

function vaultConnection(options: CredentialStoreOptions, connection = "rbbt", extra: Record<string, unknown> = {}) {
  return upsertCredentialConnection(
    {
      provider: "slack",
      connection,
      backend: "vault",
      secretRef: `vault:secret/ravi/credentials/slack/${connection}#token`,
      scopes: ["chat:write"],
      status: "active",
      ...extra,
    },
    options,
  );
}

type FakeCall = { url: string; method: string; body: unknown };

function fakeVault(respond: (url: string) => Response | Promise<Response>) {
  const calls: FakeCall[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", body: init?.body });
    return respond(url);
  }) as typeof fetch;
  return { calls, fetchFn };
}

const metadataPayload = {
  data: {
    created_time: "2026-11-01T10:00:00Z",
    updated_time: "2026-11-20T12:30:00Z",
    current_version: 3,
    versions: {
      "2": { created_time: "2026-11-10T00:00:00Z", deletion_time: "", destroyed: false },
      "3": { created_time: "2026-11-20T12:30:00Z", deletion_time: "", destroyed: false },
    },
  },
};

describe("credential lifecycle metadata", () => {
  it("keeps lifecycle fields across updates, clears them with null, and tracks disable time", () => {
    const options = tempOptions();
    vaultConnection(options, "rbbt", { owner: "luis", purpose: "bot token", expiresAt: 1_900_000_000_000 });

    // An update that does not mention lifecycle keeps it.
    vaultConnection(options, "rbbt", { label: "renamed" });
    let record = getCredentialConnection("slack", "rbbt", options);
    expect(record?.owner).toBe("luis");
    expect(record?.purpose).toBe("bot token");
    expect(record?.expiresAt).toBe(1_900_000_000_000);
    expect(record?.rotatedAt).toBeNull();

    vaultConnection(options, "rbbt", { rotatedAt: 1_800_000_000_000, purpose: null });
    record = getCredentialConnection("slack", "rbbt", options);
    expect(record?.rotatedAt).toBe(1_800_000_000_000);
    expect(record?.purpose).toBeNull();

    expect(record?.disabledAt).toBeNull();
    const disabled = setCredentialConnectionStatus("slack", "rbbt", "disabled", options);
    expect(disabled?.disabledAt).toBeNumber();
    const firstDisable = disabled?.disabledAt;
    // Re-disabling keeps the first time; an upsert that stays disabled keeps it too.
    expect(setCredentialConnectionStatus("slack", "rbbt", "disabled", options)?.disabledAt).toBe(firstDisable!);
    vaultConnection(options, "rbbt", { status: "disabled" });
    expect(getCredentialConnection("slack", "rbbt", options)?.disabledAt).toBe(firstDisable!);
    expect(setCredentialConnectionStatus("slack", "rbbt", "active", options)?.disabledAt).toBeNull();
  });

  it("adds the lifecycle columns to a database created before them, keeping the rows", () => {
    const options = tempOptions();
    const legacy = new Database(options.dbPath!, { create: true });
    legacy.exec(`
      CREATE TABLE credential_connections (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL, connection TEXT NOT NULL, label TEXT,
        backend TEXT NOT NULL CHECK(backend IN ('file', 'keychain', 'vault')),
        secret_ref TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active', 'disabled')),
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(provider, connection)
      );
      INSERT INTO credential_connections VALUES
        ('slack:old', 'slack', 'old', NULL, 'vault', 'vault:secret/ravi/credentials/slack/old#token', 'active', 1, 2);
    `);
    legacy.close();

    const record = getCredentialConnection("slack", "old", options);
    expect(record).toMatchObject({
      id: "slack:old",
      createdAt: 1,
      updatedAt: 2,
      owner: null,
      purpose: null,
      rotatedAt: null,
      expiresAt: null,
      disabledAt: null,
    });
  });
});

describe("describeSecret", () => {
  it("reads the KV v2 metadata endpoint with GET and never the data endpoint", async () => {
    const vault = fakeVault(() => Response.json(metadataPayload));
    const description = await describeSecret("vault:secret/ravi/credentials/slack/rbbt#token", {
      fetch: vault.fetchFn,
      env: VAULT_ENV,
    });
    expect(description).toEqual({
      available: true,
      exists: true,
      version: 3,
      createdAt: Date.parse("2026-11-01T10:00:00Z"),
      updatedAt: Date.parse("2026-11-20T12:30:00Z"),
      deleted: false,
    });
    expect(vault.calls).toHaveLength(1);
    expect(vault.calls[0]).toMatchObject({
      url: "https://bao.test:8200/v1/secret/metadata/ravi/credentials/slack/rbbt",
      method: "GET",
      body: undefined,
    });
  });

  it("reports a deleted or destroyed current version", async () => {
    const payload = structuredClone(metadataPayload);
    payload.data.versions["3"].deletion_time = "2026-11-21T00:00:00Z";
    const vault = fakeVault(() => Response.json(payload));
    const description = await describeSecret("vault:secret/a/b#token", { fetch: vault.fetchFn, env: VAULT_ENV });
    expect(description).toMatchObject({ available: true, deleted: true });
  });

  it("degrades with a fixed reason instead of throwing or reading the value", async () => {
    const cases: Array<[Response | Error, unknown]> = [
      [new Response("{}", { status: 404 }), { available: true, exists: false }],
      [new Response("{}", { status: 403 }), { available: false, reason: "forbidden" }],
      [new Response("{}", { status: 503 }), { available: false, reason: "sealed" }],
      [new Response("{}", { status: 500 }), { available: false, reason: "error" }],
      [new Error("ECONNREFUSED"), { available: false, reason: "unreachable" }],
    ];
    for (const [outcome, expected] of cases) {
      const vault = fakeVault(() => {
        if (outcome instanceof Error) throw outcome;
        return outcome;
      });
      const description = await describeSecret("vault:secret/a/b#token", { fetch: vault.fetchFn, env: VAULT_ENV });
      expect(description).toMatchObject(expected as Record<string, unknown>);
      expect(vault.calls.every((call) => call.url.includes("/metadata/") && call.method === "GET")).toBe(true);
    }
  });

  it("does not call out without Vault configuration or for non-Vault backends", async () => {
    const vault = fakeVault(() => Response.json(metadataPayload));
    expect(await describeSecret("vault:secret/a/b#token", { fetch: vault.fetchFn, env: {} })).toEqual({
      available: false,
      reason: "not_configured",
    });
    expect(
      await describeSecret("keychain:ravi.credentials/slack:rbbt", { fetch: vault.fetchFn, env: VAULT_ENV }),
    ).toEqual({
      available: false,
      reason: "unsupported",
    });
    expect(await describeSecret("vault:no-hash", { fetch: vault.fetchFn, env: VAULT_ENV })).toEqual({
      available: false,
      reason: "invalid_ref",
    });
    expect(vault.calls).toHaveLength(0);
  });
});

describe("buildCredentialInventory", () => {
  it("is a metadata-only snapshot: no secret value, no Vault path, no key, no data read", async () => {
    const options = tempOptions();
    vaultConnection(options, "rbbt", { owner: "luis" });
    vaultConnection(options, "sales");
    setCredentialConnectionStatus("slack", "sales", "disabled", options);
    // A vault that would hand out the value if anyone asked the data endpoint.
    const vault = fakeVault((url) =>
      url.includes("/data/")
        ? Response.json({ data: { data: { token: SECRET_VALUE } } })
        : Response.json(metadataPayload),
    );

    const inventory = await buildCredentialInventory({
      options,
      describeSecret: (ref) => describeSecret(ref, { fetch: vault.fetchFn, env: VAULT_ENV }),
    });

    expect(vault.calls.some((call) => call.url.includes("/data/"))).toBe(false);
    const serialized = JSON.stringify(inventory);
    expect(serialized).not.toContain(SECRET_VALUE);
    expect(serialized).not.toContain("ravi/credentials");
    expect(serialized).not.toContain("#token");
    expect(serialized).not.toContain(VAULT_ENV.VAULT_TOKEN!);
    expect(inventory.total).toBe(2);
    expect(inventory.items.map((item) => [item.connection, item.status, item.secretRefAlias])).toEqual([
      ["rbbt", "active", "vault:slack:rbbt"],
      ["sales", "disabled", "vault:slack:sales"],
    ]);
    expect(inventory.items[0]).toMatchObject({ owner: "luis", secret: { available: true, version: 3 } });
    expect(inventory.items[1]?.disabledAt).toBeNumber();
    expect(inventory.degraded).toBe(false);
  });

  it("derives last use from resolved secrets only and lists recent audit without actor ids", async () => {
    const options = tempOptions();
    vaultConnection(options, "rbbt");
    recordCredentialAuditEvent(
      {
        provider: "slack",
        connection: "rbbt",
        action: "chat.postMessage",
        decision: "allow",
        resultStatus: "secret_resolved",
        actorContextId: "rctx_secret_ctx",
        createdAt: 1_000,
      },
      options,
    );
    recordCredentialAuditEvent(
      {
        provider: "slack",
        connection: "rbbt",
        action: "chat.postMessage",
        decision: "deny",
        resultStatus: "failed",
        errorCode: "authorization_denied",
        createdAt: 2_000,
      },
      options,
    );

    const inventory = await buildCredentialInventory({ options, describe: false, auditLimit: 5 });
    expect(inventory.items[0]?.lastUsedAt).toBe(1_000);
    expect(inventory.items[0]?.secret).toBeNull();
    expect(inventory.audit.map((entry) => [entry.at, entry.resultStatus])).toEqual([
      [2_000, "failed"],
      [1_000, "secret_resolved"],
    ]);
    expect(JSON.stringify(inventory)).not.toContain("rctx_secret_ctx");
  });

  it("stays usable and says it is degraded when the backend refuses metadata", async () => {
    const options = tempOptions();
    vaultConnection(options, "rbbt");
    upsertCredentialConnection(
      { provider: "github", connection: "ci", backend: "file", secretRef: "file:github/ci", status: "active" },
      options,
    );
    const vault = fakeVault(() => new Response("{}", { status: 403 }));

    const inventory = await buildCredentialInventory({
      options,
      describeSecret: (ref) => describeSecret(ref, { fetch: vault.fetchFn, env: VAULT_ENV }),
    });

    expect(inventory.total).toBe(2);
    expect(inventory.degraded).toBe(true);
    // A backend without metadata (file) is not a degradation; a refused Vault is.
    expect(inventory.degradedReasons).toEqual(["forbidden"]);
    const byConnection = Object.fromEntries(inventory.items.map((item) => [item.connection, item.secret]));
    expect(byConnection.rbbt).toEqual({ available: false, reason: "forbidden" });
    expect(byConnection.ci).toEqual({ available: false, reason: "unsupported" });
  });

  it("degrades an item whose describer throws instead of failing the snapshot", async () => {
    const options = tempOptions();
    vaultConnection(options, "rbbt");
    const inventory = await buildCredentialInventory({
      options,
      describeSecret: async () => {
        throw new Error(`boom ${SECRET_VALUE}`);
      },
    });
    expect(inventory.items[0]?.secret).toEqual({ available: false, reason: "error" });
    expect(JSON.stringify(inventory)).not.toContain(SECRET_VALUE);
  });
});
