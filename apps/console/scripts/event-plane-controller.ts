#!/usr/bin/env bun

import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import {
  createSelfHostedNatsJwtProviderAdapter,
  reconcileEventPlaneCell,
  SELF_HOSTED_NATS_JWT_PROVIDER,
} from "../src/server/console/event-plane-reconciler";
import type {
  EventPlaneDesiredCell,
  EventPlaneDesiredCredentialGrant,
  EventPlaneDesiredIdentity,
  EventPlaneDesiredOrgBinding,
  EventPlaneDesiredStateSnapshot,
  EventPlaneObservedState,
  EventPlaneProviderApplyResult,
  EventPlaneReconciliationReport,
  EventPlaneReconcileOperation,
  SelfHostedNatsJwtDriver,
} from "../src/server/console/event-plane-reconciler";

const CONTROLLER_VERSION = "p0-controller-v1";
const DEFAULT_CONSOLE_URL = "https://console.ravi.bot";
const DEFAULT_POLL_INTERVAL_MS = 60_000;
const SYNTHETIC_ACCOUNT_PREFIX = "ORG_SYNTH_CTRL_";
const SYNTHETIC_SUBJECT_PREFIX = "org.synthetic.ctrl.";

type JsonObject = Record<string, unknown>;

export type ControllerConfig = {
  consoleUrl: string;
  controlTokenFile: string;
  cellId: string;
  stateFile: string;
  custodyRoot: string;
  nscPath: string;
  natsPath: string;
  nscConfigDir: string;
  nscDataDir: string;
  nscKeystoreDir: string;
  nscOperator: string;
  tlsCaFile: string;
  systemCredentialsFile: string;
  natsServers: string[];
  rolloutMode: "p0_synthetic_only";
  pollIntervalMs: number;
};

type ControllerState = {
  version: 1;
  revision: number;
  cellId: string | null;
  providerRef: string | null;
  accounts: Record<string, ManagedAccount>;
  identities: Record<string, ManagedIdentity>;
  grants: Record<string, ManagedGrant>;
  policies: Record<string, ManagedPolicy>;
  links: Record<string, ManagedLink>;
  orphans: Record<string, ManagedOrphan>;
  applied: Record<string, EventPlaneProviderApplyResult>;
};

type ManagedAccount = {
  bindingId: string;
  organizationId: string;
  accountName: string;
  providerAccountRef: string;
  accountPublicKey: string;
  status: "active" | "suspended" | "quarantined";
  policyVersion: number;
  policyHash: string | null;
  quotaHash: string;
  streamHash: string;
};

type ManagedIdentity = {
  identityId: string;
  bindingId: string;
  accountName: string;
  status: "active" | "revoked" | "quarantined";
  permissions: PermissionSet;
  permissionsHash: string;
  policyVersion: number;
};

type ManagedGrant = {
  grantId: string;
  identityId: string;
  accountName: string;
  userName: string;
  providerUserPublicKey: string;
  status: "active" | "revoked" | "quarantined";
  custodyRef: string;
  issuedAt: string;
  deliveredAt: string | null;
  revokedAt: string | null;
  probeSubject: string;
};

type ManagedPolicy = {
  policyId: string;
  scopeType: "global" | "cell" | "organization" | "identity";
  scopeId: string;
  version: number;
  policyHash: string;
  status: "active" | "revoked";
};

type ManagedLink = {
  linkId: string;
  sourceBindingId: string;
  targetBindingId: string | null;
  targetSystemService: string | null;
  sourceAccountName: string;
  targetAccountName: string | null;
  linkType: "export" | "import" | "service";
  subjectPattern: string;
  responsePattern: string | null;
  status: "active" | "revoked" | "quarantined";
  policyVersion: number;
};

type ManagedOrphan = {
  providerUserPublicKey: string;
  accountName: string;
  userName: string;
  status: "active" | "quarantined";
  createdAt: string;
};

type PermissionSet = {
  publish: string[];
  subscribe: string[];
  denyPublish: string[];
  denySubscribe: string[];
};

export type EventPlaneControllerProjection = {
  accounts: ManagedAccount[];
  identities: ManagedIdentity[];
  grants: ManagedGrant[];
};

type CommandResult = {
  exitCode: number;
  stdout: string;
};

export interface ControllerCommandRunner {
  run(program: string, args: string[], options?: { allowFailure?: boolean; captureStdout?: boolean }): Promise<CommandResult>;
}

export interface EventPlaneControlApi {
  desiredState(): Promise<EventPlaneDesiredStateSnapshot>;
  post(path: string, body: JsonObject): Promise<JsonObject>;
}

export class ControllerError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "EventPlaneControllerError";
  }
}

export class BunControllerCommandRunner implements ControllerCommandRunner {
  constructor(private readonly allowedPrograms: ReadonlySet<string>) {}

