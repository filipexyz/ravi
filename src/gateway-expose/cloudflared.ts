// Pinned cloudflared: download, verify, install and locate. The tunnel runner
// (`ravi gateway tunnel-run`) only ever starts the binary this module put in
// `~/.ravi/bin/cloudflared-<version>`, or one the operator named explicitly
// (reported `verified: false`). Normative: `.ravi/specs/sandbox/tunnel-runner`.
//
// The download is checked against the SHA-256 recorded here BEFORE anything
// is extracted, in a fresh directory that is removed on every outcome. The
// extracted executable is then checked against its own pinned SHA-256 and, on
// darwin, against Cloudflare's Developer ID signature (`codesign --verify`
// with a designated requirement pinning the Team ID) before it is ever run;
// only after its `--version` matched the pin is it renamed into place, so a
// failed install leaves nothing behind. Redirects are followed by hand and
// only to the GitHub release hosts. Reuse and `locateCloudflared` re-check
// the installed binary's SHA-256.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { logger } from "../utils/logger.js";
import { getRaviStateDir } from "../utils/paths.js";

const log = logger.child("cloudflared");

/**
 * The pinned release. Hashes copied on 2026-10-13 from the GitHub release API
 * (`api.github.com/repos/cloudflare/cloudflared/releases`, asset `digest`);
 * the Linux values also equal the release notes' "SHA256 Checksums". The
 * darwin `.tgz` values in the release notes differ from the served bytes for
 * every recent release; see the spec RUNBOOK §Pinned release.
 */
export const CLOUDFLARED_VERSION = "2026.9.1";

/**
 * Cloudflare's Apple Developer ID Team ID, pinned in the designated
 * requirement `codesign --verify` checks on darwin. NOT pinned yet: a human
 * reads it from a downloaded copy (`codesign -dv --verbose=4 cloudflared`,
 * `TeamIdentifier=`) and sets it here (RUNBOOK §Bumping the pin). While it is
 * null a darwin install refuses unless `RAVI_CLOUDFLARED_SKIP_CODESIGN=1`.
 */
export const CLOUDFLARE_DEVELOPER_TEAM_ID: string | null = null;
export const CLOUDFLARED_SKIP_CODESIGN_ENV = "RAVI_CLOUDFLARED_SKIP_CODESIGN";
/** Accept a darwin binary whose own SHA-256 is not pinned yet (`binarySha256: null`). */
export const CLOUDFLARED_SKIP_BINARY_PIN_ENV = "RAVI_CLOUDFLARED_SKIP_BINARY_PIN";

export type CloudflaredPlatformKey = "darwin-arm64" | "darwin-amd64" | "linux-amd64" | "linux-arm64";

export interface CloudflaredAsset {
  url: string;
  /** SHA-256 of the downloaded bytes (GitHub's asset `digest`). */
  sha256: string;
  /** `tgz`: a gzip tar holding `cloudflared`; `binary`: the executable itself. */
  archive: "tgz" | "binary";
  /**
   * SHA-256 of the executable itself (equal to `sha256` for a bare binary).
   * Needs the extracted bytes, so a human computes it at bump time; `null`
   * means not pinned yet: install and locate refuse unless
   * `RAVI_CLOUDFLARED_SKIP_BINARY_PIN=1`.
   */
  binarySha256: string | null;
}

