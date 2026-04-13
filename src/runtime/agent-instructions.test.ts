import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildGeneratedAgentsBridge,
  buildGeneratedClaudeBridge,
  ensureAgentInstructionFiles,
  inspectAgentInstructionFiles,
  isGeneratedAgentsBridge,
  isGeneratedClaudeBridge,
  loadAgentWorkspaceInstructions,
} from "./agent-instructions.js";

describe("agent instruction files", () => {
  it("migrates a legacy CLAUDE.md workspace into canonical AGENTS.md instructions", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ravi-agent-instructions-"));
    writeFileSync(join(cwd, "CLAUDE.md"), "# Agent\n\nPrimary instructions.\n");

    const result = ensureAgentInstructionFiles(cwd);
    const agentsPath = join(cwd, "AGENTS.md");
    const claudePath = join(cwd, "CLAUDE.md");

    expect(result.createdAgents).toBe(true);
    expect(result.updatedClaude).toBe(true);
    expect(existsSync(agentsPath)).toBe(true);
    expect(readFileSync(agentsPath, "utf8")).toBe("# Agent\n\nPrimary instructions.\n");
    expect(readFileSync(claudePath, "utf8")).toBe(buildGeneratedClaudeBridge());
  });

  it("creates a managed CLAUDE.md bridge next to a canonical AGENTS.md workspace", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ravi-agent-instructions-"));
    writeFileSync(join(cwd, "AGENTS.md"), "# Agent\n\nPrimary instructions.\n");

    const result = ensureAgentInstructionFiles(cwd);
    const claudePath = join(cwd, "CLAUDE.md");

    expect(result.createdAgents).toBe(false);
    expect(result.createdClaude).toBe(true);
    expect(existsSync(claudePath)).toBe(true);
    expect(readFileSync(claudePath, "utf8")).toBe(buildGeneratedClaudeBridge());
  });

  it("creates AGENTS.md as the canonical stub for new workspaces", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ravi-agent-instructions-"));

    const result = ensureAgentInstructionFiles(cwd, {
      createAgentsStub: "# Agent\n\nPrimary instructions.\n",
    });

    expect(result.createdAgents).toBe(true);
    expect(result.createdClaude).toBe(true);
    expect(readFileSync(join(cwd, "AGENTS.md"), "utf8")).toContain("Primary instructions.");
    expect(readFileSync(join(cwd, "CLAUDE.md"), "utf8")).toBe(buildGeneratedClaudeBridge());
  });

  it("treats a minimal @CLAUDE.md file as a legacy AGENTS bridge and migrates it", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ravi-agent-instructions-"));
    writeFileSync(join(cwd, "AGENTS.md"), "@CLAUDE.md\n");
    writeFileSync(join(cwd, "CLAUDE.md"), "# Agent\n\nPrimary instructions.\n");

    const result = ensureAgentInstructionFiles(cwd);

    expect(result.updatedAgents).toBe(true);
    expect(result.updatedClaude).toBe(true);
    expect(readFileSync(join(cwd, "AGENTS.md"), "utf8")).toBe("# Agent\n\nPrimary instructions.\n");
    expect(readFileSync(join(cwd, "CLAUDE.md"), "utf8")).toBe(buildGeneratedClaudeBridge());
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

  it("does not overwrite a custom CLAUDE.md file", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ravi-agent-instructions-"));
    writeFileSync(join(cwd, "AGENTS.md"), "# Agent\n\nPrimary instructions.\n");
    writeFileSync(join(cwd, "CLAUDE.md"), "# Custom Legacy\n\nKeep this file.\n");

    const result = ensureAgentInstructionFiles(cwd);
    const content = readFileSync(join(cwd, "CLAUDE.md"), "utf8");

    expect(result.createdClaude).toBe(false);
    expect(result.updatedClaude).toBe(false);
    expect(isGeneratedClaudeBridge(content)).toBe(false);
    expect(content).toContain("Keep this file.");
  });

  it("loads AGENTS.md content after migrating a managed legacy bridge", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ravi-agent-instructions-"));
    writeFileSync(join(cwd, "CLAUDE.md"), "# Agent\n\nPrimary instructions.\n");
    writeFileSync(join(cwd, "AGENTS.md"), buildGeneratedAgentsBridge());

    const instructions = await loadAgentWorkspaceInstructions(cwd);

    expect(instructions?.path).toBe(join(cwd, "AGENTS.md"));
    expect(instructions?.content).toContain("Primary instructions.");
    expect(readFileSync(join(cwd, "CLAUDE.md"), "utf8")).toBe(buildGeneratedClaudeBridge());
  });

  it("loads AGENTS.md content when CLAUDE.md is the managed compatibility bridge", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ravi-agent-instructions-"));
    writeFileSync(join(cwd, "AGENTS.md"), "# Agent\n\nPrimary instructions.\n");
    writeFileSync(join(cwd, "CLAUDE.md"), buildGeneratedClaudeBridge());

    const instructions = await loadAgentWorkspaceInstructions(cwd);

    expect(instructions?.path).toBe(join(cwd, "AGENTS.md"));
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

  it("classifies AGENTS-first workspaces distinctly from legacy CLAUDE-first ones", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ravi-agent-instructions-"));
    writeFileSync(join(cwd, "CLAUDE.md"), "# Agent\n\nPrimary instructions.\n");
    writeFileSync(join(cwd, "AGENTS.md"), buildGeneratedAgentsBridge());

    expect(inspectAgentInstructionFiles(cwd).state).toBe("legacy-claude-canonical");

    ensureAgentInstructionFiles(cwd);

    expect(inspectAgentInstructionFiles(cwd).state).toBe("agents-canonical");
  });
});
