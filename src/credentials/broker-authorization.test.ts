import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { generateKeyPairSync, sign } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import * as approvalService from "../approval/service.js";
import { getApprovalRequest, claimApprovalDecision } from "../approval/store.js";
import { seedApprovalContact } from "../approval/test-support.js";
import { setApprovalGrantorRouterConfigForTest } from "../channels/slack/grantors.js";
import { getOrCreateSession } from "../router/sessions.js";
import { buildRuntimeRequestContext } from "../runtime/runtime-request-context.js";
import { buildSessionRelayTurnOrigin } from "../runtime/turn-origin.js";
import * as contacts from "../contacts.js";
import * as providerRuntime from "../permissions/provider-runtime.js";
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
  getDb,
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
import { actorHoldsCredentialAction } from "./authorization.js";
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
  approvalService.setApprovalServiceDependenciesForTest();
  setApprovalGrantorRouterConfigForTest();
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

  it("runs the additional host guard after approval and before reading any secret", async () => {
    const order: string[] = [];
    spyOn(approvalService, "requestCascadingApproval").mockImplementation(async () => {
      order.push("approval");
      return { approved: true, isDelegated: false };
    });
    await expect(
      asCaller(caller(), () =>
        resolveCredentialSecret({
          provider: "slack",
          connection: "fixture",
          action: "chat.postMessage",
          beforeResolve: async () => {
            order.push("guard");
            throw new Error("member removed");
          },
        }),
      ),
    ).rejects.toThrow();
    expect(order).toEqual(["approval", "guard"]);
    expect(readSecret).not.toHaveBeenCalled();
  });
  it("revalidates a connection disabled while the host guard awaited membership", async () => {
    await expect(
      asCaller(caller(), () =>
        resolveCredentialSecret({
          provider: "slack",
          connection: "fixture",
          action: "auth.check",
          beforeResolve: async () => {
            setCredentialConnectionStatus("slack", "fixture", "disabled");
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "connection_disabled" });
    expect(readSecret).not.toHaveBeenCalled();
  });

  it("does not retain backend secret material in thrown errors or audit", async () => {
    readSecret.mockRejectedValue(new Error(fakeSecret));
    const failure = (await asCaller(caller(), () => resolve()).catch((error: unknown) => error)) as Error;
    expect(failure.message).not.toContain("fixture-only");
    expect(failure.cause).toBeUndefined();
    expect(JSON.stringify(audits())).not.toContain("fixture-only");
  });
});

describe("credential approval on the author's own turn", () => {
  const contactId = "c-operator";
  const humanTurn = {
    actorResolution: "resolved",
    actorPrincipal: `contact:${contactId}`,
    turnProvenance: { origin: "human" },
  };
  const holds = [
    { permission: "use", objectType: "credential", objectId: "slack:fixture" },
    { permission: "execute", objectType: "slack", objectId: "*" },
  ];

  function author(
    capabilities = holds,
    contact: Record<string, unknown> | null = { id: contactId, status: "allowed" },
  ) {
    spyOn(contacts, "getContactById").mockImplementation((id: string) =>
      contact && id === contactId ? (contact as never) : null,
    );
    const original = providerRuntime.materializeSubjectCapabilities;
    spyOn(providerRuntime, "materializeSubjectCapabilities").mockImplementation(((type: string, id: string) =>
      type === "contact" && id === contactId ? capabilities : original(type as never, id)) as never);
  }

  function turn(metadata: Record<string, unknown>) {
    setLiveCapabilities([useCapability, readCapability, writeCapability, ...destructiveCapabilities]);
    return caller([useCapability, readCapability, writeCapability, ...destructiveCapabilities], { metadata });
  }

  const destructiveCapabilities = [
    "conversations.create",
    "conversations.archive",
    "conversations.kick",
    "canvases.edit",
    "reactions.remove",
    "pins.remove",
    "bookmarks.remove",
    "chat.delete",
  ].map((objectId) => ({
    permission: "execute",
    objectType: "slack",
    objectId,
  }));

  it("lets the author's own write through without a card and audits it", async () => {
    author();
    const approval = spyOn(approvalService, "requestCascadingApproval");
    await asCaller(turn(humanTurn), () => resolve("conversations.create"));
    expect(approval).not.toHaveBeenCalled();
    expect(readSecret).toHaveBeenCalledTimes(1);
    expect(audits().at(-1)).toMatchObject({
      action: "conversations.create",
      decision: "allow",
      approval_required: 1,
      approval_status: "actor_authorized",
      result_status: "secret_resolved",
    });
  });

  for (const action of ["conversations.archive", "conversations.kick", "chat.delete"]) {
    it(`still asks for ${action} on the author's own turn`, async () => {
      author();
      const approval = spyOn(approvalService, "requestCascadingApproval").mockResolvedValue({
        approved: false,
        isDelegated: false,
      } as never);
      await denied(
        asCaller(turn(humanTurn), () => resolve(action)),
        "approval_denied",
      );
      expect(approval).toHaveBeenCalledTimes(1);
    });
  }

  it("asks for a write its caller marks destructive even on the author's own turn", async () => {
    author();
    const approval = spyOn(approvalService, "requestCascadingApproval").mockResolvedValue({
      approved: false,
      isDelegated: false,
    } as never);
    await denied(
      asCaller(turn(humanTurn), () =>
        resolveCredentialSecret({
          provider: "slack",
          connection: "fixture",
          action: "canvases.edit",
          destructive: true,
        }),
      ),
      "approval_denied",
    );
    expect(approval).toHaveBeenCalledTimes(1);
    expect(audits().some((row) => row.approval_status === "actor_authorized")).toBe(false);
  });

  it("lets the same canvases.edit through on the author's own turn when nothing is removed", async () => {
    author();
    const approval = spyOn(approvalService, "requestCascadingApproval");
    await asCaller(turn(humanTurn), () => resolve("canvases.edit"));
    expect(approval).not.toHaveBeenCalled();
    expect(audits().at(-1)).toMatchObject({ action: "canvases.edit", approval_status: "actor_authorized" });
  });

  for (const action of ["reactions.remove", "pins.remove", "bookmarks.remove"]) {
    it(`still asks for ${action} on the author's own turn`, async () => {
      author();
      const approval = spyOn(approvalService, "requestCascadingApproval").mockResolvedValue({
        approved: false,
        isDelegated: false,
      } as never);
      await denied(
        asCaller(turn(humanTurn), () => resolve(action)),
        "approval_denied",
      );
      expect(approval).toHaveBeenCalledTimes(1);
    });
  }

  const asks: Array<[string, Record<string, unknown>, (() => void) | undefined]> = [
    ["a cron or trigger carrying its owner", { ...humanTurn, turnProvenance: { origin: "cron" } }, undefined],
    ["an agent-origin turn", { ...humanTurn, turnProvenance: { origin: "agent" } }, undefined],
    ["a system-origin turn", { ...humanTurn, turnProvenance: { origin: "system" } }, undefined],
    ["an unknown-origin turn", { ...humanTurn, turnProvenance: { origin: "unknown" } }, undefined],
    ["a turn without provenance", { actorResolution: "resolved", actorPrincipal: `contact:${contactId}` }, undefined],
    ["an agent relay", { ...humanTurn, actorPrincipal: "agent:other" }, undefined],
    ["an unresolved speaker", { ...humanTurn, actorResolution: "missing_contact" }, undefined],
    ["a thread acting for its parent", { ...humanTurn, actorProjection: { sourceContextId: "ctx_parent" } }, undefined],
    ["an author without the action", humanTurn, () => author([holds[0]!])],
    ["a blocked author", humanTurn, () => author(holds, { id: contactId, status: "blocked" })],
  ];
  for (const [label, metadata, setup] of asks) {
    it(`never skips the card for a write from ${label}`, async () => {
      (setup ?? author)();
      spyOn(approvalService, "requestCascadingApproval").mockResolvedValue({
        approved: false,
        isDelegated: false,
      } as never);
      // Refused either by the card or, earlier, by the caller check.
      await expect(asCaller(turn(metadata), () => resolve("conversations.create"))).rejects.toMatchObject({
        code: expect.stringMatching(/^(approval_denied|caller_invalid)$/),
      });
      expect(readSecret).not.toHaveBeenCalled();
      expect(audits().some((row) => row.approval_status === "actor_authorized")).toBe(false);
    });
  }

  it("grants the exception only for Slack", () => {
    author([
      ...holds,
      { permission: "use", objectType: "credential", objectId: "github:fixture" },
      { permission: "execute", objectType: "github", objectId: "*" },
    ]);
    const context = turn(humanTurn);
    expect(
      actorHoldsCredentialAction(context, { provider: "slack", connection: "fixture", action: "chat.postMessage" }),
    ).toBe(true);
    expect(
      actorHoldsCredentialAction(context, { provider: "github", connection: "fixture", action: "repos.update" }),
    ).toBe(false);
  });

  it("keeps only a fixed refusal reason as the error detail", async () => {
    const fixed = "Timeout — nenhuma resposta em 5 minutos.";
    const leaked = "Error: connect ECONNREFUSED vault.internal:8200 token=s.fixture-only";
    const approval = spyOn(approvalService, "requestCascadingApproval");

    approval.mockResolvedValueOnce({ approved: false, reason: fixed, isDelegated: false } as never);
    await expect(asCaller(caller(), () => resolve("chat.postMessage"))).rejects.toMatchObject({
      code: "approval_denied",
      detail: fixed,
    });

    approval.mockResolvedValueOnce({ approved: false, reason: leaked, isDelegated: false } as never);
    const error = await asCaller(caller(), () => resolve("chat.postMessage")).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "approval_denied" });
    expect((error as { detail?: string }).detail).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain("fixture-only");
  });

  it("reads conversation history without asking anyone", async () => {
    const approval = spyOn(approvalService, "requestCascadingApproval");
    setLiveCapabilities([
      useCapability,
      { permission: "execute", objectType: "slack", objectId: "conversations.history" },
    ]);
    await asCaller(
      caller([useCapability, { permission: "execute", objectType: "slack", objectId: "conversations.history" }]),
      () => resolve("conversations.history"),
    );
    expect(approval).not.toHaveBeenCalled();
    expect(audits().at(-1)).toMatchObject({ approval_required: 0, result_status: "secret_resolved" });
  });
});

