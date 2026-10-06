import { afterEach, describe, expect, it } from "bun:test";
import { serve } from "bun";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteSecret, readSecret, redactSecretRef, writeSecret } from "./backends.js";
import {
  CREDENTIAL_SECRET_ERROR_CODES,
  CredentialAuditWriteError,
  classifySecretReadError,
  explainCredentialPolicy,
  publicCredentialConnection,
  resolveCredentialSecret,
} from "./broker.js";
import {
  closeCredentialsDb,
  getCredentialConnection,
  listCredentialConnections,
  upsertCredentialConnection,
  type CredentialStoreOptions,
} from "./store.js";

let stateDir: string | null = null;
let vaultServer: ReturnType<typeof serve> | null = null;
const originalVaultAddr = process.env.VAULT_ADDR;
const originalVaultToken = process.env.VAULT_TOKEN;

afterEach(() => {
  closeCredentialsDb();
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  stateDir = null;
  vaultServer?.stop(true);
  vaultServer = null;
  restoreVaultEnv();
});

function tempOptions(): CredentialStoreOptions {
  stateDir = mkdtempSync(join(tmpdir(), "ravi-credentials-"));
  return { dbPath: join(stateDir, "credentials.db") };
}

describe("credential broker", () => {
  it("stores only metadata and redacts public connection output", () => {
    const options = tempOptions();
    const record = upsertCredentialConnection(
      {
        provider: "slack",
        connection: "rbbt",
        label: "RBBT Slack",
        backend: "vault",
        secretRef: "vault:secret/ravi/credentials/slack/rbbt#token",
        scopes: ["chat:write"],
        status: "active",
      },
      options,
    );

    const listed = listCredentialConnections({}, options);
    expect(listed.total).toBe(1);
    expect(JSON.stringify(listed)).not.toContain("xoxb");

    const publicRecord = publicCredentialConnection(record);
    expect(publicRecord.secretRef).toBe("vault:secret/ravi/credentials/slack/rbbt#[redacted-key]");
  });

  it("expresses provider credential and action capabilities separately", () => {
    const policy = explainCredentialPolicy({ provider: "slack", connection: "rbbt", action: "messages.send" });
    expect(policy.requiredCapabilities).toEqual(["use:credential:slack:rbbt", "execute:slack:messages.send"]);
    expect(policy.approval.required).toBe(true);
  });

  it("stores scopes in SQLite and reads a provider connection back", () => {
    const options = tempOptions();
    upsertCredentialConnection(
      {
        provider: "slack",
        connection: "main",
        backend: "vault",
        secretRef: "vault:secret/ravi/credentials/slack/main#token",
        scopes: ["chat:write", "app_mentions:read"],
        status: "active",
      },
      options,
    );

    const saved = getCredentialConnection("slack", "main", options);
    expect(saved).toMatchObject({
      provider: "slack",
      connection: "main",
      backend: "vault",
      status: "active",
    });
    expect(saved?.scopes).toEqual(["app_mentions:read", "chat:write"]);
  });

  it("does not redact non-secret keychain coordinates", () => {
    expect(redactSecretRef("keychain:ravi.credentials/slack:rbbt")).toBe("keychain:ravi.credentials/slack:rbbt");
  });

  it("uses Vault KV v2 without overwriting sibling keys", async () => {
    const vaultData = new Map<string, Record<string, unknown>>([["ravi/credentials/slack/rbbt", { marker: "keep" }]]);
    const token = "test-vault-token";
    vaultServer = startVaultKvV2Server(vaultData, token);
    process.env.VAULT_ADDR = `http://127.0.0.1:${vaultServer.port}`;
    process.env.VAULT_TOKEN = token;

    const ref = await writeSecret({
      backend: "vault",
      provider: "slack",
      connection: "rbbt",
      secret: "dummy-provider-secret",
      vaultMount: "secret",
      vaultPath: "ravi/credentials/slack/rbbt",
      vaultKey: "token",
    });

    expect(ref).toBe("vault:secret/ravi/credentials/slack/rbbt#token");
    expect(vaultData.get("ravi/credentials/slack/rbbt")).toEqual({
      marker: "keep",
      token: "dummy-provider-secret",
    });
    expect(await readSecret(ref)).toBe("dummy-provider-secret");
    expect(await deleteSecret(ref)).toBe(true);
    expect(vaultData.get("ravi/credentials/slack/rbbt")).toEqual({ marker: "keep" });
  });
});

