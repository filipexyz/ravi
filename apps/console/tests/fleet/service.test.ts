import { describe, expect, setSystemTime, test } from "bun:test";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { FleetService } from "../../src/server/console/fleet/service";
import { assertFleetActor, FleetError, type Credential, type FleetActor, type FleetStore, type FleetTransaction,
  type Installation, type MutationReceipt, type SecretVault } from "../../src/server/console/fleet/contract";
import { matchesHostKey, parseCliVersion, privateSshAddress } from "../../src/server/console/fleet/ssh-probe";

export const org = "00000000-0000-4000-8000-000000000001";
export const actor: FleetActor = { organizationId: org, userId: "00000000-0000-4000-8000-000000000002", role: "owner", mode: "oidc" };
export const key = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
export function credentialInput() { return { operationId: randomUUID(), id: randomUUID(), label: "Dedicated test SSH", kind: "ssh_private_key", expectedRevision: 0, value: key }; }
export function installationInput(credentialId: string) { return { operationId: randomUUID(), id: randomUUID(), label: "Test Ravi", hostname: "100.64.0.8", port: 22,
  username: "ravi-fleet", hostFingerprint: `SHA256:${"a".repeat(43)}`, credentialId, expectedRevision: 0 }; }

export class MemoryVault implements SecretVault {
  values = new Map<string, { value: string; hash: string }>(); reads = 0; writes = 0; unavailable = false;
  async put(ref: Parameters<SecretVault["put"]>[0], value: string, hash: string) {
    if (this.unavailable) throw new FleetError("vault_unavailable", 503);
    const path = JSON.stringify(ref); const old = this.values.get(path);
    if (old && (old.hash !== hash || old.value !== value)) throw new FleetError("vault_write_conflict", 409);
    if (!old) this.writes++;
    this.values.set(path, { value, hash });
  }
  async read(ref: Parameters<SecretVault["read"]>[0]) {
    this.reads++; if (this.unavailable) throw new FleetError("vault_unavailable", 503);
    const entry = this.values.get(JSON.stringify(ref)); if (!entry) throw new Error("not found"); return entry.value;
  }
}
function fixture() {
  let reservations = new Map<string, import("../../src/server/console/fleet/io-reservation").IoReservation>();
  let credentials = new Map<string, Credential>(), installations = new Map<string, Installation>(), receipts = new Map<string, MutationReceipt>();
  const audits: unknown[] = []; let activeSso = false; let memberActive = true; let failCommit = false; let probes = 0;
  let now = new Date("2026-10-23T22:00:00Z");
  const store: FleetStore = { async transaction(_actor, actions, run) {
    if (!memberActive) throw new FleetError("forbidden", 403);
    if (!actions.length) throw new FleetError("forbidden", 403);
    const c = structuredClone(credentials), i = structuredClone(installations), r = structuredClone(receipts); const a: unknown[] = [];
    const reservationsCopy = structuredClone(reservations);
    const tx: FleetTransaction = {
      reservation: async id => reservationsCopy.get(id) ?? null,
      putReservation: async (id, value) => { reservationsCopy.set(id, value); },
      renewReservation: async (id, previousLeaseId, value) => {
        const current = reservationsCopy.get(id);
        if (!current || current.leaseId !== previousLeaseId || current.completed) return false;
        reservationsCopy.set(id, value); return true;
      },
      finishReservation: async id => { reservationsCopy.get(id)!.completed = true; },
      credential: async id => c.get(id) ?? null, credentials: async () => [...c.values()], putCredential: async value => { c.set(value.id, value); },
      installation: async id => i.get(id) ?? null, installations: async () => [...i.values()], putInstallation: async value => { i.set(value.id, value); },
      credentialInActiveSso: async () => activeSso, receipt: async id => r.get(id) ?? null, putReceipt: async (id, value) => { r.set(id, value); },
      audit: async (...args) => { a.push(args); },
    };
    const result = await run(tx); if (failCommit) throw new Error("simulated DB commit loss");
    credentials = c; installations = i; receipts = r; reservations = reservationsCopy; audits.push(...a); return result;
  } };
  const vault = new MemoryVault();
  const service = new FleetService(store, vault, async () => { probes++; return { ok: true, cliVersion: "3.261021.9" }; },
    { organizationId: org, operationKey: "synthetic-operation-key-only-for-tests", now: () => now });
  return { service, vault, audits, probes: () => probes, activeSso: () => { activeSso = true; }, suspend: () => { memberActive = false; },
    failCommit: (value: boolean) => { failCommit = value; }, advance: () => { now = new Date(now.getTime() + 300_001); } };
}

