import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

const readyGate = join(import.meta.dir, "ready_gate.py");
const roots: string[] = [];
const NOW = "2026-07-15T18:00:00+00:00";
const CLAIM_TOKEN = "ravi_mcc_test-controller-claim-token";
const ROTATION_CLAIM_TOKEN = "ravi_mcc_test-controller-rotation-token";
const ROTATION_GRANT_ID = "d7d49753-0557-41c6-85d3-01f6375f5aa8";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("Managed Ravi private readiness gate", () => {
  test("normalizes Ravi context epoch expiry at the appliance boundary", () => {
    const result = normalizeExpiry(Date.parse("2026-07-16T18:00:00Z"));

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("2026-07-16T18:00:00Z");
  });

  test("exposes only a bounded projection after full appliance readiness", () => {
    const path = fixture({ ready: true, checks: { secret_check: { value: "must-not-escape" } } });
    const result = project(path);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, ready: true });
    expect(result.stdout).not.toContain("must-not-escape");
  });

  test("fails closed for missing, malformed, or negative readiness", () => {
    expect(JSON.parse(project(fixture({ ready: false })).stdout)).toEqual({
      code: "readiness_invalid",
      failedChecks: [],
      ok: false,
      ready: false,
    });
    expect(JSON.parse(project(fixture("not-json")).stdout)).toEqual({
      code: "readiness_pending",
      ok: false,
      ready: false,
    });
    expect(JSON.parse(project(join(tmpdir(), "ravi-ready-missing.json")).stdout)).toEqual({
      code: "readiness_pending",
      ok: false,
      ready: false,
    });
  });

  test("exposes only safe failed and current check names before readiness", () => {
    const path = fixture({
      code: "readiness_pending",
      currentCheck: "dns_resolution",
      ready: false,
      checks: {
        contract: { ok: true, path: "/secret/path" },
        persistent_state: { ok: false, source: "/dev/mapper/secret" },
        "unsafe.check": { ok: false },
      },
    });

    const payload = JSON.parse(project(path).stdout);
    expect(payload).toEqual({
      code: "readiness_pending",
      currentCheck: "dns_resolution",
      failedChecks: ["persistent_state"],
      ok: false,
      ready: false,
    });
    expect(JSON.stringify(payload)).not.toContain("secret");
  });

  test("returns the controller credential exactly once and removes claim state", () => {
    const item = claimFixture({ ready: true });
    const first = claim(item, CLAIM_TOKEN);

    expect(first.exitCode).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({
      contextId: "context-controller",
      contextKey: "rctx_test-controller",
      instanceId: "instance_1",
    });
    expect(existsSync(item.credentialPath)).toBe(false);
    expect(existsSync(item.claimPath)).toBe(false);

    const replay = claim(item, CLAIM_TOKEN);
    expect(replay.exitCode).toBe(1);
    expect(JSON.parse(replay.stdout)).toEqual({ code: "controller_claim_consumed", status: 410 });
  });

  test("rejects a wrong token without consuming the claim", () => {
    const item = claimFixture({ ready: true });
    const wrong = claim(item, "ravi_mcc_wrong-token");

    expect(wrong.exitCode).toBe(1);
    expect(JSON.parse(wrong.stdout)).toEqual({ code: "controller_claim_unauthorized", status: 401 });
    expect(existsSync(item.credentialPath)).toBe(true);
    expect(existsSync(item.claimPath)).toBe(true);
    expect(claim(item, CLAIM_TOKEN).exitCode).toBe(0);
  });

  test("fails closed before readiness and erases expired claims", () => {
    const notReady = claimFixture({ ready: false });
    expect(JSON.parse(claim(notReady, CLAIM_TOKEN).stdout)).toEqual({
      code: "controller_not_ready",
      status: 503,
    });
    expect(existsSync(notReady.credentialPath)).toBe(true);

    const expired = claimFixture({ expiresAt: "2026-07-15T17:59:59Z", ready: true });
    expect(JSON.parse(claim(expired, CLAIM_TOKEN).stdout)).toEqual({
      code: "controller_claim_expired",
      status: 410,
    });
    expect(existsSync(expired.credentialPath)).toBe(false);
    expect(existsSync(expired.claimPath)).toBe(false);
  });

  test("prepares, claims repeatedly, and acknowledges a controller rotation exactly once", () => {
    const item = rotationFixture();
    const prepared = prepareRotation(item, "complete");

    expect(prepared.exitCode).toBe(0);
    expect(JSON.parse(prepared.stdout)).toEqual({
      grantId: ROTATION_GRANT_ID,
      ok: true,
      phase: "claimable",
      replacementContextId: "context-controller-next",
    });

    const rejected = claimRotation(item, "ravi_mcc_wrong-token");
    expect(rejected.exitCode).toBe(1);
    expect(JSON.parse(rejected.stdout)).toEqual({
      code: "controller_rotation_claim_unauthorized",
      status: 401,
    });
    expect(existsSync(item.pendingPath)).toBe(true);

    const first = claimRotation(item, ROTATION_CLAIM_TOKEN);
    const replay = claimRotation(item, ROTATION_CLAIM_TOKEN);
    expect(first.exitCode).toBe(0);
    expect(JSON.parse(first.stdout)).toEqual(JSON.parse(replay.stdout));
    expect(JSON.parse(first.stdout)).toMatchObject({
      contextId: "context-controller-next",
      contextKey: "rctx_test-controller-next",
      instanceId: "instance_1",
    });

    const acknowledged = ackRotation(item, ROTATION_CLAIM_TOKEN);
    expect(acknowledged.exitCode).toBe(0);
    expect(JSON.parse(acknowledged.stdout)).toMatchObject({
      acknowledged: true,
      contextId: "context-controller-next",
      grantId: ROTATION_GRANT_ID,
      ok: true,
    });
    expect(existsSync(item.pendingPath)).toBe(false);
    expect(JSON.parse(readFileSync(item.controllerStatePath, "utf8"))).toMatchObject({
      currentContextId: "context-controller-next",
      generation: 2,
    });

    const acknowledgedReplay = ackRotation(item, ROTATION_CLAIM_TOKEN);
    expect(acknowledgedReplay.exitCode).toBe(0);
    expect(JSON.parse(acknowledgedReplay.stdout)).toEqual(JSON.parse(acknowledged.stdout));
    const unauthorizedReplay = ackRotation(item, "ravi_mcc_wrong-token");
    expect(unauthorizedReplay.exitCode).toBe(1);
    expect(JSON.parse(unauthorizedReplay.stdout)).toEqual({
      code: "controller_rotation_claim_unauthorized",
      status: 401,
    });
  });

  test("resumes the same signed grant after an interrupted rotation", () => {
    const item = rotationFixture();
    const interrupted = prepareRotation(item, "interrupt");

    expect(interrupted.exitCode).toBe(1);
    expect(JSON.parse(interrupted.stdout)).toEqual({ code: "simulated_crash", status: 503 });
    expect(JSON.parse(readFileSync(item.pendingPath, "utf8"))).toMatchObject({
      grantId: ROTATION_GRANT_ID,
      phase: "replacement_issued",
      replacement: { contextId: "context-controller-next" },
    });

    const resumed = prepareRotation(item, "resume");
    expect(resumed.exitCode).toBe(0);
    expect(JSON.parse(resumed.stdout)).toMatchObject({
      grantId: ROTATION_GRANT_ID,
      ok: true,
      phase: "claimable",
      replacementContextId: "context-controller-next",
    });
  });

  test("replaces only an expired side-effect-free authorized rotation", () => {
    const item = rotationFixture();
    writeFileSync(
      item.pendingPath,
      JSON.stringify({
        schemaVersion: "ravi.managed-appliance.controller-rotation-state/v1",
        grantId: "d7d49753-0557-41c6-85d3-01f6375f5aa7",
        operationId: "6e75a95a-16fd-4a34-8f06-fd315a881d22",
        instanceId: "instance_1",
        previousContextId: "context-controller-current",
        credentialClaimTokenHash: `sha256:${"b".repeat(64)}`,
        expiresAt: "2026-07-15T17:00:00Z",
        claimExpiresAt: "2026-07-15T17:30:00Z",
        phase: "authorized",
        temporaryAdminContextKey: "rctx_expired-authorized-rotation",
        temporaryAdminContextId: null,
        replacement: null,
      }),
    );

    const prepared = prepareRotation(item, "complete");

    expect(prepared.exitCode).toBe(0);
    expect(JSON.parse(prepared.stdout)).toMatchObject({
      grantId: ROTATION_GRANT_ID,
      phase: "claimable",
    });

    const claimWindowActive = rotationFixture();
    writeFileSync(
      claimWindowActive.pendingPath,
      JSON.stringify({
        schemaVersion: "ravi.managed-appliance.controller-rotation-state/v1",
        grantId: "d7d49753-0557-41c6-85d3-01f6375f5aa7",
        operationId: "6e75a95a-16fd-4a34-8f06-fd315a881d22",
        instanceId: "instance_1",
        previousContextId: "context-controller-current",
        credentialClaimTokenHash: `sha256:${"b".repeat(64)}`,
        expiresAt: "2026-07-15T17:00:00Z",
        claimExpiresAt: "2026-07-15T18:30:00Z",
        phase: "authorized",
        temporaryAdminContextKey: "rctx_authorized-active-claim-window",
        temporaryAdminContextId: null,
        replacement: null,
      }),
    );

    const rejected = prepareRotation(claimWindowActive, "complete");
    expect(rejected.exitCode).toBe(1);
    expect(JSON.parse(rejected.stdout)).toEqual({
      code: "controller_rotation_pending",
      status: 409,
    });
  });

  test("keeps an expired rotation once guest side effects may exist", () => {
    for (const phase of [
      "admin_ready",
      "replacement_issued",
      "previous_revoked",
      "claimable",
      "claimed",
    ]) {
      const item = rotationFixture();
      writeFileSync(
        item.pendingPath,
        JSON.stringify({
          schemaVersion: "ravi.managed-appliance.controller-rotation-state/v1",
          grantId: "d7d49753-0557-41c6-85d3-01f6375f5aa7",
          operationId: "6e75a95a-16fd-4a34-8f06-fd315a881d22",
          instanceId: "instance_1",
          previousContextId: "context-controller-current",
          credentialClaimTokenHash: `sha256:${"b".repeat(64)}`,
          expiresAt: "2026-07-15T17:00:00Z",
          claimExpiresAt: "2026-07-15T17:30:00Z",
          phase,
          temporaryAdminContextKey: phase === "claimable" || phase === "claimed"
            ? undefined
            : "rctx_expired-interrupted-rotation",
          temporaryAdminContextId: "context-temporary-admin",
          replacement: phase === "admin_ready"
            ? null
            : {
                contextId: "context-controller-orphan",
                contextKey: "rctx_controller-orphan",
              },
        }),
      );

      const rejected = prepareRotation(item, "complete");

      expect(rejected.exitCode).toBe(1);
      expect(JSON.parse(rejected.stdout)).toEqual({
        code: "controller_rotation_pending",
        status: 409,
      });
    }
  });

  test("rejects a binding mismatch and a consumed grant replay", () => {
    const mismatch = rotationFixture({ identityInstanceId: "instance_2" });
    const rejected = prepareRotation(mismatch, "complete");
    expect(rejected.exitCode).toBe(1);
    expect(JSON.parse(rejected.stdout)).toEqual({
      code: "controller_rotation_binding_mismatch",
      status: 409,
    });

    const consumed = rotationFixture();
    mkdirSync(consumed.consumedDir, { recursive: true });
    writeFileSync(
      join(consumed.consumedDir, `${ROTATION_GRANT_ID}.json`),
      JSON.stringify({ grantId: ROTATION_GRANT_ID }),
    );
    const replay = prepareRotation(consumed, "complete");
    expect(replay.exitCode).toBe(1);
    expect(JSON.parse(replay.stdout)).toEqual({
      code: "controller_rotation_consumed",
      status: 410,
    });
  });
});

