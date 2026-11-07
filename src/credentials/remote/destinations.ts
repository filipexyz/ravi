import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { isIP } from "node:net";
import { dirname, isAbsolute, join, normalize, parse } from "node:path";
import { z } from "zod";
import { getRaviStateDir } from "../../utils/paths.js";

export class RemoteDestinationError extends Error {
  constructor(
    readonly code: "DESTINATION_INVALID" | "DESTINATION_EXISTS" | "DESTINATION_UNAVAILABLE" | "SSH_CONFIG_UNSUPPORTED",
  ) {
    super(code);
    this.name = "RemoteDestinationError";
  }
}

const token = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const destinationId = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const user = /^[a-z_][a-z0-9_-]{0,31}$/;
const envKey = /^[A-Z_][A-Z0-9_]{0,127}$/;
const literalPath = (value: string) =>
  isAbsolute(value) &&
  normalize(value) === value &&
  /^\/[a-zA-Z0-9_./-]+$/.test(value) &&
  !value.split("/").some((part) => part === "." || part === "..");
const literalHost = (value: string) =>
  isIP(value) !== 0 ||
  (/^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(value) &&
    value
      .split(".")
      .every((part) => part.length > 0 && part.length <= 63 && !part.startsWith("-") && !part.endsWith("-")));

