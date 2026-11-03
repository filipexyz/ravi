import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, verify } from "node:crypto";

import {
  issueManagedControllerRotation,
  type ManagedControllerRotationRepository,
} from "./managed-controller-rotation";
import { managedControllerCredentialRef } from "./managed-bootstrap";

const NOW = new Date("2026-07-15T12:00:00.000Z");
const OPERATION_ID = "10000000-0000-4000-8000-000000000001";
const INSTANCE_ID = "20000000-0000-4000-8000-000000000001";
const ORGANIZATION_ID = "30000000-0000-4000-8000-000000000001";
const PROJECT_ID = "40000000-0000-4000-8000-000000000001";
const HOST_ID = "50000000-0000-4000-8000-000000000001";
const IMAGE_ID = "60000000-0000-4000-8000-000000000001";
const VM_ID = "mvm_0123456789abcdef0123456789abcdef";
const DECK_INSTANCE_REF = `managed-${INSTANCE_ID}`;
const CURRENT_CONTEXT_ID = "ctx_controller_01";
const IMAGE_DIGEST = `sha256:${"a".repeat(64)}`;
const CLAIM_TOKEN = `ravi_mcc_${"d".repeat(43)}`;

describe("managed controller rotation issuer", () => {
  test("signs an instance-bound replacement grant without exposing claim authority", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const recorded: Array<Record<string, unknown>> = [];
    const result = await issueManagedControllerRotation({
      body: validBody(),
      credentialClaimTokenFactory: () => CLAIM_TOKEN,
      env: {
        RAVI_MANAGED_BOOTSTRAP_SIGNING_PRIVATE_KEY_B64: Buffer.from(
          privateKey.export({ format: "pem", type: "pkcs8" }),
        ).toString("base64"),
      } as unknown as NodeJS.ProcessEnv,
      grantIdFactory: () => "70000000-0000-4000-8000-000000000001",
      now: NOW,
      repository: repositoryForTest(recorded),
    });

    const payloadBytes = Buffer.from(result.rotation.payloadBase64, "base64");
    const signature = Buffer.from(result.rotation.signatureBase64, "base64");
    const payload = JSON.parse(payloadBytes.toString("utf8"));
    expect(verify(null, payloadBytes, publicKey, signature)).toBe(true);
    expect(payload).toMatchObject({
      schemaVersion: "ravi.managed-appliance.controller-rotation/v1",
      bindings: {
        deckInstanceRef: DECK_INSTANCE_REF,
        hostId: "ovh-managed-01",
        imageDigest: IMAGE_DIGEST,
        instanceId: INSTANCE_ID,
        operationId: OPERATION_ID,
        previousContextId: CURRENT_CONTEXT_ID,
        vmId: VM_ID,
      },
      controller: {
        capabilities: [
          "execute:group:self",
          `mutate:ravi-control.installation:${INSTANCE_ID}`,
        ],
        credentialClaimTokenHash: `sha256:${createHash("sha256")
          .update(CLAIM_TOKEN)
          .digest("hex")}`,
        ttlSeconds: 86_400,
      },
    });
    expect(payload.controller.capabilities).toEqual([
      "execute:group:self",
      `mutate:ravi-control.installation:${INSTANCE_ID}`,
    ]);
    expect(payload.controller.capabilities.join(" ")).not.toContain("*");
    expect(result.rotation.credentialClaimToken).toBe(CLAIM_TOKEN);
    expect(payloadBytes.toString("utf8")).not.toContain(CLAIM_TOKEN);
    expect(JSON.stringify(recorded)).not.toContain(CLAIM_TOKEN);
    expect(recorded).toEqual([
      expect.objectContaining({
        credentialAuthorityRecovery: "none",
        previousCredentialRef: managedControllerCredentialRef(
          INSTANCE_ID,
          CURRENT_CONTEXT_ID,
        ),
      }),
    ]);
  });

  test("recovers opaque credential reference drift only for explicit controller rotation", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const env = {
      RAVI_MANAGED_BOOTSTRAP_SIGNING_PRIVATE_KEY_B64: Buffer.from(
        privateKey.export({ format: "pem", type: "pkcs8" }),
      ).toString("base64"),
    } as unknown as NodeJS.ProcessEnv;
    const recorded: Array<Record<string, unknown>> = [];
    const result = await issueManagedControllerRotation({
      body: validBody(),
      credentialClaimTokenFactory: () => CLAIM_TOKEN,
      env,
      now: NOW,
      repository: repositoryForTest(recorded, "cred_stale"),
    });
    expect(result.rotation.credentialClaimToken).toBe(CLAIM_TOKEN);
    expect(recorded).toEqual([
      expect.objectContaining({
        consoleCredentialRef: "cred_stale",
        credentialAuthorityRecovery: "drift",
        previousCredentialRef: managedControllerCredentialRef(
          INSTANCE_ID,
          CURRENT_CONTEXT_ID,
        ),
      }),
    ]);

    const missing: Array<Record<string, unknown>> = [];
    await issueManagedControllerRotation({
      body: validBody(),
      credentialClaimTokenFactory: () => CLAIM_TOKEN,
      env,
      now: NOW,
      repository: repositoryForTest(
        missing,
        undefined,
        "rotate_controller",
        null,
      ),
    });
    expect(missing).toEqual([
      expect.objectContaining({
        consoleCredentialRef: null,
        credentialAuthorityRecovery: "missing",
      }),
    ]);

    await expect(
      issueManagedControllerRotation({
        body: validBody(),
        env,
        now: NOW,
        repository: repositoryForTest([], "cred_stale", "restore"),
      }),
    ).rejects.toMatchObject({
      code: "managed_controller_rotation_authority_invalid",
      status: 409,
    });
  });

  test("rejects a revoked connection or mismatched Deck ref", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const env = {
      RAVI_MANAGED_BOOTSTRAP_SIGNING_PRIVATE_KEY_B64: Buffer.from(
        privateKey.export({ format: "pem", type: "pkcs8" }),
      ).toString("base64"),
    } as unknown as NodeJS.ProcessEnv;
    await expect(
      issueManagedControllerRotation({
        body: validBody(),
        env,
        now: NOW,
        repository: repositoryForTest([], undefined, "rotate_controller", "revoked"),
      }),
    ).rejects.toMatchObject({
      code: "managed_controller_rotation_authority_invalid",
      status: 409,
    });

    await expect(
      issueManagedControllerRotation({
        body: { ...validBody(), deckInstanceRef: "managed-wrong" },
        env,
        now: NOW,
        repository: repositoryForTest([]),
      }),
    ).rejects.toMatchObject({
      code: "managed_controller_rotation_deck_binding_invalid",
      status: 409,
    });
  });

  test("allows restore to rotate the resurrected controller before completion", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const result = await issueManagedControllerRotation({
      body: validBody(),
      credentialClaimTokenFactory: () => CLAIM_TOKEN,
      env: {
        RAVI_MANAGED_BOOTSTRAP_SIGNING_PRIVATE_KEY_B64: Buffer.from(
          privateKey.export({ format: "pem", type: "pkcs8" }),
        ).toString("base64"),
      } as unknown as NodeJS.ProcessEnv,
      now: NOW,
      repository: repositoryForTest([], undefined, "restore"),
    });

    expect(result.rotation.credentialClaimToken).toBe(CLAIM_TOKEN);
  });

  test("allows a retry envelope to finish an interrupted restore rotation", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const result = await issueManagedControllerRotation({
      body: validBody(),
      credentialClaimTokenFactory: () => CLAIM_TOKEN,
      env: {
        RAVI_MANAGED_BOOTSTRAP_SIGNING_PRIVATE_KEY_B64: Buffer.from(
          privateKey.export({ format: "pem", type: "pkcs8" }),
        ).toString("base64"),
      } as unknown as NodeJS.ProcessEnv,
      now: NOW,
      repository: repositoryForTest([], undefined, "retry"),
    });

    expect(result.rotation.credentialClaimToken).toBe(CLAIM_TOKEN);
  });
});

