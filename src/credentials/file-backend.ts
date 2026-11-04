import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";
import { getRaviStateDir } from "../utils/paths.js";
import { CredentialBrokerError } from "./errors.js";

const REF_PATTERN = /^file:([a-f0-9]{64})$/;
const MAX_SECRET_BYTES = 64 * 1024;

/** Plaintext owned by the host account, protected by 0700/0600 permissions. */
function secretDirectory(create: boolean): string {
  const state = getRaviStateDir();
  if (create) mkdirSync(state, { recursive: true, mode: 0o700 });
  const stateInfo = lstatSync(state);
  if (!stateInfo.isDirectory() || stateInfo.isSymbolicLink() || (stateInfo.mode & 0o022) !== 0) {
    throw new Error("Unsafe state directory");
  }
  const directory = join(state, "credential-secrets");
  if (create) {
    try {
      mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700) {
    throw new Error("Unsafe secret directory");
  }
  assertOwner(info);
  return directory;
}

function assertOwner(info: Stats): void {
  if (process.getuid && info.uid !== process.getuid()) throw new Error("Unexpected secret owner");
}

function assertSecretFile(info: Stats): void {
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600 || info.nlink !== 1) {
    throw new Error("Unsafe secret file");
  }
  assertOwner(info);
}

function pathForRef(ref: string, directory: string): string {
  const match = REF_PATTERN.exec(ref);
  if (!match) throw new Error("Invalid file secret reference");
  return join(directory, `${match[1]}.secret`);
}

function fixedError(): CredentialBrokerError {
  return new CredentialBrokerError("secret_unavailable", "The protected local credential file is unavailable.");
}

export function writeFileSecret(input: { provider: string; connection: string; secret: string }): string {
  let temporary: string | undefined;
  let fd: number | undefined;
  try {
    if (
      !/^[a-z0-9][a-z0-9._-]*$/.test(input.provider) ||
      !/^[a-z0-9][a-z0-9._-]*$/.test(input.connection) ||
      !input.secret ||
      Buffer.byteLength(input.secret) > MAX_SECRET_BYTES ||
      input.secret.includes("\u0000")
    )
      throw new Error("Invalid local credential");
    const directory = secretDirectory(true);
    const hash = createHash("sha256").update(`${input.provider}:${input.connection}`).digest("hex");
    const ref = `file:${hash}`;
    const destination = pathForRef(ref, directory);
    try {
      assertSecretFile(lstatSync(destination));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    temporary = join(directory, `${hash}.${randomUUID()}.tmp`);
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, input.secret, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, destination);
    temporary = undefined;
    return ref;
  } catch {
    // No path, payload or raw filesystem cause crosses the broker boundary.
    throw fixedError();
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* Preserve the safe primary error. */
      }
    }
    if (temporary) {
      try {
        unlinkSync(temporary);
      } catch {
        /* Only a request-owned temporary file. */
      }
    }
  }
}

export function readFileSecret(ref: string): string {
  let fd: number | undefined;
  try {
    const path = pathForRef(ref, secretDirectory(false));
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(fd);
    assertSecretFile(info);
    if (info.size === 0 || info.size > MAX_SECRET_BYTES) throw new Error("Invalid local credential size");
    return readFileSync(fd, "utf8");
  } catch {
    throw fixedError();
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* Do not expose raw filesystem errors. */
      }
    }
  }
}

export function deleteFileSecret(ref: string): boolean {
  // Validate before any filesystem work, including the absent-directory case.
  if (!REF_PATTERN.test(ref)) throw fixedError();
  try {
    const path = pathForRef(ref, secretDirectory(false));
    assertSecretFile(lstatSync(path));
    unlinkSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw fixedError();
  }
}
