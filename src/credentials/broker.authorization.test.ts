import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCredentialSecret } from "./broker.js";
import { closeCredentialsDb, upsertCredentialConnection, type CredentialStoreOptions } from "./store.js";
import type { CredentialCallerContext } from "./types.js";

let stateDir: string | null = null;

afterEach(() => {
  closeCredentialsDb();
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  stateDir = null;
});

describe("credential broker authorization boundary", () => {
  it("denies missing caller context before reading the backend", async () => {
    const harness = createHarness();

    await expect(harness.resolve({ context: null })).rejects.toThrow("missing_caller_context");
    expect(harness.backendReads()).toBe(0);
    expect(lastAudit(harness.dbPath)).toMatchObject({
      decision: "deny",
      result_status: "authorization_denied",
      error_code: "missing_caller_context",
    });
  });

  it("denies a context without a caller identity before reading the backend", async () => {
    const harness = createHarness();
    const anonymousContext = { ...authorizedCaller(), agentId: null };

    await expect(harness.resolve({ context: anonymousContext })).rejects.toThrow("missing_caller_identity");
    expect(harness.backendReads()).toBe(0);
    expect(lastAudit(harness.dbPath)).toMatchObject({
      decision: "deny",
      result_status: "authorization_denied",
      error_code: "missing_caller_identity",
    });
  });

  it("denies missing credential grant before reading the backend", async () => {
    const harness = createHarness();

    await expect(harness.resolve({ context: caller([actionCapability("info.read")]) })).rejects.toThrow(
      "missing_credential_capability",
    );
    expect(harness.backendReads()).toBe(0);
    expect(lastAudit(harness.dbPath)).toMatchObject({
      decision: "deny",
      result_status: "authorization_denied",
      error_code: "missing_credential_capability",
    });
  });

  it("denies a tenant not bound to the connection before reading the backend", async () => {
    const harness = createHarness();

    await expect(harness.resolve({ context: authorizedCaller(), tenant: "other-company" })).rejects.toThrow(
      "tenant_connection_mismatch",
    );
    expect(harness.backendReads()).toBe(0);
  });

  it("denies a missing tenant for a tenant-scoped connection before reading the backend", async () => {
    const harness = createHarness();

    await expect(harness.resolve({ context: authorizedCaller(), tenant: null })).rejects.toThrow("missing_tenant");
    expect(harness.backendReads()).toBe(0);
  });

  it("denies a caller granted for a different connection before reading the backend", async () => {
    const harness = createHarness();
    const foreignConnectionCaller = caller([
      { permission: "use", objectType: "credential", objectId: "tiny:other-primary" },
      actionCapability("info.read"),
    ]);

    await expect(harness.resolve({ context: foreignConnectionCaller })).rejects.toThrow(
      "missing_credential_capability",
    );
    expect(harness.backendReads()).toBe(0);
  });

  it("denies the wrong provider action before reading the backend", async () => {
    const harness = createHarness();

    await expect(
      harness.resolve({
        action: "orders.write",
        context: caller([credentialCapability(), actionCapability("info.read")]),
      }),
    ).rejects.toThrow("missing_action_capability");
    expect(harness.backendReads()).toBe(0);
  });

  it("denies a missing action before reading the backend", async () => {
    const harness = createHarness();

    await expect(harness.resolve({ action: "", context: authorizedCaller() })).rejects.toThrow("missing_action");
    expect(harness.backendReads()).toBe(0);
  });

  it("rejects an unknown provider or connection without reading any secret backend", async () => {
    const harness = createHarness();

    await expect(harness.resolve({ provider: "other", context: authorizedCaller() })).rejects.toThrow(
      "Connection not found",
    );
    await expect(harness.resolve({ connection: "other-primary", context: authorizedCaller() })).rejects.toThrow(
      "Connection not found",
    );
    expect(harness.backendReads()).toBe(0);
  });

  it("denies a sensitive action without approval before reading the backend", async () => {
    const harness = createHarness();
    const sensitiveCaller = caller([credentialCapability(), actionCapability("orders.write")]);

    await expect(harness.resolve({ action: "orders.write", context: sensitiveCaller })).rejects.toThrow(
      "approval_required",
    );
    expect(harness.backendReads()).toBe(0);
  });

  it("denies an explicitly rejected approval before reading the backend", async () => {
    const harness = createHarness();
    const sensitiveCaller = caller([credentialCapability(), actionCapability("orders.write")]);

    await expect(
      harness.resolve({ action: "orders.write", context: sensitiveCaller, approvalStatus: "denied" }),
    ).rejects.toThrow("approval_denied");
    expect(harness.backendReads()).toBe(0);
  });

  it("denies a caller-supplied approved status without an approval capability before reading the backend", async () => {
    const harness = createHarness();
    const sensitiveCaller = caller([credentialCapability(), actionCapability("orders.write")]);

    await expect(
      harness.resolve({
        action: "orders.write",
        context: sensitiveCaller,
        approvalStatus: "approved",
      }),
    ).rejects.toThrow("approval_required");
    expect(harness.backendReads()).toBe(0);
    expect(lastAudit(harness.dbPath)).toMatchObject({
      decision: "deny",
      result_status: "authorization_denied",
      error_code: "approval_required",
      approval_status: "not_requested",
    });
  });

  it("resolves a sensitive action only after an approval capability is attached to the caller context", async () => {
    const harness = createHarness();
    const sensitiveCaller = caller([
      credentialCapability(),
      actionCapability("orders.write"),
      actionCapability("orders.write", "approval"),
    ]);

    const result = await harness.resolve({
      action: "orders.write",
      context: sensitiveCaller,
    });

    expect(result.secret).toBe("dummy-secret-never-log");
    expect(harness.backendReads()).toBe(1);
    expect(lastAudit(harness.dbPath)).toMatchObject({
      decision: "allow",
      result_status: "secret_resolved",
      approval_status: "approved",
    });
  });

  it("resolves only for the bound tenant with both capabilities and keeps the secret out of audit", async () => {
    const harness = createHarness();

    const result = await harness.resolve({ context: authorizedCaller(), tenant: "acme" });

    expect(harness.backendReads()).toBe(1);
    expect(result.secret).toBe("dummy-secret-never-log");
    const audit = lastAudit(harness.dbPath);
    expect(audit).toMatchObject({
      decision: "allow",
      result_status: "secret_resolved",
      actor_context_id: "ctx_test",
      agent_id: "tiny-reader",
    });
    expect(JSON.stringify(audit)).not.toContain("dummy-secret-never-log");
  });
});