const RELEASE_BASE = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}`;

export const CLOUDFLARED_ASSETS: Readonly<Record<CloudflaredPlatformKey, CloudflaredAsset>> = Object.freeze({
  "darwin-arm64": {
    url: `${RELEASE_BASE}/cloudflared-darwin-arm64.tgz`,
    sha256: "c27ab8fd0aa489449e3d201eb02f957ef460a13b613662928b1b23394bf1bcfe",
    archive: "tgz",
    binarySha256: null,
  },
  "darwin-amd64": {
    url: `${RELEASE_BASE}/cloudflared-darwin-amd64.tgz`,
    sha256: "ff0d3b51d5ff70eceef89d6b32145fee985018a2174596a5dbe405e2766e2ac4",
    archive: "tgz",
    binarySha256: null,
  },
  "linux-amd64": {
    url: `${RELEASE_BASE}/cloudflared-linux-amd64`,
    sha256: "03f1f25d1cc93b9ad6c60569d44060bc4f17ed97075760ed8cfca4b12dcd68cc",
    archive: "binary",
    binarySha256: "03f1f25d1cc93b9ad6c60569d44060bc4f17ed97075760ed8cfca4b12dcd68cc",
  },
  "linux-arm64": {
    url: `${RELEASE_BASE}/cloudflared-linux-arm64`,
    sha256: "3d97437c71848bd8df68041e12436b484a661d95073ea1937f01a845ce88faa3",
    archive: "binary",
    binarySha256: "3d97437c71848bd8df68041e12436b484a661d95073ea1937f01a845ce88faa3",
  },
});

/** Hosts a release download may be served from; any other redirect target is refused. */
export const CLOUDFLARED_DOWNLOAD_HOSTS: ReadonlySet<string> = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);
export const CLOUDFLARED_MAX_DOWNLOAD_BYTES = 96 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const INSTALL_MODE = 0o700;

export type CloudflaredInstallErrorCode =
  | "unsupported_platform"
  | "download_failed"
  | "redirect_refused"
  | "too_large"
  | "checksum_mismatch"
  | "archive_invalid"
  | "version_mismatch"
  | "binary_mismatch"
  | "binary_unpinned"
  | "codesign_failed"
  | "codesign_unpinned"
  | "not_found";

export class CloudflaredInstallError extends Error {
  constructor(
    readonly code: CloudflaredInstallErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CloudflaredInstallError";
  }
}

export function cloudflaredPlatformKey(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): CloudflaredPlatformKey {
  const cpu = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : null;
  if ((platform === "darwin" || platform === "linux") && cpu) return `${platform}-${cpu}`;
  throw new CloudflaredInstallError(
    "unsupported_platform",
    `No pinned cloudflared ${CLOUDFLARED_VERSION} build for ${platform}-${arch}; supported: ${Object.keys(CLOUDFLARED_ASSETS).join(", ")}. The gateway tunnel is not available on this platform.`,
  );
}

export function cloudflaredBinDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(getRaviStateDir(env), "bin");
}

export function pinnedCloudflaredPath(binDir: string = cloudflaredBinDir()): string {
  return join(binDir, `cloudflared-${CLOUDFLARED_VERSION}`);
}

export interface CommandOutput {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type CloudflaredFetch = (url: string, init: { redirect: "manual"; signal?: AbortSignal }) => Promise<Response>;

export interface InstallCloudflaredDeps {
  fetch?: CloudflaredFetch;
  platform?: NodeJS.Platform;
  arch?: string;
  binDir?: string;
  /** Runs `<path> --version`; tests inject it. */
  runVersion?: (path: string) => CommandOutput;
  /** Runs `codesign <args>` (darwin); tests inject it. */
  runCodesign?: (args: string[]) => CommandOutput;
  /** Tests only: the Team ID to require instead of `CLOUDFLARE_DEVELOPER_TEAM_ID`. */
  codesignTeamId?: string | null;
  /** Read for the `RAVI_CLOUDFLARED_SKIP_*` overrides. */
  env?: NodeJS.ProcessEnv;
  /** Tests only: assets whose bytes they can produce. */
  assets?: Readonly<Record<CloudflaredPlatformKey, CloudflaredAsset>>;
}

export interface InstalledCloudflared {
  path: string;
  version: string;
  platform: CloudflaredPlatformKey;
  sha256: string;
  /** True when the pinned binary was already installed and passed the version check. */
  reused: boolean;
}

export async function installCloudflared(deps: InstallCloudflaredDeps = {}): Promise<InstalledCloudflared> {
  const key = cloudflaredPlatformKey(deps.platform, deps.arch);
  const asset = (deps.assets ?? CLOUDFLARED_ASSETS)[key];
  const binDir = deps.binDir ?? cloudflaredBinDir();
  const target = pinnedCloudflaredPath(binDir);
  const runVersion = deps.runVersion ?? defaultRunVersion;
  const env = deps.env ?? process.env;
  const teamId = deps.codesignTeamId === undefined ? CLOUDFLARE_DEVELOPER_TEAM_ID : deps.codesignTeamId;
  // Placeholders refuse before anything is downloaded or run (reuse included).
  assertPinsConfigured(asset, key, env, teamId);

  // Reuse only a binary whose bytes still match the pin (re-checked before it is run).
  if (isPrivateRegularFile(target) && binaryPinMatches(target, asset, key, env) && versionMatches(runVersion(target))) {
    return { path: target, version: CLOUDFLARED_VERSION, platform: key, sha256: asset.sha256, reused: true };
  }

  mkdirSync(binDir, { recursive: true, mode: INSTALL_MODE });
  chmodSync(binDir, INSTALL_MODE);
  const workDir = mkdtempSync(join(binDir, ".cloudflared-install-"));
  try {
    chmodSync(workDir, INSTALL_MODE);
    const downloaded = await download(asset.url, deps.fetch ?? (globalThis.fetch as CloudflaredFetch));
    const actual = createHash("sha256").update(downloaded).digest("hex");
    if (actual !== asset.sha256) {
      throw new CloudflaredInstallError(
        "checksum_mismatch",
        `cloudflared ${CLOUDFLARED_VERSION} (${key}) checksum mismatch: expected ${asset.sha256}, got ${actual}. Nothing was installed.`,
      );
    }
    const binary = asset.archive === "tgz" ? extractCloudflaredFromTgz(downloaded) : downloaded;
    assertBinaryPin(binary, asset, key);
    const staged = join(workDir, "cloudflared");
    writeFileSync(staged, binary, { mode: INSTALL_MODE });
    chmodSync(staged, INSTALL_MODE);
    if (key.startsWith("darwin")) {
      assertCodesign(staged, {
        teamId,
        runCodesign: deps.runCodesign ?? defaultRunCodesign,
      });
    }
    const output = runVersion(staged);
    if (!versionMatches(output)) {
      throw new CloudflaredInstallError(
        "version_mismatch",
        `The downloaded cloudflared did not report version ${CLOUDFLARED_VERSION} (exit ${output.status}). Nothing was installed.`,
      );
    }
    renameSync(staged, target);
    chmodSync(target, INSTALL_MODE);
    return { path: target, version: CLOUDFLARED_VERSION, platform: key, sha256: asset.sha256, reused: false };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

export type LocatedCloudflared =
  | { found: true; path: string; verified: true; source: "pinned"; version: string }
  /** The pinned install, accepted with `RAVI_CLOUDFLARED_SKIP_BINARY_PIN=1` while its SHA-256 is not pinned. */
  | { found: true; path: string; verified: false; source: "pinned"; version: string }
  | { found: true; path: string; verified: false; source: "explicit"; version: null }
  | {
      found: false;
      reason: "not_installed" | "explicit_invalid" | "binary_mismatch" | "binary_unpinned" | "unsupported_platform";
      path: string;
    };

export interface LocateCloudflaredOptions {
  explicitPath?: string;
  binDir?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  /** Tests only. */
  assets?: Readonly<Record<CloudflaredPlatformKey, CloudflaredAsset>>;
}

/**
 * The pinned install when present, private to this user and still matching
 * its pinned SHA-256; an explicit path is accepted but never verified.
 */
export function locateCloudflared(options: LocateCloudflaredOptions = {}): LocatedCloudflared {
  const explicit = options.explicitPath?.trim();
  if (explicit) {
    if (!isAbsolute(explicit) || !isExecutableFile(explicit)) {
      return { found: false, reason: "explicit_invalid", path: explicit };
    }
    return { found: true, path: explicit, verified: false, source: "explicit", version: null };
  }
  const pinned = pinnedCloudflaredPath(options.binDir ?? cloudflaredBinDir());
  if (!isPrivateRegularFile(pinned)) return { found: false, reason: "not_installed", path: pinned };
  let key: CloudflaredPlatformKey;
  try {
    key = cloudflaredPlatformKey(options.platform, options.arch);
  } catch {
    return { found: false, reason: "unsupported_platform", path: pinned };
  }
  const asset = (options.assets ?? CLOUDFLARED_ASSETS)[key];
  if (asset.binarySha256 === null) {
    if ((options.env ?? process.env)[CLOUDFLARED_SKIP_BINARY_PIN_ENV] !== "1") {
      log.error("cloudflared binary sha256 not pinned yet; refusing the installed binary", { platform: key });
      return { found: false, reason: "binary_unpinned", path: pinned };
    }
    log.warn(`cloudflared binary sha256 not pinned yet; accepted by ${CLOUDFLARED_SKIP_BINARY_PIN_ENV}=1`, {
      platform: key,
    });
    return { found: true, path: pinned, verified: false, source: "pinned", version: CLOUDFLARED_VERSION };
  }
  if (fileSha256(pinned) !== asset.binarySha256) {
    log.error("Installed cloudflared does not match its pinned sha256; refusing it", { path: pinned });
    return { found: false, reason: "binary_mismatch", path: pinned };
  }
  return { found: true, path: pinned, verified: true, source: "pinned", version: CLOUDFLARED_VERSION };
}

function fileSha256(path: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

/** Reuse check: true when the installed bytes equal the pin (or the pin is explicitly skipped). */
function binaryPinMatches(
  path: string,
  asset: CloudflaredAsset,
  key: CloudflaredPlatformKey,
  env: NodeJS.ProcessEnv,
): boolean {
  if (asset.binarySha256 === null) return env[CLOUDFLARED_SKIP_BINARY_PIN_ENV] === "1";
  const matches = fileSha256(path) === asset.binarySha256;
  if (!matches) log.warn("Installed cloudflared does not match its pinned sha256; reinstalling", { platform: key });
  return matches;
}

/**
 * The placeholders (`binarySha256: null`, `CLOUDFLARE_DEVELOPER_TEAM_ID`
 * null on darwin) refuse unless their override is set to `1`.
 */
function assertPinsConfigured(
  asset: CloudflaredAsset,
  key: CloudflaredPlatformKey,
  env: NodeJS.ProcessEnv,
  teamId: string | null,
): void {
  if (asset.binarySha256 === null) {
    if (env[CLOUDFLARED_SKIP_BINARY_PIN_ENV] !== "1") {
      log.error("cloudflared binary sha256 not pinned yet", { platform: key });
      throw new CloudflaredInstallError(
        "binary_unpinned",
        `cloudflared binary sha256 not pinned yet for ${key} (RUNBOOK §Bumping the pin); set ${CLOUDFLARED_SKIP_BINARY_PIN_ENV}=1 to accept it unpinned. Nothing was installed.`,
      );
    }
    log.warn(`cloudflared binary sha256 not pinned yet; skipped by ${CLOUDFLARED_SKIP_BINARY_PIN_ENV}=1`, {
      platform: key,
    });
  }
  if (key.startsWith("darwin") && teamId === null) {
    log.error("codesign team id not pinned yet");
    if (env[CLOUDFLARED_SKIP_CODESIGN_ENV] !== "1") {
      throw new CloudflaredInstallError(
        "codesign_unpinned",
        `codesign team id not pinned yet (CLOUDFLARE_DEVELOPER_TEAM_ID, RUNBOOK §Bumping the pin); set ${CLOUDFLARED_SKIP_CODESIGN_ENV}=1 to install without the signature check. Nothing was installed.`,
      );
    }
    log.warn(`cloudflared signature check skipped by ${CLOUDFLARED_SKIP_CODESIGN_ENV}=1`);
  }
}

function assertBinaryPin(binary: Uint8Array, asset: CloudflaredAsset, key: CloudflaredPlatformKey): void {
  if (asset.binarySha256 === null) return; // allowed by assertPinsConfigured
  const actual = createHash("sha256").update(binary).digest("hex");
  if (actual !== asset.binarySha256) {
    throw new CloudflaredInstallError(
      "binary_mismatch",
      `cloudflared ${CLOUDFLARED_VERSION} (${key}) executable checksum mismatch: expected ${asset.binarySha256}, got ${actual}. Nothing was installed.`,
    );
  }
}

/** The designated requirement: an Apple-anchored Developer ID leaf issued to Cloudflare's Team ID. */
export function cloudflaredCodesignArgs(path: string, teamId: string): string[] {
  return ["--verify", "--strict", `-R=anchor apple generic and certificate leaf[subject.OU] = "${teamId}"`, path];
}

function assertCodesign(
  path: string,
  options: { teamId: string | null; runCodesign: (args: string[]) => CommandOutput },
): void {
  if (options.teamId === null) return; // allowed by assertPinsConfigured
  if (!/^[A-Z0-9]{10}$/.test(options.teamId)) {
    throw new CloudflaredInstallError(
      "codesign_unpinned",
      "CLOUDFLARE_DEVELOPER_TEAM_ID is not a 10-character Team ID",
    );
  }
  const result = options.runCodesign(cloudflaredCodesignArgs(path, options.teamId));
  if (result.status !== 0) {
    throw new CloudflaredInstallError(
      "codesign_failed",
      `cloudflared is not signed by Cloudflare's Developer ID (${options.teamId}): codesign exit ${result.status}: ${result.stderr.trim().slice(0, 300)}. Nothing was installed.`,
    );
  }
}

