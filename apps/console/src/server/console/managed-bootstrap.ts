import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db, schema } from "@/server/db";
import type { JsonRecord } from "@/server/db/schema";
import { ManagedRuntimeError } from "./managed-runtime";

export const MANAGED_BOOTSTRAP_SCHEMA = "ravi.managed-appliance.bootstrap/v1";
export const MANAGED_GRANT_TTL_MS = 5 * 60 * 1_000;
export const MANAGED_CONTROLLER_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_INITIAL_AGENT_ID = "managed-ravi";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function managedControllerCapabilities(instanceId: string) {
  if (!UUID_PATTERN.test(instanceId)) {
    throw new ManagedRuntimeError(503, "managed_controller_instance_id_invalid");
  }
  return [
    "execute:group:self",
    `mutate:ravi-control.installation:${instanceId}`,
  ] as const;
}

const issueBootstrapSchema = z
  .object({
    claimOwner: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    operationId: z.string().uuid(),
    deckInstanceRef: z
      .string()
      .trim()
      .min(3)
      .max(180)
      .regex(/^[A-Za-z0-9._:-]+$/),
    providerBrokerBaseUrl: z
      .string()
      .trim()
      .url()
      .max(200)
      .refine(isManagedProviderBrokerBaseUrl),
    vmId: z
      .string()
      .trim()
      .min(3)
      .max(160)
      .regex(/^[A-Za-z0-9._:-]+$/),
  })
  .strict();

type BootstrapAuthority = {
  operation: {
    action: string;
    claimExpiresAt: Date | null;
    claimOwner: string | null;
    id: string;
    instanceId: string;
    organizationId: string;
    projectId: string | null;
    status: string;
  };
  instance: {
    hostId: string | null;
    id: string;
    imageId: string | null;
    runtimeModel: string | null;
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
    version: string;
  } | null;
};

export type ManagedBootstrapRepository = {
  findAuthority(operationId: string): Promise<BootstrapAuthority | null>;
  recordIssuance(input: {
    expiresAt: Date;
    grantId: string;
    imageDigest: string;
    keyId: string;
    operation: BootstrapAuthority["operation"];
    payloadDigest: string;
    vmId: string;
  }): Promise<void>;
};

export async function issueManagedRuntimeBootstrap(input: {
  body: unknown;
  env?: NodeJS.ProcessEnv;
  credentialClaimTokenFactory?: () => string;
  grantIdFactory?: () => string;
  now?: Date;
  repository?: ManagedBootstrapRepository;
}) {
  const parsed = parseIssueBody(input.body);
  const now = input.now ?? new Date();
  const repository = input.repository ?? managedBootstrapRepositoryForDb();
  const authority = await repository.findAuthority(parsed.operationId);
  if (!authority) {
    throw new ManagedRuntimeError(404, "managed_runtime_operation_not_found");
  }
  assertBootstrapAuthority(authority, parsed.claimOwner, now);

  const signer = managedBootstrapSigner(input.env ?? process.env);
  const grantId = (input.grantIdFactory ?? randomUUID)();
  const credentialClaimToken = (
    input.credentialClaimTokenFactory ?? createManagedCredentialClaimToken
  )();
  if (!/^ravi_mcc_[A-Za-z0-9_-]{32,128}$/.test(credentialClaimToken)) {
    throw new ManagedRuntimeError(503, "managed_bootstrap_claim_token_invalid");
  }
  assertDeckInstanceRef(authority.instance.id, parsed.deckInstanceRef);
  const expiresAt = new Date(now.getTime() + MANAGED_GRANT_TTL_MS);
  const initialAgentId = initialAgentIdForImage(
    authority.image?.providerSupportJson ?? {},
  );
  const payload = {
    schemaVersion: MANAGED_BOOTSTRAP_SCHEMA,
    grantId,
    issuedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    bindings: {
      hostId: authority.host?.hostname,
      vmId: parsed.vmId,
      instanceId: authority.instance.id,
      deckInstanceRef: parsed.deckInstanceRef,
      imageDigest: authority.image?.digest,
    },
    controller: {
      label: "managed-runtime-controller",
      credentialClaimTokenHash: managedSha256(credentialClaimToken),
      capabilities: [...managedControllerCapabilities(authority.instance.id)],
      ttlSeconds: MANAGED_CONTROLLER_TTL_SECONDS,
    },
    initialAgent: {
      id: initialAgentId,
      provider: "codex" as const,
      model: authority.instance.runtimeModel,
    },
    providerBroker: {
      baseUrl: parsed.providerBrokerBaseUrl,
      kind: "host_responses_proxy" as const,
      wireApi: "responses" as const,
    },
    operatorSshPublicKey: operatorSshPublicKey(input.env ?? process.env),
  };
  const payloadBytes = Buffer.from(JSON.stringify(payload), "utf8");
  const payloadDigest = managedSha256(payloadBytes);
  const signature = sign(null, payloadBytes, signer.privateKey);

  await repository.recordIssuance({
    expiresAt,
    grantId,
    imageDigest: authority.image?.digest as string,
    keyId: signer.keyId,
    operation: authority.operation,
    payloadDigest,
    vmId: parsed.vmId,
  });

  return {
    version: 1 as const,
    bootstrap: {
      expiresAt: expiresAt.toISOString(),
      credentialClaimToken,
      grantId,
      keyId: signer.keyId,
      payloadBase64: payloadBytes.toString("base64"),
      payloadDigest,
      signatureBase64: signature.toString("base64"),
    },
  };
}

