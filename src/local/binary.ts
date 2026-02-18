/**
 * nats-server binary manager
 *
 * Downloads and caches the nats-server binary from GitHub releases.
 */

import { existsSync, mkdirSync, chmodSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform, arch } from "node:os";
import { logger } from "../utils/logger.js";

const log = logger.child("binary");

const BIN_DIR = join(homedir(), ".ravi", "bin");
const BINARY_NAME = "nats-server";
const NATS_VERSION = "v2.10.24";
const REPO = "nats-io/nats-server";

function getPlatformArch(): { os: string; arch: string } {
  const p = platform();
  const a = arch();

  const osMap: Record<string, string> = {
    darwin: "darwin",
    linux: "linux",
    win32: "windows",
  };

  const archMap: Record<string, string> = {
    x64: "amd64",
    arm64: "arm64",
  };

  const mappedOs = osMap[p];
  const mappedArch = archMap[a];

  if (!mappedOs || !mappedArch) {
    throw new Error(`Unsupported platform: ${p}/${a}`);
  }

  return { os: mappedOs, arch: mappedArch };
}

function getBinaryPath(): string {
  return join(BIN_DIR, BINARY_NAME);
}

/**
 * Ensures the nats-server binary exists, downloading it if needed.
 * Returns the absolute path to the binary.
 */
export async function ensureNatsBinary(opts?: { onProgress?: (msg: string) => void }): Promise<string> {
  const binPath = getBinaryPath();

  if (existsSync(binPath)) {
    log.debug("nats-server binary already exists", { path: binPath });
    return binPath;
  }

  mkdirSync(BIN_DIR, { recursive: true });

  const { os: osName, arch: archName } = getPlatformArch();
  const ext = ".zip";

  // nats-server releases are zip archives containing a directory with the binary
  // e.g. nats-server-v2.10.24-darwin-arm64.zip → nats-server-v2.10.24-darwin-arm64/nats-server
  const assetName = `nats-server-${NATS_VERSION}-${osName}-${archName}${ext}`;
  const releaseUrl = `https://github.com/${REPO}/releases/download/${NATS_VERSION}/${assetName}`;

  const progress = opts?.onProgress || ((msg: string) => log.info(msg));
  progress(`Downloading nats-server ${NATS_VERSION} (${osName}/${archName})...`);

  const response = await fetch(releaseUrl, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Failed to download nats-server: ${response.status} ${response.statusText} (${releaseUrl})`);
  }

  // Download zip to temp, extract binary, cleanup
  const tmpZip = `${binPath}.zip`;
  try {
    const arrayBuf = await response.arrayBuffer();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(tmpZip, Buffer.from(arrayBuf));

    // Extract using unzip (available on macOS/Linux)
    const { execSync } = await import("node:child_process");
    const extractDir = `${binPath}-extract`;
    mkdirSync(extractDir, { recursive: true });
    execSync(`unzip -o "${tmpZip}" -d "${extractDir}"`, { stdio: "pipe" });

    // Find the nats-server binary inside extracted dir
    const innerDir = `nats-server-${NATS_VERSION}-${osName}-${archName}`;
    const extractedBin = join(extractDir, innerDir, "nats-server");

    if (!existsSync(extractedBin)) {
      throw new Error(`nats-server binary not found in archive at ${extractedBin}`);
    }

    chmodSync(extractedBin, 0o755);
    renameSync(extractedBin, binPath);

    // Cleanup
    const { rmSync } = await import("node:fs");
    try { rmSync(extractDir, { recursive: true }); } catch {}
    try { unlinkSync(tmpZip); } catch {}

    progress("nats-server downloaded successfully");
    log.info("nats-server binary downloaded", { path: binPath });

    return binPath;
  } catch (err) {
    try { unlinkSync(tmpZip); } catch {}
    throw err;
  }
}
