import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  accountJwtPushArgs,
  accountNameFromProviderRef,
  BunControllerCommandRunner,
  ControllerError,
  controllerConfigFromEnv,
  NscEventPlaneControllerDriver,
  nscResolverUrl,
  parsePermissions,
  reconciliationReportBody,
  syncControlPlaneProjection,
} from "./event-plane-controller";
import type {
  ControllerCommandRunner,
  EventPlaneControlApi,
  EventPlaneControllerProjection,
} from "./event-plane-controller";
import type {
  EventPlaneDesiredCell,
  EventPlaneDesiredStateSnapshot,
  EventPlaneReconciliationReport,
  EventPlaneReconcileOperation,
} from "../src/server/console/event-plane-reconciler";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Event Plane controller boundary", () => {
  test("requires the explicit synthetic-only rollout gate and three-node cell", () => {
    expect(() => controllerConfigFromEnv({})).toThrow("controller_ravi_event_plane_rollout_mode_required");
    expect(() => controllerConfigFromEnv(controllerEnv({
      RAVI_EVENT_PLANE_ROLLOUT_MODE: "production",
    }))).toThrow("controller_rollout_mode_forbidden");
    expect(() => controllerConfigFromEnv(controllerEnv({
      RAVI_EVENT_PLANE_NATS_SERVERS: "tls://127.0.0.1:4222",
    }))).toThrow("controller_three_node_cell_required");

    const config = controllerConfigFromEnv(controllerEnv());
    expect(config.rolloutMode).toBe("p0_synthetic_only");
    expect(config.natsServers).toHaveLength(3);
  });

  test("publishes account JWT updates through the NATS resolver", () => {
    const config = controllerConfigFromEnv(controllerEnv());
    expect(nscResolverUrl("tls://172.16.30.2:4222")).toBe("nats://172.16.30.2:4222");
    expect(nscResolverUrl("nats://172.16.30.2:4222")).toBe("nats://172.16.30.2:4222");
    expect(() => nscResolverUrl("https://resolver.invalid"))
      .toThrow("controller_nsc_resolver_url_invalid");
    expect(accountJwtPushArgs(config, "ORG_SYNTH_CTRL_ALPHA")).toEqual([
      "push",
      "--account", "ORG_SYNTH_CTRL_ALPHA",
      "--account-jwt-server-url", "nats://172.16.30.2:4222",
      "--ca-cert", config.tlsCaFile,
      "--timeout", "5",
    ]);
    expect(accountJwtPushArgs(config, "ORG_SYNTH_CTRL_ALPHA").join(" "))
      .not.toMatch(/\b(?:scp|ssh)\b/);
  });

  test("accepts only synthetic account refs and tenant-bounded subjects", () => {
    expect(accountNameFromProviderRef("nats-account://ORG_SYNTH_CTRL_ALPHA"))
      .toBe("ORG_SYNTH_CTRL_ALPHA");
    expect(() => accountNameFromProviderRef("nats-account://CUSTOMER_PROD"))
      .toThrow("controller_non_synthetic_account_forbidden");

    expect(parsePermissions({
      publish: ["org.synthetic.ctrl.alpha.events.>", "_R_.>"],
      subscribe: ["org.synthetic.ctrl.alpha.events.>", "_INBOX.>"],
    }, "ORG_SYNTH_CTRL_ALPHA")).toEqual({
      publish: ["org.synthetic.ctrl.alpha.events.>", "_R_.>"],
      subscribe: ["org.synthetic.ctrl.alpha.events.>", "_INBOX.>"],
      denyPublish: ["$SYS.>", "$JS.API.>", "$JS.SNAPSHOT.>"],
      denySubscribe: ["$SYS.>", "$JS.API.>", "$JS.SNAPSHOT.>"],
    });
    expect(() => parsePermissions({
      publish: ["org.synthetic.ctrl.beta.events.>"],
      subscribe: ["_INBOX.>"],
    }, "ORG_SYNTH_CTRL_ALPHA")).toThrow("controller_cross_tenant_subject_forbidden");
    expect(() => parsePermissions({
      publish: ["_R_.foo.>"],
      subscribe: ["_INBOX.>"],
    }, "ORG_SYNTH_CTRL_ALPHA")).toThrow("controller_cross_tenant_subject_forbidden");
  });

  test("allows only explicitly configured subprocesses", async () => {
    const runner = new BunControllerCommandRunner(new Set(["/bin/echo"]));
    expect((await runner.run("/bin/echo", ["safe"], { captureStdout: true })).stdout.trim())
      .toBe("safe");
    await expect(runner.run("/usr/bin/env", [])).rejects.toThrow("controller_program_not_allowed");
  });

  test("uses the installed nats server-info contract without unsupported json flags", async () => {
    const root = temporaryDirectory();
    const config = controllerConfigFromEnv(controllerEnv({
      RAVI_EVENT_PLANE_STATE_FILE: join(root, "state.json"),
      RAVI_EVENT_PLANE_CUSTODY_ROOT: join(root, "custody"),
    }));
    const runner = new RecordingRunner();
    const driver = new NscEventPlaneControllerDriver(config, runner);
    const observed = await driver.observeCell({ cell: desiredCell() });

    expect(observed.status).toBe("reachable");
    const probe = runner.calls.find((call) => call.program === config.natsPath);
    expect(probe?.args.slice(-2)).toEqual(["server", "info"]);
    expect(probe?.args).not.toContain("--json");
  });

  test("does not mutate delivered grants in place when identity permissions change", async () => {
    const root = temporaryDirectory();
    const stateFile = join(root, "state.json");
    writeFileSync(stateFile, JSON.stringify({
      version: 1,
      revision: 1,
      cellId: "cell-p0",
      providerRef: "ovh://p0",
      accounts: {
        "binding-alpha": {
          bindingId: "binding-alpha",
          organizationId: "org-alpha",
          accountName: "ORG_SYNTH_CTRL_ALPHA",
          providerAccountRef: "nats-account://ORG_SYNTH_CTRL_ALPHA",
          accountPublicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          status: "active",
          policyVersion: 1,
          policyHash: null,
          quotaHash: "quota",
          streamHash: "stream",
        },
      },
      identities: {
        "identity-alpha": {
          identityId: "identity-alpha",
          bindingId: "binding-alpha",
          accountName: "ORG_SYNTH_CTRL_ALPHA",
          status: "active",
          permissions: {
            publish: ["org.synthetic.ctrl.alpha.service.ping"],
            subscribe: ["org.synthetic.ctrl.alpha.service.ping", "_INBOX.>"],
            denyPublish: ["$SYS.>"],
            denySubscribe: ["$SYS.>"],
          },
          permissionsHash: "old-hash",
          policyVersion: 1,
        },
      },
      grants: {
        "grant-old": {
          grantId: "grant-old",
          identityId: "identity-alpha",
          accountName: "ORG_SYNTH_CTRL_ALPHA",
          userName: "ravi-g-old",
          providerUserPublicKey: "UAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          status: "active",
          custodyRef: "ravi-secret://event-plane/grants/grant-old",
          issuedAt: "2026-07-15T00:00:00.000Z",
          deliveredAt: "2026-07-15T00:01:00.000Z",
          revokedAt: null,
          probeSubject: "org.synthetic.ctrl.alpha.service.ping",
        },
      },
      policies: {},
      links: {},
      orphans: {},
      applied: {},
    }));
    const config = controllerConfigFromEnv(controllerEnv({
      RAVI_EVENT_PLANE_STATE_FILE: stateFile,
      RAVI_EVENT_PLANE_CUSTODY_ROOT: join(root, "custody"),
    }));
    const runner = new RecordingRunner();
    const driver = new NscEventPlaneControllerDriver(config, runner);

    await driver.apply({
      type: "identity.ensure",
      targetType: "event_plane_identity",
      targetId: "identity-alpha",
      cellId: "cell-p0",
      idempotencyKey: "event-plane:test:identity-permission-rotation",
      reason: "identity policy drift",
      desired: {
        bindingId: "binding-alpha",
        permissions: {
          publish: ["org.synthetic.ctrl.alpha.service.ping", "_R_.>"],
          subscribe: ["org.synthetic.ctrl.alpha.service.ping", "_INBOX.>"],
        },
        permissionsHash: "new-hash",
        policyVersion: 2,
      },
      observed: null,
      expectedVersion: 2,
      organizationId: "org-alpha",
      emergencyRtoMs: null,
    } satisfies EventPlaneReconcileOperation);

    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    expect(runner.calls).toHaveLength(0);
    expect(state.identities["identity-alpha"].permissionsHash).toBe("new-hash");
    expect(state.grants["grant-old"].status).toBe("active");
  });

  test("repairs Console projection in dependency order and becomes a no-op", async () => {
    const api = new InMemoryControlApi(desiredState());
    const projection = controllerProjection();

    const synchronized = await syncControlPlaneProjection(api, await api.desiredState(), projection);
    expect(api.posts.map((post) => post.path)).toEqual([
      "/api/internal/event-plane/bindings/ensure",
      "/api/internal/event-plane/identities/ensure",
      "/api/internal/event-plane/credential-grants/record",
    ]);
    expect(synchronized.bindings[0]?.status).toBe("active");
    expect(synchronized.identities[0]?.status).toBe("active");
    expect(synchronized.credentialGrants[0]).toMatchObject({
      status: "issued",
      providerUserPublicKey: "UAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      custodyRefPresent: true,
    });

    api.posts.length = 0;
    await syncControlPlaneProjection(api, synchronized, projection);
    expect(api.posts).toHaveLength(0);
  });

  test("projects only safe reconciliation summaries", () => {
    const input: Parameters<typeof reconciliationReportBody>[0] = {
      cell: desiredCell(),
      observed: {
        provider: "self_hosted_nats_jwt",
        providerRef: "ovh://ravi-runtime-ovh-1/deck/ravi-event-plane-p0",
        cellId: "cell-p0",
        status: "reachable",
        observedAt: "2026-07-15T00:00:01.000Z",
        resolverRevision: "controller-state-3",
        policyBuild: "p0-controller-v1",
        capacity: { managedAccounts: 1 },
        accounts: [],
        identities: [],
        credentialGrants: [],
        policies: [],
        crossAccountLinks: [],
      },
      report: {
        version: 1,
        dryRun: false,
        cell: { id: "cell-p0" },
        desiredHash: "desired-hash",
        observedHash: "observed-hash",
        planHash: "plan-hash",
        startedAt: "2026-07-15T00:00:00.000Z",
        completedAt: "2026-07-15T00:00:01.000Z",
        operationsPlanned: 1,
        operationsApplied: 1,
        drift: [],
        orphanCount: 0,
        results: [{
          operation: "grant.issue",
          idempotencyKey: "event-plane:test",
          providerResultCode: "grant_issued_to_custody",
          status: "applied",
          observed: { providerUserPublicKey: "UAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
          delivery: { custodyRef: "ravi-secret://event-plane/grants/grant-p0" },
          durationMs: 12,
        }],
        rollbackCheckpoint: { cellId: "cell-p0" },
      } satisfies EventPlaneReconciliationReport,
    };
    const report = reconciliationReportBody(input);

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("custodyRef");
    expect(serialized).not.toContain("providerUserPublicKey");
    expect(report).toMatchObject({
      cellId: "cell-p0",
      providerResultCode: "ok",
      results: [{ operation: "grant.issue", status: "applied" }],
    });
    expect(reconciliationReportBody(input).idempotencyKey).toBe(report.idempotencyKey);
    expect(reconciliationReportBody({
      ...input,
      report: { ...input.report, dryRun: true },
    }).idempotencyKey).not.toBe(report.idempotencyKey);
  });
});

