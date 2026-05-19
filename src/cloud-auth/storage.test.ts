import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudAuthError } from "./errors.js";
import {
  deleteCloudCredentials,
  getCloudAuthDir,
  getCloudCredentialsPath,
  readCloudCredentials,
  toSafeCloudAuthSession,
  writeCloudCredentials,
} from "./storage.js";
import type { CloudCredentials } from "./types.js";

let stateDir: string | null = null;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "ravi-cloud-auth-storage-"));
  process.env.RAVI_STATE_DIR = stateDir;
});

afterEach(() => {
  delete process.env.RAVI_STATE_DIR;
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  stateDir = null;
});

describe("cloud auth credential storage", () => {
  it("writes file fallback credentials with current-user-only permissions", () => {
    const credentials = makeCredentials();

    writeCloudCredentials(credentials);

    expect(statSync(getCloudAuthDir()).mode & 0o777).toBe(0o700);
    expect(statSync(getCloudCredentialsPath()).mode & 0o777).toBe(0o600);
    expect(readCloudCredentials()).toEqual(credentials);
  });

  it("refuses to read credentials with group or world permissions", () => {
    writeCloudCredentials(makeCredentials());
    chmodSync(getCloudCredentialsPath(), 0o644);

    try {
      readCloudCredentials();
      throw new Error("Expected readCloudCredentials to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CloudAuthError);
      expect((error as CloudAuthError).code).toBe("CREDENTIALS_INVALID");
      expect((error as CloudAuthError).message).toContain("expected 0600");
    }
  });

  it("redacts token material from safe session metadata", () => {
    const credentials = makeCredentials();
    const safe = toSafeCloudAuthSession(credentials);
    const encoded = JSON.stringify(safe);

    expect(encoded).toContain("https://console.example");
    expect(encoded).toContain("alice@example.com");
    expect(encoded).not.toContain(credentials.accessToken);
    expect(encoded).not.toContain(credentials.refreshToken);
    expect(safe).toEqual({
      consoleUrl: "https://console.example",
      user: { email: "alice@example.com" },
      organization: { id: "org_123", name: "Acme" },
      installation: { id: "ins_123" },
      scopes: ["artifacts:publish"],
      accessTokenExpiresAt: "2026-05-10T00:00:00.000Z",
      refreshTokenExpiresAt: "2026-06-10T00:00:00.000Z",
    });
  });

  it("deletes stored credentials on logout", () => {
    writeCloudCredentials(makeCredentials());
    deleteCloudCredentials();
    expect(readCloudCredentials()).toBeNull();
  });
});

function makeCredentials(): CloudCredentials {
  return {
    version: 1,
    consoleUrl: "https://console.example",
    installationId: "ins_123",
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    accessTokenExpiresAt: "2026-05-10T00:00:00.000Z",
    refreshTokenExpiresAt: "2026-06-10T00:00:00.000Z",
    scopes: ["artifacts:publish"],
    user: { email: "alice@example.com" },
    organization: { id: "org_123", name: "Acme" },
    createdAt: "2026-05-09T00:00:00.000Z",
    updatedAt: "2026-05-09T00:00:00.000Z",
  };
}
