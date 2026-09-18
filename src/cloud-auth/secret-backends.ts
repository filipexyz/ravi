import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CloudAuthError } from "./errors.js";
import type { CloudAuthBackendName } from "./types.js";
import { CLOUD_AUTH_BACKENDS } from "./types.js";

const STORE_DIR_MODE = 0o700;
const CREDENTIALS_FILE_MODE = 0o600;
const CREDENTIALS_FILE = "credentials.json";
const LIBSECRET_SERVICE = "ravi.cloud-auth";
const KEYCHAIN_SERVICE = "ravi.cloud-auth";

export const CLOUD_AUTH_BACKEND_ENV = "RAVI_CLOUD_AUTH_BACKEND";

export interface CloudAuthSecretBackend {
  readonly name: CloudAuthBackendName;
  available(): boolean;
  read(userId: string): string | null;
  write(userId: string, payload: string): void;
  delete(userId: string): void;
}

export interface CloudAuthBackendCapability {
  name: CloudAuthBackendName;
  available: boolean;
  default: boolean;
}

export interface CloudAuthBackendDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  usersDir: string;
  commandExists?: (command: string) => boolean;
  runCommand?: (command: string, args: string[], options?: { input?: string }) => CommandResult;
}

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export function detectCloudAuthBackends(deps: CloudAuthBackendDeps): CloudAuthBackendCapability[] {
  const selected = selectCloudAuthBackend(deps);
  return CLOUD_AUTH_BACKENDS.map((name) => ({
    name,
    available: createBackend(name, deps).available(),
    default: name === selected.name,
  }));
}

export function selectCloudAuthBackend(deps: CloudAuthBackendDeps): CloudAuthSecretBackend {
  const preference = (deps.env?.[CLOUD_AUTH_BACKEND_ENV] ?? "file").trim().toLowerCase();
  const platform = deps.platform ?? process.platform;

  if (preference === "auto") {
    if (platform === "linux") {
      const libsecret = createBackend("libsecret", deps);
      if (libsecret.available()) return libsecret;
    }
    if (platform === "darwin") {
      const keychain = createBackend("keychain", deps);
      if (keychain.available()) return keychain;
    }
    return createBackend("file", deps);
  }

  if (preference === "libsecret") {
    const libsecret = createBackend("libsecret", deps);
    if (libsecret.available()) return libsecret;
    return createBackend("file", deps);
  }

  if (preference === "keychain") {
    const keychain = createBackend("keychain", deps);
    if (keychain.available()) return keychain;
    return createBackend("file", deps);
  }

  return createBackend("file", deps);
}

export function createBackend(name: CloudAuthBackendName, deps: CloudAuthBackendDeps): CloudAuthSecretBackend {
  if (name === "libsecret") return createLibsecretBackend(deps);
  if (name === "keychain") return createKeychainBackend(deps);
  return createFileBackend(deps);
}

export function getCloudUserDir(usersDir: string, userId: string): string {
  return join(usersDir, userId);
}

export function getCloudUserCredentialsPath(usersDir: string, userId: string): string {
  return join(getCloudUserDir(usersDir, userId), CREDENTIALS_FILE);
}

export function writeUserOnlyFile(path: string, contents: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: STORE_DIR_MODE });
  chmodSync(dir, STORE_DIR_MODE);
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, contents, { mode: CREDENTIALS_FILE_MODE });
  chmodSync(tmpPath, CREDENTIALS_FILE_MODE);
  renameSync(tmpPath, path);
  chmodSync(path, CREDENTIALS_FILE_MODE);
}

function createFileBackend(deps: CloudAuthBackendDeps): CloudAuthSecretBackend {
  return {
    name: "file",
    available() {
      return true;
    },
    read(userId) {
      const path = getCloudUserCredentialsPath(deps.usersDir, userId);
      if (!existsSync(path)) return null;
      return readFileSync(path, "utf8");
    },
    write(userId, payload) {
      const userDir = getCloudUserDir(deps.usersDir, userId);
      mkdirSync(deps.usersDir, { recursive: true, mode: STORE_DIR_MODE });
      chmodSync(deps.usersDir, STORE_DIR_MODE);
      mkdirSync(userDir, { recursive: true, mode: STORE_DIR_MODE });
      chmodSync(userDir, STORE_DIR_MODE);
      writeUserOnlyFile(getCloudUserCredentialsPath(deps.usersDir, userId), payload);
    },
    delete(userId) {
      rmSync(getCloudUserDir(deps.usersDir, userId), { recursive: true, force: true });
    },
  };
}

function createLibsecretBackend(deps: CloudAuthBackendDeps): CloudAuthSecretBackend {
  const commandExists = deps.commandExists ?? defaultCommandExists;
  const runCommand = deps.runCommand ?? defaultRunCommand;
  return {
    name: "libsecret",
    available() {
      return commandExists("secret-tool");
    },
    read(userId) {
      const result = runCommand("secret-tool", ["lookup", "service", LIBSECRET_SERVICE, "account", userId]);
      if (result.status !== 0) return null;
      const payload = result.stdout.trim();
      return payload || null;
    },
    write(userId, payload) {
      const result = runCommand(
        "secret-tool",
        ["store", "--label", `Ravi Cloud ${userId}`, "service", LIBSECRET_SERVICE, "account", userId],
        { input: payload },
      );
      if (result.status !== 0) {
        throw new CloudAuthError(
          "CREDENTIALS_INVALID",
          "FreeDesktop Secret Service is unavailable. Ravi fell back to the portable file store.",
          { cause: new Error(result.stderr || result.stdout) },
        );
      }
    },
    delete(userId) {
      runCommand("secret-tool", ["clear", "service", LIBSECRET_SERVICE, "account", userId]);
    },
  };
}

function createKeychainBackend(deps: CloudAuthBackendDeps): CloudAuthSecretBackend {
  const commandExists = deps.commandExists ?? defaultCommandExists;
  const runCommand = deps.runCommand ?? defaultRunCommand;
  const platform = deps.platform ?? process.platform;
  return {
    name: "keychain",
    available() {
      return platform === "darwin" && commandExists("security");
    },
    read(userId) {
      const result = runCommand("security", ["find-generic-password", "-a", userId, "-s", KEYCHAIN_SERVICE, "-w"]);
      if (result.status !== 0) return null;
      const payload = result.stdout.trim();
      return payload || null;
    },
    write(userId, payload) {
      const result = runCommand("security", [
        "add-generic-password",
        "-a",
        userId,
        "-s",
        KEYCHAIN_SERVICE,
        "-w",
        payload,
        "-U",
      ]);
      if (result.status !== 0) {
        throw new CloudAuthError(
          "CREDENTIALS_INVALID",
          "macOS Keychain is unavailable. Ravi fell back to the portable file store.",
          { cause: new Error(redactSecurityError(result.stderr || result.stdout)) },
        );
      }
    },
    delete(userId) {
      runCommand("security", ["delete-generic-password", "-a", userId, "-s", KEYCHAIN_SERVICE]);
    },
  };
}

function defaultCommandExists(command: string): boolean {
  const lookup = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(lookup, [command], { encoding: "utf8" });
  return result.status === 0;
}

function defaultRunCommand(command: string, args: string[], options: { input?: string } = {}): CommandResult {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    input: options.input,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function redactSecurityError(value: string): string {
  return value.replace(/(-w\s+)\S+/g, "$1[redacted]").trim();
}