function controllerEnv(
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string | undefined> {
  return {
    RAVI_EVENT_PLANE_ROLLOUT_MODE: "p0_synthetic_only",
    RAVI_EVENT_PLANE_CONTROL_TOKEN_FILE: "/tmp/control-token",
    RAVI_EVENT_PLANE_CELL_ID: "cell-p0",
    ...overrides,
  };
}

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "ravi-event-plane-controller-"));
  temporaryDirectories.push(path);
  return path;
}

function desiredCell(): EventPlaneDesiredCell {
  return {
    id: "cell-p0",
    provider: "self_hosted_nats_jwt",
    providerRef: "ovh://ravi-runtime-ovh-1/deck/ravi-event-plane-p0",
    environment: "p0",
    region: "ovh-bhs",
    placementClass: "synthetic",
    status: "active",
    endpointRef: "nats-cell://ravi-event-plane-p0",
    systemAccountRef: "nats-account://SYS",
    resolverRef: "nats-resolver://ravi-event-plane-p0",
    capacity: {},
    observedCapacity: {},
    policyVersion: 1,
    recordVersion: 1,
  };
}

function desiredState(): EventPlaneDesiredStateSnapshot {
  return {
    version: 1,
    cells: [desiredCell()],
    bindings: [{
      id: "binding-alpha",
      organizationId: "org-alpha",
      cellId: "cell-p0",
      providerAccountRef: "nats-account://ORG_SYNTH_CTRL_ALPHA",
      accountPublicKey: null,
      status: "provisioning",
      placementReason: "synthetic P0 drill",
      quotaPolicy: {},
      streamPolicy: {},
      activePolicyVersion: 1,
      recordVersion: 1,
    }],
    identities: [{
      id: "identity-alpha",
      organizationId: "org-alpha",
      bindingId: "binding-alpha",
      identityType: "agent",
      principalType: "ravi_agent",
      principalId: "synthetic-alpha",
      displayName: "Synthetic Alpha",
      status: "provisioning",
      permissions: {
        publish: ["org.synthetic.ctrl.alpha.events.>"],
        subscribe: ["org.synthetic.ctrl.alpha.events.>", "_INBOX.>"],
      },
      policyVersion: 1,
      recordVersion: 1,
      expiresAt: null,
      revokedAt: null,
    }],
    credentialGrants: [{
      id: "grant-alpha",
      identityId: "identity-alpha",
      providerUserPublicKey: null,
      custodyRefPresent: false,
      status: "pending",
      recordVersion: 1,
      issuedAt: null,
      deliveredAt: null,
      expiresAt: null,
      revokedAt: null,
      safeMetadata: {},
    }],
    policyVersions: [],
    crossAccountLinks: [],
  };
}