/** Only this fixed-size SSH public-key encoding is supported in the first profile. */
function ed25519HostKey(value: string): boolean {
  const match = /^ssh-ed25519 ([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return false;
  const blob = Buffer.from(match[1]!, "base64");
  return (
    blob.toString("base64") === match[1] &&
    blob.length === 51 &&
    blob.readUInt32BE(0) === 11 &&
    blob.subarray(4, 15).toString("ascii") === "ssh-ed25519" &&
    blob.readUInt32BE(15) === 32
  );
}

const destinationInputSchema = z
  .object({
    id: z.string().regex(destinationId),
    label: z
      .string()
      .min(1)
      .max(120)
      .refine((value) => !/[\u0000-\u001f\u007f]/.test(value)),
    sshAlias: z.string().regex(token),
    host: z.string().refine(literalHost),
    port: z.number().int().min(1).max(65535),
    user: z
      .string()
      .regex(user)
      .refine((value) => value !== "root"),
    identityFile: z.string().max(1024).refine(literalPath),
    hostKey: z.string().max(128).refine(ed25519HostKey),
    envPath: z.string().max(1024).refine(literalPath),
    remoteTarget: z.string().regex(token),
    keys: z
      .array(z.string().regex(envKey))
      .min(1)
      .max(64)
      .refine((keys) => new Set(keys).size === keys.length),
    profile: z.literal("dotenv-single-line-v1"),
  })
  .strict();
const destinationSchema = destinationInputSchema.extend({ version: z.string().uuid() }).strict();
export type DestinationInput = z.infer<typeof destinationInputSchema>;
export type Destination = z.infer<typeof destinationSchema>;
export interface DestinationRegistryOptions {
  env?: NodeJS.ProcessEnv;
}
export interface SshAliasCandidate {
  alias: string;
  host: string;
  user: string | null;
  port: number;
}

export function validateDestinationInput(input: unknown): DestinationInput {
  const result = destinationInputSchema.safeParse(input);
  if (!result.success) throw new RemoteDestinationError("DESTINATION_INVALID");
  return result.data;
}
export function validateDestination(input: unknown): Destination {
  const result = destinationSchema.safeParse(input);
  if (!result.success) throw new RemoteDestinationError("DESTINATION_INVALID");
  return result.data;
}

function assertOwner(info: Stats): void {
  if (process.getuid && info.uid !== process.getuid()) throw new RemoteDestinationError("DESTINATION_UNAVAILABLE");
}

/** No path component may redirect traversal, including a symlink above the state directory. */
export function assertNoPathLinks(path: string): void {
  if (!isAbsolute(path) || normalize(path) !== path) throw new RemoteDestinationError("DESTINATION_UNAVAILABLE");
  let current = parse(path).root;
  for (const part of path.slice(current.length).split("/").filter(Boolean)) {
    current = join(current, part);
    const info = lstatSync(current);
    if (info.isSymbolicLink()) throw new RemoteDestinationError("DESTINATION_UNAVAILABLE");
    if (info.isDirectory()) {
      const trustedOwner = !process.getuid || info.uid === 0 || info.uid === process.getuid();
      const trustedStickyRoot = info.uid === 0 && (info.mode & 0o1000) !== 0;
      if (!trustedOwner || ((info.mode & 0o022) !== 0 && !trustedStickyRoot))
        throw new RemoteDestinationError("DESTINATION_UNAVAILABLE");
    }
  }
}

function registryDirectory(create: boolean, options: DestinationRegistryOptions): string {
  const state = getRaviStateDir(options.env);
  if (!isAbsolute(state) || normalize(state) !== state) throw new RemoteDestinationError("DESTINATION_UNAVAILABLE");
  if (create) {
    assertNoPathLinks(dirname(state));
    try {
      mkdirSync(state, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  assertNoPathLinks(state);
  const stateInfo = lstatSync(state);
  assertOwner(stateInfo);
  if (!stateInfo.isDirectory() || (stateInfo.mode & 0o022) !== 0)
    throw new RemoteDestinationError("DESTINATION_UNAVAILABLE");
  const directory = join(state, "credential-destinations");
  if (create) {
    try {
      mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const info = lstatSync(directory);
  assertOwner(info);
  if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o777) !== 0o700)
    throw new RemoteDestinationError("DESTINATION_UNAVAILABLE");
  return directory;
}

function readDestinationFile(path: string): Destination {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    assertOwner(info);
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 || info.size > 16_384)
      throw new RemoteDestinationError("DESTINATION_UNAVAILABLE");
    return validateDestination(JSON.parse(readFileSync(fd, "utf8")));
  } finally {
    closeSync(fd);
  }
}

export function getDestination(id: string, options: DestinationRegistryOptions = {}): Destination | null {
  if (!destinationId.test(id)) throw new RemoteDestinationError("DESTINATION_INVALID");
  try {
    const destination = readDestinationFile(join(registryDirectory(false, options), `${id}.json`));
    if (destination.id !== id) throw new RemoteDestinationError("DESTINATION_UNAVAILABLE");
    return destination;
  } catch (error) {
    // no-cause: Registry diagnostics may disclose protected paths or malformed stored content.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new RemoteDestinationError("DESTINATION_UNAVAILABLE");
  }
}

export function listDestinations(options: DestinationRegistryOptions = {}): Destination[] {
  try {
    const directory = registryDirectory(false, options);
    return readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => {
        const destination = readDestinationFile(join(directory, name));
        if (`${destination.id}.json` !== name) throw new RemoteDestinationError("DESTINATION_UNAVAILABLE");
        return destination;
      });
  } catch (error) {
    // no-cause: Public registry failures never include filesystem diagnostics or stored JSON.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new RemoteDestinationError("DESTINATION_UNAVAILABLE");
  }
}

/** Internal full metadata; callers must omit identityFile from public projections. */
export function registerDestination(input: DestinationInput, options: DestinationRegistryOptions = {}): Destination {
  const destination: Destination = { ...validateDestinationInput(input), version: randomUUID() };
  let temporary: string | undefined;
  let fd: number | undefined;
  try {
    const directory = registryDirectory(true, options);
    temporary = join(directory, `.${randomUUID()}.tmp`);
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, `${JSON.stringify(destination)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    // link is an atomic no-replace publish, unlike rename over a prior destination.
    linkSync(temporary, join(directory, `${destination.id}.json`));
    unlinkSync(temporary);
    temporary = undefined;
    const directoryFd = openSync(directory, constants.O_RDONLY);
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
    return destination;
  } catch (error) {
    // no-cause: Do not expose paths, JSON or operating-system errors through metadata registration.
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new RemoteDestinationError("DESTINATION_EXISTS");
    throw new RemoteDestinationError("DESTINATION_UNAVAILABLE");
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // no-cause: Cleanup never replaces the safe registry outcome.
      }
    }
    if (temporary) {
      try {
        unlinkSync(temporary);
      } catch {
        // no-cause: Best-effort cleanup retains the fixed registry error.
      }
    }
  }
}

const ignoredPersonalDirectives = new Set([
  "identityfile",
  "identityagent",
  "addkeystoagent",
  "usekeychain",
  "forwardagent",
  "stricthostkeychecking",
]);
const supportedDirectives = new Set(["host", "hostname", "user", "port"]);
const forbiddenDirectives = new Set([
  "match",
  "include",
  "proxycommand",
  "proxyjump",
  "knownhostscommand",
  "localcommand",
  "remotecommand",
]);

/** Deliberately restricted SSH grammar; this does not execute or inherit personal SSH settings. */
export function discoverSshAliases(configText: string): SshAliasCandidate[] {
  if (
    Buffer.byteLength(configText, "utf8") > 65_536 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(configText)
  )
    throw new RemoteDestinationError("SSH_CONFIG_UNSUPPORTED");
  const entries: { patterns: string[]; key: string; value: string }[] = [];
  const aliases = new Set<string>();
  let patterns = ["*"];
  for (const raw of configText.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([a-zA-Z][a-zA-Z0-9]*)\s*(?:=\s*|\s+)(.*)$/.exec(line);
    if (!match) throw new RemoteDestinationError("SSH_CONFIG_UNSUPPORTED");
    const key = match[1]!.toLowerCase();
    if (forbiddenDirectives.has(key) || (!supportedDirectives.has(key) && !ignoredPersonalDirectives.has(key)))
      throw new RemoteDestinationError("SSH_CONFIG_UNSUPPORTED");
    if (ignoredPersonalDirectives.has(key)) continue;
    const value = match[2]!.replace(/\s+#.*$/, "").trim();
    if (!value || /["'\\$%~`]/.test(value)) throw new RemoteDestinationError("SSH_CONFIG_UNSUPPORTED");
    if (key === "host") {
      patterns = value.split(/\s+/);
      if (!patterns.every((pattern) => pattern === "*" || token.test(pattern)))
        throw new RemoteDestinationError("SSH_CONFIG_UNSUPPORTED");
      for (const pattern of patterns) if (pattern !== "*") aliases.add(pattern);
    } else {
      if (
        (key === "hostname" && !literalHost(value)) ||
        (key === "user" && !user.test(value)) ||
        (key === "port" && (!/^\d{1,5}$/.test(value) || Number(value) < 1 || Number(value) > 65535))
      )
        throw new RemoteDestinationError("SSH_CONFIG_UNSUPPORTED");
      entries.push({ patterns: [...patterns], key, value });
    }
  }
  return [...aliases].sort().map((alias) => {
    const resolved = new Map<string, string>();
    for (const entry of entries)
      if (entry.patterns.some((pattern) => pattern === "*" || pattern === alias) && !resolved.has(entry.key))
        resolved.set(entry.key, entry.value);
    return {
      alias,
      host: resolved.get("hostname") ?? alias,
      user: resolved.get("user") ?? null,
      port: Number(resolved.get("port") ?? 22),
    };
  });
}