describe("fleet admin contract (synthetic store/vault, not integration)", () => {
  test("identity boundary rejects wrong origin/mode; role labels confer no authorization", () => {
    for (const update of [{ mode: "anonymous" }, { mode: "workos" }, { userId: "" }, { organizationId: randomUUID() }]) {
      expect(() => assertFleetActor({ ...actor, ...update }, org)).toThrow("forbidden");
    }
    for (const role of ["admin", "owner", "viewer", "custom-renamed-label"]) {
      expect(() => assertFleetActor({ ...actor, role }, org)).not.toThrow();
    }
  });
  test("secret goes only to coffer; exact retry neither writes nor audits twice", async () => {
    const f = fixture(), input = credentialInput(); const a = await f.service.writeCredential(actor, input);
    expect(await f.service.writeCredential(actor, input)).toEqual(a);
    expect(f.vault.writes).toBe(1); expect(f.audits.length).toBe(1);
    expect(JSON.stringify({ a, state: await f.service.state(actor), audit: f.audits })).not.toContain("PRIVATE KEY");
    await expect(f.service.writeCredential(actor, { ...input, label: "changed" })).rejects.toThrow("idempotency_conflict");
  });
  test("reservation commit failure performs no Vault write and can be retried", async () => {
    const f = fixture(), input = credentialInput(); f.failCommit(true);
    await expect(f.service.writeCredential(actor, input)).rejects.toThrow("commit loss");
    expect(f.vault.writes).toBe(0);
    f.failCommit(false); expect((await f.service.state(actor)).credentials).toHaveLength(0);
    await f.service.writeCredential(actor, input); expect(f.vault.writes).toBe(1); expect(f.audits).toHaveLength(1);
  });
  test("DB commit loss after Vault write keeps an unresolved reservation, never repeats the external effect", async () => {
    const f = fixture(), input = credentialInput(), put = f.vault.put.bind(f.vault);
    f.vault.put = async (...args) => { await put(...args); f.failCommit(true); };
    await expect(f.service.writeCredential(actor, input)).rejects.toThrow("commit loss");
    f.failCommit(false);
    expect(f.vault.writes).toBe(1); expect((await f.service.state(actor)).credentials).toHaveLength(0);
    await expect(f.service.writeCredential(actor, input)).rejects.toThrow("operation_in_progress");
    expect(f.vault.writes).toBe(1); expect(f.audits).toHaveLength(0);
  });
  test("an expired credential save resumes with the same operation id; the idempotent Vault write is not repeated", async () => {
    const f = fixture(), input = credentialInput(), put = f.vault.put.bind(f.vault);
    f.vault.put = async (...args) => { await put(...args); f.failCommit(true); };
    await expect(f.service.writeCredential(actor, input)).rejects.toThrow("commit loss");
    f.failCommit(false); f.vault.put = put;
    try {
      setSystemTime(new Date(Date.now() + 120_001));
      const saved = await f.service.writeCredential(actor, input);
      expect(saved.secretVersion).toBe(1); expect(f.vault.writes).toBe(1); expect(f.audits).toHaveLength(1);
      expect(await f.service.writeCredential(actor, input)).toEqual(saved);
    } finally { setSystemTime(); }
  });
  test("a new operation skips a Vault slot orphaned by a lost finalize; the stale operation then loses the revision check", async () => {
    const f = fixture(), input = credentialInput(), put = f.vault.put.bind(f.vault);
    f.vault.put = async (...args) => { await put(...args); f.failCommit(true); };
    await expect(f.service.writeCredential(actor, input)).rejects.toThrow("commit loss");
    f.failCommit(false); f.vault.put = put;
    const saved = await f.service.writeCredential(actor, { ...input, operationId: randomUUID() });
    expect(saved.secretVersion).toBe(2); expect(saved.revision).toBe(1); expect(f.vault.writes).toBe(2);
    try {
      setSystemTime(new Date(Date.now() + 120_001));
      await expect(f.service.writeCredential(actor, input)).rejects.toThrow("version_conflict");
    } finally { setSystemTime(); }
    expect(f.vault.writes).toBe(2); expect((await f.service.state(actor)).credentials[0]?.secretVersion).toBe(2);
  });
  test("stale revision, cross-actor retry, revoked credential and active SSO refuse", async () => {
    const f = fixture(), input = credentialInput(); const c = await f.service.writeCredential(actor, input);
    await expect(f.service.writeCredential({ ...actor, userId: randomUUID() }, input)).rejects.toThrow("idempotency_conflict");
    await expect(f.service.writeCredential(actor, { ...input, operationId: randomUUID() })).rejects.toThrow("version_conflict");
    f.activeSso(); await expect(f.service.revokeCredential(actor, { operationId: randomUUID(), id: c.id, expectedRevision: c.revision })).rejects.toThrow("credential_in_active_sso");
  });
  test("save != test != activate; rotation invalidates dependent transport", async () => {
    const f = fixture(), cInput = credentialInput(); const c = await f.service.writeCredential(actor, cInput);
    const saved = await f.service.writeInstallation(actor, installationInput(c.id));
    expect(saved.status).toBe("draft"); expect(f.probes()).toBe(0);
    await expect(f.service.activateInstallation(actor, { operationId: randomUUID(), id: saved.id, expectedRevision: saved.revision })).rejects.toThrow("fresh_test_required");
    const request = { operationId: randomUUID(), id: saved.id, expectedRevision: saved.revision };
    const tested = await f.service.testInstallation(actor, request); expect(tested.status).toBe("tested");
    expect(await f.service.testInstallation(actor, request)).toEqual(tested); expect(f.probes()).toBe(1);
    const active = await f.service.activateInstallation(actor, { operationId: randomUUID(), id: tested.id, expectedRevision: tested.revision }); expect(active.status).toBe("active");
    await f.service.writeCredential(actor, { ...cInput, operationId: randomUUID(), expectedRevision: c.revision });
    const state = await f.service.state(actor); expect(state.installations[0]?.status).toBe("draft"); expect(state.installations[0]?.testedAt).toBeNull();
  });
  test("expired proof cannot activate", async () => {
    const f = fixture(); const c = await f.service.writeCredential(actor, credentialInput()); const i = await f.service.writeInstallation(actor, installationInput(c.id));
    const t = await f.service.testInstallation(actor, { operationId: randomUUID(), id: i.id, expectedRevision: i.revision }); f.advance();
    await expect(f.service.activateInstallation(actor, { operationId: randomUUID(), id: t.id, expectedRevision: t.revision })).rejects.toThrow("fresh_test_required");
  });
  test("coffer failure persists failed test, never success or secret echo", async () => {
    const f = fixture(); const c = await f.service.writeCredential(actor, credentialInput()); const i = await f.service.writeInstallation(actor, installationInput(c.id));
    f.vault.unavailable = true; const t = await f.service.testInstallation(actor, { operationId: randomUUID(), id: i.id, expectedRevision: i.revision });
    expect(t.status).toBe("failed"); expect(t.failureCode).toBe("credential_unavailable"); expect(f.probes()).toBe(0);
  });
  test("revocation prevents consumption and replay cannot restore metadata", async () => {
    const f = fixture(), input = credentialInput(); const c = await f.service.writeCredential(actor, input); const i = await f.service.writeInstallation(actor, installationInput(c.id));
    await f.service.revokeCredential(actor, { operationId: randomUUID(), id: c.id, expectedRevision: c.revision });
    await f.service.writeCredential(actor, input); // Receipt is historical, not a mutation.
    const state = await f.service.state(actor); expect(state.credentials[0]?.status).toBe("revoked");
    await expect(f.service.testInstallation(actor, { operationId: randomUUID(), id: i.id, expectedRevision: state.installations[0]!.revision })).rejects.toThrow("ssh_credential_required");
    expect(f.vault.reads).toBe(0);
  });
  test("fresh membership check refuses a previously valid actor", async () => {
    const f = fixture(); f.suspend(); await expect(f.service.state(actor)).rejects.toThrow("forbidden");
  });
  test("typed boundary rejects unknown fields, root, malformed fingerprint and empty secret", async () => {
    const f = fixture(); await expect(f.service.writeCredential(actor, { ...credentialInput(), value: "" })).rejects.toThrow("invalid_request");
    for (const change of [{ username: "root" }, { hostFingerprint: "auto-accept" }, { command: "anything" }]) {
      await expect(f.service.writeInstallation(actor, { ...installationInput(randomUUID()), ...change })).rejects.toThrow("invalid_request");
    }
  });
  test("OIDC bearer secret is bound to its original issuer/client, including on rotation", async () => {
    const f = fixture();
    const input = { ...credentialInput(), kind: "oidc_client_secret", value: "synthetic-oidc-secret", binding: { issuer: "https://idp.example.invalid", clientId: "console" } };
    const credential = await f.service.writeCredential(actor, input);
    expect(credential.binding).toEqual(input.binding);
    for (const binding of [null, { ...input.binding, issuer: "https://different.example.invalid" }, { ...input.binding, clientId: "another" }]) {
      await expect(f.service.writeCredential(actor, { ...input, operationId: randomUUID(), expectedRevision: 1, binding })).rejects.toThrow();
    }
    expect(f.vault.writes).toBe(1);
  });
});

describe("SSH safety helpers", () => {
  test("accept explicit private v4 and CGNAT, reject public, loopback, metadata and IPv6", () => {
    for (const address of ["10.1.2.3", "172.16.0.1", "172.31.255.254", "192.168.1.1", "100.64.0.1", "100.127.255.254"]) expect(privateSshAddress(address)).toBe(true);
    for (const address of ["127.0.0.1", "169.254.169.254", "100.100.100.200", "8.8.8.8", "::1", "::ffff:127.0.0.1", "172.32.0.1", "100.128.0.1", "0x7f000001"]) expect(privateSshAddress(address)).toBe(false);
  });
  test("host key and CLI result are not blindly trusted", () => {
    expect(matchesHostKey(Buffer.from("untrusted host"), `SHA256:${"a".repeat(43)}`)).toBe(false);
    expect(parseCliVersion("3.261021.9\n")).toBe("3.261021.9");
    expect(parseCliVersion("ravi 3.261021.9")).toBe("3.261021.9");
    for (const value of ["banner\n3.261021.9", "sensitive output", "3.4.5\nset token=secret"]) expect(parseCliVersion(value)).toBeNull();
  });
});