export function createManagedCredentialClaimToken() {
  return `ravi_mcc_${randomBytes(32).toString("base64url")}`;
}

export function managedBootstrapRepositoryForDb(): ManagedBootstrapRepository {
  return {
    async findAuthority(operationId) {
      const [row] = await db
        .select({
          operation: {
            action: schema.managedRuntimeOperations.action,
            claimExpiresAt: schema.managedRuntimeOperations.claimExpiresAt,
            claimOwner: schema.managedRuntimeOperations.claimOwner,
            id: schema.managedRuntimeOperations.id,
            instanceId: schema.managedRuntimeOperations.instanceId,
            organizationId: schema.managedRuntimeOperations.organizationId,
            projectId: schema.managedRuntimeOperations.projectId,
            status: schema.managedRuntimeOperations.status,
          },
          instance: {
            hostId: schema.managedRuntimeInstances.hostId,
            id: schema.managedRuntimeInstances.id,
            imageId: schema.managedRuntimeInstances.imageId,
            runtimeModel: schema.managedRuntimeInstances.runtimeModel,
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
            version: schema.runtimeImages.version,
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
        .where(eq(schema.managedRuntimeOperations.id, operationId))
        .limit(1);
      if (!row) return null;
      return {
        ...row,
        host: row.host?.id ? row.host : null,
        image: row.image?.id ? row.image : null,
      } as BootstrapAuthority;
    },

    async recordIssuance(input) {
      await db.insert(schema.auditEvents).values({
        organizationId: input.operation.organizationId,
        projectId: input.operation.projectId,
        actorType: "system",
        actorId: input.operation.claimOwner,
        targetType: "managed_runtime_operation",
        targetId: input.operation.id,
        action: "managed_runtime.bootstrap.issued",
        metadataJson: {
          expiresAt: input.expiresAt.toISOString(),
          grantId: input.grantId,
          imageDigest: input.imageDigest,
          instanceId: input.operation.instanceId,
          keyId: input.keyId,
          payloadDigest: input.payloadDigest,
          vmId: input.vmId,
        },
      });
    },
  };
}

function assertBootstrapAuthority(
  authority: BootstrapAuthority,
  claimOwner: string,
  now: Date,
) {
  if (!new Set(["create", "retry"]).has(authority.operation.action)) {
    throw new ManagedRuntimeError(409, "managed_bootstrap_action_invalid");
  }
  if (
    !new Set(["claimed", "running"]).has(authority.operation.status) ||
    authority.operation.claimOwner !== claimOwner ||
    !authority.operation.claimExpiresAt ||
    authority.operation.claimExpiresAt <= now
  ) {
    throw new ManagedRuntimeError(409, "managed_bootstrap_claim_invalid");
  }
  if (
    authority.instance.runtimeProvider !== "codex" ||
    !authority.host ||
    authority.host.status !== "active" ||
    authority.instance.hostId !== authority.host.id ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/.test(authority.host.hostname)
  ) {
    throw new ManagedRuntimeError(409, "managed_bootstrap_host_invalid");
  }
  if (
    !authority.image ||
    authority.image.status !== "active" ||
    authority.instance.imageId !== authority.image.id ||
    authority.image.providerSupportJson.codex !== true ||
    !/^sha256:[a-f0-9]{64}$/.test(authority.image.digest)
  ) {
    throw new ManagedRuntimeError(409, "managed_bootstrap_image_invalid");
  }
}

export function managedBootstrapSigner(env: NodeJS.ProcessEnv) {
  const encoded = env.RAVI_MANAGED_BOOTSTRAP_SIGNING_PRIVATE_KEY_B64?.trim();
  if (!encoded) {
    throw new ManagedRuntimeError(
      503,
      "managed_bootstrap_signer_not_configured",
    );
  }
  try {
    const privateKey = createPrivateKey(
      Buffer.from(encoded, "base64").toString("utf8"),
    );
    if (privateKey.asymmetricKeyType !== "ed25519") {
      throw new Error("signer_not_ed25519");
    }
    const publicDer = createPublicKey(privateKey).export({
      format: "der",
      type: "spki",
    });
    return { privateKey, keyId: managedSha256(publicDer) };
  } catch {
    throw new ManagedRuntimeError(503, "managed_bootstrap_signer_invalid");
  }
}

function initialAgentIdForImage(providerSupport: JsonRecord) {
  const value = providerSupport.initialAgentId;
  if (
    typeof value === "string" &&
    /^[a-z0-9][a-z0-9_-]{0,79}$/.test(value)
  ) {
    return value;
  }
  return DEFAULT_INITIAL_AGENT_ID;
}

function operatorSshPublicKey(env: NodeJS.ProcessEnv) {
  const value = env.RAVI_MANAGED_OPERATOR_SSH_PUBLIC_KEY?.trim();
  if (!value) return null;
  if (!value.startsWith("ssh-") || value.length > 16_384 || value.includes("\n")) {
    throw new ManagedRuntimeError(503, "managed_bootstrap_operator_key_invalid");
  }
  return value;
}

function parseIssueBody(body: unknown) {
  const parsed = issueBootstrapSchema.safeParse(body);
  if (!parsed.success) {
    throw new ManagedRuntimeError(400, "managed_bootstrap_payload_invalid");
  }
  return parsed.data;
}

export function managedSha256(value: string | Uint8Array) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function managedDeckInstanceRef(instanceId: string) {
  return `managed-${instanceId}`;
}

export function managedControllerCredentialRef(
  instanceId: string,
  contextId: string,
) {
  return `cred_${createHash("sha256")
    .update(`${instanceId}:${contextId}`)
    .digest("hex")
    .slice(0, 32)}`;
}

function isManagedProviderBrokerBaseUrl(value: string) {
  try {
    const url = new URL(value);
    const octets = url.hostname.split(".").map(Number);
    const address = octets.length === 4
      ? (
        ((octets[0] as number) << 24)
        + ((octets[1] as number) << 16)
        + ((octets[2] as number) << 8)
        + (octets[3] as number)
      ) >>> 0
      : 0;
    return url.protocol === "http:"
      && url.port === "7443"
      && url.pathname === "/v1"
      && !url.search
      && !url.hash
      && !url.username
      && !url.password
      && octets.length === 4
      && octets.every(
        (octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255,
      )
      && octets[0] === 172
      && octets[1] === 30
      && address % 4 === 1;
  } catch {
    return false;
  }
}

function assertDeckInstanceRef(instanceId: string, deckInstanceRef: string) {
  if (deckInstanceRef !== managedDeckInstanceRef(instanceId)) {
    throw new ManagedRuntimeError(409, "managed_bootstrap_deck_binding_invalid");
  }
}
