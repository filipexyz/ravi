import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { getDb } from "../router/router-db.js";
import {
  bindIntakeView,
  claimIntakeRequest,
  createIntakeRequest,
  getIntakeRequest,
  storeIntakeSecret,
  reconcileRemoteIntakeRequest,
} from "./intake.js";
import {
  prepareRemoteIntake,
  storeRemoteIntake,
  inspectRemoteIntake,
  authorizeRemoteIntake,
  type RemoteIntakeDependencies,
} from "./remote-intake.js";
import { RemoteCredentialError } from "./remote/ssh.js";
import type { Destination } from "./remote/destinations.js";

const SECRET = "synthetic-remote-api-token-just-for-tests";
const version = "a".repeat(64);
const receipt = "b".repeat(64);
let stateDir: string;
beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-remote-intake-");
});
afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
});

function fixture() {
  let dest: Destination = {
    id: "billing-prod",
    version: randomUUID(),
    label: "Billing production",
    sshAlias: "prod",
    host: "192.0.2.1",
    port: 22,
    user: "credential-writer",
    identityFile: "/private/fixture-key",
    hostKey: "ssh-ed25519 AAAATEST",
    envPath: "/srv/billing/.env",
    remoteTarget: "billing",
    keys: ["API_TOKEN"],
    profile: "dotenv-single-line-v1",
  };
  let authorized = true;
  const deps: Partial<RemoteIntakeDependencies> = {
    destination: () => dest,
    authorize: () => authorized,
    preflight: async () => ({ v: 1, status: "ready", version }),
    store: async (_destination, _request, value, options) => {
      await options.beforeCommit();
      expect(value).toBe(SECRET);
      return { v: 1, status: "stored", receipt, version };
    },
  };
  async function request() {
    const remote = await prepareRemoteIntake(dest.id, "API_TOKEN", deps);
    const r = createIntakeRequest({
      target: "remote:billing-prod:API_TOKEN",
      accountId: "slack-test",
      teamId: "T1",
      userId: "U1",
      channelId: "C1",
      issuerAgentId: "test-agent",
      issuerSessionKey: "session-test",
      reason: "Enable billing",
      remote,
    });
    const binding = {
      accountId: "slack-test",
      teamId: "T1",
      userId: "U1",
      actorContactId: "contact-test",
      viewId: "V1",
    };
    bindIntakeView(r.id, binding, "V1");
    return claimIntakeRequest(r.id, binding);
  }
  return {
    deps,
    request,
    revoke: () => {
      authorized = false;
    },
    change: (patch: Partial<Destination>) => {
      dest = { ...dest, ...patch };
    },
  };
}

