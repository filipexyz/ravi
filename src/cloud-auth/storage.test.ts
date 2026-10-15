import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCachedContactForConsoleUser, writeCachedActorBinding } from "./actor-bindings.js";
import { CloudAuthError } from "./errors.js";
import { getInstallationKeyPath, readOrCreateInstallationKey } from "./installation-key.js";
import { createFakeSecurity } from "../test/fake-security.js";
import { detectCloudAuthBackends, selectCloudAuthBackend } from "./secret-backends.js";
import {
  deleteCloudCredentials,
  deleteCloudCredentialsForUser,
  getActiveCloudAuthPointerPath,
  getActiveCloudCredentialsPath,
  getCloudAuthDir,
  getCloudAuthUsersDir,
  getCloudCredentialsPath,
  listCloudAuthUserIds,
  persistMeIntoCredentials,
  readActiveCloudAuthUserId,
  readCloudCredentials,
  readCloudCredentialsForUser,
  setCloudAuthBackendDepsForTests,
  shouldPersistHydratedIdentity,
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
  setCloudAuthBackendDepsForTests();
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

describe("cloud auth installation identity", () => {
  it("adopts the Console's local installation id from /me and persists the change", () => {
    const stored = makeCredentials({ installationId: "ins_local_random", user: { id: "user_alice" } });
    const next = persistMeIntoCredentials(stored, {
      user: { id: "user_alice" },
      organization: { id: "org_123" },
      localInstallation: { id: "ins_console" },
    });

    expect(next.installationId).toBe("ins_console");
    expect(shouldPersistHydratedIdentity(stored, next)).toBe(true);
    expect(shouldPersistHydratedIdentity(next, persistMeIntoCredentials(next, { localInstallation: null }))).toBe(
      false,
    );
  });

  it("keeps one private installation key across calls and logout", () => {
    const first = readOrCreateInstallationKey();
    writeCloudCredentials(makeCredentials({ user: { id: "user_alice" } }));
    deleteCloudCredentials();

    expect(readOrCreateInstallationKey()).toBe(first);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(statSync(getInstallationKeyPath()).mode & 0o777).toBe(0o600);
  });

  it("maps a Console user back to a contact only when exactly one cached link matches", () => {
    const binding = {
      contactId: "contact_luis",
      actorPrincipal: "contact:contact_luis",
      consoleUserId: "user_luis",
      orgId: "org_123",
      installationId: "ins_console",
    };
    const query = { consoleUserId: "user_luis", orgId: "org_123", installationId: "ins_console" };
    expect(resolveCachedContactForConsoleUser(query)).toBeNull();

    writeCachedActorBinding(binding);
    expect(resolveCachedContactForConsoleUser(query)).toBe("contact_luis");
    expect(resolveCachedContactForConsoleUser({ ...query, installationId: "ins_other" })).toBeNull();

    writeCachedActorBinding({ ...binding, contactId: "contact_luis_wa", actorPrincipal: "contact:contact_luis_wa" });
    expect(resolveCachedContactForConsoleUser(query)).toBeNull();
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

/**
 * The shared fake `security` (src/test/fake-security.ts) behind the injected
 * runner: `security -i` writes, `find-generic-password -g`, deletes, and a
 * `locked` switch. Never runs the real binary.
 */
function useFakeKeychain() {
  const fake = createFakeSecurity();
  const warnings: string[] = [];
  setCloudAuthBackendDepsForTests({
    platform: "darwin",
    commandExists: (command) => command === "security",
    warn: (message) => warnings.push(message),
    runCommand: (_command, args, options) => fake.run(args, options),
  });
  process.env.RAVI_CLOUD_AUTH_BACKEND = "keychain";
  return { items: fake.items, warnings, fake };
}

describe("cloud auth Keychain fallback", () => {
  const oversized = (overrides: Partial<CloudCredentials> = {}) =>
    makeCredentials({ user: { id: "user_alice" }, accessToken: `access-${"x".repeat(5000)}`, ...overrides });

  it("stores and reads through Keychain when the payload fits", () => {
    const { items } = useFakeKeychain();
    const credentials = makeCredentials({ user: { id: "user_alice" } });

    writeCloudCredentials(credentials);

    expect(items.has("ravi.cloud-auth/user_alice")).toBe(true);
    expect(existsSync(join(getCloudAuthUsersDir(), "user_alice", "credentials.json"))).toBe(false);
    expect(readCloudCredentials()).toEqual(credentials);
  });

  it("reads the file store after a Keychain write falls back, not a stale Keychain item", () => {
    const { items } = useFakeKeychain();
    // An older Ravi stored these in Keychain (argv write).
    writeCloudCredentials(makeCredentials({ user: { id: "user_alice" }, accessToken: "stale-access" }));
    expect(items.has("ravi.cloud-auth/user_alice")).toBe(true);
    const fresh = oversized();

    writeCloudCredentials(fresh);

    expect(readCloudCredentials()).toEqual(fresh);
    expect(readCloudCredentialsForUser("user_alice")).toEqual(fresh);
    expect(statSync(join(getCloudAuthUsersDir(), "user_alice", "credentials.json")).mode & 0o777).toBe(0o600);
    // The stale Keychain item is removed.
    expect(items.has("ravi.cloud-auth/user_alice")).toBe(false);
  });

  it("warns once that the credentials went to the 0600 file store, without token material", () => {
    const { warnings } = useFakeKeychain();

    writeCloudCredentials(oversized());
    writeCloudCredentials(oversized({ refreshToken: "refresh-2" }));

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("private file store");
    expect(warnings[0]).toContain("0600");
    expect(warnings[0]).toContain("too large");
    expect(warnings[0]).not.toContain("access-x");
  });

  it("logout removes a fallback file copy", () => {
    useFakeKeychain();
    writeCloudCredentials(oversized());

    deleteCloudCredentials();

    expect(readCloudCredentials()).toBeNull();
    expect(existsSync(join(getCloudAuthUsersDir(), "user_alice", "credentials.json"))).toBe(false);
  });

  it("a later Keychain write replaces the fallback file copy", () => {
    const { items } = useFakeKeychain();
    writeCloudCredentials(oversized());
    const small = makeCredentials({ user: { id: "user_alice" }, accessToken: "small-access" });

    writeCloudCredentials(small);

    expect(items.has("ravi.cloud-auth/user_alice")).toBe(true);
    expect(existsSync(join(getCloudAuthUsersDir(), "user_alice", "credentials.json"))).toBe(false);
    expect(readCloudCredentials()).toEqual(small);
  });

  it("logout promotes the next user to the store that holds its credentials, not to the departing user's", () => {
    const { fake, items } = useFakeKeychain();
    const bobOld = makeCredentials({ user: { id: "user_bob" }, accessToken: "bob-old" });
    const bobNew = makeCredentials({ user: { id: "user_bob" }, accessToken: "bob-new" });
    const alice = makeCredentials({ user: { id: "user_alice" }, accessToken: "alice-access" });

    writeCloudCredentials(bobOld);
    // Bob logs in again with the Keychain locked: the write falls back to the
    // file store and the delete of the old item fails too, so it survives.
    fake.locked = true;
    writeCloudCredentials(bobNew);
    fake.locked = false;
    expect(items.get("ravi.cloud-auth/user_bob")?.toString("utf8")).toContain("bob-old");
    expect(existsSync(join(getCloudAuthUsersDir(), "user_bob", "credentials.json"))).toBe(true);
    writeCloudCredentials(alice);
    expect(readActiveCloudAuthUserId()).toBe("user_alice");

    deleteCloudCredentials();

    expect(readActiveCloudAuthUserId()).toBe("user_bob");
    expect(JSON.parse(readFileSync(getActiveCloudAuthPointerPath(), "utf8"))).toMatchObject({ backend: "file" });
    expect(readCloudCredentials()).toEqual(bobNew);
    expect(readCloudCredentialsForUser("user_bob")).toEqual(bobNew);
  });

  it("logout promotes a user whose only copy is the fallback file (stale Keychain item already deleted)", () => {
    const { items } = useFakeKeychain();
    writeCloudCredentials(makeCredentials({ user: { id: "user_bob" }, accessToken: "bob-old" }));
    const bobNew = oversized({ user: { id: "user_bob" }, accessToken: `bob-${"x".repeat(5000)}` });
    writeCloudCredentials(bobNew);
    expect(items.has("ravi.cloud-auth/user_bob")).toBe(false);
    writeCloudCredentials(makeCredentials({ user: { id: "user_alice" } }));

    deleteCloudCredentialsForUser("user_alice");

    expect(readActiveCloudAuthUserId()).toBe("user_bob");
    expect(readCloudCredentials()).toEqual(bobNew);
    expect(items.has("ravi.cloud-auth/user_alice")).toBe(false);
  });

  it("logout clears a stale Keychain item left by a locked-Keychain fallback, so a per-user read is null", () => {
    const { fake, items } = useFakeKeychain();
    writeCloudCredentials(makeCredentials({ user: { id: "user_bob" }, accessToken: "bob-old" }));
    fake.locked = true;
    writeCloudCredentials(makeCredentials({ user: { id: "user_bob" }, accessToken: "bob-new" }));
    fake.locked = false;
    expect(items.get("ravi.cloud-auth/user_bob")?.toString("utf8")).toContain("bob-old");
    expect(JSON.parse(readFileSync(getActiveCloudAuthPointerPath(), "utf8"))).toMatchObject({ backend: "file" });

    deleteCloudCredentials();

    expect(items.has("ravi.cloud-auth/user_bob")).toBe(false);
    expect(existsSync(join(getCloudAuthUsersDir(), "user_bob"))).toBe(false);
    expect(readCloudCredentialsForUser("user_bob")).toBeNull();
    expect(readCloudCredentials()).toBeNull();
    expect(readActiveCloudAuthUserId()).toBeNull();
  });

  it("deleting an inactive user clears both the fallback file copy and the stale Keychain item", () => {
    const { fake, items } = useFakeKeychain();
    writeCloudCredentials(makeCredentials({ user: { id: "user_bob" }, accessToken: "bob-old" }));
    fake.locked = true;
    writeCloudCredentials(makeCredentials({ user: { id: "user_bob" }, accessToken: "bob-new" }));
    fake.locked = false;
    writeCloudCredentials(makeCredentials({ user: { id: "user_alice" }, accessToken: "alice-access" }));
    expect(readActiveCloudAuthUserId()).toBe("user_alice");
    expect(items.has("ravi.cloud-auth/user_bob")).toBe(true);

    deleteCloudCredentialsForUser("user_bob");

    expect(items.has("ravi.cloud-auth/user_bob")).toBe(false);
    expect(existsSync(join(getCloudAuthUsersDir(), "user_bob"))).toBe(false);
    expect(readCloudCredentialsForUser("user_bob")).toBeNull();
    expect(listCloudAuthUserIds()).not.toContain("user_bob");
    // Alice is untouched.
    expect(readActiveCloudAuthUserId()).toBe("user_alice");
    expect(readCloudCredentials()?.accessToken).toBe("alice-access");
  });

  it("promoting the legacy slot removes its Keychain item and its locked-fallback file copy", () => {
    const { fake, items } = useFakeKeychain();
    writeCloudCredentials(makeCredentials({ user: null, accessToken: "legacy-old" }));
    expect(items.has("ravi.cloud-auth/_legacy")).toBe(true);
    fake.locked = true;
    writeCloudCredentials(makeCredentials({ user: null, accessToken: "legacy-new" }));
    fake.locked = false;
    expect(items.has("ravi.cloud-auth/_legacy")).toBe(true);
    expect(existsSync(join(getCloudAuthUsersDir(), "_legacy", "credentials.json"))).toBe(true);

    writeCloudCredentials(makeCredentials({ user: { id: "user_alice" } }));

    expect(readActiveCloudAuthUserId()).toBe("user_alice");
    expect(items.has("ravi.cloud-auth/_legacy")).toBe(false);
    expect(existsSync(join(getCloudAuthUsersDir(), "_legacy"))).toBe(false);
    expect(listCloudAuthUserIds()).not.toContain("_legacy");
  });

  it("the fallback warning says when the older Keychain item could not be removed, without token material", () => {
    const { fake, warnings } = useFakeKeychain();
    writeCloudCredentials(makeCredentials({ user: { id: "user_bob" }, accessToken: "bob-old-secret" }));
    fake.locked = true;

    writeCloudCredentials(makeCredentials({ user: { id: "user_bob" }, accessToken: "bob-new-secret" }));

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("private file store");
    expect(warnings[0]).toContain("older macOS Keychain item");
    expect(warnings[0]).toContain("could not be removed");
    expect(warnings[0]).toContain("next logout");
    expect(warnings[0]).toContain("User interaction is not allowed");
    expect(warnings[0]).not.toContain("secret");
  });

  it("the fallback warning does not claim a surviving item when the old one was removed", () => {
    const { warnings } = useFakeKeychain();
    writeCloudCredentials(makeCredentials({ user: { id: "user_alice" }, accessToken: "small" }));

    writeCloudCredentials(oversized());

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain("could not be removed");
  });

  it("logout with a locked Keychain does not throw and warns that the item survived", () => {
    const { fake, items, warnings } = useFakeKeychain();
    writeCloudCredentials(makeCredentials({ user: { id: "user_alice" } }));
    fake.locked = true;

    expect(() => deleteCloudCredentials()).not.toThrow();

    expect(readActiveCloudAuthUserId()).toBeNull();
    expect(items.has("ravi.cloud-auth/user_alice")).toBe(true);
    expect(warnings.some((message) => message.includes("could not be removed") && message.includes("user_alice"))).toBe(
      true,
    );
  });

  it("promoting the legacy slot removes its fallback file copy too", () => {
    const { items } = useFakeKeychain();
    // No user id yet, and too large for Keychain: the legacy slot lands in the file store.
    writeCloudCredentials(makeCredentials({ user: null, accessToken: `access-${"x".repeat(5000)}` }));
    expect(readActiveCloudAuthUserId()).toBe("_legacy");
    expect(existsSync(join(getCloudAuthUsersDir(), "_legacy", "credentials.json"))).toBe(true);

    writeCloudCredentials(makeCredentials({ user: { id: "user_alice" } }));

    expect(readActiveCloudAuthUserId()).toBe("user_alice");
    expect(items.has("ravi.cloud-auth/user_alice")).toBe(true);
    expect(existsSync(join(getCloudAuthUsersDir(), "_legacy"))).toBe(false);
    expect(listCloudAuthUserIds()).not.toContain("_legacy");
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
