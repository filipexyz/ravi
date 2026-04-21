import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { buildRuntimeSystemPrompt } from "./runtime-system-prompt.js";

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