function createHarness(input: { scopes?: string[] } = {}) {
  stateDir = mkdtempSync(join(tmpdir(), "ravi-credential-auth-"));
  const dbPath = join(stateDir, "credentials.db");
  const options: CredentialStoreOptions = { dbPath };
  upsertCredentialConnection(
    {
      provider: "tiny",
      connection: "acme-primary",
      backend: "keychain",
      secretRef: "keychain:ravi.credentials/tiny/acme-primary",
      scopes: input.scopes ?? ["tenant:acme"],
      status: "active",
    },
    options,
  );
  let reads = 0;
  return {
    dbPath,
    backendReads: () => reads,
    resolve: (authorization: {
      context?: CredentialCallerContext | null;
      tenant?: string | null;
      action?: string;
      provider?: string;
      connection?: string;
      approvalStatus?: "approved" | "denied" | "not_requested" | null;
    }) =>
      resolveCredentialSecret(
        {
          provider: authorization.provider ?? "tiny",
          connection: authorization.connection ?? "acme-primary",
          action: authorization.action ?? "info.read",
          authorization: {
            tenant: Object.hasOwn(authorization, "tenant") ? authorization.tenant : "acme",
            approvalStatus: authorization.approvalStatus,
          },
          options,
        },
        {
          getCallerContext: () => authorization.context,
          readSecret: async () => {
            reads += 1;
            return "dummy-secret-never-log";
          },
        },
      ),
  };
}

function caller(capabilities: CredentialCallerContext["capabilities"]): CredentialCallerContext {
  return { contextId: "ctx_test", agentId: "tiny-reader", kind: "turn-runtime", capabilities };
}

function authorizedCaller(): CredentialCallerContext {
  return caller([credentialCapability(), actionCapability("info.read")]);
}

function credentialCapability() {
  return { permission: "use", objectType: "credential", objectId: "tiny:acme-primary" };
}

function actionCapability(action: string, source?: string) {
  return { permission: "execute", objectType: "tiny", objectId: action, ...(source ? { source } : {}) };
}

function lastAudit(dbPath: string): Record<string, unknown> {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query("SELECT * FROM credential_audit_events ORDER BY created_at DESC LIMIT 1").get() as Record<
      string,
      unknown
    >;
  } finally {
    db.close();
  }
}
