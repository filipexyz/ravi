import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { buildRuntimeSystemPrompt } from "./runtime-system-prompt.js";
import { addSticker } from "../stickers/catalog.js";

describe("buildRuntimeSystemPrompt", () => {
  it("renders workspace and agent contexts as plain Markdown sections", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ravi-runtime-system-prompt-"));
    try {
      writeFileSync(join(cwd, "AGENTS.md"), "# Main Agent\n\nUse the local project rules.\n");

      const prompt = await buildRuntimeSystemPrompt({
        cwd,
        sessionName: "dev",
        agent: {
          id: "main",
          cwd,
          systemPromptAppend: "Prefer concise operational answers.",
        },
        ctx: {
          channelId: "whatsapp-baileys",
          channelName: "WhatsApp",
          isGroup: false,
        },
      });

      expect(prompt.sections.map((section) => section.id)).toContain("workspace.instructions");
      expect(prompt.sections.map((section) => section.id)).toContain("agent.system_prompt_append");
      expect(prompt.text).toContain("## Workspace Instructions");
      expect(prompt.text).toContain(`Workspace instructions loaded from ${join(cwd, "AGENTS.md")}`);
      expect(prompt.text).toContain("Use the local project rules.");
      expect(prompt.text).toContain("## Agent Instructions");
      expect(prompt.text).toContain("Prefer concise operational answers.");
      expect(prompt.text).toContain("## Session Boundary");
      expect(prompt.text).not.toContain('"workspace.instructions"');
      expect(prompt.text).not.toContain('"agent.system_prompt_append"');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("buildRuntimeSystemPrompt stickers", () => {
  it("includes sticker ids only for sticker-capable channels with agent opt-in", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ravi-runtime-system-prompt-"));
    const stateDir = mkdtempSync(join(tmpdir(), "ravi-runtime-stickers-"));
    const previousStateDir = process.env.RAVI_STATE_DIR;
    const mediaPath = join(stateDir, "wave.webp");
    try {
      process.env.RAVI_STATE_DIR = stateDir;
      writeFileSync(join(cwd, "AGENTS.md"), "# Main Agent\n");
      writeFileSync(mediaPath, "webp");
      addSticker({
        id: "wave",
        label: "Wave",
        description: "Use for a friendly hello.",
        avoid: "Avoid during serious incidents.",
        channels: ["whatsapp"],
        agents: ["main"],
        media: { kind: "file", path: mediaPath },
        enabled: true,
      });

      const prompt = await buildRuntimeSystemPrompt({
        cwd,
        sessionName: "dev",
        agent: {
          id: "main",
          cwd,
          defaults: { stickers: { enabled: true } },
        },
        ctx: {
          channelId: "whatsapp-baileys",
          channelName: "WhatsApp",
          isGroup: false,
        },
      });

      const sectionIds = prompt.sections.map((section) => section.id);
      expect(sectionIds).toContain("channel.stickers");
      expect(sectionIds).toEqual(
        expect.arrayContaining(["channel.output_formatting", "channel.reactions", "channel.stickers"]),
      );
      expect(sectionIds.indexOf("channel.reactions")).toBeLessThan(sectionIds.indexOf("channel.stickers"));
      expect(prompt.text).toContain("## Stickers");
      expect(prompt.text).toContain("`wave`");
      expect(prompt.text).toContain("ravi stickers send <id>");
      expect(prompt.text).not.toContain(mediaPath);
      expect(prompt.text).not.toContain('"media"');
      expect(prompt.text).not.toContain("base64");
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.RAVI_STATE_DIR;
      } else {
        process.env.RAVI_STATE_DIR = previousStateDir;
      }
      rmSync(cwd, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("excludes stickers when the channel lacks capability or the agent has not opted in", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ravi-runtime-system-prompt-"));
    const stateDir = mkdtempSync(join(tmpdir(), "ravi-runtime-stickers-"));
    const previousStateDir = process.env.RAVI_STATE_DIR;
    const mediaPath = join(stateDir, "wave.webp");
    try {
      process.env.RAVI_STATE_DIR = stateDir;
      writeFileSync(join(cwd, "AGENTS.md"), "# Main Agent\n");
      writeFileSync(mediaPath, "webp");
      addSticker({
        id: "wave",
        label: "Wave",
        description: "Use for a friendly hello.",
        channels: ["whatsapp"],
        agents: [],
        media: { kind: "file", path: mediaPath },
        enabled: true,
      });

      const matrixPrompt = await buildRuntimeSystemPrompt({
        cwd,
        agent: { id: "main", cwd, defaults: { stickers: { enabled: true } } },
        ctx: {
          channelId: "matrix",
          channelName: "Matrix",
          isGroup: false,
        },
      });
      const disabledPrompt = await buildRuntimeSystemPrompt({
        cwd,
        agent: { id: "main", cwd },
        ctx: {
          channelId: "whatsapp",
          channelName: "WhatsApp",
          isGroup: false,
        },
      });

      expect(matrixPrompt.sections.map((section) => section.id)).not.toContain("channel.stickers");
      expect(matrixPrompt.text).not.toContain("ravi stickers send");
      expect(disabledPrompt.sections.map((section) => section.id)).not.toContain("channel.stickers");
      expect(disabledPrompt.text).not.toContain("ravi stickers send");
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.RAVI_STATE_DIR;
      } else {
        process.env.RAVI_STATE_DIR = previousStateDir;
      }
      rmSync(cwd, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("allows session runtime params to opt in to sticker prompts", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ravi-runtime-system-prompt-"));
    const stateDir = mkdtempSync(join(tmpdir(), "ravi-runtime-stickers-"));
    const previousStateDir = process.env.RAVI_STATE_DIR;
    const mediaPath = join(stateDir, "wave.webp");
    try {
      process.env.RAVI_STATE_DIR = stateDir;
      writeFileSync(join(cwd, "AGENTS.md"), "# Main Agent\n");
      writeFileSync(mediaPath, "webp");
      addSticker({
        id: "wave",
        label: "Wave",
        description: "Use for a friendly hello.",
        channels: ["whatsapp"],
        agents: [],
        media: { kind: "file", path: mediaPath },
        enabled: true,
      });

      const prompt = await buildRuntimeSystemPrompt({
        cwd,
        agent: { id: "main", cwd },
        sessionRuntimeParams: { stickers: { enabled: true } },
        ctx: {
          channelId: "whatsapp",
          channelName: "WhatsApp",
          isGroup: false,
        },
      });

      expect(prompt.sections.map((section) => section.id)).toContain("channel.stickers");
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.RAVI_STATE_DIR;
      } else {
        process.env.RAVI_STATE_DIR = previousStateDir;
      }
      rmSync(cwd, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
