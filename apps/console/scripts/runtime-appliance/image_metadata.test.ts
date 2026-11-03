import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { APPLIANCE_IMAGE_CONTRACT_SCHEMA } from "./contract";

const roots: string[] = [];
const script = join(import.meta.dir, "image_metadata.py");
const digest = `sha256:${"a".repeat(64)}`;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Managed Ravi image metadata", () => {
  test("validates pinned inputs and emits provenance plus SPDX metadata", () => {
    const root = temporaryRoot();
    const contract = join(root, "contract.json");
    const kernel = join(root, "vmlinux");
    const rootfs = join(root, "rootfs.ext4");
    const base = join(root, "base.squashfs");
    const publicKey = join(root, "bootstrap-public.pem");
    writeFileSync(publicKey, "test-bootstrap-public-key");
    writeFileSync(contract, `${JSON.stringify(validContract(sha256("test-bootstrap-public-key")))}\n`);
    writeFileSync(kernel, "kernel");
    writeFileSync(rootfs, "rootfs");
    writeFileSync(base, "base");

    const result = Bun.spawnSync([
      "python3",
      script,
      "emit",
      ...baseArguments(contract, publicKey),
      "--kernel",
      kernel,
      "--rootfs",
      rootfs,
      "--base-squashfs",
      base,
      "--ravi-release-sha256",
      "b".repeat(64),
      "--output-dir",
      root,
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(join(root, "provenance.json"), "utf8")).subject.imageDigest).toBe(digest);
    expect(JSON.parse(readFileSync(join(root, "sbom.spdx.json"), "utf8")).spdxVersion).toBe("SPDX-2.3");
  });

  test("fails when the build inputs drift from the signed contract", () => {
    const root = temporaryRoot();
    const contract = join(root, "contract.json");
    const publicKey = join(root, "bootstrap-public.pem");
    writeFileSync(publicKey, "test-bootstrap-public-key");
    writeFileSync(contract, `${JSON.stringify(validContract(sha256("test-bootstrap-public-key")))}\n`);
    const result = Bun.spawnSync([
      "python3",
      script,
      "validate-contract",
      ...baseArguments(contract, publicKey).map((value) =>
        value === "0.144.0" ? "0.145.0" : value,
      ),
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("contract mismatch: versions.codex");
  });
});

function validContract(bootstrapPublicKey: string) {
  return {
    schemaVersion: APPLIANCE_IMAGE_CONTRACT_SCHEMA,
    image: { name: "ravi-codex-p0a", digest },
    materials: { bootstrapPublicKey },
    runtime: { provider: "codex", requireCodexAuth: true, initialAgentId: "managed-ravi" },
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
  };
}

function baseArguments(contract: string, publicKey: string): string[] {
  return [
    "--contract",
    contract,
    "--bootstrap-public-key",
    publicKey,
    "--name",
    "ravi-codex-p0a",
    "--ravi-version",
    "3.260712.2",
    "--ravi-revision",
    "073599c",
    "--codex-version",
    "0.144.0",
    "--bun-version",
    "1.3.3",
    "--nats-version",
    "2.12.5",
  ];
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ravi-appliance-metadata-test-"));
  roots.push(root);
  return root;
}
