import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setApprovalGrantorRouterConfigForTest } from "../../approval/grantor.js";
import { seedApprovalContact } from "../../approval/test-support.js";
import {
  createIntakeRequest,
  getIntakeRequest,
  storeIntakeSecret,
  IntakeError,
  type IntakeMetadata,
} from "../../credentials/intake.js";
import { getCredentialConnection } from "../../credentials/store.js";
import { dbCreateAgent, dbSetSetting, dbUpdateAgent, getDb } from "../../router/router-db.js";
import {
  canonicalize,
  EXTERNAL_AUTHORITY_ASSERTION_SETTING,
  EXTERNAL_AUTHORITY_PUBKEY_SETTING,
  resetExternalAuthorityCacheForTests,
} from "../../permissions/external-authority-provider.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import type { SlackWebApiClient } from "./client.js";
import { getSlackInboundEnvelope } from "./inbound-inbox.js";
import { SlackSocketModeService } from "./socket-mode.js";
import {
  buildCredentialIntakeModal,
  CREDENTIAL_INTAKE_OPEN,
  CREDENTIAL_INTAKE_SECRET_ACTION,
  CREDENTIAL_INTAKE_SECRET_BLOCK,
  CREDENTIAL_INTAKE_SUBMIT,
  CREDENTIAL_INTAKE_APP_BLOCK,
  CREDENTIAL_INTAKE_BOT_BLOCK,
  handleCredentialIntakeEnvelope,
  type CredentialIntakeDependencies,
} from "./credential-intake.js";
import type { SlackSocketEnvelope } from "./types.js";

const SECRET = "test-only-revocable-token-no-production-12345";
const RESPONSE_URL = "https://hooks.slack.com/actions/T1/B1/test-response-url-token";
const metadata: IntakeMetadata = {
  target: "env:ANTHROPIC_API_KEY",
  accountId: "slack-test",
  teamId: "T1",
  userId: "U1",
  channelId: "C1",
  reason: "Conectar o serviço solicitado",
};
let stateDir: string | null = null;
let previousApiKey: string | undefined;

function submission(id: string, patch: Record<string, unknown> = {}): SlackSocketEnvelope {
  return {
    envelope_id: "envelope-submission",
    type: "interactive",
    accepts_response_payload: true,
    payload: {
      type: "view_submission",
      team: { id: "T1" },
      user: { id: "U1" },
      response_url: RESPONSE_URL,
      view: {
        id: "V1",
        callback_id: CREDENTIAL_INTAKE_SUBMIT,
        private_metadata: id,
        state: {
          values: {
            [CREDENTIAL_INTAKE_SECRET_BLOCK]: {
              [CREDENTIAL_INTAKE_SECRET_ACTION]: { type: "plain_text_input", value: SECRET },
            },
          },
        },
      },
      ...patch,
    },
  };
}

function databaseSnapshot(): string {
  const names = getDb().query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
  return JSON.stringify(
    names.map(({ name }) => [
      name,
      getDb()
        .query(`SELECT * FROM "${name.replaceAll('"', '""')}"`)
        .all(),
    ]),
  );
}