function validBody() {
  return {
    claimOwner: "runtime-control-ovh-01",
    currentContextId: CURRENT_CONTEXT_ID,
    deckInstanceRef: DECK_INSTANCE_REF,
    operationId: OPERATION_ID,
    vmId: VM_ID,
  };
}

function repositoryForTest(
  recorded: Array<Record<string, unknown>>,
  credentialRef = managedControllerCredentialRef(
    INSTANCE_ID,
    CURRENT_CONTEXT_ID,
  ),
  action: "restore" | "retry" | "rotate_controller" = "rotate_controller",
  connectionStatus: "connecting" | "offline" | "online" | "revoked" | "stale" | null = "online",
): ManagedControllerRotationRepository {
  return {
    async findAuthority() {
      return {
        operation: {
          action,
          actorType: action === "rotate_controller" ? "system" : "user",
          claimExpiresAt: new Date("2026-07-15T12:01:00.000Z"),
          claimOwner: "runtime-control-ovh-01",
          id: OPERATION_ID,
          instanceId: INSTANCE_ID,
          organizationId: ORGANIZATION_ID,
          projectId: PROJECT_ID,
          safeInputJson: action === "retry"
            ? {
                backupRef: `mbk_${"b".repeat(32)}`,
                retryAction: "restore",
                retryOperationId: "90000000-0000-4000-8000-000000000001",
              }
            : {},
          status: "claimed",
        },
        instance: {
          hostId: HOST_ID,
          id: INSTANCE_ID,
          imageId: IMAGE_ID,
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
          providerSupportJson: { codex: true },
          status: "active",
        },
        connection: connectionStatus === null
          ? null
          : {
              credentialRef,
              kind: "private_ravi_sdk",
              status: connectionStatus,
            },
      };
    },
    async recordIssuance(input) {
      recorded.push(input);
    },
  };
}