describe("remote intake authorization and persistence", () => {
  it("supports every registered label and rechecks revocation after status I/O", async () => {
    const f = fixture();
    f.change({ label: "L".repeat(120) });
    const r = await f.request();
    expect(r.remote?.label.length).toBe(120);
    f.deps.status = async () => {
      f.revoke();
      return { v: 1, status: "stored", receipt, version };
    };
    await expect(inspectRemoteIntake(r, f.deps)).rejects.toMatchObject({ code: "TARGET_NOT_ALLOWED" });
    expect(getIntakeRequest(r.id)?.status).toBe("pending");
  });

  it("does not fence an open invitation through status reconciliation", async () => {
    const f = fixture();
    const r = await f.request();
    getDb().prepare("UPDATE credential_intake_requests SET status = 'open' WHERE id = ?").run(r.id);
    let consulted = false;
    await expect(
      reconcileRemoteIntakeRequest(r.id, {
        inspect: async () => {
          consulted = true;
          return { v: 1, status: "not_found" };
        },
      }),
    ).rejects.toMatchObject({ code: "INTAKE_NOT_AVAILABLE" });
    expect(consulted).toBe(false);
  });
  it("rejects unregistered keys and registry changes during preflight", async () => {
    const f = fixture();
    await expect(prepareRemoteIntake("billing-prod", "OTHER", f.deps)).rejects.toMatchObject({
      code: "TARGET_NOT_ALLOWED",
    });
    f.deps.preflight = async () => {
      f.change({ envPath: "/srv/other/.env" });
      return { v: 1, status: "ready", version };
    };
    await expect(prepareRemoteIntake("billing-prod", "API_TOKEN", f.deps)).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
    });
  });

  it("binds transport identity, endpoint, path and key to the displayed request", async () => {
    for (const patch of [
      { envPath: "/srv/other/.env" },
      { host: "192.0.2.2" },
      { identityFile: "/private/other" },
      { hostKey: "ssh-ed25519 OTHER" },
      { remoteTarget: "other" },
      { keys: ["OTHER"] },
    ]) {
      const f = fixture();
      const r = await f.request();
      f.change(patch);
      await expect(storeRemoteIntake(r, SECRET, f.deps)).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
      getDb().prepare("DELETE FROM credential_intake_requests WHERE id = ?").run(r.id);
    }
  });

  it("rechecks live authority after remote prepare and before sending secret", async () => {
    const f = fixture();
    const r = await f.request();
    let sent = false;
    f.deps.store = async (_destination, _metadata, _value, options) => {
      f.revoke();
      await options.beforeCommit();
      sent = true;
      return { v: 1, status: "stored", receipt, version };
    };
    await expect(storeRemoteIntake(r, SECRET, f.deps)).rejects.toMatchObject({ code: "TARGET_NOT_ALLOWED" });
    expect(sent).toBe(false);
    expect(authorizeRemoteIntake({ ...r, issuerAgentId: undefined })).toBe(false);
    expect(authorizeRemoteIntake({ ...r, actorContactId: undefined })).toBe(false);
  });

  it("refuses expiration before opening transport and before commit", async () => {
    const f = fixture();
    const r = await f.request();
    await expect(storeRemoteIntake({ ...r, expiresAt: Date.now() - 1 }, SECRET, f.deps)).rejects.toMatchObject({
      code: "REQUEST_EXPIRED",
    });
    f.deps.store = async (_d, _m, _s, options) => {
      r.expiresAt = Date.now() - 1;
      await options.beforeCommit();
      throw new Error("unreachable");
    };
    await expect(storeRemoteIntake(r, SECRET, f.deps)).rejects.toMatchObject({ code: "REQUEST_EXPIRED" });
  });

  it("uses the persisted destination and stores only an opaque receipt", async () => {
    const f = fixture();
    const r = await f.request();
    const result = await storeIntakeSecret({ ...r, target: "env:OPENAI_API_KEY" }, SECRET, {
      remoteStore: (request, value) => storeRemoteIntake(request, value, f.deps),
    });
    expect(result).toEqual({
      fingerprint: receipt,
      receiptKind: "opaque",
      daemonReloadRequired: false,
      activationRequired: true,
    });
    expect(result.fingerprint).not.toBe(createHash("sha256").update(SECRET).digest("hex"));
    expect(getIntakeRequest(r.id)?.status).toBe("stored");
    const rows = JSON.stringify(getDb().query("SELECT * FROM credential_intake_requests").all());
    const audit = JSON.stringify(getDb().query("SELECT * FROM credential_intake_audit").all());
    expect(rows + audit).not.toContain(SECRET);
    expect(rows).not.toContain("identityFile");
  });

  it("keeps ambiguous outcomes pending and recovers stored receipt without the secret", async () => {
    const f = fixture();
    const r = await f.request();
    await expect(
      storeIntakeSecret(r, SECRET, {
        remoteStore: async () => {
          throw new RemoteCredentialError("REMOTE_UNCERTAIN");
        },
      }),
    ).rejects.toMatchObject({ code: "INTAKE_RECONCILIATION_REQUIRED" });
    expect(getIntakeRequest(r.id)?.status).toBe("pending");
    const recovered = await reconcileRemoteIntakeRequest(r.id, {
      inspect: async () => ({ v: 1, status: "stored", receipt, version }),
    });
    expect(recovered.status).toBe("stored");
    expect(recovered.fingerprint).toBe(receipt);
  });

  it("distinguishes precommit conflict, uncertain status and durably fenced no-write", async () => {
    const f = fixture();
    const r = await f.request();
    expect(
      (await reconcileRemoteIntakeRequest(r.id, { inspect: async () => ({ v: 1, status: "uncertain" }) })).status,
    ).toBe("pending");
    expect(
      (await reconcileRemoteIntakeRequest(r.id, { inspect: async () => ({ v: 1, status: "not_found" }) })).status,
    ).toBe("failed");
    const r2 = await f.request();
    await expect(
      storeIntakeSecret(r2, SECRET, {
        remoteStore: async () => {
          throw new RemoteCredentialError("VERSION_CONFLICT");
        },
      }),
    ).rejects.toMatchObject({ code: "INTAKE_REMOTE_CONFLICT" });
    expect(getIntakeRequest(r2.id)?.status).toBe("failed");
  });

  it("does not terminalize an unexpected failure or unauthenticated status", async () => {
    const f = fixture();
    const r = await f.request();
    await expect(
      storeIntakeSecret(r, SECRET, {
        remoteStore: async () => {
          throw new Error(SECRET);
        },
      }),
    ).rejects.toMatchObject({ code: "INTAKE_RECONCILIATION_REQUIRED" });
    f.revoke();
    let read = false;
    f.deps.status = async () => {
      read = true;
      return { v: 1, status: "not_found" };
    };
    await expect(inspectRemoteIntake(r, f.deps)).rejects.toMatchObject({ code: "TARGET_NOT_ALLOWED" });
    expect(read).toBe(false);
    expect(getIntakeRequest(r.id)?.status).toBe("pending");
  });
});
