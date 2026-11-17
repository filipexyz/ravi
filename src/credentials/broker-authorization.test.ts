import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { generateKeyPairSync, sign } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import * as approvalService from "../approval/service.js";
import { resolveSlackCredentialConfigFromEnv } from "../channels/slack/credentials.js";
import { runWithContext } from "../cli/context.js";
import {
  canonicalize,
  EXTERNAL_AUTHORITY_ASSERTION_SETTING,
  EXTERNAL_AUTHORITY_PUBKEY_SETTING,
  resetExternalAuthorityCacheForTests,
  type ExternalScope,
} from "../permissions/external-authority-provider.js";
import { PERMISSION_PROVIDER_IDS_SETTING } from "../permissions/provider-registry.js";
import {
  dbCreateAgent,
  dbDeleteAgent,
  dbDeleteContext,
  dbSetSetting,
  dbUpdateAgent,
  dbUpdateContextCapabilities,
  type ContextCapability,
  type ContextRecord,
} from "../router/router-db.js";
import { createRuntimeContext, revokeRuntimeContext } from "../runtime/context-registry.js";
import { writeCredentialsFile } from "../runtime/credentials-store.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import * as backends from "./backends.js";
import { execCredentialBroker, resolveCredentialSecret } from "./broker.js";
import {
  closeCredentialsDb,
  getCredentialsDbPath,
  setCredentialConnectionStatus,
  upsertCredentialConnection,
} from "./store.js";

const agentId = "broker-test-agent";
const fakeSecret = JSON.stringify({ appToken: "xapp-fixture-only", botToken: "xoxb-fixture-only" });
const useCapability = { permission: "use", objectType: "credential", objectId: "slack:fixture" };
const readCapability = { permission: "execute", objectType: "slack", objectId: "auth.check" };
const writeCapability = { permission: "execute", objectType: "slack", objectId: "chat.postMessage" };
const bootstrapAuthority = { kind: "internal-service", service: "slack-channel-runtime" } as const;
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
let stateDir: string;
let readSecret: ReturnType<typeof spyOn<typeof backends, "readSecret">>;
const envKeys = [
  "RAVI_CONTEXT_KEY",
  "RAVI_AGENT_ID",
  "RAVI_SESSION_KEY",
  "RAVI_SESSION_NAME",
  "RAVI_CREDENTIALS_PATH",
] as const;
let savedEnv: Partial<Record<(typeof envKeys)[number], string>>;

beforeEach(async () => {
  savedEnv = {};
  for (const key of envKeys) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  stateDir = await createIsolatedRaviState("ravi-broker-authorization-");
  process.env.RAVI_CREDENTIALS_PATH = join(stateDir, "default-credentials.json");
  dbCreateAgent({ id: agentId, cwd: stateDir });
  setLiveCapabilities([useCapability, readCapability, writeCapability]);
  upsertCredentialConnection({
    provider: "slack",
    connection: "fixture",
    backend: "vault",
    secretRef: "vault:secret/test-only#token",
    status: "active",
  });
  readSecret = spyOn(backends, "readSecret").mockResolvedValue(fakeSecret);
  resetExternalAuthorityCacheForTests();
});

