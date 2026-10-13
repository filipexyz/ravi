import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";

import { buildZip, crc32, downloadPageFiles, safeRelativePath, type PageReadRemoteFile } from "./read-download.js";

const HTML = "<html><link rel=stylesheet href=styles.css><h1>Weekly</h1></html>";
const CSS = "h1 { color: #b4462e; font-family: Fraunces, serif; }";

describe("downloadPageFiles", () => {
  it("writes every file into an empty directory, checking size and sha256", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "ravi-page-files-")), "weekly");
    const result = await downloadPageFiles({ files: remoteFiles(), kind: "directory", out: dir, fetch: fakeFetch });
    expect(readFileSync(join(dir, "index.html"), "utf8")).toBe(HTML);
    expect(readFileSync(join(dir, "assets/styles.css"), "utf8")).toBe(CSS);
    expect(result).toEqual({
      kind: "directory",
      path: dir,
      files: [
        { path: "index.html", contentType: "text/html", sizeBytes: HTML.length, entrypoint: true },
        { path: "assets/styles.css", contentType: "text/css", sizeBytes: CSS.length, entrypoint: false },
      ],
      totalBytes: HTML.length + CSS.length,
    });
  });

  it("writes a zip that holds the same bytes", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "ravi-page-zip-")), "weekly.zip");
    await downloadPageFiles({ files: remoteFiles(), kind: "zip", out, fetch: fakeFetch });
    expect(readZip(readFileSync(out))).toEqual({ "index.html": HTML, "assets/styles.css": CSS });
  });

  it("refuses a tampered file, an unsafe path and an existing target", async () => {
    const base = mkdtempSync(join(tmpdir(), "ravi-page-bad-"));
    const tampered = remoteFiles().map((file) => ({ ...file, sha256: "0".repeat(64) }));
    await expect(
      downloadPageFiles({ files: tampered, kind: "directory", out: join(base, "a"), fetch: fakeFetch }),
    ).rejects.toThrow(/sha256/);
    const escaping = [{ ...remoteFiles()[0], path: "../escape.html" }];
    await expect(
      downloadPageFiles({ files: escaping, kind: "directory", out: join(base, "b"), fetch: fakeFetch }),
    ).rejects.toThrow(/unsafe/);
    const duplicated = [remoteFiles()[0], { ...remoteFiles()[0], path: "./index.html" }];
    await expect(
      downloadPageFiles({ files: duplicated, kind: "zip", out: join(base, "dup.zip"), fetch: fakeFetch }),
    ).rejects.toThrow(/twice/);
    mkdirSync(join(base, "c"));
    writeFileSync(join(base, "c", "keep.txt"), "x");
    await expect(
      downloadPageFiles({ files: remoteFiles(), kind: "directory", out: join(base, "c"), fetch: fakeFetch }),
    ).rejects.toThrow(/not an empty directory/);
    writeFileSync(join(base, "d.zip"), "x");
    await expect(
      downloadPageFiles({ files: remoteFiles(), kind: "zip", out: join(base, "d.zip"), fetch: fakeFetch }),
    ).rejects.toThrow(/already exists/);
  });
});

describe("zip helpers", () => {
  it("computes the standard CRC-32", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("rejects absolute, parent and empty segments", () => {
    expect(safeRelativePath("./a/b.css")).toBe("a/b.css");
    for (const bad of ["/etc/passwd", "a/../b", "a//b", "a\\\\b", ""]) {
      expect(() => safeRelativePath(bad)).toThrow(/unsafe/);
    }
  });

  it("stores small files and deflates compressible ones", () => {
    const zip = buildZip(
      [
        { path: "a.txt", data: new TextEncoder().encode("x") },
        { path: "b.txt", data: new TextEncoder().encode("y".repeat(1000)) },
      ],
      new Date(2026, 9, 13, 12, 0, 0),
    );
    expect(readZip(Buffer.from(zip))).toEqual({ "a.txt": "x", "b.txt": "y".repeat(1000) });
  });
});

function remoteFiles(): PageReadRemoteFile[] {
  return [
    {
      path: "index.html",
      contentType: "text/html",
      sizeBytes: HTML.length,
      sha256: sha(HTML),
      entrypoint: true,
      url: "signed://index.html",
    },
    {
      path: "assets/styles.css",
      contentType: "text/css",
      sizeBytes: CSS.length,
      sha256: null,
      entrypoint: false,
      url: "signed://assets/styles.css",
    },
  ];
}

async function fakeFetch(url: string) {
  if (url === "signed://index.html") return new Response(HTML);
  if (url === "signed://assets/styles.css") return new Response(CSS);
  return new Response("", { status: 404 });
}

function sha(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

// Reads the zip back from its central directory, as an unzip tool would.
function readZip(buffer: Buffer): Record<string, string> {
  const end = buffer.length - 22;
  expect(buffer.readUInt32LE(end)).toBe(0x06054b50);
  const count = buffer.readUInt16LE(end + 10);
  let cursor = buffer.readUInt32LE(end + 16);
  const files: Record<string, string> = {};
  for (let index = 0; index < count; index++) {
    expect(buffer.readUInt32LE(cursor)).toBe(0x02014b50);
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const start = localOffset + 30 + localNameLength;
    const body = buffer.subarray(start, start + compressedSize);
    const data = method === 8 ? inflateRawSync(body) : body;
    expect(crc32(data)).toBe(crc);
    files[name] = data.toString("utf8");
    cursor += 46 + nameLength;
  }
  return files;
}
