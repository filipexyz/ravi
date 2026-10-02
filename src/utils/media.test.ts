import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { MAX_AUDIO_BYTES, MAX_MEDIA_BYTES, saveToAgentAttachments } from "./media.js";

let agentCwd: string | null = null;

afterEach(async () => {
  if (agentCwd) await rm(agentCwd, { recursive: true, force: true });
  agentCwd = null;
});

describe("media utilities", () => {
  it("keeps the 20MB limits", () => {
    expect(MAX_MEDIA_BYTES).toBe(20 * 1024 * 1024);
    expect(MAX_AUDIO_BYTES).toBe(20 * 1024 * 1024);
  });

  it("saves media under <agentCwd>/attachments with a sanitized name and the mime extension", async () => {
    agentCwd = await mkdtemp(join(tmpdir(), "ravi-media-attachments-"));

    const saved = await saveToAgentAttachments(Buffer.from("png-bytes"), agentCwd, "3EB0:abc/def", "image/png");

    expect(dirname(saved)).toBe(join(agentCwd, "attachments"));
    expect(basename(saved)).toMatch(/^\d+-3EB0_abc_def\.png$/);
    expect((await readFile(saved)).toString()).toBe("png-bytes");
  });

  it("derives the extension from the mime subtype when it is not in the table", async () => {
    agentCwd = await mkdtemp(join(tmpdir(), "ravi-media-attachments-"));

    const saved = await saveToAgentAttachments(Buffer.from("x"), agentCwd, "m1", "application/zip; charset=binary");

    expect(saved.endsWith("-m1.zip")).toBe(true);
  });
});