describe("credential approval origin and caller lifetime", () => {
  it("explains a genuinely missing approval source", async () => {
    await expect(asCaller(caller(), () => resolve("chat.postMessage"))).rejects.toMatchObject({
      code: "approval_denied",
      detail: "Não há chat de origem para pedir aprovação.",
    });
    expect(readSecret).not.toHaveBeenCalled();
  });

  it("fails closed with a fixed diagnostic when the origin adapter cannot deliver approval", async () => {
    let requestId = "";
    approvalService.setApprovalServiceDependenciesForTest({
      nats: {
        emit: async () => {},
        subscribe: (() =>
          (async function* () {})()) as approvalService.ApprovalServiceDependencies["nats"]["subscribe"],
      },
      requestReply: (async (_topic: string, data: Record<string, unknown>) => {
        requestId = String(data.approvalRequestId);
        throw new Error("no adapter, private transport detail");
      }) as approvalService.ApprovalServiceDependencies["requestReply"],
    });
    await expect(
      asCaller(caller(undefined, { source: { channel: "unsupported", accountId: "main", chatId: "origin" } }), () =>
        resolve("chat.postMessage"),
      ),
    ).rejects.toMatchObject({
      code: "approval_denied",
      detail: approvalService.APPROVAL_REFUSAL_REASON.sendFailed,
    });
    expect(getApprovalRequest(requestId)?.status).toBe("expired");
    expect(readSecret).not.toHaveBeenCalled();
  });

  for (const channel of ["slack", "whatsapp"]) {
    for (const end of ["revoke", "expire", "delete", "ttl"] as const) {
      it(`${channel}: relay opens a card at its origin and ${end} cancels it before a late approval`, async () => {
        setApprovalGrantorRouterConfigForTest(() => ({ instances: {}, instanceToAccount: {} }));
        seedApprovalContact({
          phone: "5511987009699",
          name: "Approver",
          tags: ["permission-admin"],
          slack: { userId: "UAPPROVER", instanceId: "main" },
        });
        const source = { channel, accountId: "main", chatId: "origin-chat", threadId: "origin-thread" };
        getOrCreateSession("agent:broker-test-agent:origin", agentId, stateDir, { name: "broker-origin" });
        getOrCreateSession("agent:broker-test-agent:relay", agentId, stateDir, { name: "broker-relay" });
        const origin = caller(undefined, { source, sessionKey: "agent:broker-test-agent:origin" });
        const { runtimeContext: context } = buildRuntimeRequestContext({
          dbSessionKey: "agent:broker-test-agent:relay",
          sessionName: "broker-relay",
          sessionCwd: stateDir,
          agent: { id: agentId, cwd: stateDir },
          prompt: {
            prompt: "send the document",
            _turnOrigin: buildSessionRelayTurnOrigin("execute", {
              agentId,
              contextId: origin.contextId,
              sessionKey: origin.sessionKey,
            }),
          },
          runtimeProviderId: "codex",
          model: "test-model",
          runtimeResolution: {
            options: {},
            sources: { model: null, effort: null, thinking: null },
            hasTaskRuntimeContext: false,
          },
        });
        if (end === "ttl") {
          context.expiresAt = Date.now() + 300;
          getDb()
            .prepare("UPDATE contexts SET expires_at = ? WHERE context_id = ?")
            .run(context.expiresAt, context.contextId);
        }
        expect(context.source).toEqual(source);
        expect(context.metadata?.actorPrincipal).toBe(`agent:${agentId}`);
        let requestId = "";
        let delivered!: () => void;
        const delivery = new Promise<void>((resolve) => {
          delivered = resolve;
        });
        const finalized: string[] = [];
        approvalService.setApprovalServiceDependenciesForTest({
          now: Date.now,
          requestReply: (async (_topic: string, data: Record<string, unknown>) => {
            if (_topic === "ravi.outbound.approval.finalize") {
              finalized.push(String(data.requestId));
              return { success: true };
            }
            requestId = String(data.approvalRequestId);
            expect(data).toMatchObject({ channel, to: source.chatId, threadId: source.threadId });
            expect(getApprovalRequest(requestId)).toMatchObject({
              status: "pending",
              callerContextId: context.contextId,
            });
            expect(getApprovalRequest(requestId)!.expiresAt).toBeLessThanOrEqual(context.expiresAt!);
            delivered();
            return { messageId: "card-1" };
          }) as approvalService.ApprovalServiceDependencies["requestReply"],
          nats: {
            emit: async () => {},
            subscribe: (() =>
              (async function* () {})()) as approvalService.ApprovalServiceDependencies["nats"]["subscribe"],
          },
          finalizeSlackApproval: async (input) => {
            finalized.push(input.requestId);
          },
        });
        const result = asCaller(context, () => resolve("chat.postMessage")).catch((error) => error);
        await delivery;
        expect(readSecret).not.toHaveBeenCalled();
        if (end === "revoke") revokeRuntimeContext(context.contextId);
        else if (end === "delete") dbDeleteContext(context.contextId);
        else if (end === "expire") {
          getDb()
            .prepare("UPDATE contexts SET expires_at = ? WHERE context_id = ?")
            .run(Date.now() - 1, context.contextId);
        }
        if (end === "ttl") await result;
        if (end === "revoke" || end === "delete") {
          expect(getDb().query("SELECT status FROM approval_requests WHERE id = ?").get(requestId)).toEqual({
            status: "expired",
          });
        }
        // The durable request is terminal even before the waiter sees a click.
        expect(getApprovalRequest(requestId)).toMatchObject({ status: "expired", decision: null });
        expect(
          claimApprovalDecision({ id: requestId, decision: "approved", decidedBy: "UAPPROVER", now: Date.now() }),
        ).toBeNull();
        expect(await result).toMatchObject({
          code: "caller_invalid",
          detail: expect.stringContaining("nova tentativa"),
        });
        expect(readSecret).not.toHaveBeenCalled();
        expect(finalized).toContain(requestId);
      });
    }
  }
});
