import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, linkSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { deleteSecret, readSecret, writeSecret } from "./backends.js";
import { closeCredentialsDb, getCredentialConnection, upsertCredentialConnection } from "./store.js";

let state: string;
const secret = "TEST_ONLY_FILE_SECRET_7f103ff1";
const input = { backend: "file" as const, provider: "example", connection: "secondary", secret };

beforeEach(async () => {
  state = await createIsolatedRaviState("ravi-file-credentials-");
});
afterEach(async () => {
  closeCredentialsDb();
  await cleanupIsolatedRaviState(state);
});

function secretPath(ref: string): string {
  return join(state, "credential-secrets", `${ref.slice("file:".length)}.secret`);
}

describe("protected local credential files", () => {
  it("writes and reads headlessly with 0700/0600 permissions and an opaque ref", async () => {
    const ref = await writeSecret(input);
    expect(ref).toMatch(/^file:[a-f0-9]{64}$/);
    expect(ref).not.toContain(secret);
    expect(ref).not.toContain("secondary");
    expect(statSync(join(state, "credential-secrets")).mode & 0o777).toBe(0o700);
    expect(statSync(secretPath(ref)).mode & 0o777).toBe(0o600);
    expect(readFileSync(secretPath(ref), "utf8")).toBe(secret);
    expect(await readSecret(ref)).toBe(secret);
    expect(readdirSync(join(state, "credential-secrets"))).toEqual([`${ref.slice(5)}.secret`]);
    expect(await deleteSecret(ref)).toBe(true);
    expect(await deleteSecret(ref)).toBe(false);
  });

  it("atomically replaces the same coordinate and preserves whitespace", async () => {
    const ref = await writeSecret(input);
    const replacement = "  TEST_ONLY_SECOND_VALUE\nwith line break  ";
    expect(await writeSecret({ ...input, secret: replacement })).toBe(ref);
    expect(await readSecret(ref)).toBe(replacement);
    expect(readdirSync(join(state, "credential-secrets"))).toHaveLength(1);
  });

  it("refuses a symlinked secret directory and never writes through it", async () => {
    const outside = join(state, "elsewhere");
    mkdirSync(outside, { mode: 0o700 });
    symlinkSync(outside, join(state, "credential-secrets"));
    await expect(writeSecret(input)).rejects.toMatchObject({ code: "secret_unavailable" });
    expect(readdirSync(outside)).toEqual([]);
  });

  it("refuses a writable or readable-to-others secret directory", async () => {
    mkdirSync(join(state, "credential-secrets"), { mode: 0o755 });
    await expect(writeSecret(input)).rejects.toMatchObject({ code: "secret_unavailable" });
  });

  it("refuses loose permissions rather than silently changing them", async () => {
    const ref = await writeSecret(input);
    chmodSync(secretPath(ref), 0o644);
    await expect(readSecret(ref)).rejects.toMatchObject({ code: "secret_unavailable" });
    await expect(writeSecret({ ...input, secret: "TEST_ONLY_REPLACEMENT" })).rejects.toMatchObject({
      code: "secret_unavailable",
    });
    await expect(deleteSecret(ref)).rejects.toMatchObject({ code: "secret_unavailable" });
    expect(readFileSync(secretPath(ref), "utf8")).toBe(secret);
  });

  it("refuses symlinked or hardlinked files for read, write and delete", async () => {
    const ref = await writeSecret(input);
    const linked = join(state, "another-name");
    linkSync(secretPath(ref), linked);
    await expect(readSecret(ref)).rejects.toMatchObject({ code: "secret_unavailable" });
    await expect(deleteSecret(ref)).rejects.toMatchObject({ code: "secret_unavailable" });
    await expect(writeSecret(input)).rejects.toMatchObject({ code: "secret_unavailable" });
    const missing = `file:${"a".repeat(64)}`;
    symlinkSync(linked, secretPath(missing));
    await expect(readSecret(missing)).rejects.toMatchObject({ code: "secret_unavailable" });
    await expect(deleteSecret(missing)).rejects.toMatchObject({ code: "secret_unavailable" });
    expect(readFileSync(linked, "utf8")).toBe(secret);
  });

  it("rejects arbitrary references with fixed non-secret errors", async () => {
    await writeSecret(input);
    for (const ref of ["file:../../outside", "file:/tmp/value", `file:${secret}`, "file:"]) {
      for (const operation of [readSecret, deleteSecret]) {
        const failure = (await operation(ref).catch((error: unknown) => error)) as Error;
        expect(failure.message).toBe("The protected local credential file is unavailable.");
        expect(failure.cause).toBeUndefined();
        expect(JSON.stringify(failure)).not.toContain(secret);
      }
    }
  });

  it("rejects invalid destination, empty/NUL and oversized secrets without artifacts", async () => {
    for (const invalid of [
      { ...input, provider: "../escape" },
      { ...input, connection: "../../escape" },
      { ...input, secret: "" },
      { ...input, secret: "bad\u0000value" },
      { ...input, secret: "s".repeat(65537) },
    ]) {
      await expect(writeSecret(invalid)).rejects.toMatchObject({ code: "secret_unavailable" });
    }
    expect(readdirSync(state)).not.toContain("credential-secrets");
  });
});