function harness(
  options: {
    authorized?: () => boolean;
    realAuthorization?: boolean;
    enabled?: boolean;
    store?: typeof storeIntakeSecret;
    dependencies?: Partial<CredentialIntakeDependencies>;
  } = {},
) {
  const ack = mock(async (_id: string, _payload?: Record<string, unknown>) => {});
  const updates: Record<string, unknown>[] = [];
  const opens: Record<string, unknown>[] = [];
  const published: unknown[] = [];
  const prompts: unknown[] = [];
  const feedback: unknown[] = [];
  const client = {
    viewsOpen: mock(async ({ view }: { view: Record<string, unknown> }) => {
      opens.push(view);
      return { ok: true, view: { id: "V1" } };
    }),
    viewsUpdate: mock(async ({ view }: { view: Record<string, unknown> }) => {
      updates.push(view);
      return { ok: true, view: { id: "V1" } };
    }),
    postEphemeral: mock(async (input: Record<string, unknown>) => {
      feedback.push(input);
      return { channel: "C1", ts: "1.1", messageId: "1.1", raw: { ok: true } };
    }),
  } as unknown as SlackWebApiClient;
  const service = new SlackSocketModeService({
    appToken: "test-app",
    botToken: "test-bot",
    accountId: "slack-test",
    instanceId: "slack-test",
    webClient: client,
    credentialIntakeEnabled: options.enabled,
    credentialIntakeDependencies: {
      ...(options.realAuthorization
        ? {}
        : { authorize: () => (options.authorized?.() === false ? null : "contact-1") }),
      ...(options.store ? { store: options.store } : {}),
      ...options.dependencies,
    },
    publishInteraction: async (...args) => {
      published.push(args);
    },
    publishPrompt: async (...args) => {
      prompts.push(args);
    },
    getRouterConfig: () => {
      throw new Error("Sensitive intake must not route a message");
    },
  });
  async function open(id: string) {
    const envelope: SlackSocketEnvelope = {
      envelope_id: "envelope-open",
      type: "interactive",
      payload: {
        type: "block_actions",
        team: { id: "T1" },
        user: { id: "U1" },
        channel: { id: "C1" },
        trigger_id: "fresh-trigger",
        actions: [{ action_id: CREDENTIAL_INTAKE_OPEN, value: id }],
        response_url: RESPONSE_URL,
      },
    };
    await service.handleEnvelope(envelope, ack);
    return envelope;
  }
  return { service, client, ack, opens, updates, published, prompts, feedback, open };
}

