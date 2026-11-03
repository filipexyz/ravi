import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  applianceBootstrapSchema,
  applianceImageContractSchema,
  APPLIANCE_BOOTSTRAP_SCHEMA,
  APPLIANCE_IMAGE_CONTRACT_SCHEMA,
  parseApplianceBootstrap,
  safeApplianceBootstrap,
  sha256Digest,
  stableJson,
} from "./contract";

const now = new Date("2026-07-15T18:00:00.000Z");
const expectation = {
  hostId: "host_ovh_1",
  vmId: "vm_appliance_1",
  instanceId: "instance_1",
  deckInstanceRef: "managed-instance_1",
  imageDigest: `sha256:${"a".repeat(64)}`,
};

function validBootstrap() {
  return {
    schemaVersion: APPLIANCE_BOOTSTRAP_SCHEMA,
    grantId: randomUUID(),
    issuedAt: "2026-07-15T17:59:30.000Z",
    expiresAt: "2026-07-15T18:09:30.000Z",
    bindings: expectation,
    controller: {
      label: "managed-runtime-controller",
      credentialClaimTokenHash: `sha256:${"c".repeat(64)}`,
      capabilities: ["execute:group:sessions", "access:session:*"],
      ttlSeconds: 86_400,
    },
    initialAgent: { id: "managed-ravi", provider: "codex", model: null },
    operatorSshPublicKey: null,
    providerBroker: {
      baseUrl: "http://172.30.0.1:7443/v1",
      kind: "host_responses_proxy",
      wireApi: "responses",
    },
  };
}

describe("managed Ravi appliance bootstrap contract", () => {
  test("accepts a bounded Codex-only grant without carrying controller authority", () => {
    const parsed = parseApplianceBootstrap(validBootstrap(), expectation, now);
    const safe = safeApplianceBootstrap(parsed);

    expect(safe.controller).toEqual({
      label: "managed-runtime-controller",
      credentialClaimTokenHash: `sha256:${"c".repeat(64)}`,
      capabilities: ["execute:group:sessions", "access:session:*"],
      ttlSeconds: 86_400,
    });
    expect(JSON.stringify(safe)).not.toContain("rctx_");
    expect(safe.initialAgent.provider).toBe("codex");
    expect(safe.providerBroker.baseUrl).toBe("http://172.30.0.1:7443/v1");
  });

  test("accepts a dotted Ravi Control resource type", () => {
    const payload = validBootstrap();
    payload.controller.capabilities = [
      "execute:group:self",
      "mutate:ravi-control.installation:instance_1",
    ];

    expect(applianceBootstrapSchema.parse(payload).controller.capabilities).toEqual(
      payload.controller.capabilities,
    );
  });

  test("validates the immutable image and storage contract", () => {
    const contract = applianceImageContractSchema.parse({
      schemaVersion: APPLIANCE_IMAGE_CONTRACT_SCHEMA,
      image: { name: "ravi-codex-p0a", digest: expectation.imageDigest },
      runtime: { provider: "codex", requireCodexAuth: true, initialAgentId: "managed-ravi" },
      materials: { bootstrapPublicKey: "c".repeat(64) },
      storage: {
        stateLabel: "RAVI_STATE",
        stateMount: "/var/lib/ravi",
        bootstrapLabel: "RAVI_BOOTSTRAP",
        bootstrapMount: "/run/ravi-bootstrap",
      },
      versions: {
        ravi: "3.260712.2",
        raviRevision: "073599c",
        codex: "0.144.0",
        bun: "1.3.3",
        nats: "2.12.5",
      },
    });

    expect(contract.storage.stateLabel).toBe("RAVI_STATE");
  });

  test.each([
    ["hostId", "other-host", "bootstrap_hostId_mismatch"],
    ["vmId", "other-vm", "bootstrap_vmId_mismatch"],
    ["instanceId", "other-instance", "bootstrap_instanceId_mismatch"],
    [
      "deckInstanceRef",
      "managed-other-instance",
      "bootstrap_deckInstanceRef_mismatch",
    ],
    ["imageDigest", `sha256:${"b".repeat(64)}`, "bootstrap_imageDigest_mismatch"],
  ] as const)("rejects a mismatched %s binding", (key, value, code) => {
    const payload = validBootstrap();
    payload.bindings = { ...payload.bindings, [key]: value };
    expect(() => parseApplianceBootstrap(payload, expectation, now)).toThrow(
      expect.objectContaining({ code }),
    );
  });

  test("rejects expired and overlong grants", () => {
    const expired = validBootstrap();
    expired.expiresAt = "2026-07-15T17:59:59.000Z";
    expect(() => parseApplianceBootstrap(expired, expectation, now)).toThrow(
      expect.objectContaining({ code: "bootstrap_expired" }),
    );

    const overlong = validBootstrap();
    overlong.expiresAt = "2026-07-15T18:09:31.000Z";
    expect(() => parseApplianceBootstrap(overlong, expectation, now)).toThrow(
      expect.objectContaining({ code: "bootstrap_ttl_invalid" }),
    );
  });

  test("rejects a controller TTL that cannot be represented by the Ravi CLI", () => {
    const value = validBootstrap();
    value.controller.ttlSeconds = 301;

    expect(() => applianceBootstrapSchema.parse(value)).toThrow();
  });

  test("produces deterministic build-input digests", () => {
    expect(stableJson({ z: 1, a: [true, { c: "x", b: null }] })).toBe(
      '{"a":[true,{"b":null,"c":"x"}],"z":1}',
    );
    expect(sha256Digest(stableJson({ z: 1, a: 2 }))).toBe(sha256Digest(stableJson({ a: 2, z: 1 })));
  });
});
