import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { APPLIANCE_BOOTSTRAP_SCHEMA } from "./contract";

const roots: string[] = [];
const firstboot = join(import.meta.dir, "firstboot.py");
const hygiene = join(import.meta.dir, "hygiene.py");
const now = "2026-07-15T18:00:00Z";
const imageDigest = `sha256:${"a".repeat(64)}`;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Managed Ravi appliance first boot", () => {
  test("accepts an authentic, bounded package without exposing its context key", () => {
    const fixture = createFixture();
    const result = runFirstboot(fixture.root);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('"phase": "validated"');
    expect(result.stdout).not.toContain("rctx_");
  });

  test("bootstraps admin authority from an in-memory environment key", () => {
    const source = readFileSync(firstboot, "utf8");

    expect(source).toContain('"--from-env"');
    expect(source).toContain('"RAVI_BOOTSTRAP_KEY"');
    expect(source).toContain('cwd="/"');
    expect(source).not.toContain('payload.get("contextKey")');
  });

  test("keeps the immutable identity readable by the unprivileged controller gate", () => {
    const source = readFileSync(firstboot, "utf8");

    expect(source).toContain('["chown", "ravi:ravi", str(identity_path)]');
    expect(source).toContain("write_json(identity_path, identity, 0o600)");
  });

  test("parses the pretty JSON emitted by Ravi commands", () => {
    const result = runJsonParser(`{
      "action": "init-admin-key",
      "changed": true,
      "contextId": "ctx_example"
    }`);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      action: "init-admin-key",
      changed: true,
      contextId: "ctx_example",
    });
  });

  test("converts controller TTL seconds to Ravi CLI duration syntax without rounding", () => {
    expect(runDurationFormatter(300).stdout.trim()).toBe("5m");
    expect(runDurationFormatter(3600).stdout.trim()).toBe("1h");
    expect(runDurationFormatter(86400).stdout.trim()).toBe("1d");
    expect(runDurationFormatter(301).exitCode).toBe(1);
  });

  test("fails closed for tamper, expiry, and replay", () => {
    const tampered = createFixture();
    const payloadPath = join(tampered.root, "run/ravi-bootstrap/payload.json");
    const payload = JSON.parse(readFileSync(payloadPath, "utf8"));
    payload.bindings.instanceId = "instance_tampered";
    writeFileSync(payloadPath, `${JSON.stringify(payload)}\n`);
    expect(runFirstboot(tampered.root).stdout).toContain("bootstrap_signature_invalid");

    const expired = createFixture({ expiresAt: "2026-07-15T17:59:59Z" });
    expect(runFirstboot(expired.root).stdout).toContain("bootstrap_expired");

    const replayed = createFixture();
    mkdirSync(join(replayed.root, "var/lib/ravi/provisioning/consumed"), { recursive: true });
    writeFileSync(join(replayed.root, `var/lib/ravi/provisioning/consumed/${replayed.grantId}.json`), "{}\n");
    expect(runFirstboot(replayed.root).stdout).toContain("bootstrap_replayed");
  });

  test("rejects a malformed controller credential claim hash", () => {
    const fixture = createFixture({ credentialClaimTokenHash: "not-a-digest" });

    expect(runFirstboot(fixture.root).stdout).toContain("bootstrap_controller_claim_invalid");
  });

  test("accepts the exact Ravi Control installation capability", () => {
    const fixture = createFixture({
      capabilities: [
        "execute:group:self",
        "mutate:ravi-control.installation:d2a92057-5e59-4778-8e78-2fc2ca9a5f02",
      ],
    });

    const result = runFirstboot(fixture.root);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('"phase": "validated"');
  });

  test("writes a keyless Codex Responses provider bound to the host broker", () => {
    const root = temporaryRoot();
    const result = initializeCodexProvider(root);

    expect(result.exitCode).toBe(0);
    const config = readFileSync(join(root, "var/lib/ravi/.codex/config.toml"), "utf8");
    expect(config).toContain('model_provider = "ravi-managed-openai"');
    expect(config).toContain('base_url = "http://172.30.0.1:7443/v1"');
    expect(config).toContain("requires_openai_auth = false");
    expect(config).not.toContain("sk-");
    expect(config).not.toContain("api_key");
    expect(statSync(join(root, "var/lib/ravi/.codex/config.toml")).mode & 0o777).toBe(0o600);
  });

  test("stores controller authority under persistent state for one-time private claim", () => {
    const root = temporaryRoot();
    const result = persistControllerCredential(root);

    expect(result.exitCode).toBe(0);
    const credentialPath = join(root, "var/lib/ravi/provisioning/controller-credential.json");
    const claimPath = join(root, "var/lib/ravi/provisioning/controller-claim.json");
    const statePath = join(root, "var/lib/ravi/provisioning/controller-state.json");
    expect(JSON.parse(readFileSync(credentialPath, "utf8"))).toMatchObject({
      contextId: "context-controller",
      contextKey: "rctx_test-controller",
      expiresAt: "2026-07-16T18:00:00Z",
      instanceId: "instance_1",
    });
    expect(JSON.parse(readFileSync(claimPath, "utf8"))).toMatchObject({
      credentialClaimTokenHash: `sha256:${"c".repeat(64)}`,
      instanceId: "instance_1",
    });
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({
      currentContextId: "context-controller",
      generation: 1,
      schemaVersion: "ravi.managed-appliance.controller-state/v1",
    });
    expect(statSync(credentialPath).mode & 0o777).toBe(0o600);
    expect(statSync(claimPath).mode & 0o777).toBe(0o600);
    expect(statSync(statePath).mode & 0o777).toBe(0o600);
    expect(existsSync(join(root, "run/ravi-bootstrap/controller-credential.json"))).toBe(false);
  });

  test("rejects a state volume bound to another instance", () => {
    const fixture = createFixture();
    const markerPath = join(fixture.root, "var/lib/ravi/.ravi-state-volume.json");
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    marker.instanceId = "instance_other";
    writeFileSync(markerPath, `${JSON.stringify(marker)}\n`);

    expect(runFirstboot(fixture.root).stdout).toContain("state_instanceId_mismatch");
  });

  test("accepts the unique machine id generated by systemd at runtime", () => {
    const root = temporaryRoot();
    const machineId = randomUUID().replaceAll("-", "");
    mkdirSync(join(root, "etc"), { recursive: true });
    writeFileSync(join(root, "etc/machine-id"), `${machineId}\n`);

    const result = runMachineIdentity(root, true);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(machineId);
  });

  test("recreates volatile runtime state when an existing appliance boots", () => {
    const root = createExistingInstallation("ready");

    const result = Bun.spawnSync(["python3", firstboot, "--root", root, "--bootstrap-dir", "/run/ravi-bootstrap"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain('"phase": "already_provisioned"');
    expect(statSync(join(root, "run/ravi")).isDirectory()).toBe(true);
  });

  test("retries readiness after a transient probe failure without reprovisioning", () => {
    const root = createExistingInstallation("readiness_failed");

    const result = Bun.spawnSync(["python3", firstboot, "--root", root, "--bootstrap-dir", "/run/ravi-bootstrap"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain('"phase": "already_provisioned"');
  });

  test("still rejects an existing installation with a permanent provisioning failure", () => {
    const root = createExistingInstallation("failed");

    const result = Bun.spawnSync(["python3", firstboot, "--root", root, "--bootstrap-dir", "/run/ravi-bootstrap"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toContain("provisioning_status_invalid");
  });

  test("still rejects an inherited machine id outside runtime first boot", () => {
    const root = temporaryRoot();
    mkdirSync(join(root, "etc"), { recursive: true });
    writeFileSync(join(root, "etc/machine-id"), `${randomUUID().replaceAll("-", "")}\n`);

    const result = runMachineIdentity(root, false);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("machine_identity_not_clean");
  });
});

describe("Managed Ravi appliance hygiene", () => {
  test("reports safe paths/categories without printing secret values", () => {
    const root = temporaryRoot();
    mkdirSync(join(root, "etc"), { recursive: true });
    writeFileSync(join(root, "etc/machine-id"), "");
    expect(Bun.spawnSync(["python3", hygiene, root]).exitCode).toBe(0);

    mkdirSync(join(root, "var/lib/ravi"), { recursive: true });
    const secret = "rctx_1234567890abcdefghijklmnop";
    writeFileSync(join(root, "var/lib/ravi/credentials.json"), secret);
    const result = Bun.spawnSync(["python3", hygiene, root]);
    const output = result.stdout.toString();
    expect(result.exitCode).toBe(1);
    expect(output).toContain("var/lib/ravi/credentials.json");
    expect(output).not.toContain(secret);
  });
});

function createFixture(overrides: {
  capabilities?: string[];
  credentialClaimTokenHash?: string;
  expiresAt?: string;
} = {}) {
  const root = temporaryRoot();
  const bootstrapDir = join(root, "run/ravi-bootstrap");
  const configDir = join(root, "etc/ravi-appliance");
  mkdirSync(bootstrapDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  mkdirSync(join(root, "var/lib/ravi/provisioning"), { recursive: true });
  writeFileSync(
    join(configDir, "contract.json"),
    `${JSON.stringify({
      image: { digest: imageDigest },
      runtime: { provider: "codex" },
      storage: {
        stateLabel: "RAVI_STATE",
        stateMount: "/var/lib/ravi",
        bootstrapLabel: "RAVI_BOOTSTRAP",
        bootstrapMount: "/run/ravi-bootstrap",
      },
    })}\n`,
  );

  const privateKey = join(root, "bootstrap-private.pem");
  const publicKey = join(configDir, "bootstrap-public.pem");
  expect(Bun.spawnSync(["openssl", "genpkey", "-algorithm", "ED25519", "-out", privateKey]).exitCode).toBe(0);
  expect(Bun.spawnSync(["openssl", "pkey", "-in", privateKey, "-pubout", "-out", publicKey]).exitCode).toBe(0);
  chmodSync(privateKey, 0o600);

  const grantId = randomUUID();
  const payload = {
    schemaVersion: APPLIANCE_BOOTSTRAP_SCHEMA,
    grantId,
    issuedAt: "2026-07-15T17:59:30Z",
    expiresAt: overrides.expiresAt ?? "2026-07-15T18:09:30Z",
    bindings: {
      hostId: "host_ovh_1",
      vmId: "vm_appliance_1",
      instanceId: "instance_1",
      deckInstanceRef: "managed-instance_1",
      imageDigest,
    },
    controller: {
      label: "managed-runtime-controller",
      credentialClaimTokenHash:
        overrides.credentialClaimTokenHash ??
        `sha256:${createHash("sha256").update("test-claim-token").digest("hex")}`,
      capabilities: overrides.capabilities ?? ["execute:group:sessions", "access:session:*"],
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
  const payloadPath = join(bootstrapDir, "payload.json");
  const signaturePath = join(bootstrapDir, "payload.sig");
  mkdirSync(join(root, "var/lib/ravi"), { recursive: true });
  writeFileSync(
    join(root, "var/lib/ravi/.ravi-state-volume.json"),
    `${JSON.stringify({
      schemaVersion: "ravi.managed-appliance.state-volume/v1",
      instanceId: payload.bindings.instanceId,
      vmId: payload.bindings.vmId,
      imageDigest: payload.bindings.imageDigest,
    })}\n`,
  );
  writeFileSync(payloadPath, `${JSON.stringify(payload)}\n`);
  expect(
    Bun.spawnSync([
      "openssl",
      "pkeyutl",
      "-sign",
      "-inkey",
      privateKey,
      "-rawin",
      "-in",
      payloadPath,
      "-out",
      signaturePath,
    ]).exitCode,
  ).toBe(0);
  return { root, grantId };
}

function runFirstboot(root: string) {
  const result = Bun.spawnSync([
    "python3",
    firstboot,
    "--root",
    root,
    "--bootstrap-dir",
    "/run/ravi-bootstrap",
    "--now",
    now,
    "--validate-only",
  ]);
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function runMachineIdentity(root: string, acceptSystemdGenerated: boolean) {
  const source = [
    "import importlib.util, pathlib, sys",
    "spec=importlib.util.spec_from_file_location('firstboot', sys.argv[1])",
    "module=importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "try:",
    " print(module.initialize_machine_identity(pathlib.Path(sys.argv[2]), accept_systemd_generated=sys.argv[3]=='1'))",
    "except module.FirstBootError as error:",
    " print(str(error))",
    " raise SystemExit(1)",
  ].join("\n");
  const result = Bun.spawnSync([
    "python3",
    "-c",
    source,
    firstboot,
    root,
    acceptSystemdGenerated ? "1" : "0",
  ]);
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function runJsonParser(stdout: string) {
  const source = [
    "import importlib.util, json, sys",
    "spec=importlib.util.spec_from_file_location('firstboot', sys.argv[1])",
    "module=importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "print(json.dumps(module.parse_json_object(sys.argv[2], 'parse_failed'), sort_keys=True))",
  ].join("\n");
  const result = Bun.spawnSync(["python3", "-c", source, firstboot, stdout]);
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function runDurationFormatter(seconds: number) {
  const source = [
    "import importlib.util, sys",
    "spec=importlib.util.spec_from_file_location('firstboot', sys.argv[1])",
    "module=importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "print(module.format_cli_duration(int(sys.argv[2])))",
  ].join("\n");
  const result = Bun.spawnSync(["python3", "-c", source, firstboot, String(seconds)]);
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function persistControllerCredential(root: string) {
  const source = [
    "import importlib.util, json, pathlib, sys",
    "spec=importlib.util.spec_from_file_location('firstboot', sys.argv[1])",
    "module=importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "payload=json.loads(sys.argv[3])",
    "controller=json.loads(sys.argv[4])",
    "module.persist_controller_credential(pathlib.Path(sys.argv[2]), payload, controller)",
  ].join("\n");
  const payload = {
    bindings: { instanceId: "instance_1" },
    controller: { credentialClaimTokenHash: `sha256:${"c".repeat(64)}` },
    expiresAt: "2026-07-15T18:09:30Z",
  };
  const controller = {
    contextId: "context-controller",
    contextKey: "rctx_test-controller",
    expiresAt: Date.parse("2026-07-16T18:00:00Z"),
  };
  const result = Bun.spawnSync([
    "python3",
    "-c",
    source,
    firstboot,
    root,
    JSON.stringify(payload),
    JSON.stringify(controller),
  ]);
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function initializeCodexProvider(root: string) {
  const source = [
    "import importlib.util, json, pathlib, sys",
    "spec=importlib.util.spec_from_file_location('firstboot', sys.argv[1])",
    "module=importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "module.initialize_codex_provider(pathlib.Path(sys.argv[2]), json.loads(sys.argv[3]))",
  ].join("\n");
  const result = Bun.spawnSync([
    "python3",
    "-c",
    source,
    firstboot,
    root,
    JSON.stringify({
      providerBroker: {
        baseUrl: "http://172.30.0.1:7443/v1",
        kind: "host_responses_proxy",
        wireApi: "responses",
      },
    }),
  ]);
  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    stdout: result.stdout.toString(),
  };
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ravi-appliance-test-"));
  roots.push(root);
  return root;
}

function createExistingInstallation(phase: string): string {
  const root = temporaryRoot();
  const digest = `sha256:${"b".repeat(64)}`;
  mkdirSync(join(root, "etc/ravi-appliance"), { recursive: true });
  mkdirSync(join(root, "var/lib/ravi/provisioning"), { recursive: true });
  writeFileSync(
    join(root, "etc/ravi-appliance/contract.json"),
    `${JSON.stringify({
      image: { digest },
      storage: { stateLabel: "RAVI_STATE", stateMount: "/var/lib/ravi" },
    })}\n`,
  );
  writeFileSync(
    join(root, "var/lib/ravi/.ravi-state-volume.json"),
    `${JSON.stringify({ instanceId: "instance_1", vmId: "vm_1", imageDigest: digest })}\n`,
  );
  writeFileSync(
    join(root, "var/lib/ravi/identity.json"),
    `${JSON.stringify({
      deckInstanceRef: "managed-instance_1",
      instanceId: "instance_1",
      vmId: "vm_1",
      imageDigest: digest,
      installationId: "rinst_existing",
      providerBrokerBaseUrl: "http://172.30.0.1:7443/v1",
    })}\n`,
  );
  mkdirSync(join(root, "var/lib/ravi/.codex"), { recursive: true });
  writeFileSync(
    join(root, "var/lib/ravi/.codex/config.toml"),
    'base_url = "http://172.30.0.1:7443/v1"\n',
  );
  writeFileSync(
    join(root, "var/lib/ravi/provisioning/provider-broker.json"),
    `${JSON.stringify({
      baseUrl: "http://172.30.0.1:7443/v1",
      healthUrl: "http://172.30.0.1:7443/health",
      kind: "host_responses_proxy",
      schemaVersion: "ravi.managed-appliance.provider-broker/v1",
    })}\n`,
  );
  writeFileSync(join(root, "var/lib/ravi/provisioning/status.json"), `${JSON.stringify({ phase })}\n`);
  return root;
}