function fixture(value: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "ravi-ready-gate-"));
  roots.push(root);
  const path = join(root, "readiness.json");
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  return path;
}

function project(path: string) {
  const source = [
    "import importlib.util, json, pathlib, sys",
    "spec=importlib.util.spec_from_file_location('ready_gate', sys.argv[1])",
    "module=importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "print(json.dumps(module.readiness_payload(pathlib.Path(sys.argv[2])), sort_keys=True))",
  ].join("\n");
  const result = Bun.spawnSync(["python3", "-c", source, readyGate, path]);
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function normalizeExpiry(value: number) {
  const source = [
    "import importlib.util, sys",
    "spec=importlib.util.spec_from_file_location('ready_gate', sys.argv[1])",
    "module=importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "print(module.normalize_context_expiry(int(sys.argv[2])))",
  ].join("\n");
  const result = Bun.spawnSync(["python3", "-c", source, readyGate, String(value)]);
  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    stdout: result.stdout.toString(),
  };
}

function claimFixture(input: { expiresAt?: string; ready: boolean }) {
  const root = mkdtempSync(join(tmpdir(), "ravi-ready-claim-"));
  roots.push(root);
  const readinessPath = join(root, "readiness.json");
  const credentialPath = join(root, "provisioning/controller-credential.json");
  const claimPath = join(root, "provisioning/controller-claim.json");
  mkdirSync(join(root, "provisioning"), { recursive: true });
  writeFileSync(readinessPath, JSON.stringify({ ready: input.ready }));
  writeFileSync(
    credentialPath,
    JSON.stringify({
      schemaVersion: "ravi.managed-appliance.controller-credential/v1",
      contextId: "context-controller",
      contextKey: "rctx_test-controller",
      expiresAt: "2026-07-16T18:00:00Z",
      instanceId: "instance_1",
    }),
  );
  writeFileSync(
    claimPath,
    JSON.stringify({
      schemaVersion: "ravi.managed-appliance.controller-claim/v1",
      credentialClaimTokenHash: `sha256:${createHash("sha256").update(CLAIM_TOKEN).digest("hex")}`,
      expiresAt: input.expiresAt ?? "2026-07-15T18:05:00Z",
      instanceId: "instance_1",
    }),
  );
  return { claimPath, credentialPath, readinessPath };
}

