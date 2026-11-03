import { randomUUID, sign } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db, schema } from "@/server/db";
import type { JsonRecord } from "@/server/db/schema";
import {
  createManagedCredentialClaimToken,
  managedBootstrapSigner,
  managedControllerCapabilities,
  managedControllerCredentialRef,
  MANAGED_CONTROLLER_TTL_SECONDS,
  managedDeckInstanceRef,
  MANAGED_GRANT_TTL_MS,
  managedSha256,
} from "./managed-bootstrap";
import { ManagedRuntimeError } from "./managed-runtime";

export const MANAGED_CONTROLLER_ROTATION_SCHEMA =
  "ravi.managed-appliance.controller-rotation/v1";

const issueRotationSchema = z
  .object({
    claimOwner: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    currentContextId: z
      .string()
      .trim()
      .min(3)
      .max(240)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]+$/),
    deckInstanceRef: z
      .string()
      .trim()
      .min(3)
      .max(180)
      .regex(/^[A-Za-z0-9._:-]+$/),
    operationId: z.string().uuid(),
    vmId: z
      .string()
      .trim()
      .min(3)
      .max(160)
      .regex(/^[A-Za-z0-9._:-]+$/),
  })
  .strict();

type RotationAuthority = {
  operation: {
    action: string;
    actorType: string;
    claimExpiresAt: Date | null;
    claimOwner: string | null;
    id: string;
    instanceId: string;
    organizationId: string;
    projectId: string | null;
    safeInputJson: JsonRecord;
    status: string;
  };
  instance: {
    hostId: string | null;
    id: string;
    imageId: string | null;
    runtimeProvider: string;
  };
  host: {
    hostname: string;
    id: string;
    status: string;
  } | null;
  image: {
    digest: string;
    id: string;
    providerSupportJson: JsonRecord;
    status: string;
  } | null;
  connection: {
    credentialRef: string | null;
    kind: string;
    status: string;
  } | null;
};

export type ManagedControllerRotationRepository = {
  findAuthority(operationId: string): Promise<RotationAuthority | null>;
  recordIssuance(input: {
    consoleCredentialRef: string | null;
    credentialAuthorityRecovery: "drift" | "missing" | "none" | "stale";
    expiresAt: Date;
    grantId: string;
    keyId: string;
    operation: RotationAuthority["operation"];
    payloadDigest: string;
    previousCredentialRef: string;
    vmId: string;
  }): Promise<void>;
};

export async function issueManagedControllerRotation(input: {
  body: unknown;
  credentialClaimTokenFactory?: () => string;
  env?: NodeJS.ProcessEnv;
  grantIdFactory?: () => string;
  now?: Date;
  repository?: ManagedControllerRotationRepository;
}) {
  const parsed = parseIssueBody(input.body);
  const now = input.now ?? new Date();
  const repository =
    input.repository ?? managedControllerRotationRepositoryForDb();
  const authority = await repository.findAuthority(parsed.operationId);
  if (!authority) {
    throw new ManagedRuntimeError(404, "managed_runtime_operation_not_found");
  }
  const rotationAuthority = assertRotationAuthority(
    authority,
    parsed,
    now,
  );

  const signer = managedBootstrapSigner(input.env ?? process.env);
  const grantId = (input.grantIdFactory ?? randomUUID)();
  const credentialClaimToken = (
    input.credentialClaimTokenFactory ?? createManagedCredentialClaimToken
  )();
  if (!/^ravi_mcc_[A-Za-z0-9_-]{32,128}$/.test(credentialClaimToken)) {
    throw new ManagedRuntimeError(
      503,
      "managed_controller_rotation_claim_token_invalid",
    );
  }
  const expiresAt = new Date(now.getTime() + MANAGED_GRANT_TTL_MS);
  const payload = {
    schemaVersion: MANAGED_CONTROLLER_ROTATION_SCHEMA,
    grantId,
    issuedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    bindings: {
      operationId: authority.operation.id,
      hostId: authority.host?.hostname,
      vmId: parsed.vmId,
      instanceId: authority.instance.id,
      deckInstanceRef: parsed.deckInstanceRef,
      imageDigest: authority.image?.digest,
      previousContextId: parsed.currentContextId,
    },
    controller: {
      label: "managed-runtime-controller",
      credentialClaimTokenHash: managedSha256(credentialClaimToken),
      capabilities: [...managedControllerCapabilities(authority.instance.id)],
      ttlSeconds: MANAGED_CONTROLLER_TTL_SECONDS,
    },
  };
  const payloadBytes = Buffer.from(JSON.stringify(payload), "utf8");
  const payloadDigest = managedSha256(payloadBytes);
  const signature = sign(null, payloadBytes, signer.privateKey);

  await repository.recordIssuance({
    consoleCredentialRef: rotationAuthority.consoleCredentialRef,
    credentialAuthorityRecovery: rotationAuthority.credentialAuthorityRecovery,
    expiresAt,
    grantId,
    keyId: signer.keyId,
    operation: authority.operation,
    payloadDigest,
    previousCredentialRef: rotationAuthority.previousCredentialRef,
    vmId: parsed.vmId,
  });

  return {
    version: 1 as const,
    rotation: {
      credentialClaimToken,
      expiresAt: expiresAt.toISOString(),
      grantId,
      keyId: signer.keyId,
      payloadBase64: payloadBytes.toString("base64"),
      payloadDigest,
      signatureBase64: signature.toString("base64"),
    },
  };
}

