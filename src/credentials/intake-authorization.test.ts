import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { seedApprovalContact } from "../approval/test-support.js";
import {
  canonicalize,
  EXTERNAL_AUTHORITY_ASSERTION_SETTING,
  EXTERNAL_AUTHORITY_PUBKEY_SETTING,
  resetExternalAuthorityCacheForTests,
} from "../permissions/external-authority-provider.js";
import { canWithCapabilities } from "../permissions/capability-snapshot.js";
import { materializeSubjectCapabilities } from "../permissions/provider-runtime.js";
import { dbCreateAgent, dbSetSetting, dbUpdateAgent } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { authorizeIntakeSubject } from "./intake-authorization.js";

const target = "connection:github:intake-test";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
let stateDir: string | null = null;

describe("credential intake live authorization", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-intake-authority-");
    resetExternalAuthorityCacheForTests();
  });
  afterEach(async () => {
    resetExternalAuthorityCacheForTests();
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  for (const type of ["agent", "contact"] as const) {
    it(`honors external allow, deny and approval for ${type} despite a materialized grant`, () => {
      const resource = type === "agent" ? "credentials.requests" : "credentials.secrets";
      const id =
        type === "agent"
          ? dbCreateAgent({ id: "intake-issuer", cwd: stateDir! }).id
          : seedApprovalContact({ phone: "5511987009602", name: "Intake owner", tags: ["permission.owner"] }).id;
      if (type === "agent") {
        dbUpdateAgent(id, { defaults: { runtimePermissions: { capabilities: [`mutate:${resource}:${target}`] } } });
      }
      expect(authorizeIntakeSubject(type, id, resource, target)).toBe(true);
      dbSetSetting("permissions.provider_ids", "external-authority");
      // Materializers still expose the grant; they are not the final authority.
      expect(canWithCapabilities(materializeSubjectCapabilities(type, id), "mutate", resource, target)).toBe(true);
      expect(authorizeIntakeSubject(type, id, resource, target)).toBe(false);

      const assertionPath = join(stateDir!, "assertion.json");
      dbSetSetting(EXTERNAL_AUTHORITY_ASSERTION_SETTING, assertionPath);
      dbSetSetting(EXTERNAL_AUTHORITY_PUBKEY_SETTING, publicKey.export({ type: "spki", format: "pem" }).toString());
      for (const verdict of ["allow", "needs_approval", "deny"] as const) {
        const assertion = {
          iss: "test-intake-authority",
          sub: `${type}:${id}`,
          exp: Math.floor(Date.now() / 1000) + 60,
          scope: [
            {
              permission: verdict === "deny" ? "read" : "mutate",
              objectType: resource,
              objectId: target,
              ...(verdict === "needs_approval" ? { requiresApproval: true } : {}),
            },
          ],
        };
        writeFileSync(
          assertionPath,
          JSON.stringify({
            ...assertion,
            sig: sign(null, Buffer.from(canonicalize(assertion)), privateKey).toString("base64"),
          }),
        );
        resetExternalAuthorityCacheForTests();
        expect(authorizeIntakeSubject(type, id, resource, target)).toBe(verdict === "allow");
      }
    });
  }
});