function claim(
  item: ReturnType<typeof claimFixture>,
  token: string,
) {
  const source = [
    "import datetime as dt, importlib.util, json, pathlib, sys",
    "spec=importlib.util.spec_from_file_location('ready_gate', sys.argv[1])",
    "module=importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "try:",
    " value=module.claim_controller_credential(sys.argv[5], readiness_path=pathlib.Path(sys.argv[2]), credential_path=pathlib.Path(sys.argv[3]), claim_path=pathlib.Path(sys.argv[4]), now=dt.datetime.fromisoformat(sys.argv[6]))",
    " print(json.dumps(value, sort_keys=True))",
    "except module.ControllerClaimError as error:",
    " print(json.dumps({'code': error.code, 'status': error.status}, sort_keys=True))",
    " raise SystemExit(1)",
  ].join("\n");
  const result = Bun.spawnSync([
    "python3",
    "-c",
    source,
    readyGate,
    item.readinessPath,
    item.credentialPath,
    item.claimPath,
    token,
    NOW,
  ]);
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function rotationFixture(input: { identityInstanceId?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ravi-ready-rotation-"));
  roots.push(root);
  const provisioningDir = join(root, "provisioning");
  const identityPath = join(root, "identity.json");
  const controllerStatePath = join(provisioningDir, "controller-state.json");
  const pendingPath = join(provisioningDir, "controller-rotation-pending.json");
  const consumedDir = join(provisioningDir, "controller-rotations-consumed");
  mkdirSync(provisioningDir, { recursive: true });
  const imageDigest = `sha256:${"a".repeat(64)}`;
  writeFileSync(
    identityPath,
    JSON.stringify({
      schemaVersion: "ravi.managed-appliance.identity/v1",
      deckInstanceRef: "managed-instance_1",
      hostId: "ravi-runtime-ovh-1",
      imageDigest,
      instanceId: input.identityInstanceId ?? "instance_1",
      vmId: "vm-managed-1",
    }),
  );
  writeFileSync(
    controllerStatePath,
    JSON.stringify({
      schemaVersion: "ravi.managed-appliance.controller-state/v1",
      currentContextId: "context-controller-current",
      generation: 1,
      updatedAt: "2026-07-15T17:00:00Z",
    }),
  );
  const payload = {
    schemaVersion: "ravi.managed-appliance.controller-rotation/v1",
    grantId: ROTATION_GRANT_ID,
    issuedAt: "2026-07-15T18:00:00Z",
    expiresAt: "2026-07-15T18:05:00Z",
    bindings: {
      operationId: "6e75a95a-16fd-4a34-8f06-fd315a881d23",
      hostId: "ravi-runtime-ovh-1",
      vmId: "vm-managed-1",
      instanceId: "instance_1",
      deckInstanceRef: "managed-instance_1",
      imageDigest,
      previousContextId: "context-controller-current",
    },
    controller: {
      label: "managed-runtime-controller",
      credentialClaimTokenHash: `sha256:${createHash("sha256")
        .update(ROTATION_CLAIM_TOKEN)
        .digest("hex")}`,
      capabilities: ["execute:group:sessions"],
      ttlSeconds: 86_400,
    },
  };
  return {
    consumedDir,
    controllerStatePath,
    identityPath,
    payloadBase64: Buffer.from(JSON.stringify(payload), "utf8").toString("base64"),
    pendingPath,
    signatureBase64: Buffer.from("valid-signature", "utf8").toString("base64"),
  };
}

function prepareRotation(
  item: ReturnType<typeof rotationFixture>,
  mode: "complete" | "interrupt" | "resume",
) {
  const source = [
    "import datetime as dt, importlib.util, json, pathlib, sys",
    "spec=importlib.util.spec_from_file_location('ready_gate', sys.argv[1])",
    "module=importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "mode=sys.argv[8]",
    "def executor(pending, payload, path):",
    " replacement={'schemaVersion':'ravi.managed-appliance.controller-credential/v1','contextId':'context-controller-next','contextKey':'rctx_test-controller-next','expiresAt':'2026-07-16T18:00:00Z','instanceId':'instance_1'}",
    " if mode == 'resume' and pending.get('phase') != 'replacement_issued': raise module.ControllerClaimError(503, 'resume_state_invalid')",
    " pending['replacement']=replacement",
    " pending['phase']='replacement_issued' if mode == 'interrupt' else 'claimable'",
    " module.write_private_json(path, pending)",
    " if mode == 'interrupt': raise module.ControllerClaimError(503, 'simulated_crash')",
    " return pending",
    "try:",
    " value=module.prepare_controller_rotation(sys.argv[2], sys.argv[3], now=dt.datetime.fromisoformat(sys.argv[4]), identity_path=pathlib.Path(sys.argv[5]), controller_state_path=pathlib.Path(sys.argv[6]), pending_path=pathlib.Path(sys.argv[7]), consumed_dir=pathlib.Path(sys.argv[9]), signature_verifier=lambda *_: True, rotation_executor=executor)",
    " print(json.dumps(value, sort_keys=True))",
    "except module.ControllerClaimError as error:",
    " print(json.dumps({'code': error.code, 'status': error.status}, sort_keys=True))",
    " raise SystemExit(1)",
  ].join("\n");
  return spawnPython(source, [
    item.payloadBase64,
    item.signatureBase64,
    NOW,
    item.identityPath,
    item.controllerStatePath,
    item.pendingPath,
    mode,
    item.consumedDir,
  ]);
}

function claimRotation(item: ReturnType<typeof rotationFixture>, token: string) {
  const source = [
    "import datetime as dt, importlib.util, json, pathlib, sys",
    "spec=importlib.util.spec_from_file_location('ready_gate', sys.argv[1])",
    "module=importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "try:",
    " value=module.claim_controller_rotation(sys.argv[2], sys.argv[3], now=dt.datetime.fromisoformat(sys.argv[4]), pending_path=pathlib.Path(sys.argv[5]))",
    " print(json.dumps(value, sort_keys=True))",
    "except module.ControllerClaimError as error:",
    " print(json.dumps({'code': error.code, 'status': error.status}, sort_keys=True))",
    " raise SystemExit(1)",
  ].join("\n");
  return spawnPython(source, [token, ROTATION_GRANT_ID, NOW, item.pendingPath]);
}

function ackRotation(item: ReturnType<typeof rotationFixture>, token: string) {
  const source = [
    "import datetime as dt, importlib.util, json, pathlib, sys",
    "spec=importlib.util.spec_from_file_location('ready_gate', sys.argv[1])",
    "module=importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "try:",
    " value=module.ack_controller_rotation(sys.argv[2], sys.argv[3], sys.argv[4], now=dt.datetime.fromisoformat(sys.argv[5]), controller_state_path=pathlib.Path(sys.argv[6]), pending_path=pathlib.Path(sys.argv[7]), consumed_dir=pathlib.Path(sys.argv[8]))",
    " print(json.dumps(value, sort_keys=True))",
    "except module.ControllerClaimError as error:",
    " print(json.dumps({'code': error.code, 'status': error.status}, sort_keys=True))",
    " raise SystemExit(1)",
  ].join("\n");
  return spawnPython(source, [
    token,
    ROTATION_GRANT_ID,
    "context-controller-next",
    NOW,
    item.controllerStatePath,
    item.pendingPath,
    item.consumedDir,
  ]);
}

function spawnPython(source: string, args: string[]) {
  const result = Bun.spawnSync(["python3", "-c", source, readyGate, ...args]);
  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    stdout: result.stdout.toString(),
  };
}
