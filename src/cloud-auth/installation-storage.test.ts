import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureRemoteClientInstallationId,
  getRemoteInstallationCredentialsPath,
  listRemoteInstallationCredentials,
  readRemoteInstallationCredential,
  readRemoteInstallationCredentialState,
  toSafeRemoteInstallationCredential,
  writeRemoteInstallationCredential,
} from "./installation-storage.js";

let stateDir: string | null = null;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "ravi-remote-installation-storage-"));
  process.env.RAVI_STATE_DIR = stateDir;
});

afterEach(() => {
  delete process.env.RAVI_STATE_DIR;
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  stateDir = null;
});

describe("remote installation credential storage", () => {
  it("keeps one client identity and independent credentials for multiple endpoints", () => {
    const clientInstallationId = ensureRemoteClientInstallationId(
      undefined,
      process.env,
      () => "client_installation_1",
    );
    expect(ensureRemoteClientInstallationId("ignored")).toBe(clientInstallationId);

    const first = writeRemoteInstallationCredential(
      "https://one.example",
      clientInstallationId,
      {
        provider: "example",
        credentialId: "credential_1",
        material: { privateKeyPem: "first-private-secret" },
        publicMetadata: { installationId: "installation_1" },
      },
      process.env,
      () => "2026-07-25T12:00:00.000Z",
    );
    writeRemoteInstallationCredential(
      "https://two.example",
      clientInstallationId,
      {
        provider: "example",
        credentialId: "credential_2",
        material: { privateKeyPem: "second-private-secret" },
        publicMetadata: { installationId: "installation_2" },
      },
      process.env,
      () => "2026-07-25T12:01:00.000Z",
    );

    expect(readRemoteInstallationCredentialState()).toMatchObject({
      version: 1,
      clientInstallationId,
      activeEndpointUrl: "https://two.example",
      connections: {
        "https://one.example": {
          credential: { credentialId: "credential_1" },
        },
        "https://two.example": {
          credential: { credentialId: "credential_2" },
        },
      },
    });
    expect(readRemoteInstallationCredential("https://one.example")).toEqual(first);
    expect(readRemoteInstallationCredential()).toMatchObject({
      endpointUrl: "https://two.example",
      credential: { credentialId: "credential_2" },
    });
    expect(listRemoteInstallationCredentials().map((stored) => stored.endpointUrl)).toEqual([
      "https://one.example",
      "https://two.example",
    ]);
  });

  it("stores secret material with user-only permissions but excludes it from safe metadata", () => {
    const clientInstallationId = ensureRemoteClientInstallationId("client_installation_1");
    const stored = writeRemoteInstallationCredential("https://auth.example", clientInstallationId, {
      provider: "example",
      credentialId: "credential_1",
      material: {
        privateKeyPem: "private-secret",
        renewableCredential: "renewable-secret",
      },
      publicMetadata: { installationId: "installation_1" },
    });
    const path = getRemoteInstallationCredentialsPath();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toContain("private-secret");

    const safe = toSafeRemoteInstallationCredential(stored);
    expect(safe).toEqual({
      endpointUrl: "https://auth.example",
      provider: "example",
      credentialId: "credential_1",
      publicMetadata: { installationId: "installation_1" },
    });
    expect(JSON.stringify(safe)).not.toContain("private-secret");
    expect(JSON.stringify(safe)).not.toContain("renewable-secret");
  });

  it("refuses credential state readable by another user", () => {
    ensureRemoteClientInstallationId("client_installation_1");
    chmodSync(getRemoteInstallationCredentialsPath(), 0o644);
    expect(() => readRemoteInstallationCredentialState()).toThrow(
      expect.objectContaining({ code: "CREDENTIALS_INVALID" }),
    );
  });
});