describe("Slack private credential intake boundary", () => {
  beforeEach(async () => {
    previousApiKey = process.env.ANTHROPIC_API_KEY;
    stateDir = await createIsolatedRaviState("ravi-slack-intake-");
    setApprovalGrantorRouterConfigForTest(() => null);
    resetExternalAuthorityCacheForTests();
  });
  afterEach(async () => {
    if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousApiKey;
    setApprovalGrantorRouterConfigForTest();
    resetExternalAuthorityCacheForTests();
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("stores an allowlisted env secret through the modal without publishing, tracing or persisting its payload", async () => {
    const request = createIntakeRequest(metadata);
    const h = harness({
      store: (claimed, secret) =>
        storeIntakeSecret(claimed, secret, {
          getEnvKey: () => ({
            key: "ANTHROPIC_API_KEY",
            present: false,
            processPresent: false,
            origin: "absent",
            secret: true,
            redacted: true,
            value: null,
            path: "isolated",
          }),
        }),
    });
    await h.open(request.id);
    const envelope = submission(request.id);
    const payloadReference = envelope.payload;
    await h.service.handleEnvelope(envelope, h.ack);
    expect(readFileSync(join(stateDir!, ".env"), "utf8")).toContain(SECRET);
    expect(getIntakeRequest(request.id)?.status).toBe("stored");
    expect(h.updates).toHaveLength(1);
    expect(JSON.stringify(h.updates)).toContain("Fingerprint");
    expect(h.published).toEqual([]);
    expect(h.prompts).toEqual([]);
    expect(getSlackInboundEnvelope("slack-test", "envelope-submission")).toBeNull();
    const visibleAndPersistent =
      JSON.stringify([payloadReference, h.ack.mock.calls, h.opens, h.updates, h.published, h.prompts]) +
      databaseSnapshot();
    expect(visibleAndPersistent).not.toContain(SECRET);
    expect(visibleAndPersistent).not.toContain(RESPONSE_URL);
    expect(h.ack.mock.calls[1]?.[1]).toMatchObject({ response_action: "update" });
    expect(JSON.stringify(h.ack.mock.calls[1]?.[1])).not.toContain("plain_text_input");
  });

  it("stores a provider connection using its existing parser and secret backend only", async () => {
    const request = createIntakeRequest({ ...metadata, target: "connection:slack:test", backend: "keychain" });
    const secret = JSON.stringify({ appToken: "xapp-test-only-123456789", botToken: "xoxb-test-only-123456789" });
    let backendValue: string | undefined;
    const h = harness({
      store: (claimed, value) =>
        storeIntakeSecret(claimed, value, {
          writeSecret: async (input) => {
            backendValue = input.secret;
            return "keychain:test/slack:test";
          },
        }),
    });
    await h.open(request.id);
    const envelope = submission(request.id);
    const view = (envelope.payload as Record<string, unknown>).view as Record<string, unknown>;
    const tokenFields = JSON.parse(secret) as { appToken: string; botToken: string };
    view.state = {
      values: {
        [CREDENTIAL_INTAKE_APP_BLOCK]: { [CREDENTIAL_INTAKE_SECRET_ACTION]: { value: tokenFields.appToken } },
        [CREDENTIAL_INTAKE_BOT_BLOCK]: { [CREDENTIAL_INTAKE_SECRET_ACTION]: { value: tokenFields.botToken } },
      },
    };
    await h.service.handleEnvelope(envelope, h.ack);
    expect(backendValue).toBe(secret);
    expect(getCredentialConnection("slack", "test")?.secretRef).toBe("keychain:test/slack:test");
    expect(getIntakeRequest(request.id)?.status).toBe("stored");
    expect(databaseSnapshot() + JSON.stringify([h.ack.mock.calls, h.updates, envelope])).not.toContain(secret);
    expect(databaseSnapshot() + JSON.stringify([h.ack.mock.calls, h.updates, envelope])).not.toContain(
      tokenFields.appToken,
    );
    expect(databaseSnapshot() + JSON.stringify([h.ack.mock.calls, h.updates, envelope])).not.toContain(
      tokenFields.botToken,
    );
    expect(h.published).toEqual([]);
    expect(h.prompts).toEqual([]);
  });

  it("refuses replay, identity spoofing, expiration and a revoked human permission", async () => {
    const writes: string[] = [];
    let authorized = true;
    const h = harness({
      authorized: () => authorized,
      store: async (_request, value) => {
        writes.push(value);
        return { fingerprint: "a".repeat(64), daemonReloadRequired: false };
      },
    });
    const request = createIntakeRequest(metadata);
    await h.open(request.id);
    await h.service.handleEnvelope(submission(request.id, { user: { id: "U2" } }), h.ack);
    await h.service.handleEnvelope(submission(request.id, { team: { id: "T2" } }), h.ack);
    authorized = false;
    await h.service.handleEnvelope(submission(request.id), h.ack);
    expect(writes).toEqual([]);
    authorized = true;
    await h.service.handleEnvelope(submission(request.id), h.ack);
    await h.service.handleEnvelope(submission(request.id), h.ack);
    expect(writes).toEqual([SECRET]);
    const expired = createIntakeRequest(
      { ...metadata, target: "env:ANTHROPIC_AUTH_TOKEN" },
      { now: Date.now() - 700_000 },
    );
    await h.open(expired.id);
    await h.service.handleEnvelope(submission(expired.id), h.ack);
    expect(writes).toEqual([SECRET]);
    expect(h.published).toEqual([]);
  });

  it("scrubs before ACK and contains malicious backend errors without logging their content", async () => {
    const request = createIntakeRequest(metadata);
    const h = harness({
      store: async () => {
        throw new Error(`backend accidentally echoed ${SECRET} ${RESPONSE_URL}`);
      },
    });
    await h.open(request.id);
    const envelope = submission(request.id);
    const viewReference = (envelope.payload as Record<string, unknown>).view;
    const logs: unknown[] = [];
    const loggers = (["error", "warn", "info", "log"] as const).map((level) =>
      spyOn(console, level).mockImplementation((...args) => {
        logs.push(args);
      }),
    );
    try {
      await h.service.handleEnvelope(envelope, async (_id, response) => {
        expect(JSON.stringify([envelope, viewReference])).not.toContain(SECRET);
        expect(JSON.stringify(response)).not.toContain(SECRET);
      });
    } finally {
      for (const logger of loggers) logger.mockRestore();
    }
    expect(JSON.stringify([h.updates, logs]) + databaseSnapshot()).not.toContain(SECRET);
    expect(JSON.stringify([h.updates, logs]) + databaseSnapshot()).not.toContain(RESPONSE_URL);
    expect(h.published).toEqual([]);
    expect(h.updates).toHaveLength(1);
    expect(JSON.stringify(h.updates)).toContain("Não envie o token de novo");
    expect(JSON.stringify(h.updates)).not.toContain("Solicite um novo convite");
    expect(getIntakeRequest(request.id)?.status).toBe("pending");
  });

  it("rechecks the issuer's live provider authority on submission after opening the modal", async () => {
    seedApprovalContact({
      phone: "5511987009602",
      name: "Intake owner",
      tags: ["permission.owner"],
      slack: { userId: "U1", instanceId: "slack-test" },
    });
    dbCreateAgent({ id: "intake-issuer", cwd: stateDir! });
    dbUpdateAgent("intake-issuer", {
      defaults: { runtimePermissions: { capabilities: [`mutate:credentials.requests:${metadata.target}`] } },
    });
    const request = createIntakeRequest({ ...metadata, issuerAgentId: "intake-issuer" });
    const store = mock(async () => {
      throw new Error("Denied submission must not reach store");
    });
    const h = harness({ realAuthorization: true, store });
    await h.open(request.id);
    expect(h.opens).toHaveLength(1);
    dbSetSetting("permissions.provider_ids", "external-authority");
    const envelope = submission(request.id);
    await h.service.handleEnvelope(envelope, h.ack);
    expect(store).not.toHaveBeenCalled();
    expect(h.published).toEqual([]);
    expect(h.prompts).toEqual([]);
    expect(getIntakeRequest(request.id)?.status).toBe("open");
    expect(getSlackInboundEnvelope("slack-test", "envelope-submission")).toBeNull();
    expect(JSON.stringify([envelope, h.ack.mock.calls, h.updates]) + databaseSnapshot()).not.toContain(SECRET);
    expect(JSON.stringify([envelope, h.ack.mock.calls, h.updates]) + databaseSnapshot()).not.toContain(RESPONSE_URL);
  });

  for (const verdict of ["deny", "needs_approval"] as const) {
    it(`rejects a human's external ${verdict} through the real default authorization boundary`, async () => {
      const contact = seedApprovalContact({
        phone: "5511987009602",
        name: "Intake owner",
        tags: ["permission.owner"],
        slack: { userId: "U1", instanceId: "slack-test" },
      });
      const request = createIntakeRequest(metadata);
      const store = mock(async () => {
        throw new Error("Denied submission must not reach store");
      });
      const h = harness({ realAuthorization: true, store });
      await h.open(request.id);
      expect(h.opens).toHaveLength(1);
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      const assertion = {
        iss: "test-intake-authority",
        sub: `contact:${contact.id}`,
        exp: Math.floor(Date.now() / 1000) + 60,
        scope: [
          {
            permission: verdict === "deny" ? "read" : "mutate",
            objectType: "credentials.secrets",
            objectId: metadata.target,
            ...(verdict === "needs_approval" ? { requiresApproval: true } : {}),
          },
        ],
      };
      const assertionPath = join(stateDir!, "authority.json");
      writeFileSync(
        assertionPath,
        JSON.stringify({
          ...assertion,
          sig: sign(null, Buffer.from(canonicalize(assertion)), privateKey).toString("base64"),
        }),
      );
      dbSetSetting(EXTERNAL_AUTHORITY_ASSERTION_SETTING, assertionPath);
      dbSetSetting(EXTERNAL_AUTHORITY_PUBKEY_SETTING, publicKey.export({ type: "spki", format: "pem" }).toString());
      dbSetSetting("permissions.provider_ids", "external-authority");
      const envelope = submission(request.id);
      await h.service.handleEnvelope(envelope, h.ack);
      expect(store).not.toHaveBeenCalled();
      expect(h.published).toEqual([]);
      expect(h.prompts).toEqual([]);
      expect(getIntakeRequest(request.id)?.status).toBe("open");
      expect(getSlackInboundEnvelope("slack-test", "envelope-submission")).toBeNull();
      expect(JSON.stringify([envelope, h.ack.mock.calls, h.updates]) + databaseSnapshot()).not.toContain(SECRET);
      expect(JSON.stringify([envelope, h.ack.mock.calls, h.updates]) + databaseSnapshot()).not.toContain(RESPONSE_URL);
    });
  }

  it("consumes malformed reserved callbacks and gateway submissions without generic publication", async () => {
    const h = harness({ enabled: false });
    const envelope = submission("missing");
    await h.service.handleEnvelope(envelope, h.ack);
    const malformed: SlackSocketEnvelope = {
      envelope_id: "malformed",
      payload: {
        type: "view_submission",
        view: { callback_id: "ravi_credential_intake:future", state: { secret: SECRET } },
        response_urls: [{ response_url: RESPONSE_URL }],
      },
    };
    await h.service.handleEnvelope(malformed, h.ack);
    expect(h.published).toEqual([]);
    expect(h.prompts).toEqual([]);
    expect(h.opens).toEqual([]);
    expect(JSON.stringify([envelope, malformed, h.ack.mock.calls])).not.toContain(SECRET);
    expect(JSON.stringify([envelope, malformed, h.ack.mock.calls])).not.toContain(RESPONSE_URL);
  });

  it("releases a claimed target when the ACK fails before any secret write", async () => {
    const request = createIntakeRequest(metadata);
    const store = mock(async () => ({ fingerprint: "a".repeat(64), daemonReloadRequired: true }));
    const h = harness({ store });
    await h.open(request.id);
    await h.service.handleEnvelope(submission(request.id), async () => {
      throw new Error(`ACK failure ${SECRET}`);
    });
    expect(store).not.toHaveBeenCalled();
    expect(getIntakeRequest(request.id)?.status).toBe("failed");
    expect(databaseSnapshot() + JSON.stringify(h.updates)).not.toContain(SECRET);
    expect(
      getDb().query("SELECT count(*) AS count FROM credential_intake_requests WHERE status = 'pending'").get(),
    ).toEqual({ count: 0 });
    expect(h.published).toEqual([]);
  });

  it("removes the secret field if the opened modal cannot be bound", async () => {
    const request = createIntakeRequest(metadata);
    const h = harness({
      dependencies: {
        bindView: () => {
          throw new Error("Concurrent modal binding");
        },
      },
    });
    await h.open(request.id);
    expect(h.opens).toHaveLength(1);
    expect(h.updates).toHaveLength(1);
    expect(JSON.stringify(h.updates)).not.toContain("plain_text_input");
    expect(h.feedback).toHaveLength(1);
    expect(h.feedback[0]).toMatchObject({ channel: "C1", user: "U1" });
    expect(getIntakeRequest(request.id)?.status).toBe("open");
    expect(h.published).toEqual([]);
  });

  it("gives expired invitations private feedback only to the authorized bound human", async () => {
    const expired = createIntakeRequest(metadata, { now: Date.now() - 700_000 });
    const h = harness();
    await h.open(expired.id);
    expect(h.opens).toEqual([]);
    expect(h.feedback).toHaveLength(1);
    const denied = harness({ authorized: () => false });
    await denied.open(expired.id);
    expect(denied.feedback).toEqual([]);
    expect(denied.published).toEqual([]);
  });

  it("consumes a malformed view identified only by its reserved action key", async () => {
    const h = harness();
    const malformed: SlackSocketEnvelope = {
      envelope_id: "malformed-action",
      payload: {
        type: "view_submission",
        view: { state: { values: { changed_block: { [CREDENTIAL_INTAKE_SECRET_ACTION]: { value: SECRET } } } } },
        response_url: RESPONSE_URL,
      },
    };
    await h.service.handleEnvelope(malformed, h.ack);
    expect(h.published).toEqual([]);
    expect(h.prompts).toEqual([]);
    expect(JSON.stringify([malformed, h.ack.mock.calls]) + databaseSnapshot()).not.toContain(SECRET);
    expect(JSON.stringify([malformed, h.ack.mock.calls]) + databaseSnapshot()).not.toContain(RESPONSE_URL);
  });

  it("rejects a forged view id before calling the secret store", async () => {
    const request = createIntakeRequest(metadata);
    const store = mock(async () => ({ fingerprint: "a".repeat(64), daemonReloadRequired: true }));
    const h = harness({ store });
    await h.open(request.id);
    const envelope = submission(request.id);
    ((envelope.payload as Record<string, unknown>).view as Record<string, unknown>).id = "VFORGED";
    await h.service.handleEnvelope(envelope, h.ack);
    expect(store).not.toHaveBeenCalled();
    expect(getIntakeRequest(request.id)?.status).toBe("open");
    expect(h.published).toEqual([]);
    expect(JSON.stringify([envelope, h.ack.mock.calls]) + databaseSnapshot()).not.toContain(SECRET);
  });

  it("does not invite a retry when the write needs reconciliation", async () => {
    const request = createIntakeRequest(metadata);
    const h = harness({
      store: async () => {
        throw new IntakeError("INTAKE_RECONCILIATION_REQUIRED");
      },
    });
    await h.open(request.id);
    await h.service.handleEnvelope(submission(request.id), h.ack);
    expect(getIntakeRequest(request.id)?.status).toBe("pending");
    const visible = JSON.stringify(h.updates);
    expect(visible).toContain("Verificar gravação");
    expect(visible).toContain("Não envie o token de novo");
    expect(visible).not.toContain("Credencial não salva");
    expect(visible + databaseSnapshot()).not.toContain(SECRET);
  });

  it("falls back to a private receipt if the saved modal cannot refresh", async () => {
    const request = createIntakeRequest(metadata);
    const h = harness({ store: async () => ({ fingerprint: "a".repeat(64), daemonReloadRequired: true }) });
    await h.open(request.id);
    h.client.viewsUpdate = mock(async () => {
      throw new Error("view closed before completion");
    });
    await h.service.handleEnvelope(submission(request.id), h.ack);
    expect(h.feedback).toHaveLength(1);
    expect(h.feedback[0]).toMatchObject({ user: "U1", channel: "C1" });
    expect(JSON.stringify(h.feedback)).toContain("Credencial salva");
    expect(JSON.stringify(h.feedback)).toContain("aaaaaaaaaaaa");
    expect(JSON.stringify(h.feedback)).not.toContain(SECRET);
    expect(h.published).toEqual([]);
  });

  it("cancellation consumes the request, and the modal has no prefill or keystroke dispatch", async () => {
    const request = createIntakeRequest(metadata);
    const modal = buildCredentialIntakeModal(request);
    const serialized = JSON.stringify(modal);
    expect(serialized).not.toContain("initial_value");
    expect(serialized).not.toContain("dispatch_action");
    expect((modal.blocks as { type: string }[]).filter((block) => block.type === "input")).toHaveLength(1);
    const h = harness();
    await h.open(request.id);
    await h.service.handleEnvelope(submission(request.id, { type: "view_closed" }), h.ack);
    expect(getIntakeRequest(request.id)?.status).toBe("cancelled");
    await h.service.handleEnvelope(submission(request.id), h.ack);
    expect(getIntakeRequest(request.id)?.status).toBe("cancelled");
    expect(h.published).toEqual([]);
  });

  it("asks for named Slack tokens without exposing the serialized storage format", () => {
    const request = createIntakeRequest({ ...metadata, target: "connection:slack:test", backend: "file" });
    const modal = buildCredentialIntakeModal(request);
    const serialized = JSON.stringify(modal);
    expect((modal.blocks as { type: string }[]).filter((block) => block.type === "input")).toHaveLength(2);
    expect(serialized).toContain("Token do app");
    expect(serialized).toContain("Token do bot");
    expect(serialized).not.toContain("JSON");
    expect(serialized).not.toContain("initial_value");
    expect(serialized).not.toContain("dispatch_action");
  });

  it("leaves ordinary interactions to their existing handler", async () => {
    expect(
      await handleCredentialIntakeEnvelope({
        envelope: { payload: { type: "block_actions", actions: [{ action_id: "ordinary" }] } },
        accountId: "slack-test",
        instanceId: "slack-test",
        directSocketMode: true,
        client: {} as never,
        ack: () => {},
      }),
    ).toBe(false);
  });
});