function controllerProjection(): EventPlaneControllerProjection {
  return {
    accounts: [{
      bindingId: "binding-alpha",
      organizationId: "org-alpha",
      accountName: "ORG_SYNTH_CTRL_ALPHA",
      providerAccountRef: "nats-account://ORG_SYNTH_CTRL_ALPHA",
      accountPublicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      status: "active",
      policyVersion: 1,
      policyHash: null,
      quotaHash: "quota-hash",
      streamHash: "stream-hash",
    }],
    identities: [{
      identityId: "identity-alpha",
      bindingId: "binding-alpha",
      accountName: "ORG_SYNTH_CTRL_ALPHA",
      status: "active",
      permissions: {
        publish: ["org.synthetic.ctrl.alpha.events.>"],
        subscribe: ["org.synthetic.ctrl.alpha.events.>", "_INBOX.>"],
        denyPublish: ["$SYS.>"],
        denySubscribe: ["$SYS.>"],
      },
      permissionsHash: "permissions-hash",
      policyVersion: 1,
    }],
    grants: [{
      grantId: "grant-alpha",
      identityId: "identity-alpha",
      accountName: "ORG_SYNTH_CTRL_ALPHA",
      userName: "ravi-g-grant-alpha",
      providerUserPublicKey: "UAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      status: "active",
      custodyRef: "ravi-secret://event-plane/grants/grant-alpha",
      issuedAt: "2026-07-15T00:00:00.000Z",
      deliveredAt: null,
      revokedAt: null,
      probeSubject: "org.synthetic.ctrl.alpha.events.controller.claim",
    }],
  };
}

