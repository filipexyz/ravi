import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  addRaviEnvKey,
  getRaviEnvKey,
  RAVI_ENV_SECRET_KEYS,
  RaviEnvFileError,
  setRaviEnvKey,
} from "../runtime/ravi-env-file.js";
import {
  closeCredentialsDb,
  createCredentialConnectionIfAbsent,
  getCredentialConnection,
  upsertCredentialConnection,
} from "./store.js";
import { resolveCredentialSecret } from "./broker.js";
import {
  bindIntakeView,
  cancelIntakeRequest,
  claimIntakeRequest,
  createIntakeRequest,
  getIntakeRequest,
  INTAKE_TTL_MS,
  intakeMetadataSchema,
  normalizeIntakeTarget,
  storeIntakeSecret,
  type IntakeBinding,
  type IntakeMetadata,
  type IntakeRequest,
} from "./intake.js";

const TOKEN = "intake-test-token-cdbb62e2c3474e48962d7880235c5ff1";
const NOW = 1_800_000_000_000;
const metadata: IntakeMetadata = {
  target: "env:ANTHROPIC_API_KEY",
  accountId: "slack-test",
  teamId: "T12345",
  userId: "U12345",
  channelId: "D12345",
  threadTs: "12345.00001",
  issuerContextId: "ctx_test",
  issuerAgentId: "assistant",
  issuerSessionKey: "agent:assistant:slack:dm:U12345",
  reason: "Enable the requested API integration",
};
const binding: IntakeBinding = {
  accountId: metadata.accountId,
  teamId: metadata.teamId,
  userId: metadata.userId,
  actorContactId: "contact_test",
  viewId: "V12345",
};

let stateDir: string;
let priorSecretEnv: Map<string, string | undefined>;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-intake-test-");
  closeCredentialsDb();
  priorSecretEnv = new Map([...RAVI_ENV_SECRET_KEYS].map((key) => [key, process.env[key]]));
  for (const key of RAVI_ENV_SECRET_KEYS) delete process.env[key];
});