export function versionMatches(output: CommandOutput): boolean {
  return (
    output.status === 0 && new RegExp(`\\bversion ${CLOUDFLARED_VERSION.replace(/\./g, "\\.")}\\b`).test(output.stdout)
  );
}

async function download(url: string, fetchImpl: CloudflaredFetch): Promise<Uint8Array> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    assertDownloadUrl(current);
    let response: Response;
    try {
      response = await fetchImpl(current, { redirect: "manual", signal: AbortSignal.timeout(120_000) });
    } catch (error) {
      throw new CloudflaredInstallError(
        "download_failed",
        `cloudflared download failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => {});
      if (!location)
        throw new CloudflaredInstallError("download_failed", "cloudflared download redirect without Location");
      current = new URL(location, current).toString();
      continue;
    }
    if (!response.ok || !response.body) {
      throw new CloudflaredInstallError("download_failed", `cloudflared download failed: HTTP ${response.status}`);
    }
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > CLOUDFLARED_MAX_DOWNLOAD_BYTES) throw tooLarge();
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > CLOUDFLARED_MAX_DOWNLOAD_BYTES) {
        await reader.cancel().catch(() => {});
        throw tooLarge();
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  }
  throw new CloudflaredInstallError("download_failed", "cloudflared download: too many redirects");
}

function assertDownloadUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CloudflaredInstallError("redirect_refused", "cloudflared download URL is invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password || !CLOUDFLARED_DOWNLOAD_HOSTS.has(url.hostname)) {
    throw new CloudflaredInstallError(
      "redirect_refused",
      `cloudflared download refused: ${url.protocol}//${url.hostname} is not a GitHub release host`,
    );
  }
}

