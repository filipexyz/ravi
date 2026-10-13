import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { deflateRawSync } from "node:zlib";

import { CloudAuthError } from "../cloud-auth/errors.js";

/**
 * Downloads the files `ravi pages read --format files|zip` gets from Console.
 *
 * Console answers `format: "files"` with every file of the route's artifact
 * version and a presigned GET for each, valid for a few minutes. The bytes are
 * fetched here, checked against the size and sha256 Console recorded, and
 * written to a directory or a zip. The signed URLs never leave this module.
 */

export interface PageReadRemoteFile {
  path: string;
  contentType: string;
  sizeBytes: number | null;
  sha256: string | null;
  entrypoint: boolean;
  url: string;
}

export interface PageReadDownloadedFile {
  path: string;
  contentType: string;
  sizeBytes: number;
  entrypoint: boolean;
}

export interface PageReadDownload {
  kind: "directory" | "zip";
  path: string;
  files: PageReadDownloadedFile[];
  totalBytes: number;
}

export type PageReadFetch = (url: string) => Promise<Response>;

const DOWNLOAD_CONCURRENCY = 4;

export async function downloadPageFiles(input: {
  files: PageReadRemoteFile[];
  kind: "directory" | "zip";
  out: string;
  fetch?: PageReadFetch;
  now?: Date;
}): Promise<PageReadDownload> {
  const target = resolve(input.out);
  assertWritableTarget(target, input.kind);
  const seen = new Set<string>();
  for (const file of input.files) {
    const path = safeRelativePath(file.path);
    if (seen.has(path)) {
      throw new CloudAuthError("SERVER_UNAVAILABLE", `Console listed ${path.slice(0, 200)} twice.`);
    }
    seen.add(path);
  }

  const fetchFile = input.fetch ?? ((url: string) => fetch(url));
  const bytes = await mapWithConcurrency(input.files, DOWNLOAD_CONCURRENCY, async (file) => {
    const response = await fetchFile(file.url);
    if (!response.ok) {
      throw new CloudAuthError("SERVER_UNAVAILABLE", `Could not download ${file.path} (HTTP ${response.status}).`);
    }
    const data = new Uint8Array(await response.arrayBuffer());
    if (file.sizeBytes !== null && data.byteLength !== file.sizeBytes) {
      throw new CloudAuthError("SERVER_UNAVAILABLE", `${file.path} came back with a different size than published.`);
    }
    if (file.sha256 && /^[0-9a-f]{64}$/i.test(file.sha256)) {
      const digest = createHash("sha256").update(data).digest("hex");
      if (digest !== file.sha256.toLowerCase()) {
        throw new CloudAuthError("SERVER_UNAVAILABLE", `${file.path} does not match its published sha256.`);
      }
    }
    return data;
  });

  const entries = input.files.map((file, index) => ({ path: safeRelativePath(file.path), data: bytes[index] }));
  if (input.kind === "zip") {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, buildZip(entries, input.now ?? new Date()));
  } else {
    for (const entry of entries) {
      const filePath = join(target, entry.path);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, entry.data);
    }
  }

  const files = input.files.map((file, index) => ({
    path: entries[index].path,
    contentType: file.contentType,
    sizeBytes: entries[index].data.byteLength,
    entrypoint: file.entrypoint,
  }));
  return {
    kind: input.kind,
    path: target,
    files,
    totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
  };
}

/** A published path as a safe relative path: no absolute paths, no `..`, no backslashes. */
export function safeRelativePath(path: string): string {
  const normalized = path.replace(/^\.\//, "");
  const segments = normalized.split("/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.includes("\\") ||
    normalized.includes("\0") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new CloudAuthError("SERVER_UNAVAILABLE", `Refusing an unsafe file path from Console: ${path.slice(0, 200)}`);
  }
  return normalized;
}

function assertWritableTarget(target: string, kind: "directory" | "zip") {
  if (!existsSync(target)) return;
  if (kind === "zip") {
    throw new CloudAuthError("PAYLOAD_INVALID", `${target} already exists. Pass a new --out path for the zip.`);
  }
  if (!statSync(target).isDirectory() || readdirSync(target).length > 0) {
    throw new CloudAuthError("PAYLOAD_INVALID", `${target} is not an empty directory. Pass a new --out path.`);
  }
}

/** A plain zip (deflate, no zip64), enough for the 100 MB a Page may hold. */
export function buildZip(entries: Array<{ path: string; data: Uint8Array }>, now: Date): Uint8Array {
  const { date, time } = dosDateTime(now);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path, "utf8");
    const crc = crc32(entry.data);
    const deflated = deflateRawSync(entry.data);
    const useDeflate = deflated.byteLength < entry.data.byteLength;
    const body = useDeflate ? deflated : Buffer.from(entry.data);
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.byteLength, 18);
    local.writeUInt32LE(entry.data.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.byteLength, 20);
    central.writeUInt32LE(entry.data.byteLength, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.byteLength + name.byteLength + body.byteLength;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.byteLength, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, ...centrals, end]));
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(now: Date) {
  const year = Math.max(1980, now.getFullYear());
  return {
    date: ((year - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate(),
    time: (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2),
  };
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}
