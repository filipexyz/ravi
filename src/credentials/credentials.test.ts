import { afterEach, describe, expect, it } from "bun:test";
import { serve } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteSecret, readSecret, redactSecretRef, replaceSecret, writeSecret } from "./backends.js";
import { explainCredentialPolicy, publicCredentialConnection } from "./broker.js";
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
    await replaceSecret(ref, "rotated-provider-secret");
    expect(await readSecret(ref)).toBe("rotated-provider-secret");
    expect(vaultData.get("ravi/credentials/slack/rbbt")).toEqual({
      marker: "keep",
      token: "rotated-provider-secret",
    });
    expect(await deleteSecret(ref)).toBe(true);
    expect(vaultData.get("ravi/credentials/slack/rbbt")).toEqual({ marker: "keep" });
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
