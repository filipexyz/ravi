import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const GENERATED_AGENTS_BRIDGE_MARKER = "<!-- ravi:generated:agents-bridge -->";

export interface AgentInstructionPaths {
  claudePath: string;
  agentsPath: string;
}

export interface AgentInstructionSyncResult {
  createdClaude: boolean;
  createdAgents: boolean;
  updatedAgents: boolean;
}

export interface AgentWorkspaceInstructions {
  path: string;
  content: string;
}

export function getAgentInstructionPaths(cwd: string): AgentInstructionPaths {
  return {
    claudePath: join(cwd, "CLAUDE.md"),
    agentsPath: join(cwd, "AGENTS.md"),
  };
}

export function buildGeneratedAgentsBridge(): string {
  return [
    GENERATED_AGENTS_BRIDGE_MARKER,
    "# AGENTS.md",
    "",
    "This file is managed by Ravi for Codex compatibility.",
    "The authoritative workspace instructions for this agent live in `./CLAUDE.md`.",
    "Before doing any work, read `./CLAUDE.md` and follow it as the primary instruction file for this workspace.",
    "",
    "@CLAUDE.md",
    "",
  ].join("\n");
}

export function isGeneratedAgentsBridge(content: string): boolean {
  return content.includes(GENERATED_AGENTS_BRIDGE_MARKER);
}

export function ensureAgentInstructionFiles(
  cwd: string,
  options: { createClaudeStub?: string } = {},
): AgentInstructionSyncResult {
  mkdirSync(cwd, { recursive: true });

  const { claudePath, agentsPath } = getAgentInstructionPaths(cwd);
  let createdClaude = false;
  let createdAgents = false;
  let updatedAgents = false;

  if (!existsSync(claudePath) && options.createClaudeStub) {
    writeFileSync(claudePath, options.createClaudeStub);
    createdClaude = true;
  }

  if (!existsSync(claudePath)) {
    return { createdClaude, createdAgents, updatedAgents };
  }

  const desiredBridge = buildGeneratedAgentsBridge();
  if (!existsSync(agentsPath)) {
    writeFileSync(agentsPath, desiredBridge);
    createdAgents = true;
    return { createdClaude, createdAgents, updatedAgents };
  }

  const currentAgents = readFileSync(agentsPath, "utf8");
  if (isGeneratedAgentsBridge(currentAgents) && currentAgents !== desiredBridge) {
    writeFileSync(agentsPath, desiredBridge);
    updatedAgents = true;
  }

  return { createdClaude, createdAgents, updatedAgents };
}

export async function loadAgentWorkspaceInstructions(cwd: string): Promise<AgentWorkspaceInstructions | null> {
  const { claudePath, agentsPath } = getAgentInstructionPaths(cwd);
  const agents = await tryReadInstructionFile(agentsPath);
  const claude = await tryReadInstructionFile(claudePath);

  if (agents && !isGeneratedAgentsBridge(agents.content)) {
    return agents;
  }

  if (claude) {
    return claude;
  }

  return agents;
}

async function tryReadInstructionFile(path: string): Promise<AgentWorkspaceInstructions | null> {
  try {
    const content = (await readFile(path, "utf8")).trim();
    if (content.length > 0) {
      return { path, content };
    }
  } catch {}

  return null;
}