export function managedControllerRotationRepositoryForDb(): ManagedControllerRotationRepository {
  return {
    async findAuthority(operationId) {
      const [row] = await db
        .select({
          operation: {
            action: schema.managedRuntimeOperations.action,
            actorType: schema.managedRuntimeOperations.actorType,
            claimExpiresAt: schema.managedRuntimeOperations.claimExpiresAt,
            claimOwner: schema.managedRuntimeOperations.claimOwner,
            id: schema.managedRuntimeOperations.id,
            instanceId: schema.managedRuntimeOperations.instanceId,
            organizationId: schema.managedRuntimeOperations.organizationId,
            projectId: schema.managedRuntimeOperations.projectId,
            safeInputJson: schema.managedRuntimeOperations.safeInputJson,
            status: schema.managedRuntimeOperations.status,
          },
          instance: {
            hostId: schema.managedRuntimeInstances.hostId,
            id: schema.managedRuntimeInstances.id,
            imageId: schema.managedRuntimeInstances.imageId,
            runtimeProvider: schema.managedRuntimeInstances.runtimeProvider,
          },
          host: {
            hostname: schema.runtimeHosts.hostname,
            id: schema.runtimeHosts.id,
            status: schema.runtimeHosts.status,
          },
          image: {
            digest: schema.runtimeImages.digest,
            id: schema.runtimeImages.id,
            providerSupportJson: schema.runtimeImages.providerSupportJson,
            status: schema.runtimeImages.status,
          },
          connection: {
            credentialRef: schema.managedRuntimeConnections.credentialRef,
            kind: schema.managedRuntimeConnections.kind,
            status: schema.managedRuntimeConnections.status,
          },
        })
        .from(schema.managedRuntimeOperations)
        .innerJoin(
          schema.managedRuntimeInstances,
          eq(
            schema.managedRuntimeInstances.id,
            schema.managedRuntimeOperations.instanceId,
          ),
        )
        .leftJoin(
          schema.runtimeHosts,
          eq(schema.runtimeHosts.id, schema.managedRuntimeInstances.hostId),
        )
        .leftJoin(
          schema.runtimeImages,
          eq(schema.runtimeImages.id, schema.managedRuntimeInstances.imageId),
        )
        .leftJoin(
          schema.managedRuntimeConnections,
          and(
            eq(
              schema.managedRuntimeConnections.instanceId,
              schema.managedRuntimeInstances.id,
            ),
            eq(
              schema.managedRuntimeConnections.kind,
              "private_ravi_sdk",
            ),
          ),
        )
        .where(eq(schema.managedRuntimeOperations.id, operationId))
        .limit(1);
      if (!row) return null;
      return {
        ...row,
        connection: row.connection?.kind ? row.connection : null,
        host: row.host?.id ? row.host : null,
        image: row.image?.id ? row.image : null,
      } as RotationAuthority;
    },

    async recordIssuance(input) {
      await db.insert(schema.auditEvents).values({
        organizationId: input.operation.organizationId,
        projectId: input.operation.projectId,
        actorType: "system",
        actorId: input.operation.claimOwner,
        targetType: "managed_runtime_operation",
        targetId: input.operation.id,
        action: "managed_runtime.controller_rotation_grant.issued",
        metadataJson: {
          expiresAt: input.expiresAt.toISOString(),
          consoleCredentialRef: input.consoleCredentialRef,
          credentialAuthorityRecovery: input.credentialAuthorityRecovery,
          grantId: input.grantId,
          instanceId: input.operation.instanceId,
          keyId: input.keyId,
          payloadDigest: input.payloadDigest,
          previousCredentialRef: input.previousCredentialRef,
          vmId: input.vmId,
        },
      });
    },
  };
}

