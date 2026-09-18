import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudAuthError } from "./errors.js";
import { detectCloudAuthBackends, selectCloudAuthBackend } from "./secret-backends.js";
import {
  deleteCloudCredentials,
  getActiveCloudAuthPointerPath,
  getActiveCloudCredentialsPath,
  getCloudAuthDir,
  getCloudAuthUsersDir,
  getCloudCredentialsPath,
  listCloudAuthUserIds,
  readActiveCloudAuthUserId,
  readCloudCredentials,
  readCloudCredentialsForUser,
  toSafeCloudAuthSession,
  writeCloudCredentials,
} from "./storage.js";
import type { CloudCredentials } from "./types.js";

let stateDir: string | null = null;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "ravi-cloud-auth-storage-"));
  process.env.RAVI_STATE_DIR = stateDir;
  delete process.env.RAVI_CLOUD_AUTH_BACKEND;
});

afterEach(() => {
  delete process.env.RAVI_STATE_DIR;
  delete process.env.RAVI_CLOUD_AUTH_BACKEND;
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  stateDir = null;
});

describe("cloud auth credential storage", () => {
  it("writes per-user file credentials with 0700 directories and 0600 files", () => {
    const credentials = makeCredentials({ user: { id: "user_alice", email: "alice@example.com" } });

    writeCloudCredentials(credentials);

    expect(statSync(getCloudAuthDir()).mode & 0o777).toBe(0o700);
    expect(statSync(getCloudAuthUsersDir()).mode & 0o777).toBe(0o700);
    expect(statSync(join(getCloudAuthUsersDir(), "user_alice")).mode & 0o777).toBe(0o700);
    expect(statSync(getActiveCloudCredentialsPath()!).mode & 0o777).toBe(0o600);
    expect(statSync(getActiveCloudAuthPointerPath()).mode & 0o777).toBe(0o600);
    expect(readActiveCloudAuthUserId()).toBe("user_alice");
    expect(readCloudCredentials()).toEqual(credentials);
    expect(existsSync(getCloudCredentialsPath())).toBe(false);
  });

  it("keeps multiple users and points whoami at the active user", () => {
    const alice = makeCredentials({
      user: { id: "user_alice", email: "alice@example.com" },
      accessToken: "alice-access",
      refreshToken: "alice-refresh",
    });
    const bob = makeCredentials({
      user: { id: "user_bob", email: "bob@example.com" },
      accessToken: "bob-access",
      refreshToken: "bob-refresh",
      organization: { id: "org_456", name: "Other" },
    });

    writeCloudCredentials(alice);
    writeCloudCredentials(bob);

    expect(readActiveCloudAuthUserId()).toBe("user_bob");
    expect(readCloudCredentials()?.user?.id).toBe("user_bob");
    expect(readCloudCredentialsForUser("user_alice")?.accessToken).toBe("alice-access");
    expect(listCloudAuthUserIds()).toEqual(["user_alice", "user_bob"]);

    deleteCloudCredentials();
    expect(readActiveCloudAuthUserId()).toBe("user_alice");
    expect(readCloudCredentials()?.user?.id).toBe("user_alice");
    expect(readCloudCredentialsForUser("user_bob")).toBeNull();
  });

  it("migrates the legacy single-slot file into the active user store", () => {
    const credentials = makeCredentials({ user: { id: "user_alice", email: "alice@example.com" } });
    const dir = getCloudAuthDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(getCloudCredentialsPath(), `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
    chmodSync(getCloudCredentialsPath(), 0o600);

    expect(readCloudCredentials()).toEqual(credentials);
    expect(readActiveCloudAuthUserId()).toBe("user_alice");
    expect(existsSync(getCloudCredentialsPath())).toBe(false);
    expect(statSync(getActiveCloudCredentialsPath()!).mode & 0o777).toBe(0o600);
  });

  it("writes credentials without a user id to the reserved legacy slot", () => {
    writeCloudCredentials(makeCredentials());
    expect(readActiveCloudAuthUserId()).toBe("_legacy");
    expect(readCloudCredentials()?.accessToken).toBe("access-secret");
  });

  it("promotes the legacy slot once a Console user id is known", () => {
    writeCloudCredentials(makeCredentials());
    writeCloudCredentials(makeCredentials({ user: { id: "user_alice", email: "alice@example.com" } }));
    expect(readActiveCloudAuthUserId()).toBe("user_alice");
    expect(listCloudAuthUserIds()).toEqual(["user_alice"]);
  });

  it("refuses to read credentials with group or world permissions", () => {
    writeCloudCredentials(makeCredentials({ user: { id: "user_alice" } }));
    chmodSync(getActiveCloudCredentialsPath()!, 0o644);

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
    writeCloudCredentials(makeCredentials({ user: { id: "user_alice" } }));
    deleteCloudCredentials();
    expect(readCloudCredentials()).toBeNull();
    expect(readActiveCloudAuthUserId()).toBeNull();
  });
});

describe("cloud auth secret backends", () => {
  it("defaults to the portable file backend and never requires Keychain", () => {
    const caps = detectCloudAuthBackends({
      usersDir: getCloudAuthUsersDir(),
      platform: "linux",
      env: {},
      commandExists: () => false,
    });
    expect(caps.find((item) => item.name === "file")).toMatchObject({ available: true, default: true });
    expect(caps.find((item) => item.name === "keychain")).toMatchObject({ available: false, default: false });
    expect(selectCloudAuthBackend({ usersDir: getCloudAuthUsersDir(), platform: "linux", env: {} }).name).toBe("file");
  });

  it("falls back to file when an optional backend is requested but unavailable", () => {
    const backend = selectCloudAuthBackend({
      usersDir: getCloudAuthUsersDir(),
      platform: "linux",
      env: { RAVI_CLOUD_AUTH_BACKEND: "keychain" },
      commandExists: () => false,
    });
    expect(backend.name).toBe("file");
  });

  it("can select libsecret when secret-tool is available", () => {
    const backend = selectCloudAuthBackend({
      usersDir: getCloudAuthUsersDir(),
      platform: "linux",
      env: { RAVI_CLOUD_AUTH_BACKEND: "libsecret" },
      commandExists: (command) => command === "secret-tool",
    });
    expect(backend.name).toBe("libsecret");
  });
});

function makeCredentials(overrides: Partial<CloudCredentials> = {}): CloudCredentials {
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
    ...overrides,
  };
}
