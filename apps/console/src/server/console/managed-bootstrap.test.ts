import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, verify } from "node:crypto";

import {
  issueManagedRuntimeBootstrap,
  type ManagedBootstrapRepository,
} from "./managed-bootstrap";

const NOW = new Date("2026-07-15T12:00:00.000Z");
const OPERATION_ID = "10000000-0000-4000-8000-000000000001";
const INSTANCE_ID = "20000000-0000-4000-8000-000000000001";
const ORGANIZATION_ID = "30000000-0000-4000-8000-000000000001";
const PROJECT_ID = "40000000-0000-4000-8000-000000000001";
const HOST_ID = "50000000-0000-4000-8000-000000000001";
const IMAGE_ID = "60000000-0000-4000-8000-000000000001";
const VM_ID = "mvm_0123456789abcdef0123456789abcdef";
const DECK_INSTANCE_REF = `managed-${INSTANCE_ID}`;
const IMAGE_DIGEST = `sha256:${"a".repeat(64)}`;
const CREDENTIAL_CLAIM_TOKEN = `ravi_mcc_${"c".repeat(43)}`;
const PROVIDER_BROKER_BASE_URL = "http://172.30.0.1:7443/v1";

describe("managed runtime bootstrap issuer", () => {
  test("signs a short-lived bootstrap and keeps controller authority out of the payload", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const privatePem = privateKey.export({ format: "pem", type: "pkcs8" });
    const recorded: Array<Record<string, unknown>> = [];
    const repository = repositoryForTest(recorded);

    const result = await issueManagedRuntimeBootstrap({
      body: {
        claimOwner: "runtime-control-ovh-01",
        deckInstanceRef: DECK_INSTANCE_REF,
        operationId: OPERATION_ID,
        providerBrokerBaseUrl: PROVIDER_BROKER_BASE_URL,
        vmId: VM_ID,
      },
      env: {
        RAVI_MANAGED_BOOTSTRAP_SIGNING_PRIVATE_KEY_B64: Buffer.from(
          privatePem,
        ).toString("base64"),
      } as unknown as NodeJS.ProcessEnv,
      credentialClaimTokenFactory: () => CREDENTIAL_CLAIM_TOKEN,
      grantIdFactory: () => "70000000-0000-4000-8000-000000000001",
      now: NOW,
      repository,
    });

    const payloadBytes = Buffer.from(result.bootstrap.payloadBase64, "base64");
    const payload = JSON.parse(payloadBytes.toString("utf8"));
    const signature = Buffer.from(result.bootstrap.signatureBase64, "base64");

    expect(verify(null, payloadBytes, publicKey, signature)).toBe(true);
    expect(payload).toMatchObject({
      schemaVersion: "ravi.managed-appliance.bootstrap/v1",
      bindings: {
        hostId: "ovh-managed-01",
        imageDigest: IMAGE_DIGEST,
        instanceId: INSTANCE_ID,
        deckInstanceRef: DECK_INSTANCE_REF,
        vmId: VM_ID,
      },
      controller: {
        capabilities: [
          "execute:group:self",
          `mutate:ravi-control.installation:${INSTANCE_ID}`,
        ],
        credentialClaimTokenHash: `sha256:${createHash("sha256")
          .update(CREDENTIAL_CLAIM_TOKEN)
          .digest("hex")}`,
        label: "managed-runtime-controller",
        ttlSeconds: 86_400,
      },
      initialAgent: {
        id: "managed-ravi",
        model: null,
        provider: "codex",
      },
      operatorSshPublicKey: null,
      providerBroker: {
        baseUrl: PROVIDER_BROKER_BASE_URL,
        kind: "host_responses_proxy",
        wireApi: "responses",
      },
    });
    expect(Date.parse(payload.expiresAt) - Date.parse(payload.issuedAt)).toBe(
      5 * 60 * 1_000,
    );
    expect(result.bootstrap.keyId).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.bootstrap.payloadDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.bootstrap.credentialClaimToken).toBe(CREDENTIAL_CLAIM_TOKEN);
    expect(payloadBytes.toString("utf8")).not.toContain(CREDENTIAL_CLAIM_TOKEN);
    expect(payload.controller.capabilities).toEqual([
      "execute:group:self",
      `mutate:ravi-control.installation:${INSTANCE_ID}`,
    ]);
    expect(payload.controller.capabilities.join(" ")).not.toContain("*");
    expect(JSON.stringify(result)).not.toContain("PRIVATE KEY");
    expect(JSON.stringify(result)).not.toContain("rctx_");
    expect(recorded).toEqual([
      expect.objectContaining({
        grantId: "70000000-0000-4000-8000-000000000001",
        imageDigest: IMAGE_DIGEST,
        vmId: VM_ID,
      }),
    ]);
    expect(JSON.stringify(recorded)).not.toContain(CREDENTIAL_CLAIM_TOKEN);
  });

  test("fails closed for stale claims and missing signer configuration", async () => {
    await expect(
      issueManagedRuntimeBootstrap({
        body: {
          claimOwner: "wrong-controller",
          deckInstanceRef: DECK_INSTANCE_REF,
          operationId: OPERATION_ID,
          providerBrokerBaseUrl: PROVIDER_BROKER_BASE_URL,
          vmId: VM_ID,
        },
        env: {} as NodeJS.ProcessEnv,
        now: NOW,
        repository: repositoryForTest([]),
      }),
    ).rejects.toMatchObject({
      code: "managed_bootstrap_claim_invalid",
      status: 409,
    });

    await expect(
      issueManagedRuntimeBootstrap({
        body: {
          claimOwner: "runtime-control-ovh-01",
          deckInstanceRef: DECK_INSTANCE_REF,
          operationId: OPERATION_ID,
          providerBrokerBaseUrl: PROVIDER_BROKER_BASE_URL,
          vmId: VM_ID,
        },
        env: {} as NodeJS.ProcessEnv,
        now: NOW,
        repository: repositoryForTest([]),
      }),
    ).rejects.toMatchObject({
      code: "managed_bootstrap_signer_not_configured",
      status: 503,
    });

    const { privateKey } = generateKeyPairSync("ed25519");
    const privatePem = privateKey.export({ format: "pem", type: "pkcs8" });
    await expect(
      issueManagedRuntimeBootstrap({
        body: {
          claimOwner: "runtime-control-ovh-01",
          deckInstanceRef: DECK_INSTANCE_REF,
          operationId: OPERATION_ID,
          providerBrokerBaseUrl: PROVIDER_BROKER_BASE_URL,
          vmId: VM_ID,
        },
        credentialClaimTokenFactory: () => "invalid token",
        env: {
          RAVI_MANAGED_BOOTSTRAP_SIGNING_PRIVATE_KEY_B64: Buffer.from(
            privatePem,
          ).toString("base64"),
        } as unknown as NodeJS.ProcessEnv,
        now: NOW,
        repository: repositoryForTest([]),
      }),
    ).rejects.toMatchObject({
      code: "managed_bootstrap_claim_token_invalid",
      status: 503,
    });

    await expect(
      issueManagedRuntimeBootstrap({
        body: {
          claimOwner: "runtime-control-ovh-01",
          deckInstanceRef: "managed-wrong-instance",
          operationId: OPERATION_ID,
          providerBrokerBaseUrl: PROVIDER_BROKER_BASE_URL,
          vmId: VM_ID,
        },
        env: {
          RAVI_MANAGED_BOOTSTRAP_SIGNING_PRIVATE_KEY_B64: Buffer.from(
            privatePem,
          ).toString("base64"),
        } as unknown as NodeJS.ProcessEnv,
        now: NOW,
        repository: repositoryForTest([]),
      }),
    ).rejects.toMatchObject({
      code: "managed_bootstrap_deck_binding_invalid",
      status: 409,
    });
  });
});

function repositoryForTest(
  recorded: Array<Record<string, unknown>>,
): ManagedBootstrapRepository {
  return {
    async findAuthority() {
      return {
        operation: {
          action: "create",
          claimExpiresAt: new Date("2026-07-15T12:01:00.000Z"),
          claimOwner: "runtime-control-ovh-01",
          id: OPERATION_ID,
          instanceId: INSTANCE_ID,
          organizationId: ORGANIZATION_ID,
          projectId: PROJECT_ID,
          status: "claimed",
        },
        instance: {
          hostId: HOST_ID,
          id: INSTANCE_ID,
          imageId: IMAGE_ID,
          runtimeModel: null,
          runtimeProvider: "codex",
        },
        host: {
          hostname: "ovh-managed-01",
          id: HOST_ID,
          status: "active",
        },
        image: {
          digest: IMAGE_DIGEST,
          id: IMAGE_ID,
          providerSupportJson: {
            codex: true,
            initialAgentId: "managed-ravi",
          },
          status: "active",
          version: "2026.07.15",
        },
      };
    },
    async recordIssuance(input) {
      recorded.push(input);
    },
  };
}