afterEach(async () => {
  mock.restore();
  resetExternalAuthorityCacheForTests();
  closeCredentialsDb();
  await cleanupIsolatedRaviState(stateDir);
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function setLiveCapabilities(capabilities: ContextCapability[]) {
  dbUpdateAgent(agentId, { defaults: { runtimePermissions: { profile: "explicit-only", capabilities } } });
}

function caller(capabilities = [useCapability, readCapability, writeCapability], extra: Partial<ContextRecord> = {}) {
  return createRuntimeContext({ kind: "turn-runtime", agentId, capabilities, ...extra });
}

function asCaller<T>(context: ContextRecord, fn: () => T): T {
  return runWithContext({ context, contextId: context.contextId, agentId, transport: "tool" }, fn);
}

function resolve(action = "auth.check") {
  return resolveCredentialSecret({ provider: "slack", connection: "fixture", action });
}

function audits(): Array<Record<string, unknown>> {
  const db = new Database(getCredentialsDbPath(), { readonly: true });
  try {
    return db.query("SELECT * FROM credential_audit_events ORDER BY rowid").all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

function externalAuthority(scope: ExternalScope[]) {
  const assertionPath = join(stateDir, "authority.json");
  const payload = { iss: "fixture", sub: `agent:${agentId}`, exp: Math.floor(Date.now() / 1000) + 120, scope };
  writeFileSync(
    assertionPath,
    JSON.stringify({
      ...payload,
      sig: sign(null, Buffer.from(canonicalize(payload)), privateKey).toString("base64"),
    }),
  );
  dbSetSetting(PERMISSION_PROVIDER_IDS_SETTING, "context-capabilities,external-authority");
  dbSetSetting(EXTERNAL_AUTHORITY_ASSERTION_SETTING, assertionPath);
  dbSetSetting(EXTERNAL_AUTHORITY_PUBKEY_SETTING, publicKey.export({ type: "spki", format: "pem" }).toString());
  resetExternalAuthorityCacheForTests();
}

async function denied(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ code });
  expect(readSecret).not.toHaveBeenCalled();
  expect(JSON.stringify(audits())).not.toContain("fixture-only");
}

describe("credential broker authorization boundary", () => {
  it("lets an authorized Slack adapter consume the configured connection and audits no secret", async () => {
    const context = caller();
    const config = await asCaller(context, () =>
      resolveSlackCredentialConfigFromEnv(
        {},
        {
          action: "auth.check",
          channel: {
            name: "test-slack",
            provider: "slack",
            enabled: true,
            credentialConnection: "fixture",
            createdAt: 0,
            updatedAt: 0,
          },
        },
      ),
    );
    expect(config).toMatchObject({ source: "broker", connection: "fixture", botToken: "xoxb-fixture-only" });
    expect(readSecret).toHaveBeenCalledTimes(1);
    expect(audits().at(-1)).toMatchObject({
      decision: "allow",
      result_status: "secret_resolved",
      actor_context_id: context.contextId,
      agent_id: agentId,
    });
    expect(JSON.stringify(audits())).not.toContain("fixture-only");
  });

  for (const [label, capabilities] of [
    ["credential use", [readCapability]],
    ["provider action", [useCapability]],
  ] as const) {
    it(`denies a missing ${label} capability before reading the secret`, async () => {
      await denied(
        asCaller(caller([...capabilities]), () => resolve()),
        "authorization_denied",
      );
      expect(audits().at(-1)).toMatchObject({
        decision: "deny",
        error_code: "authorization_denied",
        agent_id: agentId,
      });
    });
  }

  it("does not let a broad live executor ceiling widen a narrowed issued context", async () => {
    setLiveCapabilities([{ permission: "admin", objectType: "system", objectId: "*" }]);
    await denied(
      asCaller(caller([readCapability]), () => resolve()),
      "authorization_denied",
    );
  });

  it("rechecks the live executor ceiling after the turn was issued", async () => {
    const context = caller();
    setLiveCapabilities([readCapability]);
    await denied(
      asCaller(context, () => resolve()),
      "authorization_denied",
    );
  });

  it("uses current persisted capabilities instead of a cached snapshot", async () => {
    const context = caller();
    dbUpdateContextCapabilities(context.contextId, [readCapability]);
    await denied(
      asCaller(context, () => resolve()),
      "authorization_denied",
    );
  });

  for (const state of ["revoked", "expired", "deleted", "agent deleted", "forged key"] as const) {
    it(`rejects a ${state} caller before reading the secret`, async () => {
      let context = caller([], state === "expired" ? { expiresAt: Date.now() - 1 } : {});
      if (state === "revoked") revokeRuntimeContext(context.contextId);
      if (state === "deleted") dbDeleteContext(context.contextId);
      if (state === "agent deleted") dbDeleteAgent(agentId);
      if (state === "forged key") context = { ...context, contextKey: "rctx_forged_fixture" };
      await denied(
        asCaller(context, () => resolve()),
        "caller_invalid",
      );
    });
  }

  it("does not infer operator authority from missing context or default credentials", async () => {
    const context = caller();
    process.env.RAVI_CREDENTIALS_PATH = join(stateDir, "default-credentials.json");
    writeCredentialsFile({
      version: 1,
      default: context.contextKey,
      contexts: {
        [context.contextKey]: {
          context_id: context.contextId,
          agent_id: agentId,
          label: "fixture",
          kind: context.kind,
          issued_at: Date.now(),
          expires_at: null,
        },
      },
    });
    await denied(resolve(), "caller_invalid");
  });

  it("does not fall back from an invalid explicit key to default credentials or host authority", async () => {
    const context = caller();
    writeCredentialsFile({
      version: 1,
      default: context.contextKey,
      contexts: {
        [context.contextKey]: {
          context_id: context.contextId,
          agent_id: agentId,
          label: "fixture",
          kind: context.kind,
          issued_at: Date.now(),
          expires_at: null,
        },
      },
    });
    process.env.RAVI_CONTEXT_KEY = "rctx_invalid_fixture";
    await denied(
      resolveCredentialSecret({
        provider: "slack",
        connection: "fixture",
        action: "socket_mode.connect",
        authority: bootstrapAuthority,
      }),
      "caller_invalid",
    );
  });

  it("allows explicit host bootstrap without borrowing ambient agent authority", async () => {
    await resolveCredentialSecret({
      provider: "slack",
      connection: "fixture",
      action: "socket_mode.connect",
      authority: bootstrapAuthority,
    });
    expect(readSecret).toHaveBeenCalledTimes(1);
    expect(audits().at(-1)).toMatchObject({ decision: "allow", actor_context_id: "system:slack-channel-runtime" });
  });

  it("cannot use host bootstrap to bypass an active denied agent", async () => {
    await denied(
      asCaller(caller([]), () =>
        resolveCredentialSecret({
          provider: "slack",
          connection: "fixture",
          action: "socket_mode.connect",
          authority: bootstrapAuthority,
        }),
      ),
      "authorization_denied",
    );
  });

  it("does not allow bootstrap authority to execute other actions", async () => {
    await denied(
      resolveCredentialSecret({
        provider: "slack",
        connection: "fixture",
        action: "chat.postMessage",
        authority: bootstrapAuthority,
      }),
      "caller_invalid",
    );
  });

  it("checks a real signed external provider denial even when the snapshot allows", async () => {
    externalAuthority([useCapability]);
    await denied(
      asCaller(caller(), () => resolve()),
      "authorization_denied",
    );
    expect(audits().at(-1)).toMatchObject({ decision: "deny" });
  });

  it("keeps external provider approval pending and never reads or grants locally", async () => {
    externalAuthority([useCapability, { ...readCapability, requiresApproval: true }]);
    const approval = spyOn(approvalService, "requestCascadingApproval");
    await denied(
      asCaller(caller(), () => resolve()),
      "approval_required",
    );
    expect(approval).not.toHaveBeenCalled();
    expect(audits().at(-1)).toMatchObject({
      decision: "needs_approval",
      approval_required: 1,
      approval_status: "pending",
    });
  });

  it("allows a matching signed external provider decision", async () => {
    externalAuthority([useCapability, readCapability]);
    await asCaller(caller(), () => resolve());
    expect(readSecret).toHaveBeenCalledTimes(1);
  });

  it("resolves a valid explicit context key without a cached tool context", async () => {
    const context = caller();
    process.env.RAVI_CONTEXT_KEY = context.contextKey;
    await resolve();
    expect(readSecret).toHaveBeenCalledTimes(1);
    expect(audits().at(-1)).toMatchObject({ actor_context_id: context.contextId, agent_id: agentId });
  });

  it("keeps an executed broker CLI payload free of the consumed secret", async () => {
    const result = await asCaller(caller(), () =>
      execCredentialBroker({
        provider: "slack",
        connection: "fixture",
        action: "auth.check",
        dryRun: false,
      }),
    );
    expect(result).toMatchObject({ status: "executed", secretResolved: true });
    expect(JSON.stringify(result)).not.toContain("fixture-only");
    expect(readSecret).toHaveBeenCalledTimes(1);
  });

  it("never resolves a secret for dry-run", async () => {
    const result = await execCredentialBroker({
      provider: "slack",
      connection: "fixture",
      action: "chat.postMessage",
      dryRun: true,
    });
    expect(result).toMatchObject({ status: "planned", secretResolved: false });
    expect(readSecret).not.toHaveBeenCalled();
  });

  it("does not auto-approve a sensitive action without an approval source", async () => {
    await denied(
      asCaller(caller(), () => resolve("chat.postMessage")),
      "approval_denied",
    );
    expect(audits()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          decision: "needs_approval",
          approval_status: "pending",
          result_status: "approval_pending",
        }),
        expect.objectContaining({ decision: "deny", approval_status: "denied" }),
      ]),
    );
  });

  it("does not read while an action approval is pending, then reads after approval", async () => {
    let approve!: (value: { approved: boolean; isDelegated: boolean }) => void;
    const waiting = new Promise<{ approved: boolean; isDelegated: boolean }>((resolve) => {
      approve = resolve;
    });
    const requested = spyOn(approvalService, "requestCascadingApproval").mockImplementation(() => waiting);
    const operation = asCaller(caller(), () => resolve("chat.postMessage"));
    await Promise.resolve();
    await Promise.resolve();
    expect(readSecret).not.toHaveBeenCalled();
    expect(audits().at(-1)).toMatchObject({ decision: "needs_approval", approval_status: "pending" });
    approve({ approved: true, isDelegated: false });
    await operation;
    expect(requested).toHaveBeenCalledWith(expect.objectContaining({ autoApproveWithoutSource: false }));
    expect(readSecret).toHaveBeenCalledTimes(1);
    expect(audits().at(-1)).toMatchObject({ decision: "allow", approval_status: "approved" });
  });

  for (const changed of ["context revoked", "ceiling revoked", "connection disabled", "provider approval"] as const) {
    it(`revalidates ${changed} after approval and before secret read`, async () => {
      const context = caller();
      spyOn(approvalService, "requestCascadingApproval").mockImplementation(async () => {
        if (changed === "context revoked") revokeRuntimeContext(context.contextId);
        if (changed === "ceiling revoked") setLiveCapabilities([readCapability]);
        if (changed === "connection disabled") setCredentialConnectionStatus("slack", "fixture", "disabled");
        if (changed === "provider approval")
          externalAuthority([useCapability, { ...writeCapability, requiresApproval: true }]);
        return { approved: true, isDelegated: false };
      });
      const codes = {
        "context revoked": "caller_invalid",
        "ceiling revoked": "authorization_denied",
        "connection disabled": "connection_disabled",
        "provider approval": "approval_required",
      };
      await denied(
        asCaller(context, () => resolve("chat.postMessage")),
        codes[changed],
      );
    });
  }

  it("does not retain backend secret material in thrown errors or audit", async () => {
    readSecret.mockRejectedValue(new Error(fakeSecret));
    const failure = (await asCaller(caller(), () => resolve()).catch((error: unknown) => error)) as Error;
    expect(failure.message).not.toContain("fixture-only");
    expect(failure.cause).toBeUndefined();
    expect(JSON.stringify(audits())).not.toContain("fixture-only");
  });
});
