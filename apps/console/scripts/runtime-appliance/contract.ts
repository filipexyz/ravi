import { createHash } from "node:crypto";
import { z } from "zod";

export const APPLIANCE_BOOTSTRAP_SCHEMA = "ravi.managed-appliance.bootstrap/v1" as const;
export const APPLIANCE_IMAGE_CONTRACT_SCHEMA = "ravi.managed-appliance.image-contract/v1" as const;
export const MAX_BOOTSTRAP_TTL_SECONDS = 600;
export const MAX_CONTROLLER_TTL_SECONDS = 90 * 24 * 60 * 60;

const boundIdSchema = z.string().trim().min(3).max(160).regex(/^[A-Za-z0-9._:-]+$/);
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const providerBrokerBaseUrlSchema = z
  .string()
  .url()
  .max(200)
  .refine((value) => {
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
        && octets.length === 4
        && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
        && octets[0] === 172
        && octets[1] === 30
        && address % 4 === 1;
    } catch {
      return false;
    }
  });

export const applianceBootstrapSchema = z.object({
  schemaVersion: z.literal(APPLIANCE_BOOTSTRAP_SCHEMA),
  grantId: z.string().uuid(),
  issuedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  bindings: z.object({
    hostId: boundIdSchema,
    vmId: boundIdSchema,
    instanceId: boundIdSchema,
    deckInstanceRef: boundIdSchema,
    imageDigest: digestSchema,
  }),
  controller: z.object({
    label: z.string().trim().min(1).max(120),
    credentialClaimTokenHash: digestSchema,
    capabilities: z
      .array(z.string().trim().regex(/^[a-z][a-z0-9_-]*:[a-z][a-z0-9_.-]*:[^,\s]{1,160}$/))
      .min(1)
      .max(32),
    ttlSeconds: z.number().int().min(300).max(MAX_CONTROLLER_TTL_SECONDS).multipleOf(60),
  }),
  initialAgent: z.object({
    id: z.string().trim().min(1).max(80).regex(/^[a-z0-9][a-z0-9_-]*$/),
    provider: z.literal("codex"),
    model: z.string().trim().min(1).max(160).nullable(),
  }),
  providerBroker: z.object({
    baseUrl: providerBrokerBaseUrlSchema,
    kind: z.literal("host_responses_proxy"),
    wireApi: z.literal("responses"),
  }),
  operatorSshPublicKey: z.string().trim().startsWith("ssh-").max(16_384).nullable(),
});

export type ApplianceBootstrap = z.infer<typeof applianceBootstrapSchema>;

export type ApplianceBootstrapExpectation = {
  hostId: string;
  vmId: string;
  instanceId: string;
  deckInstanceRef: string;
  imageDigest: string;
};

export const applianceImageContractSchema = z.object({
  schemaVersion: z.literal(APPLIANCE_IMAGE_CONTRACT_SCHEMA),
  image: z.object({
    name: boundIdSchema,
    digest: digestSchema,
  }),
  runtime: z.object({
    provider: z.literal("codex"),
    requireCodexAuth: z.boolean(),
    initialAgentId: z.string().trim().min(1).max(80).regex(/^[a-z0-9][a-z0-9_-]*$/),
  }),
  materials: z
    .object({
      bootstrapPublicKey: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .passthrough(),
  storage: z.object({
    stateLabel: z.literal("RAVI_STATE"),
    stateMount: z.literal("/var/lib/ravi"),
    bootstrapLabel: z.literal("RAVI_BOOTSTRAP"),
    bootstrapMount: z.literal("/run/ravi-bootstrap"),
  }),
  versions: z.object({
    ravi: z.string().trim().min(1),
    raviRevision: z.string().regex(/^[a-f0-9]{7,64}$/),
    codex: z.string().trim().min(1),
    bun: z.string().trim().min(1),
    nats: z.string().trim().min(1),
  }),
});

export type ApplianceImageContract = z.infer<typeof applianceImageContractSchema>;

export function parseApplianceBootstrap(
  input: unknown,
  expectation: ApplianceBootstrapExpectation,
  now = new Date(),
): ApplianceBootstrap {
  const parsed = applianceBootstrapSchema.parse(input);
  const issuedAt = Date.parse(parsed.issuedAt);
  const expiresAt = Date.parse(parsed.expiresAt);
  const nowMs = now.getTime();

  if (issuedAt > nowMs + 30_000) {
    throw new ApplianceBootstrapError("bootstrap_not_yet_valid");
  }
  if (expiresAt <= nowMs) {
    throw new ApplianceBootstrapError("bootstrap_expired");
  }
  if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_BOOTSTRAP_TTL_SECONDS * 1_000) {
    throw new ApplianceBootstrapError("bootstrap_ttl_invalid");
  }

  for (const key of [
    "hostId",
    "vmId",
    "instanceId",
    "deckInstanceRef",
    "imageDigest",
  ] as const) {
    if (parsed.bindings[key] !== expectation[key]) {
      throw new ApplianceBootstrapError(`bootstrap_${key}_mismatch`);
    }
  }

  return parsed;
}

export function safeApplianceBootstrap(input: ApplianceBootstrap): ApplianceBootstrap {
  return structuredClone(input);
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256Digest(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export class ApplianceBootstrapError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "ApplianceBootstrapError";
  }
}
