import { afterEach, describe, expect, it } from "bun:test";
import { serve } from "bun";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SECURITY_INTERACTIVE_MAX_LINE_BYTES } from "../security/macos-keychain.js";
import { createFakeSecurity } from "../test/fake-security.js";
import {
  deleteSecret,
  readSecret,
  redactSecretRef,
  setKeychainCommandRunnerForTests,
  writeSecret,
} from "./backends.js";
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
  setKeychainCommandRunnerForTests();
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

describe("credential broker Keychain backend", () => {
  /** The shared fake `security` (src/test/fake-security.ts); never runs the real binary. */
  function fakeSecurity() {
    const fake = createFakeSecurity();
    setKeychainCommandRunnerForTests(fake.run);
    return { calls: fake.calls, items: fake.items, fake };
  }

  it("writes the secret through stdin: it is in no argv element", async () => {
    const { calls } = fakeSecurity();
    const secret = 'xoxb-secret"; delete-keychain login.keychain\n-w leak';

    const ref = await writeSecret({ backend: "keychain", provider: "slack", connection: "rbbt", secret });

    expect(ref).toBe("keychain:ravi.credentials/slack:rbbt");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(["-i"]);
    for (const call of calls) {
      for (const arg of call.args) expect(arg).not.toContain("xoxb");
    }
    expect(calls[0]!.input).toBe(
      `add-generic-password -U -a slack:rbbt -s ravi.credentials -X ${Buffer.from(secret).toString("hex")}\n`,
    );
  });

  it("reads and deletes what it wrote", async () => {
    fakeSecurity();
    const ref = await writeSecret({ backend: "keychain", provider: "slack", connection: "rbbt", secret: "s3cr3t" });

    expect(await readSecret(ref)).toBe("s3cr3t");
    expect(await deleteSecret(ref)).toBe(true);
    expect(await deleteSecret(ref)).toBe(false);
  });

  it("stores a ~3.5 KB printable secret (service-account JSON) through the quoted form", async () => {
    const { calls } = fakeSecurity();
    const secret = JSON.stringify({
      type: "service_account",
      private_key: `-----BEGIN PRIVATE KEY-----\n${"M".repeat(3200)}\n-----END PRIVATE KEY-----\n`,
      client_email: "bot@project.iam.gserviceaccount.com",
    });

    const ref = await writeSecret({ backend: "keychain", provider: "gcp", connection: "main", secret });

    expect(calls[0]!.args).toEqual(["-i"]);
    expect(calls[0]!.input).toContain(' -w "{\\"type\\":');
    expect(Buffer.byteLength(calls[0]!.input!)).toBeLessThanOrEqual(SECURITY_INTERACTIVE_MAX_LINE_BYTES);
    expect(await readSecret(ref)).toBe(secret);
  });

  it("reads back a non-ASCII secret (printed as hex by `security -g`)", async () => {
    fakeSecurity();
    const ref = await writeSecret({ backend: "keychain", provider: "slack", connection: "rbbt", secret: "senha-ç✓" });
    expect(await readSecret(ref)).toBe("senha-ç✓");
  });

  it("reads with `find-generic-password -g`, so hex-shaped printable secrets come back verbatim", async () => {
    const { calls } = fakeSecurity();
    const secrets = ["123456", "000000", "0a", "c3a9", "deadbeef", '{"a":"\\u00e9"}', "é", 'x "q" \\ \n'];
    for (const secret of secrets) {
      const ref = await writeSecret({ backend: "keychain", provider: "p", connection: "c", secret });
      expect(await readSecret(ref)).toBe(secret);
    }
    const reads = calls.filter((call) => call.args[0] === "find-generic-password");
    expect(reads).toHaveLength(secrets.length);
    for (const read of reads) {
      expect(read.args).toContain("-g");
      expect(read.args).not.toContain("-w");
    }
  });

  it("reads a legacy item an older Ravi wrote with `add-generic-password -w <secret>` in argv", async () => {
    const { fake } = fakeSecurity();
    fake.run(["add-generic-password", "-U", "-a", "slack:rbbt", "-s", "ravi.credentials", "-w", "000000"]);
    fake.run(["add-generic-password", "-U", "-a", "slack:old", "-s", "ravi.credentials", "-w", "xoxb-ç"]);

    expect(await readSecret("keychain:ravi.credentials/slack:rbbt")).toBe("000000");
    expect(await readSecret("keychain:ravi.credentials/slack:old")).toBe("xoxb-ç");
  });

  it("round-trips a printable secret that fills the `security -i` line exactly", async () => {
    const { calls } = fakeSecurity();
    const overhead = Buffer.byteLength('add-generic-password -U -a slack:rbbt -s ravi.credentials -w ""\n');
    const secret = "7".repeat(SECURITY_INTERACTIVE_MAX_LINE_BYTES - overhead);

    const ref = await writeSecret({ backend: "keychain", provider: "slack", connection: "rbbt", secret });

    expect(Buffer.byteLength(calls[0]!.input!)).toBe(SECURITY_INTERACTIVE_MAX_LINE_BYTES);
    expect(await readSecret(ref)).toBe(secret);
    await expect(
      writeSecret({ backend: "keychain", provider: "slack", connection: "rbbt", secret: `${secret}7` }),
    ).rejects.toThrow("vault backend");
  });

  it("fails a read whose output it cannot parse, without the output in the error", async () => {
    setKeychainCommandRunnerForTests(() => ({ status: 0, stdout: "", stderr: "password: 0xZZ \n" }));
    await expect(readSecret("keychain:ravi.credentials/slack:rbbt")).rejects.toThrow("cannot parse");
  });

  it("refuses a secret too large for one `security -i` line instead of truncating it", async () => {
    const { calls } = fakeSecurity();
    const secret = "x".repeat(SECURITY_INTERACTIVE_MAX_LINE_BYTES);

    await expect(writeSecret({ backend: "keychain", provider: "slack", connection: "rbbt", secret })).rejects.toThrow(
      "vault backend",
    );
    expect(calls).toHaveLength(0);
  });

  it("refuses a Keychain service name the interactive parser would split", async () => {
    const { calls } = fakeSecurity();
    const previous = process.env.RAVI_CREDENTIALS_KEYCHAIN_SERVICE;
    process.env.RAVI_CREDENTIALS_KEYCHAIN_SERVICE = "ravi creds";
    try {
      await expect(
        writeSecret({ backend: "keychain", provider: "slack", connection: "rbbt", secret: "s3cr3t" }),
      ).rejects.toThrow("RAVI_CREDENTIALS_KEYCHAIN_SERVICE");
    } finally {
      if (previous === undefined) delete process.env.RAVI_CREDENTIALS_KEYCHAIN_SERVICE;
      else process.env.RAVI_CREDENTIALS_KEYCHAIN_SERVICE = previous;
    }
    expect(calls).toHaveLength(0);
  });
});

describe("credential broker DB file", () => {
  const posixOnly = process.platform === "win32" ? it.skip : it;

  posixOnly("is 0600 after open", () => {
    const options = tempOptions();
    listCredentialConnections({}, options);
    expect(statSync(options.dbPath!).mode & 0o777).toBe(0o600);
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