afterEach(async () => {
  closeCredentialsDb();
  for (const [key, value] of priorSecretEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await cleanupIsolatedRaviState(stateDir);
});

function claimed(input: IntakeMetadata = metadata): IntakeRequest {
  const request = createIntakeRequest(input, { now: NOW });
  bindIntakeView(request.id, binding, "V12345", { now: NOW });
  return claimIntakeRequest(request.id, binding, { now: NOW });
}

function auditRows(): unknown[] {
  return getDb().prepare("SELECT * FROM credential_intake_audit ORDER BY rowid").all();
}

describe("credential intake boundary", () => {
  it("accepts only the strict metadata shape, never a secret or response URL field", () => {
    expect(intakeMetadataSchema.safeParse({ ...metadata, secret: TOKEN }).success).toBe(false);
    expect(
      intakeMetadataSchema.safeParse({ ...metadata, response_url: "https://hooks.slack.com/actions/test" }).success,
    ).toBe(false);
    expect(() => createIntakeRequest({ ...metadata, secret: TOKEN } as IntakeMetadata)).toThrow(
      "INTAKE_METADATA_INVALID",
    );
    expect(normalizeIntakeTarget("connection:SLACK:demo")).toEqual({
      kind: "connection",
      target: "connection:slack:demo",
      provider: "slack",
      connection: "demo",
      scope: "provider",
    });
    expect(createIntakeRequest({ ...metadata, target: "connection:github:file-test", backend: "file" }).backend).toBe(
      "file",
    );
    expect(() => createIntakeRequest({ ...metadata, target: "connection:github:no-backend" })).toThrow(
      "INTAKE_METADATA_INVALID",
    );
  });

  it("fails closed for unknown env keys and non-secret process configuration", () => {
    for (const key of [
      "PATH",
      "SECRET_ANYTHING",
      "CODEX_HOME",
      "GROK_HOME",
      "GROK_DISABLE_AUTOUPDATER",
      "CLAUDE_CODE_OAUTH_TOKEN",
    ]) {
      expect(() => createIntakeRequest({ ...metadata, target: `env:${key}` })).toThrow("INTAKE_TARGET_INVALID");
    }
    expect(() => normalizeIntakeTarget("connection:slack:../demo")).toThrow("INTAKE_TARGET_INVALID");
    expect(() => normalizeIntakeTarget("runtime:pi:anything")).toThrow("INTAKE_TARGET_INVALID");
  });

  it("requires an exact account, team, user, contact and modal binding", () => {
    const request = createIntakeRequest(metadata, { now: NOW });
    expect(() => claimIntakeRequest(request.id, binding, { now: NOW })).toThrow("INTAKE_BINDING_MISMATCH");
    for (const changed of [{ accountId: "other" }, { teamId: "TOTHER" }, { userId: "UOTHER" }]) {
      expect(() => bindIntakeView(request.id, { ...binding, ...changed }, "V12345", { now: NOW })).toThrow(
        "INTAKE_BINDING_MISMATCH",
      );
    }
    bindIntakeView(request.id, binding, "V12345", { now: NOW });
    expect(() => bindIntakeView(request.id, binding, "VOTHER", { now: NOW })).toThrow("INTAKE_ALREADY_USED");
    expect(() => claimIntakeRequest(request.id, { ...binding, actorContactId: "contact_other" }, { now: NOW })).toThrow(
      "INTAKE_BINDING_MISMATCH",
    );
    expect(() => claimIntakeRequest(request.id, { ...binding, viewId: "VOTHER" }, { now: NOW })).toThrow(
      "INTAKE_BINDING_MISMATCH",
    );
    expect(claimIntakeRequest(request.id, binding, { now: NOW }).status).toBe("pending");
    expect(() => claimIntakeRequest(request.id, binding, { now: NOW })).toThrow("INTAKE_ALREADY_USED");
  });

  it("expires and cancels requests without allowing replay", () => {
    const expired = createIntakeRequest(metadata, { now: NOW });
    expect(() => bindIntakeView(expired.id, binding, "V12345", { now: NOW + INTAKE_TTL_MS })).toThrow("INTAKE_EXPIRED");
    const cancelled = createIntakeRequest(metadata, { now: NOW });
    bindIntakeView(cancelled.id, binding, "V12345", { now: NOW });
    cancelIntakeRequest(cancelled.id, binding, { now: NOW });
    expect(getIntakeRequest(cancelled.id)?.status).toBe("cancelled");
    expect(() => claimIntakeRequest(cancelled.id, binding, { now: NOW })).toThrow("INTAKE_ALREADY_USED");
  });

  it("serializes concurrent requests for the same target", () => {
    claimed();
    const second = createIntakeRequest(metadata, { now: NOW });
    bindIntakeView(second.id, binding, "V12345", { now: NOW });
    expect(() => claimIntakeRequest(second.id, binding, { now: NOW })).toThrow("INTAKE_TARGET_BUSY");
  });

  it("writes an allowlisted env token only to its 0600 store and fingerprints the audit", async () => {
    const request = claimed();
    const logs: unknown[][] = [];
    const log = spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args);
    });
    const warn = spyOn(console, "warn").mockImplementation((...args) => {
      logs.push(args);
    });
    const error = spyOn(console, "error").mockImplementation((...args) => {
      logs.push(args);
    });
    try {
      const result = await storeIntakeSecret(request, TOKEN);
      expect(result).toEqual({
        fingerprint: createHash("sha256").update(TOKEN).digest("hex"),
        daemonReloadRequired: true,
      });
      expect(getRaviEnvKey("ANTHROPIC_API_KEY").value).toBe("[REDACTED]");
      expect(readFileSync(join(stateDir, ".env"), "utf8")).toContain(TOKEN);
      expect(statSync(join(stateDir, ".env")).mode & 0o777).toBe(0o600);
      expect(getIntakeRequest(request.id)).toMatchObject({ status: "stored", fingerprint: result.fingerprint });
      expect(auditRows().at(-1)).toMatchObject({
        actor_contact_id: "contact_test",
        scope: "host",
        outcome: "stored",
        fingerprint: result.fingerprint,
      });
      const publicData = JSON.stringify({ result, request: getIntakeRequest(request.id), audit: auditRows(), logs });
      expect(publicData).not.toContain(TOKEN);
      expect(readFileSync(join(stateDir, "ravi.db")).includes(Buffer.from(TOKEN))).toBe(false);
      await expect(storeIntakeSecret(request, TOKEN)).rejects.toThrow("INTAKE_ALREADY_USED");
    } finally {
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it("refuses to replace an existing env credential", async () => {
    setRaviEnvKey("ANTHROPIC_API_KEY", TOKEN);
    const request = claimed();
    await expect(storeIntakeSecret(request, `${TOKEN}-replacement`)).rejects.toThrow("INTAKE_TARGET_EXISTS");
    expect(getIntakeRequest(request.id)?.status).toBe("failed");
    expect(readFileSync(join(stateDir, ".env"), "utf8")).not.toContain("replacement");
  });

  it("refuses an inherited process credential before touching the env file", async () => {
    process.env.ANTHROPIC_API_KEY = TOKEN;
    const request = claimed();
    let written = false;
    await expect(
      storeIntakeSecret(request, `${TOKEN}-replacement`, {
        addEnvKey: (...args) => {
          written = true;
          return addRaviEnvKey(...args);
        },
      }),
    ).rejects.toThrow("INTAKE_TARGET_EXISTS");
    expect(written).toBe(false);
    expect(getRaviEnvKey("ANTHROPIC_API_KEY").present).toBe(false);
    expect(getIntakeRequest(request.id)?.status).toBe("failed");
  });

  it("enforces add-only again inside the writer after a stale preflight", async () => {
    const request = claimed();
    let preflight = true;
    await expect(
      storeIntakeSecret(request, `${TOKEN}-loser`, {
        getEnvKey: (key) => {
          const result = getRaviEnvKey(key);
          if (preflight) {
            preflight = false;
            setRaviEnvKey(key, `${TOKEN}-winner`);
          }
          return result;
        },
      }),
    ).rejects.toThrow("INTAKE_TARGET_EXISTS");
    const bytes = readFileSync(join(stateDir, ".env"), "utf8");
    expect(bytes).toContain(`${TOKEN}-winner`);
    expect(bytes).not.toContain("loser");
    expect(getIntakeRequest(request.id)).toMatchObject({ status: "failed", errorCode: "INTAKE_TARGET_EXISTS" });
  });

  it("validates Slack payload and stores only its backend reference", async () => {
    const secret = JSON.stringify({ appToken: `${TOKEN}-app`, botToken: `${TOKEN}-bot` });
    const request = claimed({
      ...metadata,
      target: "connection:slack:intake-test",
      backend: "keychain",
      label: "Intake test",
      scopes: ["chat:write"],
    });
    let backendSecret = "";
    const result = await storeIntakeSecret(request, secret, {
      writeSecret: async (input) => {
        backendSecret = input.secret;
        expect(input.connection).toBe(`intake-test-${request.id}`);
        return `keychain:test/${input.provider}:${input.connection}`;
      },
    });
    expect(backendSecret).toBe(secret);
    expect(result.daemonReloadRequired).toBe(false);
    expect(getCredentialConnection("slack", "intake-test")).toMatchObject({
      backend: "keychain",
      scopes: ["chat:write"],
    });
    expect(
      JSON.stringify({
        audit: auditRows(),
        request: getIntakeRequest(request.id),
        connection: getCredentialConnection("slack", "intake-test"),
      }),
    ).not.toContain(TOKEN);
    expect(auditRows().at(-1)).toMatchObject({ target: "connection:slack:intake-test", scope: "provider" });
  });

  it("stores a provider credential in the real local file backend and resolves it through the broker", async () => {
    const request = claimed({ ...metadata, target: "connection:github:local-test", backend: "file" });
    const result = await storeIntakeSecret(request, TOKEN);
    const connection = getCredentialConnection("github", "local-test")!;
    expect(connection.backend).toBe("file");
    expect(connection.secretRef).toMatch(/^file:[a-f0-9]{64}$/);
    const secretDirectory = join(stateDir, "credential-secrets");
    const secretPath = join(secretDirectory, `${connection.secretRef.slice("file:".length)}.secret`);
    expect(statSync(secretDirectory).mode & 0o777).toBe(0o700);
    expect(statSync(secretPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(secretPath, "utf8")).toBe(TOKEN);
    // Intake grants no use authority. The merged broker refuses an absent
    // caller; this isolated host-side integration must declare its own intent.
    await expect(
      resolveCredentialSecret({ provider: "github", connection: "local-test", action: "whoami" }),
    ).rejects.toMatchObject({ code: "caller_invalid" });
    const resolved = await resolveCredentialSecret({
      provider: "github",
      connection: "local-test",
      action: "whoami",
      authority: { kind: "local-operator" },
    });
    expect(resolved.secret).toBe(TOKEN);
    expect(getIntakeRequest(request.id)?.status).toBe("stored");
    expect(
      JSON.stringify({ result, connection, request: getIntakeRequest(request.id), audit: auditRows() }),
    ).not.toContain(TOKEN);
    // Includes ravi.db/credentials.db and their WAL/SHM files while still open.
    // The one approved plaintext sink is the protected backend file above.
    for (const name of readdirSync(stateDir)) {
      const path = join(stateDir, name);
      if (statSync(path).isFile()) expect(readFileSync(path).includes(Buffer.from(TOKEN))).toBe(false);
    }
    expect(readdirSync(secretDirectory)).toEqual([`${connection.secretRef.slice("file:".length)}.secret`]);
  });

  it("does not overwrite a connection that appeared while the backend write was pending", async () => {
    const request = claimed({ ...metadata, target: "connection:github:intake-test", backend: "keychain" });
    const deleted: string[] = [];
    await expect(
      storeIntakeSecret(request, TOKEN, {
        writeSecret: async () => {
          upsertCredentialConnection({
            provider: "github",
            connection: "intake-test",
            backend: "keychain",
            secretRef: "keychain:test/existing",
          });
          return "keychain:test/new-unreferenced";
        },
        deleteSecret: async (ref) => {
          deleted.push(ref);
          return true;
        },
      }),
    ).rejects.toThrow("INTAKE_TARGET_EXISTS");
    expect(getCredentialConnection("github", "intake-test")?.secretRef).toBe("keychain:test/existing");
    expect(getIntakeRequest(request.id)?.status).toBe("failed");
    expect(deleted).toEqual(["keychain:test/new-unreferenced"]);
  });

  it("cleans up only its own new backend ref when atomic metadata creation loses a race", async () => {
    const request = claimed({ ...metadata, target: "connection:github:intake-test", backend: "keychain" });
    const deleted: string[] = [];
    await expect(
      storeIntakeSecret(request, TOKEN, {
        writeSecret: async () => "keychain:test/request-owned",
        saveConnection: () => null,
        deleteSecret: async (ref) => {
          deleted.push(ref);
          throw new Error(`Backend echoed ${TOKEN}`);
        },
      }),
    ).rejects.toThrow("INTAKE_TARGET_EXISTS");
    expect(deleted).toEqual(["keychain:test/request-owned"]);
    expect(getIntakeRequest(request.id)?.status).toBe("failed");
    expect(JSON.stringify(auditRows())).not.toContain(TOKEN);
  });

  it("does not delete a stored secret or report failure when metadata committed before throwing", async () => {
    const request = claimed({ ...metadata, target: "connection:github:intake-test", backend: "keychain" });
    const deleted: string[] = [];
    let failure: unknown;
    try {
      await storeIntakeSecret(request, TOKEN, {
        writeSecret: async () => "keychain:test/request-owned",
        saveConnection: (input) => {
          createCredentialConnectionIfAbsent(input);
          throw new Error(`Commit response echoed ${TOKEN}`);
        },
        deleteSecret: async (ref) => {
          deleted.push(ref);
          return true;
        },
      });
    } catch (error) {
      failure = error;
    }
    expect(String(failure)).toBe("IntakeError: INTAKE_RECONCILIATION_REQUIRED");
    expect((failure as Error).cause).toBeUndefined();
    expect(deleted).toEqual([]);
    expect(getCredentialConnection("github", "intake-test")?.secretRef).toBe("keychain:test/request-owned");
    expect(getIntakeRequest(request.id)?.status).toBe("pending");
    expect(auditRows().map((row) => (row as { outcome: string }).outcome)).toEqual(["requested", "accepted"]);
  });

  it("keeps a successfully written env target blocked when terminal audit fails", async () => {
    const request = claimed();
    getDb().exec(`CREATE TRIGGER refuse_stored_audit BEFORE INSERT ON credential_intake_audit
      WHEN NEW.outcome = 'stored' BEGIN SELECT RAISE(ABORT, 'test audit unavailable'); END`);
    await expect(storeIntakeSecret(request, TOKEN)).rejects.toThrow("INTAKE_RECONCILIATION_REQUIRED");
    expect(getRaviEnvKey("ANTHROPIC_API_KEY").present).toBe(true);
    expect(getIntakeRequest(request.id)?.status).toBe("pending");
    expect(() => claimed()).toThrow("INTAKE_TARGET_BUSY");
    expect(auditRows().some((row) => (row as { outcome: string }).outcome === "failed")).toBe(false);
    expect(JSON.stringify(auditRows())).not.toContain(TOKEN);
  });

  it("keeps an env write that threw after storing in reconciliation instead of reporting not saved", async () => {
    const request = claimed();
    await expect(
      storeIntakeSecret(request, TOKEN, {
        addEnvKey: (...args) => {
          addRaviEnvKey(...args);
          throw new Error(`Write response echoed ${TOKEN}`);
        },
      }),
    ).rejects.toThrow("INTAKE_RECONCILIATION_REQUIRED");
    expect(getRaviEnvKey("ANTHROPIC_API_KEY").present).toBe(true);
    expect(getIntakeRequest(request.id)?.status).toBe("pending");
  });

  it("keeps an explicit postcommit uncertainty pending even if the target is no longer present", async () => {
    const request = claimed();
    await expect(
      storeIntakeSecret(request, TOKEN, {
        addEnvKey: () => {
          throw new RaviEnvFileError("ENV_WRITE_UNCERTAIN", "ENV_WRITE_UNCERTAIN");
        },
      }),
    ).rejects.toThrow("INTAKE_RECONCILIATION_REQUIRED");
    expect(getIntakeRequest(request.id)?.status).toBe("pending");
    expect(auditRows().some((row) => (row as { outcome: string }).outcome === "failed")).toBe(false);
  });

  it("makes connection creation atomic even when the preflight check raced", () => {
    const input = {
      provider: "github",
      connection: "intake-test",
      backend: "keychain" as const,
      secretRef: "keychain:test/first",
      scopes: ["read"],
    };
    expect(createCredentialConnectionIfAbsent(input)).not.toBeNull();
    expect(
      createCredentialConnectionIfAbsent({ ...input, secretRef: "keychain:test/second", scopes: ["write"] }),
    ).toBeNull();
    expect(getCredentialConnection("github", "intake-test")).toMatchObject({
      secretRef: "keychain:test/first",
      scopes: ["read"],
    });
  });

  it("rejects recognized long-lived OAuth tokens in any direct destination", async () => {
    for (const input of [
      metadata,
      { ...metadata, target: "connection:github:oauth-test", backend: "keychain" as const },
    ]) {
      const request = claimed(input);
      await expect(storeIntakeSecret(request, "sk-ant-oat01-test-only-not-a-real-credential")).rejects.toThrow(
        "INTAKE_SECRET_INVALID",
      );
    }
  });

  it("never persists or returns raw parser/backend errors containing secret material", async () => {
    for (const [provider, secret] of [
      ["slack", `{"bad":"${TOKEN}"`],
      ["github", TOKEN],
    ]) {
      const request = claimed({ ...metadata, target: `connection:${provider}:intake-test`, backend: "keychain" });
      let caught: unknown;
      try {
        await storeIntakeSecret(request, secret!, {
          writeSecret: async () => {
            throw new Error(`Backend echoed ${TOKEN}`);
          },
        });
      } catch (error) {
        caught = error;
      }
      expect(String(caught)).toBe("IntakeError: INTAKE_STORE_FAILED");
      expect((caught as Error).cause).toBeUndefined();
      expect(JSON.stringify(auditRows())).not.toContain(TOKEN);
      expect(getIntakeRequest(request.id)).toMatchObject({ status: "failed", errorCode: "INTAKE_STORE_FAILED" });
    }
  });

  it("rejects malformed values and uses persisted metadata over a caller's changed copy", async () => {
    const request = claimed();
    await expect(storeIntakeSecret({ ...request, target: "env:PATH" }, "short")).rejects.toThrow(
      "INTAKE_SECRET_INVALID",
    );
    const another = claimed();
    await storeIntakeSecret({ ...another, target: "env:PATH" }, TOKEN);
    expect(getRaviEnvKey("ANTHROPIC_API_KEY").present).toBe(true);
  });
});