  async run(
    program: string,
    args: string[],
    options: { allowFailure?: boolean; captureStdout?: boolean } = {},
  ): Promise<CommandResult> {
    if (!this.allowedPrograms.has(program)) throw new ControllerError("controller_program_not_allowed");
    if (args.some((arg) => arg.includes("\u0000"))) throw new ControllerError("controller_argument_invalid");

    const child = Bun.spawn([program, ...args], {
      env: process.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdoutPromise = options.captureStdout
      ? new Response(child.stdout).text()
      : drain(child.stdout).then(() => "");
    const [exitCode, stdout] = await Promise.all([
      child.exited,
      stdoutPromise,
      drain(child.stderr),
    ]).then(([code, output]) => [code, output] as const);

    if (exitCode !== 0 && !options.allowFailure) {
      throw new ControllerError(`controller_command_failed_${basename(program).replace(/[^a-z0-9]/gi, "_").toLowerCase()}`);
    }
    return { exitCode, stdout };
  }
}

export class EventPlaneControllerApi implements EventPlaneControlApi {
  constructor(private readonly config: Pick<ControllerConfig, "consoleUrl" | "controlTokenFile">) {}

  async desiredState(): Promise<EventPlaneDesiredStateSnapshot> {
    const payload = await this.request("/api/internal/event-plane/desired-state");
    return {
      version: numberValue(payload.version, "desired_state_version"),
      cells: arrayValue(payload.cells) as EventPlaneDesiredStateSnapshot["cells"],
      bindings: arrayValue(payload.bindings) as EventPlaneDesiredStateSnapshot["bindings"],
      identities: arrayValue(payload.identities) as EventPlaneDesiredStateSnapshot["identities"],
      credentialGrants: arrayValue(payload.credentialGrants) as EventPlaneDesiredStateSnapshot["credentialGrants"],
      policyVersions: arrayValue(payload.policyVersions) as EventPlaneDesiredStateSnapshot["policyVersions"],
      crossAccountLinks: arrayValue(payload.crossAccountLinks) as EventPlaneDesiredStateSnapshot["crossAccountLinks"],
    };
  }

  async post(path: string, body: JsonObject): Promise<JsonObject> {
    return this.request(path, { method: "POST", body });
  }

  private async request(
    path: string,
    options: { method?: "GET" | "POST"; body?: JsonObject } = {},
  ): Promise<JsonObject> {
    const token = readFileSync(this.config.controlTokenFile, "utf8").trim();
    if (token.length < 24) throw new ControllerError("controller_control_token_invalid");
    const response = await fetch(new URL(path, this.config.consoleUrl), {
      method: options.method ?? "GET",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-request-id": randomUUID(),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await response.json().catch(() => null) as JsonObject | null;
    if (!response.ok || !payload || payload.status === "error") {
      const code = typeof payload?.code === "string" ? payload.code : `http_${response.status}`;
      throw new ControllerError(`controller_console_${safeCode(code)}`);
    }
    return payload;
  }
}

export class NscEventPlaneControllerDriver implements SelfHostedNatsJwtDriver {
  private state: ControllerState;

  constructor(
    private readonly config: ControllerConfig,
    private readonly runner: ControllerCommandRunner,
  ) {
    this.state = loadControllerState(config.stateFile);
  }

  async observeCell(input: { cell: EventPlaneDesiredCell }): Promise<EventPlaneObservedState> {
    const reachable = await this.cellReachable();
    const activeGrantByIdentity = new Map<string, ManagedGrant>();
    for (const grant of Object.values(this.state.grants)) {
      if (grant.status === "active") activeGrantByIdentity.set(grant.identityId, grant);
    }

    return {
      provider: SELF_HOSTED_NATS_JWT_PROVIDER,
      providerRef: this.state.providerRef ?? input.cell.providerRef,
      cellId: this.state.cellId,
      status: reachable ? "reachable" : "unreachable",
      observedAt: new Date().toISOString(),
      resolverRevision: `controller-state-${this.state.revision}`,
      policyBuild: CONTROLLER_VERSION,
      capacity: {
        managedAccounts: Object.keys(this.state.accounts).length,
        managedIdentities: Object.keys(this.state.identities).length,
        managedGrants: Object.keys(this.state.grants).length,
        managedLinks: Object.keys(this.state.links).length,
      },
      accounts: Object.values(this.state.accounts).map((account) => ({
        bindingId: account.bindingId,
        organizationId: account.organizationId,
        providerAccountRef: account.providerAccountRef,
        accountPublicKey: account.accountPublicKey,
        status: account.status,
        policyVersion: account.policyVersion,
        policyHash: account.policyHash,
        quotaHash: account.quotaHash,
        streamHash: account.streamHash,
      })),
      identities: [
        ...Object.values(this.state.identities).map((identity) => ({
          identityId: identity.identityId,
          bindingId: identity.bindingId,
          providerUserPublicKey: activeGrantByIdentity.get(identity.identityId)?.providerUserPublicKey ?? null,
          status: identity.status,
          permissionsHash: identity.permissionsHash,
          policyVersion: identity.policyVersion,
        })),
        ...Object.values(this.state.orphans).map((orphan) => ({
          identityId: null,
          bindingId: null,
          providerUserPublicKey: orphan.providerUserPublicKey,
          status: orphan.status,
          permissionsHash: null,
          policyVersion: null,
        })),
      ],
      credentialGrants: Object.values(this.state.grants).map((grant) => ({
        grantId: grant.grantId,
        identityId: grant.identityId,
        providerUserPublicKey: grant.providerUserPublicKey,
        status: grant.status,
        revokedAt: grant.revokedAt,
      })),
      policies: Object.values(this.state.policies).map((policy) => ({
        policyId: policy.policyId,
        scopeType: policy.scopeType,
        scopeId: policy.scopeId,
        version: policy.version,
        policyHash: policy.policyHash,
        status: policy.status,
      })),
      crossAccountLinks: Object.values(this.state.links).map((link) => ({
        linkId: link.linkId,
        sourceBindingId: link.sourceBindingId,
        targetBindingId: link.targetBindingId,
        targetSystemService: link.targetSystemService,
        linkType: link.linkType,
        subjectPattern: link.subjectPattern,
        responsePattern: link.responsePattern,
        status: link.status,
        policyVersion: link.policyVersion,
      })),
    };
  }

  controlProjection(): EventPlaneControllerProjection {
    return {
      accounts: structuredClone(Object.values(this.state.accounts)),
      identities: structuredClone(Object.values(this.state.identities)),
      grants: structuredClone(Object.values(this.state.grants)),
    };
  }

  async apply(operation: EventPlaneReconcileOperation): Promise<EventPlaneProviderApplyResult> {
    const previous = this.state.applied[operation.idempotencyKey];
    if (previous) return { ...previous, status: "unchanged", durationMs: 0 };

    const startedAt = Date.now();
    let result: Omit<EventPlaneProviderApplyResult, "operation" | "idempotencyKey" | "durationMs">;
    switch (operation.type) {
      case "cell.reconcile":
        result = await this.applyCell(operation);
        break;
      case "account.ensure":
        result = await this.applyAccount(operation);
        break;
      case "account.suspend":
        result = await this.suspendAccount(operation);
        break;
      case "policy.apply":
        result = this.applyPolicy(operation);
        break;
      case "identity.ensure":
        result = await this.applyIdentity(operation);
        break;
      case "identity.revoke":
        result = await this.revokeIdentity(operation);
        break;
      case "grant.issue":
        result = await this.issueGrant(operation);
        break;
      case "grant.revoke":
        result = await this.revokeGrant(operation);
        break;
      case "cross_account_link.ensure":
        result = await this.ensureLink(operation);
        break;
      case "cross_account_link.revoke":
        result = await this.revokeLink(operation);
        break;
      case "orphan.quarantine":
        result = await this.quarantineOrphan(operation);
        break;
      default:
        throw new ControllerError("controller_operation_not_supported");
    }

    const complete: EventPlaneProviderApplyResult = {
      operation: operation.type,
      idempotencyKey: operation.idempotencyKey,
      durationMs: Date.now() - startedAt,
      ...result,
    };
    this.state.applied[operation.idempotencyKey] = complete;
    this.save();
    return complete;
  }

  async claimGrant(grantId: string, api: EventPlaneControlApi): Promise<JsonObject> {
    const grant = this.state.grants[grantId];
    if (!grant) throw new ControllerError("controller_grant_not_found");
    const pendingPath = join(this.config.custodyRoot, "pending", `${grantId}.creds`);
    const claimedPath = join(this.config.custodyRoot, "claimed", `${grantId}.creds`);

    if (!grant.deliveredAt) {
      if (!existsSync(pendingPath)) throw new ControllerError("controller_grant_delivery_missing");
      await this.nats([
        "--creds", pendingPath,
        "pub", grant.probeSubject,
        "controller-claim-probe",
      ]);
      mkdirSecure(dirname(claimedPath));
      renameSync(pendingPath, claimedPath);
      chmodSync(claimedPath, 0o600);
      grant.deliveredAt = new Date().toISOString();
      this.save();
    }

    const desired = await api.desiredState();
    const desiredGrant = desired.credentialGrants.find((item) => item.id === grantId);
    if (!desiredGrant) throw new ControllerError("controller_desired_grant_not_found");
    await api.post("/api/internal/event-plane/credential-grants/record", {
      grantId,
      identityId: grant.identityId,
      providerUserPublicKey: grant.providerUserPublicKey,
      secretRef: grant.custodyRef,
      status: "active",
      issuedAt: grant.issuedAt,
      deliveredAt: grant.deliveredAt,
      expectedVersion: desiredGrant.recordVersion,
      idempotencyKey: boundedIdempotencyKey(`event-plane:grant:claim:${grantId}:${grant.deliveredAt}`),
      safeMetadata: { deliveryChannel: "controller_encrypted_custody", deliveredOnce: true },
    });

    return {
      version: 1,
      status: "claimed",
      grantId,
      providerUserPublicKey: grant.providerUserPublicKey,
      deliveredAt: grant.deliveredAt,
      deliveredOnce: true,
    };
  }

  async injectSyntheticOrphan(bindingId: string): Promise<JsonObject> {
    const account = this.state.accounts[bindingId];
    if (!account) throw new ControllerError("controller_binding_not_managed");
    const suffix = Date.now().toString(36);
    const userName = `ravi-orphan-${suffix}`;
    const prefix = subjectPrefixForAccount(account.accountName);
    await this.ensureUser(account.accountName, userName, {
      publish: [`${prefix}.orphan.>`],
      subscribe: [`${prefix}.orphan.>`, "_INBOX.>"],
      denyPublish: reservedSubjects(),
      denySubscribe: reservedSubjects(),
    });
    const providerUserPublicKey = await this.userPublicKey(account.accountName, userName);
    await this.syncAccountJwt(account.accountName);
    this.state.orphans[providerUserPublicKey] = {
      providerUserPublicKey,
      accountName: account.accountName,
      userName,
      status: "active",
      createdAt: new Date().toISOString(),
    };
    this.save();
    return { version: 1, status: "injected", providerUserPublicKey };
  }

  async probeRevokedGrant(grantId: string): Promise<JsonObject> {
    const grant = this.state.grants[grantId];
    if (!grant || grant.status !== "revoked" || !grant.revokedAt) {
      throw new ControllerError("controller_grant_not_revoked");
    }
    const revokedPath = join(this.config.custodyRoot, "revoked", `${grantId}.creds`);
    if (!existsSync(revokedPath)) throw new ControllerError("controller_revoked_probe_missing");
    const startedAt = Date.now();
    let denied = false;
    while (Date.now() - startedAt <= 60_000) {
      const result = await this.nats([
        "--creds", revokedPath,
        "pub", grant.probeSubject,
        "controller-revoked-probe",
      ], true);
      if (result.exitCode !== 0) {
        denied = true;
        break;
      }
      await Bun.sleep(2_000);
    }
    const elapsedMs = Date.now() - startedAt;
    if (!denied) throw new ControllerError("controller_revocation_rto_exceeded");
    return { version: 1, status: "denied", grantId, deniedElapsedMs: elapsedMs };
  }

  private async applyCell(operation: EventPlaneReconcileOperation) {
    if (!(await this.cellReachable())) throw new ControllerError("controller_cell_unreachable");
    this.state.cellId = operation.cellId;
    this.state.providerRef = stringValue(operation.desired.providerRef, "provider_ref");
    return applied("cell_reconciled", { cellId: operation.cellId });
  }

  private async applyAccount(operation: EventPlaneReconcileOperation) {
    const desired = operation.desired;
    const accountName = accountNameFromProviderRef(stringValue(desired.providerAccountRef, "provider_account_ref"));
    const bindingId = stringValue(desired.bindingId, "binding_id");
    const organizationId = stringValue(desired.organizationId, "organization_id");
    const exists = await this.accountExists(accountName);
    if (!exists) {
      await this.nsc(["add", "account", "--name", accountName]);
      await this.nsc(["edit", "account", "--name", accountName, "--js-enable", "0"]);
    }
    await this.applyAccountLimits(accountName, objectValue(desired.quotaPolicy));
    const accountPublicKey = await this.accountPublicKey(accountName);
    await this.syncAccountJwt(accountName);

    this.state.accounts[bindingId] = {
      bindingId,
      organizationId,
      accountName,
      providerAccountRef: `nats-account://${accountName}`,
      accountPublicKey,
      status: "active",
      policyVersion: numberValue(desired.activePolicyVersion, "active_policy_version"),
      policyHash: null,
      quotaHash: stringValue(desired.quotaHash, "quota_hash"),
      streamHash: stringValue(desired.streamHash, "stream_hash"),
    };
    return applied("account_ensured", {
      bindingId,
      providerAccountRef: `nats-account://${accountName}`,
      accountPublicKey,
      status: "active",
    });
  }

  private async suspendAccount(operation: EventPlaneReconcileOperation) {
    const account = this.state.accounts[operation.targetId];
    if (!account) return unchanged("account_not_managed", {});
    await this.nsc(["edit", "account", "--name", account.accountName, "--conns", "1", "--subscriptions", "1"]);
    await this.syncAccountJwt(account.accountName);
    account.status = "suspended";
    return applied("account_suspended", { bindingId: account.bindingId, status: account.status });
  }

  private applyPolicy(operation: EventPlaneReconcileOperation) {
    const desired = operation.desired;
    this.state.policies[operation.targetId] = {
      policyId: operation.targetId,
      scopeType: stringValue(desired.scopeType, "scope_type") as ManagedPolicy["scopeType"],
      scopeId: stringValue(desired.scopeId, "scope_id"),
      version: numberValue(desired.version, "policy_version"),
      policyHash: stringValue(desired.policyHash, "policy_hash"),
      status: "active",
    };
    return applied("policy_recorded", { policyId: operation.targetId, status: "active" });
  }

  private async applyIdentity(operation: EventPlaneReconcileOperation) {
    const desired = operation.desired;
    const bindingId = stringValue(desired.bindingId, "binding_id");
    const account = this.state.accounts[bindingId];
    if (!account) throw new ControllerError("controller_identity_account_missing");
    const permissions = parsePermissions(desired.permissions, account.accountName);
    this.state.identities[operation.targetId] = {
      identityId: operation.targetId,
      bindingId,
      accountName: account.accountName,
      status: "active",
      permissions,
      permissionsHash: stringValue(desired.permissionsHash, "permissions_hash"),
      policyVersion: numberValue(desired.policyVersion, "identity_policy_version"),
    };
    return applied("identity_ensured", { identityId: operation.targetId, bindingId, status: "active" });
  }

  private async revokeIdentity(operation: EventPlaneReconcileOperation) {
    const identity = this.state.identities[operation.targetId];
    if (!identity) return unchanged("identity_not_managed", {});
    for (const grant of Object.values(this.state.grants)) {
      if (grant.identityId !== identity.identityId || grant.status !== "active") continue;
      await this.revokeUser(grant.accountName, grant.userName);
      grant.status = "revoked";
      grant.revokedAt = new Date().toISOString();
      this.archiveGrantFile(grant.grantId);
    }
    await this.syncAccountJwt(identity.accountName);
    identity.status = "revoked";
    return applied("identity_revoked", { identityId: identity.identityId, status: identity.status });
  }

  private async issueGrant(operation: EventPlaneReconcileOperation) {
    const desired = operation.desired;
    const identityId = stringValue(desired.identityId, "identity_id");
    const identity = this.state.identities[identityId];
    if (!identity) throw new ControllerError("controller_grant_identity_missing");
    const userName = userNameForGrant(operation.targetId);
    await this.ensureUser(identity.accountName, userName, identity.permissions);
    const providerUserPublicKey = await this.userPublicKey(identity.accountName, userName);
    const pendingPath = join(this.config.custodyRoot, "pending", `${operation.targetId}.creds`);
    mkdirSecure(dirname(pendingPath));
    if (!existsSync(pendingPath)) {
      await this.nsc([
        "generate", "creds",
        "--account", identity.accountName,
        "--name", userName,
        "--output-file", pendingPath,
      ]);
      chmodSync(pendingPath, 0o600);
    }
    await this.syncAccountJwt(identity.accountName);
    const issuedAt = new Date().toISOString();
    const custodyRef = `ravi-secret://event-plane/grants/${operation.targetId}`;
    this.state.grants[operation.targetId] = {
      grantId: operation.targetId,
      identityId,
      accountName: identity.accountName,
      userName,
      providerUserPublicKey,
      status: "active",
      custodyRef,
      issuedAt,
      deliveredAt: null,
      revokedAt: null,
      probeSubject: probeSubject(identity.permissions),
    };
    return {
      providerResultCode: "grant_issued_to_custody",
      status: "applied" as const,
      observed: { grantId: operation.targetId, identityId, providerUserPublicKey, status: "active" },
      delivery: { custodyRef, issuedAt, providerUserPublicKey, deliveredOnce: false },
    };
  }

  private async revokeGrant(operation: EventPlaneReconcileOperation) {
    const grant = this.state.grants[operation.targetId];
    if (!grant) return unchanged("grant_not_managed", {});
    if (grant.status !== "revoked") {
      await this.revokeUser(grant.accountName, grant.userName);
      await this.syncAccountJwt(grant.accountName);
      grant.status = "revoked";
      grant.revokedAt = new Date().toISOString();
      this.archiveGrantFile(grant.grantId);
    }
    return applied("grant_revoked", {
      grantId: grant.grantId,
      identityId: grant.identityId,
      providerUserPublicKey: grant.providerUserPublicKey,
      status: grant.status,
      revokedAt: grant.revokedAt,
    });
  }

  private async ensureLink(operation: EventPlaneReconcileOperation) {
    const desired = operation.desired;
    const sourceBindingId = stringValue(desired.sourceBindingId, "source_binding_id");
    const targetBindingId = nullableString(desired.targetBindingId);
    const source = this.state.accounts[sourceBindingId];
    const target = targetBindingId ? this.state.accounts[targetBindingId] : null;
    if (!source) throw new ControllerError("controller_link_source_missing");
    if (targetBindingId && !target) throw new ControllerError("controller_link_target_missing");
    const subject = exactCrossAccountSubject(stringValue(desired.subjectPattern, "subject_pattern"));
    const linkType = stringValue(desired.linkType, "link_type") as ManagedLink["linkType"];
    const name = linkName(operation.targetId);

    if (!this.state.links[operation.targetId]) {
      const exportArgs = ["add", "export", "--account", source.accountName, "--name", name, "--subject", subject];
      if (linkType === "service") exportArgs.push("--service");
      await this.nsc(exportArgs);
      if (target) {
        const localSubject = nullableString(desired.responsePattern) ?? subject;
        const importArgs = [
          "add", "import",
          "--account", target.accountName,
          "--name", name,
          "--src-account", source.accountPublicKey,
          "--remote-subject", subject,
          "--local-subject", localSubject,
        ];
        if (linkType === "service") importArgs.push("--service");
        await this.nsc(importArgs);
      }
      await this.syncAccountJwt(source.accountName);
      if (target) await this.syncAccountJwt(target.accountName);
    }

    this.state.links[operation.targetId] = {
      linkId: operation.targetId,
      sourceBindingId,
      targetBindingId,
      targetSystemService: nullableString(desired.targetSystemService),
      sourceAccountName: source.accountName,
      targetAccountName: target?.accountName ?? null,
      linkType,
      subjectPattern: subject,
      responsePattern: nullableString(desired.responsePattern),
      status: "active",
      policyVersion: numberValue(desired.policyVersion, "link_policy_version"),
    };
    return applied("cross_account_link_ensured", { linkId: operation.targetId, status: "active" });
  }

  private async revokeLink(operation: EventPlaneReconcileOperation) {
    const link = this.state.links[operation.targetId];
    if (!link) return unchanged("link_not_managed", {});
    if (link.status === "active") {
      if (link.targetAccountName) {
        await this.nsc([
          "delete", "import",
          "--account", link.targetAccountName,
          "--subject", link.responsePattern ?? link.subjectPattern,
          "--src-account", this.state.accounts[link.sourceBindingId]?.accountPublicKey ?? "",
        ]);
      }
      await this.nsc(["delete", "export", "--account", link.sourceAccountName, "--subject", link.subjectPattern]);
      await this.syncAccountJwt(link.sourceAccountName);
      if (link.targetAccountName) await this.syncAccountJwt(link.targetAccountName);
      link.status = "revoked";
    }
    return applied("cross_account_link_revoked", { linkId: link.linkId, status: link.status });
  }

  private async quarantineOrphan(operation: EventPlaneReconcileOperation) {
    if (operation.targetType === "event_plane_provider_user") {
      const orphan = this.state.orphans[operation.targetId];
      if (!orphan) return unchanged("orphan_not_managed", { targetId: operation.targetId });
      if (orphan.status !== "quarantined") {
        await this.revokeUser(orphan.accountName, orphan.userName);
        await this.syncAccountJwt(orphan.accountName);
        orphan.status = "quarantined";
      }
      return {
        providerResultCode: "orphan_user_quarantined",
        status: "quarantined" as const,
        observed: { providerUserPublicKey: orphan.providerUserPublicKey, status: orphan.status },
        delivery: null,
      };
    }
    throw new ControllerError("controller_orphan_type_not_supported_p0");
  }

  private async accountExists(accountName: string): Promise<boolean> {
    const result = await this.nsc(["describe", "account", "--name", accountName, "--json"], true, true);
    return result.exitCode === 0;
  }

  private async applyAccountLimits(accountName: string, quota: JsonObject) {
    const conns = boundedNumber(quota.maxConnections, 10, 1, 20);
    const subscriptions = boundedNumber(quota.maxSubscriptions, 200, 1, 500);
    const payload = boundedNumber(quota.maxPayloadBytes, 1_048_576, 1_024, 1_048_576);
    const data = boundedNumber(quota.maxDataBytes, 67_108_864, 1_048_576, 67_108_864);
    await this.nsc([
      "edit", "account", "--name", accountName,
      "--description", "Synthetic non-production Event Plane controller account",
      "--conns", String(conns),
      "--subscriptions", String(subscriptions),
      "--payload", String(payload),
      "--data", String(data),
      "--js-mem-storage", "67108864",
      "--js-disk-storage", "1073741824",
      "--js-streams", "10",
      "--js-consumer", "20",
      "--js-max-disk-stream", "268435456",
      "--js-max-mem-stream", "67108864",
      "--js-max-ack-pending", "1000",
      "--js-max-bytes-required",
    ]);
  }

  private async ensureUser(accountName: string, userName: string, permissions: PermissionSet) {
    const args = userPermissionArgs(accountName, userName, permissions);
    const exists = (await this.nsc([
      "describe", "user", "--account", accountName, "--name", userName, "--json",
    ], true, true)).exitCode === 0;
    await this.nsc([exists ? "edit" : "add", "user", ...args]);
  }

  private async revokeUser(accountName: string, userName: string) {
    await this.nsc(["revocations", "add-user", "--account", accountName, "--name", userName, "--at", "0"]);
  }

  private async accountPublicKey(accountName: string): Promise<string> {
    const result = await this.nsc([
      "describe", "account", "--name", accountName, "--json",
    ], false, true);
    return publicKeyFromNscJson(result.stdout, "account_public_key");
  }

  private async userPublicKey(accountName: string, userName: string): Promise<string> {
    const result = await this.nsc([
      "describe", "user", "--account", accountName, "--name", userName, "--json",
    ], false, true);
    return publicKeyFromNscJson(result.stdout, "user_public_key");
  }

  private async syncAccountJwt(accountName: string) {
    const source = join(
      this.config.nscDataDir,
      this.config.nscOperator,
      "accounts",
      accountName,
      `${accountName}.jwt`,
    );
    if (!existsSync(source)) throw new ControllerError("controller_account_jwt_missing");
    await this.nsc(accountJwtPushArgs(this.config, accountName));
  }

  private async cellReachable(): Promise<boolean> {
    for (const server of this.config.natsServers) {
      const result = await this.runner.run(this.config.natsPath, [
        "--timeout", "5s",
        "--server", server,
        "--tlsca", this.config.tlsCaFile,
        "--creds", this.config.systemCredentialsFile,
        "server", "info",
      ], { allowFailure: true });
      if (result.exitCode === 0) return true;
    }
    return false;
  }

  private async nsc(
    args: string[],
    allowFailure = false,
    captureStdout = false,
  ): Promise<CommandResult> {
    return this.runner.run(this.config.nscPath, [
      "--config-dir", this.config.nscConfigDir,
      "--data-dir", this.config.nscDataDir,
      "--keystore-dir", this.config.nscKeystoreDir,
      ...args,
    ], { allowFailure, captureStdout });
  }

  private async nats(args: string[], allowFailure = false): Promise<CommandResult> {
    return this.runner.run(this.config.natsPath, [
      "--timeout", "5s",
      "--server", this.config.natsServers[0]!,
      "--tlsca", this.config.tlsCaFile,
      ...args,
    ], { allowFailure });
  }

  private archiveGrantFile(grantId: string) {
    const pending = join(this.config.custodyRoot, "pending", `${grantId}.creds`);
    const claimed = join(this.config.custodyRoot, "claimed", `${grantId}.creds`);
    const revoked = join(this.config.custodyRoot, "revoked", `${grantId}.creds`);
    const current = existsSync(claimed) ? claimed : existsSync(pending) ? pending : null;
    if (!current) return;
    mkdirSecure(dirname(revoked));
    renameSync(current, revoked);
    chmodSync(revoked, 0o600);
  }

  private save() {
    this.state.revision += 1;
    writeControllerState(this.config.stateFile, this.state);
  }
}

export function accountJwtPushArgs(config: ControllerConfig, accountName: string): string[] {
  return [
    "push",
    "--account", accountName,
    "--account-jwt-server-url", nscResolverUrl(config.natsServers[0]!),
    "--ca-cert", config.tlsCaFile,
    "--timeout", "5",
  ];
}

export function nscResolverUrl(server: string): string {
  const trimmed = server.trim();
  if (trimmed.startsWith("tls://")) return `nats://${trimmed.slice("tls://".length)}`;
  if (trimmed.startsWith("nats://")) return trimmed;
  throw new ControllerError("controller_nsc_resolver_url_invalid");
}

export function controllerConfigFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ControllerConfig {
  const rolloutMode = requiredEnv(env, "RAVI_EVENT_PLANE_ROLLOUT_MODE");
  if (rolloutMode !== "p0_synthetic_only") throw new ControllerError("controller_rollout_mode_forbidden");
  const natsServers = csvEnv(env.RAVI_EVENT_PLANE_NATS_SERVERS ?? "tls://172.16.30.2:4222,tls://172.16.31.2:4222,tls://172.16.32.2:4222");
  if (natsServers.length !== 3) throw new ControllerError("controller_three_node_cell_required");
  return {
    consoleUrl: env.RAVI_EVENT_PLANE_CONSOLE_URL?.trim() || DEFAULT_CONSOLE_URL,
    controlTokenFile: requiredEnv(env, "RAVI_EVENT_PLANE_CONTROL_TOKEN_FILE"),
    cellId: requiredEnv(env, "RAVI_EVENT_PLANE_CELL_ID"),
    stateFile: env.RAVI_EVENT_PLANE_STATE_FILE?.trim() || "/home/ubuntu/.ravi/event-plane-controller/state.json",
    custodyRoot: env.RAVI_EVENT_PLANE_CUSTODY_ROOT?.trim() || "/home/ubuntu/.ravi/secrets/event-plane-controller/custody",
    nscPath: env.RAVI_EVENT_PLANE_NSC_PATH?.trim() || "/home/ubuntu/.local/bin/nsc",
    natsPath: env.RAVI_EVENT_PLANE_NATS_PATH?.trim() || "/home/ubuntu/.local/bin/nats",
    nscConfigDir: env.RAVI_EVENT_PLANE_NSC_CONFIG_DIR?.trim() || "/home/ubuntu/.ravi/secrets/event-plane-p0/nsc/config",
    nscDataDir: env.RAVI_EVENT_PLANE_NSC_DATA_DIR?.trim() || "/home/ubuntu/.ravi/secrets/event-plane-p0/nsc/stores",
    nscKeystoreDir: env.RAVI_EVENT_PLANE_NSC_KEYSTORE_DIR?.trim() || "/home/ubuntu/.ravi/secrets/event-plane-p0/nsc/keys",
    nscOperator: env.RAVI_EVENT_PLANE_NSC_OPERATOR?.trim() || "RAVI_EVENT_PLANE_P0",
    tlsCaFile: env.RAVI_EVENT_PLANE_TLS_CA_FILE?.trim() || "/home/ubuntu/.ravi/secrets/event-plane-p0/tls/ca.crt",
    systemCredentialsFile: env.RAVI_EVENT_PLANE_SYS_CREDS_FILE?.trim() || "/home/ubuntu/.ravi/secrets/event-plane-p0/creds/sys-admin.creds",
    natsServers,
    rolloutMode,
    pollIntervalMs: boundedNumber(env.RAVI_EVENT_PLANE_POLL_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS, 5_000, 60_000),
  };
}

export function reconciliationReportBody(input: {
  report: EventPlaneReconciliationReport;
  cell: EventPlaneDesiredCell;
  observed: EventPlaneObservedState;
}): JsonObject {
  const failed = input.report.results.some((result) => result.status === "failed");
  return {
    cellId: input.cell.id,
    expectedVersion: input.cell.recordVersion,
    idempotencyKey: boundedIdempotencyKey(
      `event-plane:report:${input.cell.id}:${input.report.dryRun ? "dry" : "live"}:${input.report.startedAt}:${input.report.planHash}`,
    ),
    desiredHash: input.report.desiredHash,
    observedHash: input.report.observedHash,
    planHash: input.report.planHash,
    startedAt: input.report.startedAt,
    completedAt: input.report.completedAt,
    dryRun: input.report.dryRun,
    observedStatus: failed ? "degraded" : input.observed.status,
    operationsPlanned: input.report.operationsPlanned,
    operationsApplied: input.report.operationsApplied,
    orphanCount: input.report.orphanCount,
    drift: input.report.drift,
    policyBuild: input.observed.policyBuild ?? CONTROLLER_VERSION,
    resolverRevision: input.observed.resolverRevision,
    providerResultCode: failed ? "partial_failure" : "ok",
    results: input.report.results.map((result) => ({
      durationMs: result.durationMs,
      idempotencyKey: result.idempotencyKey,
      operation: result.operation,
      providerResultCode: result.providerResultCode,
      status: result.status,
    })),
    rollbackCheckpoint: input.report.rollbackCheckpoint,
  };
}

export function accountNameFromProviderRef(providerRef: string): string {
  const prefix = "nats-account://";
  if (!providerRef.startsWith(prefix)) throw new ControllerError("controller_provider_account_ref_invalid");
  const accountName = providerRef.slice(prefix.length);
  if (!new RegExp(`^${SYNTHETIC_ACCOUNT_PREFIX}[A-Z0-9_]{1,40}$`).test(accountName)) {
    throw new ControllerError("controller_non_synthetic_account_forbidden");
  }
  return accountName;
}

export function parsePermissions(value: unknown, accountName: string): PermissionSet {
  const input = objectValue(value);
  const permissions = {
    publish: stringArray(input.publish),
    subscribe: stringArray(input.subscribe),
    denyPublish: unique([...stringArray(input.denyPublish), ...reservedSubjects()]),
    denySubscribe: unique([...stringArray(input.denySubscribe), ...reservedSubjects()]),
  };
  if (permissions.publish.length === 0 || permissions.subscribe.length === 0) {
    throw new ControllerError("controller_permissions_required");
  }
  const expectedPrefix = subjectPrefixForAccount(accountName);
  for (const subject of [...permissions.publish, ...permissions.subscribe]) {
    if (subject === "_INBOX.>" || subject === "_R_.>" || subject === "$JS.ACK.>") continue;
    if (!subject.startsWith(`${expectedPrefix}.`)) throw new ControllerError("controller_cross_tenant_subject_forbidden");
    if (subject.includes("*") || (subject.includes(">") && !subject.endsWith(".>"))) {
      throw new ControllerError("controller_subject_pattern_invalid");
    }
  }
  return permissions;
}

async function runOnce(config: ControllerConfig, dryRun = false) {
  const api = new EventPlaneControllerApi(config);
  const runner = new BunControllerCommandRunner(new Set([
    config.nscPath,
    config.natsPath,
  ]));
  const driver = new NscEventPlaneControllerDriver(config, runner);
  const desiredState = await api.desiredState();
  const cell = desiredState.cells.find((item) => item.id === config.cellId);
  if (!cell) throw new ControllerError("controller_cell_not_in_desired_state");
  const adapter = createSelfHostedNatsJwtProviderAdapter(driver);
  const report = await reconcileEventPlaneCell({
    adapter,
    cellId: config.cellId,
    desiredState,
    dryRun,
  });
  const synchronizedState = dryRun
    ? desiredState
    : await syncControlPlaneProjection(api, desiredState, driver.controlProjection());
  const synchronizedCell = synchronizedState.cells.find((item) => item.id === config.cellId);
  if (!synchronizedCell) throw new ControllerError("controller_cell_not_in_synchronized_state");
  const observed = await adapter.observeCell({ cell });
  await api.post(
    "/api/internal/event-plane/reconciliations/report",
    reconciliationReportBody({ report, cell: synchronizedCell, observed }),
  );
  return {
    version: 1,
    status: "ok",
    dryRun,
    cellId: config.cellId,
    operationsPlanned: report.operationsPlanned,
    operationsApplied: report.operationsApplied,
    orphanCount: report.orphanCount,
    observedStatus: observed.status,
    planHash: report.planHash,
  };
}

export async function syncControlPlaneProjection(
  api: EventPlaneControlApi,
  desiredState: EventPlaneDesiredStateSnapshot,
  projection: EventPlaneControllerProjection,
): Promise<EventPlaneDesiredStateSnapshot> {
  let current = desiredState;

  for (const account of projection.accounts) {
    const binding = current.bindings.find((item) => item.id === account.bindingId);
    if (!binding || !["provisioning", "active", "migrating"].includes(binding.status)) continue;
    if (
      binding.status === "active" &&
      binding.providerAccountRef === account.providerAccountRef &&
      binding.accountPublicKey === account.accountPublicKey
    ) continue;
    await api.post("/api/internal/event-plane/bindings/ensure", {
      ...bindingMutationBody(binding),
      status: "active",
      providerAccountRef: account.providerAccountRef,
      accountPublicKey: account.accountPublicKey,
      expectedVersion: binding.recordVersion,
      idempotencyKey: boundedIdempotencyKey(
        `event-plane:projection:binding:${binding.id}:${binding.recordVersion}:${account.accountPublicKey}`,
      ),
    });
    current = await api.desiredState();
  }

  for (const managedIdentity of projection.identities) {
    const identity = current.identities.find((item) => item.id === managedIdentity.identityId);
    if (!identity || !["provisioning", "active", "rotating"].includes(identity.status)) continue;
    if (identity.status === "active") continue;
    await api.post("/api/internal/event-plane/identities/ensure", {
      ...identityMutationBody(identity),
      status: "active",
      expectedVersion: identity.recordVersion,
      idempotencyKey: boundedIdempotencyKey(
        `event-plane:projection:identity:${identity.id}:${identity.recordVersion}:active`,
      ),
    });
    current = await api.desiredState();
  }

  for (const managedGrant of projection.grants) {
    const grant = current.credentialGrants.find((item) => item.id === managedGrant.grantId);
    if (!grant || !["pending", "issued", "active"].includes(grant.status)) continue;
    const targetStatus = managedGrant.deliveredAt ? "active" : "issued";
    if (
      grant.status === targetStatus &&
      grant.providerUserPublicKey === managedGrant.providerUserPublicKey &&
      grant.custodyRefPresent &&
      (targetStatus !== "active" || grant.deliveredAt === managedGrant.deliveredAt)
    ) continue;
    await api.post("/api/internal/event-plane/credential-grants/record", {
      grantId: grant.id,
      identityId: grant.identityId,
      providerUserPublicKey: managedGrant.providerUserPublicKey,
      secretRef: managedGrant.custodyRef,
      status: targetStatus,
      issuedAt: managedGrant.issuedAt,
      deliveredAt: managedGrant.deliveredAt,
      expectedVersion: grant.recordVersion,
      idempotencyKey: boundedIdempotencyKey(
        `event-plane:projection:grant:${grant.id}:${grant.recordVersion}:${targetStatus}`,
      ),
      safeMetadata: {
        deliveryChannel: "controller_encrypted_custody",
        deliveredOnce: Boolean(managedGrant.deliveredAt),
      },
    });
    current = await api.desiredState();
  }

  return current;
}

function bindingMutationBody(binding: EventPlaneDesiredOrgBinding): JsonObject {
  return {
    cellId: binding.cellId,
    organizationId: binding.organizationId,
    placementReason: binding.placementReason,
    status: binding.status,
    providerAccountRef: binding.providerAccountRef,
    accountPublicKey: binding.accountPublicKey,
    quotaPolicy: binding.quotaPolicy,
    streamPolicy: binding.streamPolicy,
    activePolicyVersion: binding.activePolicyVersion,
  };
}

function identityMutationBody(identity: EventPlaneDesiredIdentity): JsonObject {
  return {
    bindingId: identity.bindingId,
    identityType: identity.identityType,
    principalType: identity.principalType,
    principalId: identity.principalId,
    displayName: identity.displayName,
    status: identity.status,
    permissions: identity.permissions,
    policyVersion: identity.policyVersion,
    expiresAt: identity.expiresAt,
  };
}

function loadControllerState(path: string): ControllerState {
  if (!existsSync(path)) return emptyControllerState();
  const parsed = JSON.parse(readFileSync(path, "utf8")) as ControllerState;
  if (parsed.version !== 1) throw new ControllerError("controller_state_version_invalid");
  return parsed;
}

function writeControllerState(path: string, state: ControllerState) {
  mkdirSecure(dirname(path));
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

function emptyControllerState(): ControllerState {
  return {
    version: 1,
    revision: 0,
    cellId: null,
    providerRef: null,
    accounts: {},
    identities: {},
    grants: {},
    policies: {},
    links: {},
    orphans: {},
    applied: {},
  };
}

function applied(providerResultCode: string, observed: JsonObject) {
  return { providerResultCode, status: "applied" as const, observed, delivery: null };
}

function unchanged(providerResultCode: string, observed: JsonObject) {
  return { providerResultCode, status: "unchanged" as const, observed, delivery: null };
}

function userPermissionArgs(accountName: string, userName: string, permissions: PermissionSet): string[] {
  return [
    "--account", accountName,
    "--name", userName,
    "--allow-pub", permissions.publish.join(","),
    "--allow-sub", permissions.subscribe.join(","),
    "--deny-pub", permissions.denyPublish.join(","),
    "--deny-sub", permissions.denySubscribe.join(","),
    "--expiry", "2h",
  ];
}

function publicKeyFromNscJson(value: string, field: string): string {
  const parsed = JSON.parse(value) as JsonObject;
  const publicKey = stringValue(parsed.sub ?? parsed.public_key, field);
  if (!/^[AU][A-Z0-9]{40,}$/.test(publicKey)) throw new ControllerError(`controller_${field}_invalid`);
  return publicKey;
}

function subjectPrefixForAccount(accountName: string): string {
  if (!accountName.startsWith(SYNTHETIC_ACCOUNT_PREFIX)) {
    throw new ControllerError("controller_non_synthetic_account_forbidden");
  }
  const suffix = accountName.slice(SYNTHETIC_ACCOUNT_PREFIX.length).toLowerCase().replace(/_+/g, ".");
  return `${SYNTHETIC_SUBJECT_PREFIX}${suffix}`;
}

function probeSubject(permissions: PermissionSet): string {
  const candidate = permissions.publish.find((subject) => subject.startsWith(SYNTHETIC_SUBJECT_PREFIX));
  if (!candidate) throw new ControllerError("controller_probe_subject_missing");
  return candidate.endsWith(".>") ? `${candidate.slice(0, -2)}.controller.claim` : candidate;
}

function exactCrossAccountSubject(value: string): string {
  if (!value.startsWith(SYNTHETIC_SUBJECT_PREFIX) || value.includes(">") || value.includes("*")) {
    throw new ControllerError("controller_cross_account_subject_forbidden");
  }
  return value;
}

function userNameForGrant(grantId: string): string {
  return `ravi-g-${grantId.replace(/-/g, "").slice(0, 20)}`;
}

function linkName(linkId: string): string {
  return `ravi-link-${linkId.replace(/-/g, "").slice(0, 16)}`;
}

function reservedSubjects(): string[] {
  return ["$SYS.>", "$JS.API.>", "$JS.SNAPSHOT.>"];
}

function mkdirSecure(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function boundedIdempotencyKey(value: string): string {
  if (value.length <= 200) return value;
  return `event-plane:${createHash("sha256").update(value).digest("hex")}`;
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "string" ? Number(value) : typeof value === "number" ? value : fallback;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function requiredEnv(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new ControllerError(`controller_${name.toLowerCase()}_required`);
  return value;
}

function csvEnv(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function objectValue(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as JsonObject;
}

function arrayValue(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new ControllerError("controller_console_array_invalid");
  return value;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return [];
  return unique(value as string[]);
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ControllerError(`controller_${field}_invalid`);
  }
  return value;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberValue(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ControllerError(`controller_${field}_invalid`);
  return value;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function safeCode(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 120);
}

async function drain(stream: ReadableStream<Uint8Array> | number | null): Promise<void> {
  if (!stream || typeof stream === "number") return;
  await new Response(stream).arrayBuffer();
}

function safeOutput(value: JsonObject) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main() {
  const config = controllerConfigFromEnv();
  const command = process.argv[2] ?? "once";
  const runner = new BunControllerCommandRunner(new Set([
    config.nscPath,
    config.natsPath,
  ]));

  if (command === "once") return safeOutput(await runOnce(config));
  if (command === "dry-run") return safeOutput(await runOnce(config, true));
  if (command === "run") {
    while (true) {
      try {
        safeOutput(await runOnce(config));
      } catch (error) {
        safeOutput({ version: 1, status: "error", code: errorCode(error) });
      }
      await Bun.sleep(config.pollIntervalMs);
    }
  }

  const api = new EventPlaneControllerApi(config);
  const driver = new NscEventPlaneControllerDriver(config, runner);
  if (command === "claim-grant") {
    return safeOutput(await driver.claimGrant(requiredArgument(3, "grant_id"), api));
  }
  if (command === "inject-orphan") {
    return safeOutput(await driver.injectSyntheticOrphan(requiredArgument(3, "binding_id")));
  }
  if (command === "probe-revoked") {
    return safeOutput(await driver.probeRevokedGrant(requiredArgument(3, "grant_id")));
  }
  if (command === "reset-p0-state") {
    rmSync(config.stateFile, { force: true });
    return safeOutput({ version: 1, status: "reset" });
  }
  throw new ControllerError("controller_command_unknown");
}

function requiredArgument(index: number, name: string): string {
  const value = process.argv[index]?.trim();
  if (!value) throw new ControllerError(`controller_${name}_required`);
  return value;
}

function errorCode(error: unknown): string {
  if (error instanceof ControllerError) return error.code;
  return "controller_internal_error";
}

if (import.meta.main) {
  main().catch((error) => {
    safeOutput({ version: 1, status: "error", code: errorCode(error) });
    process.exitCode = 1;
  });
}
