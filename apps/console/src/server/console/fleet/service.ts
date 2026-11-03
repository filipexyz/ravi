import { operationDigest, matchesOperationDigest, legacyOperationDigest } from "./operation-digest";
import { assertFleetActor, credentialWriteSchema, FleetError, installationWriteSchema, parseFleet,
  revisionActionSchema, type Credential, type FleetActor, type FleetStore, type FleetTransaction,
  type Installation, type MutationReceipt, type ProbeResult, type SafeResult, type SecretVault } from "./contract";
import { validatePrivateKey } from "./ssh-probe";
import type { OrganizationAction } from "../authorization/policy";
import { assertSshPort, validateSshPorts } from "./ssh-policy";
import { randomUUID } from "node:crypto";
import { assertReservation, reservationConflict } from "./io-reservation";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
const MAX_ORPHAN_SECRET_SLOTS = 8;
export class FleetService {
  constructor(private store: FleetStore, private vault: SecretVault,
    private probe: (installation: Installation, key: string) => Promise<ProbeResult>,
    private config: { organizationId: string; operationKey: string; now?: () => Date; allowedSshPorts?: readonly number[] }) {
    if (config.operationKey.length < 32) throw new FleetError("fleet_not_configured", 503);
    validateSshPorts(config.allowedSshPorts ?? [22]);
    this.config = { ...config, allowedSshPorts: Object.freeze([...(config.allowedSshPorts ?? [22])]) };
  }
  private now() { return (this.config.now?.() ?? new Date()).toISOString(); }
  private authorize(actor: FleetActor) { assertFleetActor(actor, this.config.organizationId); }
  async state(actor: FleetActor) {
    this.authorize(actor);
    return this.store.transaction(actor, ["organization.credentials.read", "organization.installations.read"],
      async tx => ({ credentials: await tx.credentials(), installations: await tx.installations() }));
  }
  async credentials(actor: FleetActor) {
    this.authorize(actor);
    return this.store.transaction(actor, ["organization.credentials.read"], tx => tx.credentials());
  }
  async installations(actor: FleetActor) {
    this.authorize(actor);
    return this.store.transaction(actor, ["organization.installations.read"], tx => tx.installations());
  }
  private async mutate<T extends SafeResult>(actor: FleetActor, action: OrganizationAction, operation: string, body: { operationId: string }, run: (tx: FleetTransaction, hash: string) => Promise<T>): Promise<T> {
    this.authorize(actor);
    const payload = canonical({ operation, userId: actor.userId, body });
    const inputHash = operationDigest(this.config.operationKey, "fleet", payload);
    return this.store.transaction(actor, [action], async tx => {
      const previous = await tx.receipt(body.operationId);
      if (previous) {
        if (!matchesOperationDigest(previous.inputHash, this.config.operationKey, "fleet", payload)) throw new FleetError("idempotency_conflict", 409);
        return previous.result as T;
      }
      if (await tx.reservation(body.operationId)) throw new FleetError("idempotency_conflict", 409);
      const result = await run(tx, inputHash);
      await tx.putReceipt(body.operationId, { inputHash, result } satisfies MutationReceipt);
      await tx.audit(`fleet.${operation}`, result.id, { operationId: body.operationId, revision: result.revision, status: result.status,
        ...("failureCode" in result ? { failureCode: result.failureCode } : {}) });
      return result;
    }, body.operationId);
  }
  private async ioMutation<P, E, T extends SafeResult>(actor: FleetActor, action: OrganizationAction, operation: string,
    body: { operationId: string }, prepare: (tx: FleetTransaction) => Promise<P>,
    external: (prepared: P, inputHash: string, revalidate: () => Promise<void>) => Promise<E>,
    finalize: (tx: FleetTransaction, prepared: P, result: E) => Promise<T>, resumable = false): Promise<T> {
    const payload = canonical({ operation, userId: actor.userId, body }), inputHash = operationDigest(this.config.operationKey, "fleet", payload);
    const leaseId = randomUUID();
    const start = await this.store.transaction(actor, [action], async tx => {
      const previous = await tx.receipt(body.operationId);
      if (previous) {
        if (!matchesOperationDigest(previous.inputHash, this.config.operationKey, "fleet", payload)) throw new FleetError("idempotency_conflict", 409);
        return { kind: "replay" as const, result: previous.result as T };
      }
      const pending = await tx.reservation(body.operationId);
      if (pending) {
        if (pending.inputHash !== inputHash) throw new FleetError("idempotency_conflict", 409);
        // An idempotent external write (same digest, same value) may be resumed once its lease
        // expired, so a lost DB finalize does not block this operation id forever.
        if (!resumable || pending.completed || Date.parse(pending.expiresAt) > Date.now()) reservationConflict(pending);
      }
      const prepared = await prepare(tx);
      const next = { inputHash, leaseId, expiresAt: new Date(Date.now() + 120000).toISOString(), completed: false };
      if (!pending) await tx.putReservation(body.operationId, next);
      else if (!await tx.renewReservation(body.operationId, pending.leaseId, next)) throw new FleetError("operation_in_progress", 409);
      return { kind: "prepared" as const, prepared };
    }, body.operationId);
    if (start.kind === "replay") return start.result;
    // No database transaction, connection reservation or lock during I/O.
    const revalidate = () => this.store.transaction(actor, [action], async tx => {
      assertReservation(await tx.reservation(body.operationId), leaseId, inputHash);
      if (canonical(await prepare(tx)) !== canonical(start.prepared)) throw new FleetError("version_conflict", 409);
    }, body.operationId);
    const observed = await external(start.prepared, inputHash, revalidate);
    return this.store.transaction(actor, [action], async tx => {
      assertReservation(await tx.reservation(body.operationId), leaseId, inputHash);
      const current = await prepare(tx); // current identity/policy checked by store, config/secret by prepare
      if (canonical(current) !== canonical(start.prepared)) throw new FleetError("version_conflict", 409);
      const result = await finalize(tx, current, observed);
      // Fresh deadline after all DB waits, not PostgreSQL transaction-start time.
      assertReservation(await tx.reservation(body.operationId), leaseId, inputHash);
      await tx.putReceipt(body.operationId, { inputHash, result });
      await tx.finishReservation(body.operationId);
      await tx.audit(`fleet.${operation}`, result.id, { operationId: body.operationId, revision: result.revision, status: result.status,
        ...("failureCode" in result ? { failureCode: result.failureCode } : {}) });
      return result;
    }, body.operationId);
  }
  async writeCredential(actor: FleetActor, body: unknown) {
    this.authorize(actor);
    const input = parseFleet(credentialWriteSchema, body);
    if (input.kind === "ssh_private_key") validatePrivateKey(input.value);
    return this.ioMutation(actor, "organization.credentials.manage", "credential.saved", input, async tx => {
      const existing = await tx.credential(input.id);
      if ((existing?.revision ?? 0) !== input.expectedRevision) throw new FleetError("version_conflict", 409);
      if (existing?.status === "revoked") throw new FleetError("credential_revoked", 409);
      if (existing && existing.kind !== input.kind) throw new FleetError("credential_kind_immutable", 409);
      if (existing && canonical(existing.binding) !== canonical(input.binding)) throw new FleetError("credential_binding_immutable", 409);
      if (existing && await tx.credentialInActiveSso(existing.id)) throw new FleetError("credential_in_active_sso", 409);
      return existing;
    }, async (existing, hash, revalidate) => {
      const now = this.now();
      const legacyHash = legacyOperationDigest(this.config.operationKey, canonical({ operation: "credential.saved", userId: actor.userId, body: input }));
      // KV versions are immutable. A slot left by another operation whose DB finalize was lost is
      // never read (the row still points at the old version), so skip it; the revision CAS in
      // finalize still decides which concurrent save wins.
      for (let offset = 1; ; offset++) {
        const secretVersion = (existing?.secretVersion ?? 0) + offset;
        try {
          await this.vault.put({ organizationId: actor.organizationId, credentialId: input.id, version: secretVersion }, input.value, hash, legacyHash);
        } catch (error) {
          if (!(error instanceof FleetError && error.code === "vault_write_conflict") || offset >= MAX_ORPHAN_SECRET_SLOTS) throw error;
          await revalidate();
          continue;
        }
        return { id: input.id, label: input.label, kind: input.kind, revision: (existing?.revision ?? 0) + 1, binding: input.binding,
          secretVersion, status: "active", createdAt: existing?.createdAt ?? now, updatedAt: now } satisfies Credential;
      }
    }, async (tx, _existing, credential) => {
      await tx.putCredential(credential);
      for (const item of await tx.installations()) if (item.credentialId === credential.id) {
        await tx.putInstallation({ ...item, revision: item.revision + 1, status: "draft", testedAt: null,
          testedCredentialRevision: null, cliVersion: null, failureCode: null, updatedAt: this.now() });
      }
      return credential;
    }, true);
  }
  async revokeCredential(actor: FleetActor, body: unknown) {
    this.authorize(actor); const input = parseFleet(revisionActionSchema, body);
    return this.mutate(actor, "organization.credentials.manage", "credential.revoked", input, async tx => {
      const existing = await tx.credential(input.id);
      if (!existing) throw new FleetError("not_found", 404);
      if (existing.revision !== input.expectedRevision) throw new FleetError("version_conflict", 409);
      if (await tx.credentialInActiveSso(existing.id)) throw new FleetError("credential_in_active_sso", 409);
      const now = this.now();
      const credential: Credential = { ...existing, revision: existing.revision + 1, status: "revoked", updatedAt: now };
      await tx.putCredential(credential);
      for (const item of await tx.installations()) if (item.credentialId === credential.id) {
        await tx.putInstallation({ ...item, revision: item.revision + 1, status: "draft", testedAt: null,
          testedCredentialRevision: null, cliVersion: null, failureCode: "credential_revoked", updatedAt: now });
      }
      return credential;
    });
  }
  async writeInstallation(actor: FleetActor, body: unknown) {
    this.authorize(actor); const input = parseFleet(installationWriteSchema, body);
    assertSshPort(input.port, this.config.allowedSshPorts);
    return this.mutate(actor, "organization.installations.manage", "installation.saved", input, async tx => {
      const existing = await tx.installation(input.id);
      if ((existing?.revision ?? 0) !== input.expectedRevision) throw new FleetError("version_conflict", 409);
      const credential = await tx.credential(input.credentialId);
      if (!credential || credential.status !== "active" || credential.kind !== "ssh_private_key") throw new FleetError("ssh_credential_required");
      const now = this.now();
      const item: Installation = { id: input.id, label: input.label, hostname: input.hostname, port: input.port,
        username: input.username, hostFingerprint: input.hostFingerprint, credentialId: input.credentialId,
        revision: (existing?.revision ?? 0) + 1, status: "draft", testedCredentialRevision: null, testedAt: null,
        cliVersion: null, failureCode: null, createdAt: existing?.createdAt ?? now, updatedAt: now };
      await tx.putInstallation(item); return item;
    });
  }
  async testInstallation(actor: FleetActor, body: unknown) {
    this.authorize(actor); const input = parseFleet(revisionActionSchema, body);
    return this.ioMutation(actor, "organization.installations.manage", "installation.tested", input, async tx => {
      const existing = await tx.installation(input.id);
      if (!existing) throw new FleetError("not_found", 404);
      if (existing.revision !== input.expectedRevision) throw new FleetError("version_conflict", 409);
      const credential = await tx.credential(existing.credentialId);
      if (!credential || credential.status !== "active" || credential.kind !== "ssh_private_key") throw new FleetError("ssh_credential_required");
      assertSshPort(existing.port, this.config.allowedSshPorts);
      return { existing, credential };
    }, async ({ existing, credential }, _hash, revalidate) => {
      let result: ProbeResult;
      try {
        const key = await this.vault.read({ organizationId: actor.organizationId, credentialId: credential.id, version: credential.secretVersion });
        // Vault may have stalled across a revocation. Recheck before sending
        // secret material to the pinned peer; no DB lock spans either I/O.
        await revalidate();
        result = await this.probe(existing, key);
      } catch { result = { ok: false, code: "credential_unavailable" }; }
      return result;
    }, async (tx, { existing, credential }, result) => {
      const now = this.now();
      const item: Installation = { ...existing, revision: existing.revision + 1, status: result.ok ? "tested" : "failed",
        testedCredentialRevision: result.ok ? credential.revision : null, testedAt: result.ok ? now : null,
        cliVersion: result.ok ? result.cliVersion : null, failureCode: result.ok ? null : result.code, updatedAt: now };
      await tx.putInstallation(item); return item;
    });
  }
  async activateInstallation(actor: FleetActor, body: unknown) {
    this.authorize(actor); const input = parseFleet(revisionActionSchema, body);
    return this.mutate(actor, "organization.installations.manage", "installation.activated", input, async tx => {
      const existing = await tx.installation(input.id);
      if (!existing) throw new FleetError("not_found", 404);
      if (existing.revision !== input.expectedRevision) throw new FleetError("version_conflict", 409);
      const credential = await tx.credential(existing.credentialId);
      const now = this.now();
      if (existing.status !== "tested" || !existing.testedAt || Date.parse(now) - Date.parse(existing.testedAt) > 300_000 ||
          !credential || credential.status !== "active" || credential.revision !== existing.testedCredentialRevision) {
        throw new FleetError("fresh_test_required", 409);
      }
      const item: Installation = { ...existing, revision: existing.revision + 1, status: "active", updatedAt: now };
      await tx.putInstallation(item); return item;
    });
  }
}
