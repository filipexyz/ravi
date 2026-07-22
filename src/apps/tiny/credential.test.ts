import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeCredentialsDb, upsertCredentialConnection } from "../../credentials/index.js";
import type { CredentialCallerContext } from "../../credentials/types.js";
import type { TinyTenantConfig } from "./config.js";
import { resolveTinyReadCredential } from "./credential.js";

let stateDir: string | null = null;

afterEach(() => {
  closeCredentialsDb();
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  stateDir = null;
});

describe("Tiny credential broker binding", () => {
  test("binds the selected Tiny read operation and tenant before backend access", async () => {
    const dbPath = createConnection();
    let backendReads = 0;
    const context = caller("contatos.read");

    const result = await resolveTinyReadCredential(
      config(),
      "contatos",
      { dbPath },
      {
        getCallerContext: () => context,
        readSecret: async () => {
          backendReads += 1;
          return "dummy-tiny-secret";
        },
      },
    );

    expect(result.status.connection).toBe("acme-primary");
    expect(backendReads).toBe(1);
  });

  test("does not let an info grant authorize another Tiny read operation", async () => {
    const dbPath = createConnection();
    let backendReads = 0;

    await expect(
      resolveTinyReadCredential(
        config(),
        "contatos",
        { dbPath },
        {
          getCallerContext: () => caller("info.read"),
          readSecret: async () => {
            backendReads += 1;
            return "dummy-tiny-secret";
          },
        },
      ),
    ).rejects.toThrow("missing_action_capability");
    expect(backendReads).toBe(0);
  });
});

function createConnection(): string {
  stateDir = mkdtempSync(join(tmpdir(), "ravi-tiny-credential-auth-"));
  const dbPath = join(stateDir, "credentials.db");
  upsertCredentialConnection(
    {
      provider: "tiny",
      connection: "acme-primary",
      backend: "keychain",
      secretRef: "keychain:ravi.credentials/tiny/acme-primary",
      scopes: ["tenant:acme"],
      status: "active",
    },
    { dbPath },
  );
  return dbPath;
}

function config(): TinyTenantConfig {
  return {
    tenant: "acme",
    apiVersion: "v2",
    credentialProvider: "tiny",
    credentialConnection: "acme-primary",
    baseUrl: "https://api.tiny.com.br/api2",
  };
}

function caller(action: string): CredentialCallerContext {
  return {
    contextId: "ctx_tiny_test",
    agentId: "tiny-reader",
    kind: "turn-runtime",
    capabilities: [
      { permission: "use", objectType: "credential", objectId: "tiny:acme-primary" },
      { permission: "execute", objectType: "tiny", objectId: action },
    ],
  };
}
