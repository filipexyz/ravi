import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addSticker,
  getStickerCatalogPath,
  listStickers,
  readStickerCatalog,
  validateStickerEntry,
} from "./catalog.js";

let stateDir: string | null = null;
let previousStateDir: string | undefined;

beforeEach(() => {
  previousStateDir = process.env.RAVI_STATE_DIR;
  stateDir = mkdtempSync(join(tmpdir(), "ravi-stickers-catalog-"));
  process.env.RAVI_STATE_DIR = stateDir;
});

afterEach(() => {
  if (previousStateDir === undefined) {
    delete process.env.RAVI_STATE_DIR;
  } else {
    process.env.RAVI_STATE_DIR = previousStateDir;
  }
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  stateDir = null;
});

describe("sticker catalog", () => {
  it("validates, stores and normalizes typed sticker entries", () => {
    const mediaPath = join(stateDir!, "wave.webp");
    writeFileSync(mediaPath, "webp");

    const sticker = addSticker({
      id: "wave",
      label: "Wave",
      description: "Use for a friendly quick hello.",
      avoid: "Do not use for serious incidents.",
      channels: ["whatsapp-baileys", "whatsapp"],
      agents: ["main", "dev"],
      media: { kind: "file", path: mediaPath },
      enabled: true,
    });

    expect(sticker).toMatchObject({
      id: "wave",
      channels: ["whatsapp"],
      agents: ["main", "dev"],
      media: {
        path: mediaPath,
        mimeType: "image/webp",
      },
      enabled: true,
    });
    expect(listStickers()).toHaveLength(1);
    expect(readStickerCatalog(getStickerCatalogPath()).stickers[0]?.id).toBe("wave");
  });

  it("rejects invalid ids and inline base64 media references", () => {
    expect(() =>
      validateStickerEntry({
        id: "Bad Id",
        label: "Bad",
        description: "Invalid id.",
        channels: ["whatsapp"],
        agents: [],
        media: { kind: "file", path: "/tmp/sticker.webp" },
        enabled: true,
      }),
    ).toThrow();

    expect(() =>
      validateStickerEntry({
        id: "inline",
        label: "Inline",
        description: "Invalid inline media.",
        channels: ["whatsapp"],
        agents: [],
        media: { kind: "file", path: "data:image/webp;base64,AAAA" },
        enabled: true,
      }),
    ).toThrow("inline base64");
  });
});
