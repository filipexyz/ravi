import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
      expect(prompt.sections.map((section) => section.id)).toContain("runtime.operational_context");
      expect(prompt.text).toContain("## Ravi Operational Context");
      expect(prompt.text).toContain("- agent: `main`");
      expect(prompt.text).toContain("- session: `dev`");
      expect(prompt.text).toContain("`ravi self permissions --json`");
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

  it("renders bounded runtime capabilities without exposing context keys", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ravi-runtime-system-prompt-"));
    try {
      const prompt = await buildRuntimeSystemPrompt({
        cwd,
        sessionName: "ops",
        agent: { id: "main", cwd },
        runtimeContext: {
          contextId: "ctx_visible",
          kind: "agent-runtime",
          agentId: "main",
          sessionKey: "agent:main:main",
          sessionName: "ops",
          source: { channel: "whatsapp", accountId: "main", chatId: "chat_123" },
          capabilities: [
            { permission: "use", objectType: "tool", objectId: "Bash", source: "test" },
            { permission: "execute", objectType: "group", objectId: "sessions", source: "test" },
          ],
        },
      });

      expect(prompt.text).toContain("`ctx_visible` (agent-runtime)");
      expect(prompt.text).toContain("- capabilities: 2");
      expect(prompt.text).toContain("`use:tool:Bash source=test`");
      expect(prompt.text).toContain("`execute:group:sessions source=test`");
      expect(prompt.text).not.toContain("rctx_");
      expect(prompt.text).not.toContain("contextKey");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("injects .ravi/rules as an ordered Ravi Rules section", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ravi-runtime-system-prompt-"));
    try {
      const rulesDir = join(cwd, ".ravi", "rules");
      mkdirSync(join(rulesDir, "vault"), { recursive: true });
      writeFileSync(join(cwd, "AGENTS.md"), "# Main Agent\n\nUse the local project rules.\n");
      writeFileSync(join(rulesDir, ".gitkeep"), "");
      writeFileSync(join(rulesDir, "01-project-tracking.md"), "Always update project tracking.\n");
      writeFileSync(join(rulesDir, "02-task-profiles.md"), "Honor task profiles.\n");
      writeFileSync(join(rulesDir, "03-extensionless"), "Accept extensionless text rules.\n");
      writeFileSync(join(rulesDir, "04-binary.md"), Buffer.from([0, 1, 2, 3]));
      writeFileSync(join(rulesDir, "05-generated.json"), '{"ignored":true}\n');
      writeFileSync(join(rulesDir, "vault", "frontmatter-standard.md"), "Validate vault frontmatter.\n");

      const prompt = await buildRuntimeSystemPrompt({
        cwd,
        agent: {
          id: "main",
          cwd,
          systemPromptAppend: "Prefer concise operational answers.",
        },
      });

      const sectionIds = prompt.sections.map((section) => section.id);
      expect(sectionIds).toContain("workspace.instructions");
      expect(sectionIds).toContain("ravi.rules");
      expect(sectionIds).toContain("agent.system_prompt_append");

      const rulesSection = prompt.sections.find((section) => section.id === "ravi.rules");
      expect(rulesSection).toMatchObject({
        title: "Ravi Rules",
        priority: 30,
        source: rulesDir,
      });

      expect(prompt.text).toContain("## Ravi Rules");
      expect(prompt.text).toContain(`Ravi rules loaded from ${rulesDir}.`);
      expect(prompt.text).toContain("### 01-project-tracking.md");
      expect(prompt.text).toContain("Always update project tracking.");
      expect(prompt.text).toContain("### 02-task-profiles.md");
      expect(prompt.text).toContain("Honor task profiles.");
      expect(prompt.text).toContain("### 03-extensionless");
      expect(prompt.text).toContain("Accept extensionless text rules.");
      expect(prompt.text).toContain("### vault/frontmatter-standard.md");
      expect(prompt.text).toContain("Validate vault frontmatter.");
      expect(prompt.text).not.toContain(".gitkeep");
      expect(prompt.text).not.toContain("04-binary.md");
      expect(prompt.text).not.toContain("05-generated.json");

      expect(prompt.text.indexOf("## Workspace Instructions")).toBeLessThan(prompt.text.indexOf("## Ravi Rules"));
      expect(prompt.text.indexOf("## Ravi Rules")).toBeLessThan(prompt.text.indexOf("## Agent Instructions"));
      expect(prompt.text).not.toContain('"ravi.rules"');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("does not inject Ravi Rules when .ravi/rules is missing or empty", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ravi-runtime-system-prompt-"));
    try {
      const missingPrompt = await buildRuntimeSystemPrompt({
        cwd,
        agent: { id: "main", cwd },
      });
      expect(missingPrompt.sections.map((section) => section.id)).not.toContain("ravi.rules");
      expect(missingPrompt.text).not.toContain("## Ravi Rules");

      mkdirSync(join(cwd, ".ravi", "rules"), { recursive: true });
      const emptyPrompt = await buildRuntimeSystemPrompt({
        cwd,
        agent: { id: "main", cwd },
      });
      expect(emptyPrompt.sections.map((section) => section.id)).not.toContain("ravi.rules");
      expect(emptyPrompt.text).not.toContain("## Ravi Rules");
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
