import { spawn, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { constants, lstatSync, mkdtempSync, openSync, closeSync, fstatSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { assertNoPathLinks, validateDestination, type Destination } from "./destinations.js";

const REMOTE_COMMAND = "/usr/local/libexec/ravi-credential-writer";
const MAX_OUTPUT_BYTES = 8192;
const MAX_SECRET_BYTES = 8192;
const HEX = /^[a-f0-9]{64}$/;
const REQUEST = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const receiverCodes = [
  "INVALID_REQUEST",
  "FILE_TOO_LARGE",
  "REQUEST_LIMIT",
  "INVALID_POLICY",
  "UNSAFE_PATH",
  "TARGET_NOT_ALLOWED",
  "KEY_NOT_ALLOWED",
  "KEY_EXISTS",
  "UNSUPPORTED_FORMAT",
  "VERSION_CONFLICT",
  "REQUEST_CONFLICT",
  "REQUEST_EXPIRED",
  "INVALID_NONCE",
  "SECRET_INVALID",
  "LOCK_TIMEOUT",
  "READ_TIMEOUT",
  "IO_ERROR",
  "UNCERTAIN",
] as const;
export type RemoteCredentialErrorCode =
  | (typeof receiverCodes)[number]
  | "REMOTE_UNAVAILABLE"
  | "REMOTE_PROTOCOL_ERROR"
  | "REMOTE_UNCERTAIN"
  | "REMOTE_AUTHORIZATION_DENIED";
export class RemoteCredentialError extends Error {
  constructor(readonly code: RemoteCredentialErrorCode) {
    super(code);
    this.name = "RemoteCredentialError";
  }
}
export type RemotePreflight = { v: 1; status: "ready"; version: string };
export type RemoteStored = { v: 1; status: "stored"; receipt: string; version: string };
export type RemoteRequestStatus = RemoteStored | { v: 1; status: "not_found" | "uncertain" };
export interface RemoteStoreInput {
  requestId: string;
  key: string;
  expectedVersion: string;
  expiresAt: number;
  destinationVersion: string;
}
export interface RemoteSshProcess extends EventEmitter {
  stdin: Writable;
  stdout: Readable;
  kill(signal?: NodeJS.Signals): boolean;
}
export type RemoteSshSpawn = (command: string, args: readonly string[], options: SpawnOptions) => RemoteSshProcess;
export interface RemoteSshOptions {
  /** Internal test injection only; never accepted from a command or intake payload. */
  spawn?: RemoteSshSpawn;
  /** Tests may shorten, never extend the production total deadline. */
  timeoutMs?: number;
}
export interface RemoteStoreOptions extends RemoteSshOptions {
  beforeCommit: () => void | Promise<void>;
}

function validateKey(destination: Destination, key: string): void {
  if (!/^[A-Z_][A-Z0-9_]{0,127}$/.test(key) || !destination.keys.includes(key))
    throw new RemoteCredentialError("KEY_NOT_ALLOWED");
}
function validateId(id: string): void {
  if (!REQUEST.test(id)) throw new RemoteCredentialError("INVALID_REQUEST");
}
function ownPrivateKey(path: string): void {
  assertNoPathLinks(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      ![0o400, 0o600].includes(info.mode & 0o777) ||
      info.size < 1 ||
      info.size > 65_536 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new Error("Unsafe transport identity");
    const parent = lstatSync(dirname(path));
    if (!parent.isDirectory() || (parent.mode & 0o022) !== 0 || (process.getuid && parent.uid !== process.getuid()))
      throw new Error("Unsafe transport identity directory");
  } finally {
    closeSync(fd);
  }
}
function exactObject(value: unknown, fields: string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === fields.length && keys.every((key) => fields.includes(key));
}
function storedResponse(value: unknown): RemoteStored | null {
  if (
    !exactObject(value, ["v", "status", "receipt", "version"]) ||
    value.v !== 1 ||
    value.status !== "stored" ||
    typeof value.receipt !== "string" ||
    typeof value.version !== "string" ||
    !HEX.test(value.receipt) ||
    !HEX.test(value.version)
  )
    return null;
  return { v: 1, status: "stored", receipt: value.receipt, version: value.version };
}
function receiverFailure(value: unknown): RemoteCredentialError | null {
  if (
    !exactObject(value, ["v", "status", "code"]) ||
    value.v !== 1 ||
    value.status !== "error" ||
    typeof value.code !== "string" ||
    !(receiverCodes as readonly string[]).includes(value.code)
  )
    return null;
  return new RemoteCredentialError(value.code as RemoteCredentialErrorCode);
}
function safeDestination(value: Destination): Destination {
  try {
    return validateDestination(value);
  } catch {
    // no-cause: Destination validation must not expose raw metadata through the transport boundary.
    throw new RemoteCredentialError("INVALID_REQUEST");
  }
}

export async function preflightRemote(
  destination: Destination,
  key: string,
  options: RemoteSshOptions = {},
): Promise<RemotePreflight> {
  const dest = safeDestination(destination);
  validateKey(dest, key);
  return exchange(
    dest,
    { v: 1, op: "preflight", target: dest.remoteTarget, envPath: dest.envPath, profile: dest.profile, key },
    "preflight",
    options,
  ) as Promise<RemotePreflight>;
}
export async function remoteRequestStatus(
  destination: Destination,
  requestId: string,
  options: RemoteSshOptions = {},
): Promise<RemoteRequestStatus> {
  const dest = safeDestination(destination);
  validateId(requestId);
  return exchange(
    dest,
    { v: 1, op: "status", target: dest.remoteTarget, envPath: dest.envPath, profile: dest.profile, requestId },
    "status",
    options,
  ) as Promise<RemoteRequestStatus>;
}
export async function storeRemoteSecret(
  destination: Destination,
  input: RemoteStoreInput,
  secret: string,
  options: RemoteStoreOptions,
): Promise<RemoteStored> {
  const dest = safeDestination(destination);
  validateKey(dest, input.key);
  validateId(input.requestId);
  if (
    !HEX.test(input.expectedVersion) ||
    input.destinationVersion !== dest.version ||
    !Number.isSafeInteger(input.expiresAt) ||
    input.expiresAt <= 0 ||
    typeof options?.beforeCommit !== "function"
  )
    throw new RemoteCredentialError("INVALID_REQUEST");
  if (
    typeof secret !== "string" ||
    !secret ||
    Buffer.byteLength(secret, "utf8") > MAX_SECRET_BYTES ||
    /[\u0000\r\n]/.test(secret) ||
    Buffer.from(secret, "utf8").toString("utf8") !== secret
  )
    throw new RemoteCredentialError("SECRET_INVALID");
  return exchange(
    dest,
    {
      v: 1,
      op: "prepare",
      target: dest.remoteTarget,
      envPath: dest.envPath,
      profile: dest.profile,
      requestId: input.requestId,
      key: input.key,
      expectedVersion: input.expectedVersion,
      expiresAt: input.expiresAt,
      destinationVersion: input.destinationVersion,
    },
    "store",
    options,
    { input, secret, beforeCommit: options.beforeCommit },
  ) as Promise<RemoteStored>;
}

async function exchange(
  destination: Destination,
  initial: object,
  mode: "preflight" | "status" | "store",
  options: RemoteSshOptions,
  store?: { input: RemoteStoreInput; secret: string; beforeCommit: () => void | Promise<void> },
): Promise<RemotePreflight | RemoteRequestStatus> {
  let temporary: string | undefined;
  let child: RemoteSshProcess | undefined;
  try {
    ownPrivateKey(destination.identityFile);
    temporary = mkdtempSync(join(tmpdir(), "ravi-credential-ssh-"));
    const knownHosts = join(temporary, "known_hosts");
    // HostKeyAlias is fixed and independent of DNS aliases; this file contains exactly one approved key.
    writeFileSync(knownHosts, `ravi-credential-destination ${destination.hostKey}\n`, { mode: 0o600, flag: "wx" });
    const args = [
      "-F",
      "none",
      "-S",
      "none",
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "ConnectionAttempts=1",
      "-o",
      "IdentityAgent=none",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "HostKeyAlias=ravi-credential-destination",
      "-o",
      `UserKnownHostsFile=${knownHosts}`,
      "-o",
      "GlobalKnownHostsFile=/dev/null",
      "-o",
      "UpdateHostKeys=no",
      "-o",
      "VerifyHostKeyDNS=no",
      "-o",
      "HostKeyAlgorithms=ssh-ed25519",
      "-o",
      "PasswordAuthentication=no",
      "-o",
      "KbdInteractiveAuthentication=no",
      "-o",
      "PreferredAuthentications=publickey",
      "-o",
      "ForwardAgent=no",
      "-o",
      "ForwardX11=no",
      "-o",
      "ClearAllForwardings=yes",
      "-o",
      "PermitLocalCommand=no",
      "-o",
      "ProxyCommand=none",
      "-o",
      "ProxyJump=none",
      "-o",
      "CanonicalizeHostname=no",
      "-o",
      "LogLevel=ERROR",
      "-i",
      destination.identityFile,
      "-p",
      String(destination.port),
      "-l",
      destination.user,
      "--",
      destination.host,
      REMOTE_COMMAND,
    ];
    const spawnImpl: RemoteSshSpawn =
      options.spawn ??
      ((command, argv, settings) => spawn(command, [...argv], settings) as unknown as RemoteSshProcess);
    child = spawnImpl("/usr/bin/ssh", args, {
      stdio: ["pipe", "pipe", "ignore"],
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" },
      cwd: temporary,
      windowsHide: true,
    });
    const process = child;
    return await new Promise<RemotePreflight | RemoteRequestStatus>((resolve, reject) => {
      let settled = false;
      let phase: "waiting" | "processing" | "committing" | "closing" = "waiting";
      let commitStarted = false;
      let outputBytes = 0;
      let pending = "";
      let result: RemotePreflight | RemoteRequestStatus | undefined;
      let closed = false;
      let exitCode: number | null = null;
      const decoder = new StringDecoder("utf8");
      const timeout = setTimeout(
        () => fail("REMOTE_UNAVAILABLE"),
        Math.max(1, Math.min(options.timeoutMs ?? 30_000, 30_000)),
      );
      const fail = (code: RemoteCredentialErrorCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        try {
          process.kill("SIGKILL");
        } catch {
          // no-cause: Killing a failed transport must not replace the fixed error with process diagnostics.
        }
        reject(new RemoteCredentialError(commitStarted ? "REMOTE_UNCERTAIN" : code));
      };
      const finishInput = () => {
        phase = "closing";
        if (!process.stdin.writableEnded) process.stdin.end();
      };
      const finishClosed = () => {
        if (settled || !closed || phase === "processing") return;
        if (exitCode !== 0 || phase !== "closing" || !result || pending || decoder.end()) {
          fail("REMOTE_UNAVAILABLE");
          return;
        }
        settled = true;
        clearTimeout(timeout);
        resolve(result);
      };
      const reauthorize = async () => {
        try {
          await store!.beforeCommit();
        } catch {
          // no-cause: Authorization callbacks may contain sensitive diagnostics; expose a fixed denial only.
          throw new RemoteCredentialError("REMOTE_AUTHORIZATION_DENIED");
        }
      };
      const frame = async (line: string, at: "waiting" | "committing") => {
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          // no-cause: JSON parser diagnostics can echo a remote payload or secret.
          throw new RemoteCredentialError("REMOTE_PROTOCOL_ERROR");
        }
        const failure = receiverFailure(value);
        if (failure) throw failure;
        if (mode === "preflight") {
          if (
            !exactObject(value, ["v", "status", "version"]) ||
            value.v !== 1 ||
            value.status !== "ready" ||
            typeof value.version !== "string" ||
            !HEX.test(value.version)
          )
            throw new RemoteCredentialError("REMOTE_PROTOCOL_ERROR");
          result = { v: 1, status: "ready", version: value.version };
          finishInput();
          return;
        }
        const stored = storedResponse(value);
        if (mode === "status") {
          if (stored) result = stored;
          else if (
            exactObject(value, ["v", "status"]) &&
            value.v === 1 &&
            (value.status === "not_found" || value.status === "uncertain")
          )
            result = { v: 1, status: value.status };
          else throw new RemoteCredentialError("REMOTE_PROTOCOL_ERROR");
          finishInput();
          return;
        }
        if (stored) {
          if (at === "waiting") await reauthorize();
          if (settled) return;
          if ([stored.receipt, stored.version].some((field) => field === store!.secret))
            throw new RemoteCredentialError("REMOTE_PROTOCOL_ERROR");
          result = stored;
          finishInput();
          return;
        }
        if (
          at !== "waiting" ||
          !exactObject(value, ["v", "status", "nonce"]) ||
          value.v !== 1 ||
          value.status !== "ready" ||
          typeof value.nonce !== "string" ||
          !HEX.test(value.nonce)
        )
          throw new RemoteCredentialError("REMOTE_PROTOCOL_ERROR");
        await reauthorize();
        if (settled) return;
        if (closed) throw new RemoteCredentialError("REMOTE_UNAVAILABLE");
        if (store!.input.expiresAt <= Date.now()) throw new RemoteCredentialError("REQUEST_EXPIRED");
        phase = "committing";
        commitStarted = true;
        process.stdin.end(`${JSON.stringify({ v: 1, op: "commit", nonce: value.nonce, secret: store!.secret })}\n`);
      };
      process.stdin.on("error", () => fail("REMOTE_UNAVAILABLE"));
      process.stdout.on("error", () => fail("REMOTE_UNAVAILABLE"));
      process.on("error", () => fail("REMOTE_UNAVAILABLE"));
      process.stdout.on("data", (chunk: Buffer | string) => {
        if (settled) return;
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes > MAX_OUTPUT_BYTES) {
          fail("REMOTE_PROTOCOL_ERROR");
          return;
        }
        pending += typeof chunk === "string" ? chunk : decoder.write(chunk);
        let newline = pending.indexOf("\n");
        while (newline !== -1) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          if ((phase !== "waiting" && phase !== "committing") || !line || line.includes("\r")) {
            fail("REMOTE_PROTOCOL_ERROR");
            return;
          }
          const at = phase;
          phase = "processing";
          void frame(line, at)
            .then(finishClosed)
            .catch((error: unknown) =>
              fail(error instanceof RemoteCredentialError ? error.code : "REMOTE_PROTOCOL_ERROR"),
            );
          newline = pending.indexOf("\n");
        }
      });
      process.on("close", (code: number | null) => {
        closed = true;
        exitCode = code;
        finishClosed();
      });
      process.stdin.write(`${JSON.stringify(initial)}\n`);
    });
  } catch (error) {
    // no-cause: Spawn/filesystem/stream diagnostics must never expose transport identity paths or secret input.
    if (error instanceof RemoteCredentialError) throw error;
    throw new RemoteCredentialError("REMOTE_UNAVAILABLE");
  } finally {
    if (store) store.secret = "";
    if (temporary) {
      try {
        rmSync(temporary, { recursive: true, force: true });
      } catch {
        // no-cause: This request's SSH metadata cleanup cannot leak filesystem diagnostics.
      }
    }
  }
}