const tooLarge = () =>
  new CloudflaredInstallError("too_large", `cloudflared download exceeds ${CLOUDFLARED_MAX_DOWNLOAD_BYTES} bytes`);

const TAR_MEMBER_NAMES = new Set(["cloudflared", "./cloudflared"]);

/** Reads the `cloudflared` regular-file member from a gzip tar; no other entry is ever written to disk. */
export function extractCloudflaredFromTgz(archive: Uint8Array): Uint8Array {
  let tar: Uint8Array;
  try {
    tar = gunzipSync(archive);
  } catch {
    throw new CloudflaredInstallError("archive_invalid", "cloudflared archive is not gzip");
  }
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const sizeField = tarString(header, 124, 12).trim();
    const size = /^[0-7]+$/.test(sizeField) ? Number.parseInt(sizeField, 8) : Number.NaN;
    const dataStart = offset + 512;
    if (!Number.isSafeInteger(size) || dataStart + size > tar.length) {
      throw new CloudflaredInstallError("archive_invalid", "cloudflared archive has a truncated or invalid entry");
    }
    if (TAR_MEMBER_NAMES.has(fullName)) {
      const type = header[156];
      if (type !== 0x30 && type !== 0) {
        throw new CloudflaredInstallError("archive_invalid", "cloudflared archive member is not a regular file");
      }
      return tar.slice(dataStart, dataStart + size);
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  throw new CloudflaredInstallError("archive_invalid", "cloudflared archive does not contain `cloudflared`");
}

function tarString(header: Uint8Array, start: number, length: number): string {
  const field = header.subarray(start, start + length);
  const end = field.indexOf(0);
  return Buffer.from(end === -1 ? field : field.subarray(0, end)).toString("utf8");
}

function isPrivateRegularFile(path: string): boolean {
  try {
    const stat = lstatSync(path);
    const uid = process.getuid?.();
    return (
      stat.isFile() && (stat.mode & 0o077) === 0 && (stat.mode & 0o100) !== 0 && (uid === undefined || stat.uid === uid)
    );
  } catch {
    return false;
  }
}

function isExecutableFile(path: string): boolean {
  try {
    const stat = statSync(path);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function defaultRunCodesign(args: string[]): CommandOutput {
  const result = spawnSync("/usr/bin/codesign", args, {
    encoding: "utf8",
    timeout: 30_000,
    env: { PATH: "/usr/bin:/bin" },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? result.error?.message ?? "" };
}

function defaultRunVersion(path: string): CommandOutput {
  const result = spawnSync(path, ["--version"], {
    encoding: "utf8",
    timeout: 15_000,
    env: { PATH: process.env.PATH ?? "" },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
