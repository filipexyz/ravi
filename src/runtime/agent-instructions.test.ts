import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildGeneratedAgentsBridge,
  ensureAgentInstructionFiles,
  isGeneratedAgentsBridge,
  loadAgentWorkspaceInstructions,
} from "./agent-instructions.js";

describe("agent instruction files", () => {
  it("creates a managed AGENTS.md bridge next to CLAUDE.md", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ravi-agent-instructions-"));
    writeFileSync(join(cwd, "CLAUDE.md"), "# Agent\n\nPrimary instructions.\n");

    const result = ensureAgentInstructionFiles(cwd);
    const agentsPath = join(cwd, "AGENTS.md");

    expect(result.createdAgents).toBe(true);
    expect(existsSync(agentsPath)).toBe(true);
    expect(readFileSync(agentsPath, "utf8")).toBe(buildGeneratedAgentsBridge());
  });

  it("does not overwrite a custom AGENTS.md file", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ravi-agent-instructions-"));
    writeFileSync(join(cwd, "CLAUDE.md"), "# Agent\n\nPrimary instructions.\n");
    writeFileSync(join(cwd, "AGENTS.md"), "# Custom\n\nUse this instead.\n");

    const result = ensureAgentInstructionFiles(cwd);
    const content = readFileSync(join(cwd, "AGENTS.md"), "utf8");

    expect(result.createdAgents).toBe(false);
    expect(result.updatedAgents).toBe(false);
    expect(isGeneratedAgentsBridge(content)).toBe(false);
    expect(content).toContain("Use this instead.");
  });

  it("loads CLAUDE.md content when AGENTS.md is the managed bridge", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ravi-agent-instructions-"));
    writeFileSync(join(cwd, "CLAUDE.md"), "# Agent\n\nPrimary instructions.\n");
    writeFileSync(join(cwd, "AGENTS.md"), buildGeneratedAgentsBridge());

    const instructions = await loadAgentWorkspaceInstructions(cwd);

    expect(instructions?.path).toBe(join(cwd, "CLAUDE.md"));
    expect(instructions?.content).toContain("Primary instructions.");
  });

  it("prefers a custom AGENTS.md over CLAUDE.md", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ravi-agent-instructions-"));
    writeFileSync(join(cwd, "CLAUDE.md"), "# Agent\n\nPrimary instructions.\n");
    writeFileSync(join(cwd, "AGENTS.md"), "# Custom\n\nCodex instructions.\n");

    const instructions = await loadAgentWorkspaceInstructions(cwd);

    expect(instructions?.path).toBe(join(cwd, "AGENTS.md"));
    expect(instructions?.content).toContain("Codex instructions.");
  });
});