function assertRotationAuthority(
  authority: RotationAuthority,
  parsed: z.infer<typeof issueRotationSchema>,
  now: Date,
) {
  const action = rotationOperationAction(authority.operation);
  if (!action) {
    throw new ManagedRuntimeError(
      409,
      "managed_controller_rotation_action_invalid",
    );
  }
  if (
    !new Set(["claimed", "running"]).has(authority.operation.status) ||
    authority.operation.claimOwner !== parsed.claimOwner ||
    !authority.operation.claimExpiresAt ||
    authority.operation.claimExpiresAt <= now
  ) {
    throw new ManagedRuntimeError(
      409,
      "managed_controller_rotation_claim_invalid",
    );
  }
  if (
    authority.instance.runtimeProvider !== "codex" ||
    !authority.host ||
    authority.host.status !== "active" ||
    authority.instance.hostId !== authority.host.id ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/.test(authority.host.hostname)
  ) {
    throw new ManagedRuntimeError(
      409,
      "managed_controller_rotation_host_invalid",
    );
  }
  if (
    !authority.image ||
    authority.image.status !== "active" ||
    authority.instance.imageId !== authority.image.id ||
    authority.image.providerSupportJson.codex !== true ||
    !/^sha256:[a-f0-9]{64}$/.test(authority.image.digest)
  ) {
    throw new ManagedRuntimeError(
      409,
      "managed_controller_rotation_image_invalid",
    );
  }
  if (
    parsed.deckInstanceRef !== managedDeckInstanceRef(authority.instance.id)
  ) {
    throw new ManagedRuntimeError(
      409,
      "managed_controller_rotation_deck_binding_invalid",
    );
  }
  const previousCredentialRef = managedControllerCredentialRef(
    authority.instance.id,
    parsed.currentContextId,
  );
  const systemRecovery =
    action === "rotate_controller" &&
    authority.operation.actorType === "system";
  const connection = authority.connection;
  if (connection?.status === "revoked") {
    throw new ManagedRuntimeError(
      409,
      "managed_controller_rotation_authority_invalid",
    );
  }
  if (
    !systemRecovery &&
    (!connection ||
      connection.kind !== "private_ravi_sdk" ||
      connection.status !== "online" ||
      connection.credentialRef !== previousCredentialRef)
  ) {
    throw new ManagedRuntimeError(
      409,
      "managed_controller_rotation_authority_invalid",
    );
  }
  if (systemRecovery && connection && connection.kind !== "private_ravi_sdk") {
    throw new ManagedRuntimeError(
      409,
      "managed_controller_rotation_authority_invalid",
    );
  }
  const credentialAuthorityRecovery: "drift" | "missing" | "none" | "stale" = !connection
    ? "missing"
    : connection.status !== "online"
      ? "stale"
      : connection.credentialRef !== previousCredentialRef
        ? "drift"
        : "none";
  return {
    consoleCredentialRef: connection?.credentialRef ?? null,
    credentialAuthorityRecovery,
    previousCredentialRef,
  };
}

function rotationOperationAction(
  operation: RotationAuthority["operation"],
): "restore" | "rotate_controller" | null {
  if (operation.action === "restore" || operation.action === "rotate_controller") {
    return operation.action;
  }
  if (
    operation.action === "retry" &&
    (operation.safeInputJson.retryAction === "restore" ||
      operation.safeInputJson.retryAction === "rotate_controller") &&
    typeof operation.safeInputJson.retryOperationId === "string" &&
    z.string().uuid().safeParse(operation.safeInputJson.retryOperationId).success
  ) {
    return operation.safeInputJson.retryAction;
  }
  return null;
}

function parseIssueBody(body: unknown) {
  const parsed = issueRotationSchema.safeParse(body);
  if (!parsed.success) {
    throw new ManagedRuntimeError(
      400,
      "managed_controller_rotation_payload_invalid",
    );
  }
  return parsed.data;
}