class RecordingRunner implements ControllerCommandRunner {
  calls: Array<{ program: string; args: string[] }> = [];

  async run(program: string, args: string[]) {
    this.calls.push({ program, args });
    return { exitCode: 0, stdout: "" };
  }
}

class InMemoryControlApi implements EventPlaneControlApi {
  posts: Array<{ path: string; body: Record<string, unknown> }> = [];

  constructor(private state: EventPlaneDesiredStateSnapshot) {}

  async desiredState() {
    return structuredClone(this.state);
  }

  async post(path: string, body: Record<string, unknown>) {
    this.posts.push({ path, body: structuredClone(body) });
    if (path.endsWith("/bindings/ensure")) {
      const binding = this.state.bindings.find((item) => item.id === "binding-alpha")!;
      binding.status = body.status as typeof binding.status;
      binding.providerAccountRef = body.providerAccountRef as string;
      binding.accountPublicKey = body.accountPublicKey as string;
      binding.recordVersion += 1;
    } else if (path.endsWith("/identities/ensure")) {
      const identity = this.state.identities.find((item) => item.id === "identity-alpha")!;
      identity.status = body.status as typeof identity.status;
      identity.recordVersion += 1;
    } else if (path.endsWith("/credential-grants/record")) {
      const grant = this.state.credentialGrants.find((item) => item.id === "grant-alpha")!;
      grant.status = body.status as typeof grant.status;
      grant.providerUserPublicKey = body.providerUserPublicKey as string;
      grant.custodyRefPresent = Boolean(body.secretRef);
      grant.issuedAt = body.issuedAt as string;
      grant.deliveredAt = (body.deliveredAt as string | null) ?? null;
      grant.recordVersion += 1;
    }
    return { version: 1 };
  }
}