describe("credential broker audit ordering", () => {
  const token = "test-vault-token";
  const secretRef = "vault:secret/ravi/credentials/slack/audit#token";

  function seedVaultConnection(options: CredentialStoreOptions): void {
    const vaultData = new Map<string, Record<string, unknown>>([
      ["ravi/credentials/slack/audit", { token: "SENTINEL_BROKER_SECRET" }],
    ]);
    vaultServer = startVaultKvV2Server(vaultData, token);
    process.env.VAULT_ADDR = `http://127.0.0.1:${vaultServer.port}`;
    process.env.VAULT_TOKEN = token;
    upsertCredentialConnection(
      { provider: "slack", connection: "audit", backend: "vault", secretRef, scopes: [], status: "active" },
      options,
    );
  }

  function auditRows(options: CredentialStoreOptions): Array<{ result_status: string; error_code: string | null }> {
    const db = new Database(options.dbPath!, { readonly: true });
    try {
      return db.query("SELECT result_status, error_code FROM credential_audit_events ORDER BY rowid").all() as Array<{
        result_status: string;
        error_code: string | null;
      }>;
    } finally {
      db.close();
    }
  }

  function failAuditInserts(options: CredentialStoreOptions, when: "always" | "resolved"): void {
    const db = new Database(options.dbPath!);
    try {
      const condition = when === "always" ? "" : "WHEN NEW.result_status = 'secret_resolved'";
      db.exec(
        `CREATE TRIGGER fail_audit BEFORE INSERT ON credential_audit_events ${condition}
         BEGIN SELECT RAISE(ABORT, 'audit disk full'); END;`,
      );
    } finally {
      db.close();
    }
  }

  it("records the decision before reading and the result before releasing the secret", async () => {
    const options = tempOptions();
    seedVaultConnection(options);

    const resolved = await resolveCredentialSecret({
      provider: "slack",
      connection: "audit",
      action: "auth.check",
      options,
    });

    expect(resolved.secret).toBe("SENTINEL_BROKER_SECRET");
    expect(auditRows(options)).toEqual([
      { result_status: "secret_requested", error_code: null },
      { result_status: "secret_resolved", error_code: null },
    ]);
  });

  it("fails closed without reading the secret when the decision audit write fails", async () => {
    const options = tempOptions();
    upsertCredentialConnection(
      { provider: "slack", connection: "audit", backend: "vault", secretRef, scopes: [], status: "active" },
      options,
    );
    let vaultRequests = 0;
    vaultServer = serve({
      port: 0,
      fetch: () => {
        vaultRequests += 1;
        return Response.json({ data: { data: { token: "SENTINEL_BROKER_SECRET" } } });
      },
    });
    process.env.VAULT_ADDR = `http://127.0.0.1:${vaultServer.port}`;
    process.env.VAULT_TOKEN = token;
    failAuditInserts(options, "always");

    const error = await resolveCredentialSecret({
      provider: "slack",
      connection: "audit",
      action: "auth.check",
      options,
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CredentialAuditWriteError);
    expect(vaultRequests).toBe(0);
    expect(auditRows(options)).toEqual([]);
  });

  it("does not release the secret when the result audit write fails", async () => {
    const options = tempOptions();
    seedVaultConnection(options);
    failAuditInserts(options, "resolved");

    const error = await resolveCredentialSecret({
      provider: "slack",
      connection: "audit",
      action: "auth.check",
      options,
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(CredentialAuditWriteError);
    expect(JSON.stringify(error)).not.toContain("SENTINEL_BROKER_SECRET");
    expect((error as Error).message).not.toContain("SENTINEL_BROKER_SECRET");
    expect(auditRows(options)).toEqual([{ result_status: "secret_requested", error_code: null }]);
  });

  it("stores a closed error code instead of the raw read error message", async () => {
    const options = tempOptions();
    upsertCredentialConnection(
      { provider: "slack", connection: "audit", backend: "vault", secretRef, scopes: [], status: "active" },
      options,
    );
    vaultServer = serve({
      port: 0,
      fetch: () => Response.json({ errors: ["boom"] }, { status: 500 }),
    });
    process.env.VAULT_ADDR = `http://127.0.0.1:${vaultServer.port}`;
    process.env.VAULT_TOKEN = token;

    await expect(
      resolveCredentialSecret({ provider: "slack", connection: "audit", action: "auth.check", options }),
    ).rejects.toThrow("Vault request failed");

    const rows = auditRows(options);
    expect(rows).toEqual([
      { result_status: "secret_requested", error_code: null },
      { result_status: "failed", error_code: "backend_request_failed" },
    ]);
    expect(JSON.stringify(rows)).not.toContain("ravi/credentials/slack/audit");
  });

  it("maps every backend failure to the closed error-code set", () => {
    const cases: Array<[unknown, string]> = [
      [new Error("Unsupported secret ref: env:[redacted]"), "unsupported_secret_ref"],
      [new Error("Invalid keychain secret ref: keychain:x"), "invalid_secret_ref"],
      [new Error("Invalid vault secret ref: vault:x"), "invalid_secret_ref"],
      [new Error("Vault secret key not found: vault:a/b#[redacted-key]"), "secret_not_found"],
      [new Error("security failed: The specified item could not be found in the keychain."), "secret_not_found"],
      [new Error("VAULT_ADDR and VAULT_TOKEN are required for the vault backend."), "backend_not_configured"],
      [new Error("Vault request failed (403) for secret/ravi/x"), "backend_request_failed"],
      [new Error("security failed: user interaction is not allowed"), "backend_request_failed"],
      [new Error("SENTINEL raw text with token=abc"), "secret_read_failed"],
      ["not an error", "secret_read_failed"],
    ];
    for (const [error, code] of cases) {
      const classified = classifySecretReadError(error);
      expect(classified).toBe(code as (typeof CREDENTIAL_SECRET_ERROR_CODES)[number]);
      expect(CREDENTIAL_SECRET_ERROR_CODES).toContain(classified);
    }
  });
});

function restoreVaultEnv(): void {
  if (originalVaultAddr === undefined) {
    delete process.env.VAULT_ADDR;
  } else {
    process.env.VAULT_ADDR = originalVaultAddr;
  }
  if (originalVaultToken === undefined) {
    delete process.env.VAULT_TOKEN;
  } else {
    process.env.VAULT_TOKEN = originalVaultToken;
  }
}

function startVaultKvV2Server(vaultData: Map<string, Record<string, unknown>>, token: string) {
  return serve({
    port: 0,
    fetch: async (request) => {
      if (request.headers.get("x-vault-token") !== token) {
        return Response.json({ errors: ["forbidden"] }, { status: 403 });
      }

      const url = new URL(request.url);
      const prefix = "/v1/secret/data/";
      if (!url.pathname.startsWith(prefix)) {
        return Response.json({ errors: ["not found"] }, { status: 404 });
      }

      const path = decodeURIComponent(url.pathname.slice(prefix.length));
      if (request.method === "GET") {
        const data = vaultData.get(path);
        if (!data) return Response.json({ errors: ["not found"] }, { status: 404 });
        return Response.json({ data: { data } });
      }

      if (request.method === "POST") {
        const payload = (await request.json()) as { data?: Record<string, unknown> };
        vaultData.set(path, payload.data ?? {});
        return Response.json({ data: { version: 1 } });
      }

      if (request.method === "DELETE") {
        vaultData.delete(path);
        return new Response(null, { status: 204 });
      }

      return Response.json({ errors: ["method not allowed"] }, { status: 405 });
    },
  });
}
