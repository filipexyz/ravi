import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { generateKeyPairSync, sign as signPayload } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PrCommands } from "./pr.js";
import { buildRegistry } from "../registry-snapshot.js";
import { PUBLICATION_CONTEXT_REQUIRED_MESSAGE } from "../../pr/contracts.js";
import {
  canonicalize,
  EXTERNAL_AUTHORITY_ASSERTION_SETTING,
  EXTERNAL_AUTHORITY_PUBKEY_SETTING,
  resetExternalAuthorityCacheForTests,
} from "../../permissions/external-authority-provider.js";
import { PERMISSION_PROVIDER_IDS_SETTING } from "../../permissions/provider-registry.js";
import * as permissionDenials from "../../permissions/denials.js";
import {
  flushPermissionAuditEvents,
  listPermissionDenials,
  setPermissionAuditPublisherForTest,
} from "../../permissions/denials.js";
import { dbSetSetting, getDb, type ContextRecord } from "../../router/router-db.js";
import { dispatch } from "../../sdk/gateway/dispatcher.js";
import {
  cleanupIsolatedRaviState,
  createIsolatedRaviState,
  RAVI_RUNTIME_CONTEXT_ENV_KEYS,
} from "../../test/ravi-state.js";

const environmentKeys = [...RAVI_RUNTIME_CONTEXT_ENV_KEYS, "RAVI_CLI_FORCE_LOCAL_OPERATOR", "RAVI_CREDENTIALS_PATH"];
let state: string | null = null;
let savedEnv: Record<string, string | undefined>;
let permissionAudits: Array<{ topic: string; data: Record<string, unknown> }>;

beforeEach(async () => {
  state = await createIsolatedRaviState("ravi-pr-approval-");
  savedEnv = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  for (const key of environmentKeys) delete process.env[key];
  process.env.RAVI_CREDENTIALS_PATH = join(state, "credentials.json");
  permissionAudits = [];
  setPermissionAuditPublisherForTest((topic, data) => {
    permissionAudits.push({ topic, data });
  });
  delete process.env.RAVI_SUPPRESS_AUDIT_EVENTS;
  resetExternalAuthorityCacheForTests();
});

afterEach(async () => {
  await flushPermissionAuditEvents();
  setPermissionAuditPublisherForTest();
  resetExternalAuthorityCacheForTests();
  await cleanupIsolatedRaviState(state);
  state = null;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("pr publish approval through the gateway dispatcher", () => {
  it("requires approved authenticated session execution in the response and both denial audit surfaces", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const payload = {
      iss: "issuer",
      sub: "agent:dev",
      exp: Math.floor(Date.now() / 1000) + 60,
      scope: [
        { permission: "mutate", objectType: "pr", objectId: "publish", requiresApproval: true },
        { permission: "execute", objectType: "group", objectId: "pr" },
      ],
    };
    const sig = signPayload(null, Buffer.from(canonicalize(payload)), privateKey).toString("base64");
    const assertionPath = join(state!, "assertion.json");
    writeFileSync(assertionPath, JSON.stringify({ ...payload, sig }));
    dbSetSetting(PERMISSION_PROVIDER_IDS_SETTING, "external-authority");
    dbSetSetting(EXTERNAL_AUTHORITY_ASSERTION_SETTING, assertionPath);
    dbSetSetting(EXTERNAL_AUTHORITY_PUBKEY_SETTING, publicKey.export({ type: "spki", format: "pem" }).toString());
    resetExternalAuthorityCacheForTests();

    const contextRecord: ContextRecord = {
      contextId: "ctx_pr_approval_test",
      contextKey: "rctx_pr_approval_test",
      kind: "turn-runtime",
      agentId: "dev",
      sessionKey: "agent:dev:pr-approval-test",
      sessionName: "pr-approval-test",
      capabilities: [],
      metadata: { authorityMode: "delegated" },
      createdAt: Date.now(),
    };
    const command = buildRegistry([PrCommands]).commands.find((entry) => entry.fullName === "pr.publish")!;
    const handler = spyOn(PrCommands.prototype, "publish");
    const recordDenial = spyOn(permissionDenials, "recordAndEmitPermissionDenial");
    try {
      const { response } = await dispatch(
        command,
        { repo: "o/r", base: "dev", execute: true },
        {},
        { contextRecord, emitAudit: () => {} },
      );
      await flushPermissionAuditEvents();

      expect(response.status).toBe(403);
      const body = (await response.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("PERMISSION_DENIED");
      expect(body.error.message).toContain("Approval required");
      expect(body.error.message).toContain("external_authority_requires_approval");

      const denials = listPermissionDenials({ subjectType: "agent", subjectId: "dev" });
      expect(denials).toHaveLength(1);
      expect(denials[0]).toMatchObject({
        relation: "mutate",
        objectType: "pr",
        objectId: "publish",
        contextId: contextRecord.contextId,
        sessionKey: contextRecord.sessionKey,
      });
      // Observe the input without replacing persistence, emission or redaction.
      expect(recordDenial).toHaveBeenCalledTimes(1);
      const recorded = recordDenial.mock.calls[0]![0];
      const detailGuidance = recorded.detail!.guidance as { message: string };
      const auditGuidance = recorded.audit.guidance as { recommendedPath: string };
      expect(auditGuidance.recommendedPath).toBe(detailGuidance.message);
      expect(body.error.message).toContain(detailGuidance.message);
      expect(denials[0]!.detail!.guidance).toMatchObject({
        message: `[REDACTED:content length=${detailGuidance.message.length}]`,
      });
      expect(permissionAudits).toHaveLength(1);
      expect(permissionAudits[0]).toMatchObject({
        topic: "ravi.audit.denied",
        data: {
          blockType: "cli_command_access_needs_approval",
          denied: "mutate:pr:publish",
          denialId: denials[0]!.id,
          guidance: { recommendedPath: "[REDACTED:path]" },
        },
      });
      for (const message of [body.error.message, detailGuidance.message, auditGuidance.recommendedPath]) {
        expect(message).toContain(PUBLICATION_CONTEXT_REQUIRED_MESSAGE);
        expect(message).toContain("gateway/agent");
        expect(message).toContain("authorized runtime context");
        expect(message).toContain("ask the authority to reissue the scope without requiresApproval");
        expect(message).not.toContain("or have the operator run it");
      }

      expect(handler).not.toHaveBeenCalled();
      expect(
        getDb().query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'pr_publication_%'").all(),
      ).toHaveLength(0);
    } finally {
      handler.mockRestore();
      recordDenial.mockRestore();
    }
  });
});
