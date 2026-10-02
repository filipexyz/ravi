/**
 * History sync media handling (#1127): honor the job's downloadMedia flag,
 * file media under the message's month, and aggregate failure logs.
 */

import { describe, expect, it, mock } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

// Spread the real module: mock.module is process-wide, so every other export stays real.
const { loadBaileys } = await import("../../baileys-loader.js");
const realBaileys = await loadBaileys();
const downloadMediaMessage = mock(async () => Readable.from([Buffer.from([1, 2, 3])]));
mock.module("baileys", () => ({ ...realBaileys, downloadMediaMessage }));

const { tryDownloadMedia, logMediaDownloadFailure, setupMessageHandlers } = await import("../handlers/messages.js");
const { createFakeHost } = await import("./fake-host.js");
const { EventEmitter } = await import("node:events");

type WAMessage = Parameters<typeof tryDownloadMedia>[0];

function imageMessage(id: string, epochSeconds: number): WAMessage {
  return {
    key: { id, remoteJid: "5511999999999@s.whatsapp.net", fromMe: false },
    message: { imageMessage: { mimetype: "image/png", fileLength: 3 } },
    messageTimestamp: epochSeconds,
  } as unknown as WAMessage;
}

describe("history sync media (#1127)", () => {
  // Omni's 'skips the download when the job disables downloadMedia' drives plugin.processHistoryMessage: step 2.

  it("files downloaded media under the message month, not the current month", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "ravi-wa-media-"));
    try {
      const march2020 = Date.UTC(2020, 2, 15) / 1000;
      const result = await tryDownloadMedia(imageMessage("hist-2", march2020), "inst-1", "hist-2", { baseDir });

      expect(result?.mediaLocalPath).toContain("2020-03");
      expect(result?.mediaLocalPath).toBe(join(baseDir, "inst-1", "2020-03", "hist-2.png"));
      expect(existsSync(result?.mediaLocalPath ?? "")).toBe(true);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("returns a file:// media URL for the absolute local path (ravi: no media API)", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "ravi-wa-media-"));
    try {
      const result = await tryDownloadMedia(imageMessage("hist-3", 1_700_000_000), "inst-1", "hist-3", { baseDir });
      expect(result).not.toBeNull();
      expect(result?.mediaUrl).toBe(pathToFileURL(result?.mediaLocalPath ?? "").href);
      expect(result?.mediaUrl.startsWith("file://")).toBe(true);
      expect(result?.mimeType).toBe("image/png");
      expect(result?.size).toBe(3);
      expect(readFileSync(result?.mediaLocalPath ?? "")).toEqual(Buffer.from([1, 2, 3]));
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("sanitizes ids so a crafted externalId or instanceId cannot escape the media root", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "ravi-wa-media-"));
    try {
      const result = await tryDownloadMedia(imageMessage("x", 1_700_000_000), "../evil", "../../etc/passwd", {
        baseDir,
      });
      expect(result?.mediaLocalPath.startsWith(`${baseDir}/`)).toBe(true);
      expect(result?.mediaLocalPath).not.toContain("..");
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("forwards the Baileys re-upload context to downloadMediaMessage", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "ravi-wa-media-"));
    try {
      downloadMediaMessage.mockClear();
      const context = { reuploadRequest: mock(async (m: WAMessage) => m), logger: {} as never };
      await tryDownloadMedia(imageMessage("hist-4", 1_700_000_000), "inst-1", "hist-4", { baseDir, context });
      const calls = downloadMediaMessage.mock.calls as unknown as unknown[][];
      expect(calls[0]?.[3]).toBe(context);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("inbound media through setupMessageHandlers lands under the host media root with a file:// URL", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "ravi-wa-media-"));
    try {
      downloadMediaMessage.mockClear();
      const ev = new EventEmitter();
      const updateMediaMessage = mock(async (m: WAMessage) => m);
      const sockLogger = { info: () => {} };
      const sock = { ev, presenceSubscribe: mock(async () => {}), updateMediaMessage, logger: sockLogger };
      const host = createFakeHost({ mediaBaseDir: baseDir });
      setupMessageHandlers(sock as unknown as Parameters<typeof setupMessageHandlers>[0], host, "inst-media");

      ev.emit("messages.upsert", { type: "notify", messages: [imageMessage("IMG-1", 1_700_000_000)] });
      await new Promise((r) => setTimeout(r, 20));

      expect(host.handleMessageReceived).toHaveBeenCalledTimes(1);
      const content = (host.handleMessageReceived.mock.calls[0] as unknown[])[4] as Record<string, unknown>;
      const expectedPath = join(baseDir, "inst-media", "2023-11", "IMG-1.png");
      expect(content.mediaLocalPath).toBe(expectedPath);
      expect(content.mediaUrl).toBe(pathToFileURL(expectedPath).href);
      expect(content.mimeType).toBe("image/png");
      const ctx = (downloadMediaMessage.mock.calls[0] as unknown as unknown[])[3] as Record<string, unknown>;
      expect(ctx.reuploadRequest).toBe(updateMediaMessage);
      expect(ctx.logger).toBe(sockLogger);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("logs one media failure per window and counts the rest", () => {
    const t0 = 10_000_000_000_000;
    expect(logMediaDownloadFailure("a", new Error("x"), t0)).toBe(true);
    expect(logMediaDownloadFailure("b", new Error("x"), t0 + 1_000)).toBe(false);
    expect(logMediaDownloadFailure("c", new Error("x"), t0 + 61_000)).toBe(true);
  });
});