describe("file credential schema migration", () => {
  it("preserves connections, scopes and audit when widening the backend constraint", () => {
    const dbPath = join(state, "credentials.db");
    const legacy = new Database(dbPath);
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE credential_connections (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL, connection TEXT NOT NULL, label TEXT,
        backend TEXT NOT NULL CHECK(backend IN ('keychain','vault')), secret_ref TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active','disabled')),
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(provider,connection)
      );
      CREATE TABLE credential_connection_scopes (
        id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES credential_connections(id) ON DELETE CASCADE,
        scope TEXT NOT NULL, UNIQUE(connection_id,scope)
      );
      CREATE TABLE credential_audit_events (
        id TEXT PRIMARY KEY, connection_id TEXT REFERENCES credential_connections(id) ON DELETE SET NULL,
        provider TEXT NOT NULL, connection TEXT NOT NULL, action TEXT NOT NULL, actor_context_id TEXT,
        agent_id TEXT, decision TEXT NOT NULL, approval_required INTEGER NOT NULL, approval_status TEXT,
        result_status TEXT, error_code TEXT, created_at INTEGER NOT NULL
      );
      INSERT INTO credential_connections VALUES ('slack:old','slack','old','Existing','keychain','keychain:ravi/old','active',1,2);
      INSERT INTO credential_connections VALUES ('example:vault','example','vault',NULL,'vault','vault:secret/path#key','disabled',3,4);
      INSERT INTO credential_connection_scopes VALUES ('scope-old','slack:old','chat:write');
      INSERT INTO credential_audit_events VALUES ('audit-old','slack:old','slack','old','read',NULL,NULL,'allow',0,NULL,'ok',NULL,5);
    `);
    legacy.close();

    upsertCredentialConnection(
      { provider: "example", connection: "local", backend: "file", secretRef: `file:${"b".repeat(64)}` },
      { dbPath },
    );
    expect(getCredentialConnection("slack", "old", { dbPath })).toMatchObject({
      backend: "keychain",
      label: "Existing",
      createdAt: 1,
      updatedAt: 2,
      scopes: ["chat:write"],
    });
    expect(getCredentialConnection("example", "vault", { dbPath })).toMatchObject({
      backend: "vault",
      status: "disabled",
      createdAt: 3,
      updatedAt: 4,
    });
    expect(getCredentialConnection("example", "local", { dbPath })?.backend).toBe("file");
    closeCredentialsDb();
    const migrated = new Database(dbPath);
    expect(migrated.prepare("SELECT connection_id FROM credential_audit_events WHERE id = 'audit-old'").get()).toEqual({
      connection_id: "slack:old",
    });
    expect(migrated.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    migrated.close();
    // Re-opening is idempotent and cannot repeat destructive table work.
    expect(getCredentialConnection("slack", "old", { dbPath })?.scopes).toEqual(["chat:write"]);
  });
});
