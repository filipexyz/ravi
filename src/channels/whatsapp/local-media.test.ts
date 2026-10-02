import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { defaultLocalMediaRoots, readLocalMediaFile, resolveLocalMediaPath } from "./local-media.js";

let dir: string;
let root: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ravi-local-media-"));
  root = join(dir, "media");
  mkdirSync(join(root, "whatsapp", "inst"), { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("resolveLocalMediaPath", () => {
  it("resolves file:// URLs and absolute local paths, never remote URLs", () => {
    const file = join(root, "whatsapp", "inst", "a b.jpg");
    expect(resolveLocalMediaPath({ mediaUrl: pathToFileURL(file).href })).toBe(file);
    expect(resolveLocalMediaPath({ mediaUrl: pathToFileURL(file).href, localPath: "/other" })).toBe(file);
    expect(resolveLocalMediaPath({ localPath: file })).toBe(file);
    expect(resolveLocalMediaPath({ mediaUrl: "https://omni/media/x", localPath: file })).toBeNull();
    // Omni's own localPath is relative to Omni's storage.
    expect(resolveLocalMediaPath({ mediaUrl: "/api/v2/media/x", localPath: "inst/2026-10/x.jpg" })).toBeNull();
    expect(resolveLocalMediaPath({ mediaUrl: "/api/v2/media/x", localPath: file })).toBeNull();
    expect(resolveLocalMediaPath({ localPath: "relative/x.jpg" })).toBeNull();
    expect(resolveLocalMediaPath({ mediaUrl: "file://remote-host/x.jpg" })).toBeNull();
    expect(resolveLocalMediaPath({})).toBeNull();
  });
});

describe("readLocalMediaFile", () => {
  it("reads files inside the allowed roots", async () => {
    const file = join(root, "whatsapp", "inst", "photo.jpg");
    writeFileSync(file, "jpeg");
    expect((await readLocalMediaFile(file, { roots: [root] }))?.toString()).toBe("jpeg");
  });

  it("enforces the size limit like downloaded media", async () => {
    const file = join(root, "whatsapp", "inst", "big.bin");
    writeFileSync(file, Buffer.alloc(11));
    expect(await readLocalMediaFile(file, { roots: [root], maxBytes: 10 })).toBeNull();
    expect(await readLocalMediaFile(file, { roots: [root], maxBytes: 11 })).not.toBeNull();
  });

  it("refuses files outside the roots, including through symlinks and ..", async () => {
    const secret = join(dir, "secret.txt");
    writeFileSync(secret, "secret");
    const link = join(root, "whatsapp", "inst", "link.txt");
    symlinkSync(secret, link);

    expect(await readLocalMediaFile(secret, { roots: [root] })).toBeNull();
    expect(await readLocalMediaFile(link, { roots: [root] })).toBeNull();
    expect(await readLocalMediaFile(join(root, "..", "secret.txt"), { roots: [root] })).toBeNull();
  });

  it("returns null for missing files, directories and empty files", async () => {
    const empty = join(root, "whatsapp", "inst", "empty.bin");
    writeFileSync(empty, "");
    expect(await readLocalMediaFile(join(root, "missing.jpg"), { roots: [root] })).toBeNull();
    expect(await readLocalMediaFile(join(root, "whatsapp"), { roots: [root] })).toBeNull();
    expect(await readLocalMediaFile(empty, { roots: [root] })).toBeNull();
  });

  it("defaults to the media directory under RAVI_STATE_DIR", () => {
    expect(defaultLocalMediaRoots({ RAVI_STATE_DIR: "/srv/ravi" })).toEqual(["/srv/ravi/media"]);
  });
});
